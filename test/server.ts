/*
 * 服务测试 —— 起一个真监听的服务，用真 HTTP 请求打它
 *
 * 不 mock http：这个文件的目的是证明「路由 / 静态文件 / 错误形状 / 本地化出口」
 * 这几件事在真网络栈上是通的。用内存库 + 一份真实 enka 响应播种，
 * 所以断言里可以直接出现「Diluc」「Crimson Witch of Flames」这种真数据。
 *
 * 与 pipeline.ts 的分工：pipeline 管「数据有没有被搞坏」，本文件管「接口给的东西对不对」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer } from '../src/server/index.ts'
import * as repo from '../src/store/repo.ts'
import { ingestPayload } from '../src/adapter/ingest.ts'
import type { EnkaPayload } from '../src/domain/enka.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'enka-real.json'), 'utf8'))

let failed = 0
let passed = 0
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
function eq (a: unknown, b: unknown, label: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`)
}

/* 播种：把真实响应过一遍 ingest 落进内存库 */
const summary = ingestPayload(REAL, { source: 'enka' })
/* 夹具是真实响应，uid 必然在（ingest 那边找不到就直接抛了）—— 后面到处拿它拼 URL / 查库。 */
const UID = summary.player.uid!

const app = await startServer({ port: 0, dbFile: ':memory:' })
repo.saveFetch(app.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })

const get = (p: string): Promise<Response> => fetch(app.url + p)
/*
 * 接口返回的 JSON 体。`Response.json()` 在 Node 的类型里是 `Promise<unknown>`
 * （浏览器那套 lib.dom 才标 any），而本文件是按字段名断言的 —— 与其每行断言一次，
 * 不如在**这一处**把「接口给的 JSON」收回 any。
 */
const readJson = (r: Response): Promise<any> => r.json()
const json = async (p: string): Promise<any> => readJson(await get(p))

/* ---------------- 1. 元信息 ---------------- */

console.log('=== 1. 元信息与健康检查 ===')
{
  const h = await json('/api/health')
  eq(h.ok, true, '/api/health 返回 ok')
  eq(h.data.uids, 1, '/api/health 报出 1 个 uid')

  const m = await json('/api/meta')
  const codes = m.data.locales.map((l: any) => l.code)
  ok(codes.includes('chs'), '语言表里有 chs')
  ok(codes.length >= 1, `语言表共 ${codes.length} 种：${codes.join(', ')}`)
  eq(m.data.defaultLocale, 'chs', '默认语言是 chs')

  /* 界面文字：前端靠这一份把按钮/标题都换掉，所以每种语言都得给全 */
  ok(m.data.ui && typeof m.data.ui === 'object', '/api/meta 带 ui 文案表')
  eq(m.data.ui.panelSection, '面板属性', 'chs 的界面文字是中文')
  ok(m.data.ui.fetchDone.includes('{n}'), 'fetchDone 带 {n} 占位符')

  const en = await json('/api/meta?locale=en')
  eq(en.data.ui.panelSection, 'Stats', 'locale=en 时界面文字跟着变')
  ok(en.data.ui.fetchDone.includes('{n}'), '英文版的占位符还在')

  /* 首页「按属性权重筛选」的四个选项：顺序固定，名字随语言变（前端不写死词条名） */
  eq(m.data.weightOptions.map((o: any) => o.key).join(','), 'atk,def,hp,mastery', '权重筛选四项按攻/防/生/精排')
  eq(m.data.weightOptions[0].label, '攻击力', 'chs 的属性名是中文')
  eq(en.data.weightOptions[0].label, 'ATK', '英文下属性名跟着变')

  /* 认不出的语言要落回默认语言，不能给个空表让页面全是 key */
  const bogus = await json('/api/meta?locale=xx')
  eq(bogus.data.ui.panelSection, '面板属性', '未知语言回落到默认语言')
}

/* ---------------- 2. uid 列表 ---------------- */

console.log('\n=== 2. uid 列表 ===')
{
  const r = await json('/api/uids')
  eq(r.data.length, 1, '/api/uids 有 1 条')
  eq(r.data[0].uid, UID, 'uid 对得上')
  eq(r.data[0].avatarCount, summary.avatarCount, '角色数与 ingest 一致')

  /* 抓取时间在**出口**转成本地时区文本（库里存的仍是 ISO UTC，见 shape.ts 的 fmtTime）。
     断言刻意写成与时区无关 —— 换台机器跑也得过，所以拆成两条：
       ① 格式：没有 T/Z，就是「YYYY-MM-DD HH:mm:ss」
       ② 换算：把结果按本地时间解析回去，应当与库里那个 UTC 时刻**同一毫秒**
          （② 才是真验证时区换算，而且不用把 +8 写死） */
  const ft = r.data[0].fetchedAt
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ft),
    'fetchedAt 是本地时间文本、不含 T/Z', `实际 ${JSON.stringify(ft)}`)
  eq(new Date(String(ft).replace(' ', 'T')).getTime(),
    new Date('2026-09-13T00:00:00.000Z').getTime(),
    'fetchedAt 换算回去与库里时刻是同一时刻')
}

/* ---------------- 3. 视图：中文 ---------------- */

console.log('\n=== 3. 视图（locale=chs）===')
let chsView = null
{
  const r = await json(`/api/uid/${UID}?locale=chs`)
  chsView = r.data
  eq(r.data.count, summary.avatarCount, '角色数一致')
  eq(r.data.locale, 'chs', '回显语言')
  eq(r.data.skipped, [], '没有被跳过的角色')
  ok(!!r.data.account.nickname, `账号昵称拿得到（${r.data.account.nickname}）`)

  const diluc = r.data.avatars.find((a: any) => a.nameZh === '迪卢克')
  ok(!!diluc, '能找到迪卢克')
  if (diluc) {
    eq(diluc.artifacts.length, 5, '圣遗物 5 个位置都在')
    ok(diluc.artifacts.every((a: any) => a.posName), '每个位置都有部位名')
    ok(diluc.panel.length > 0, `面板属性 ${diluc.panel.length} 项`)
    ok(diluc.sets.length > 0, `套装 ${diluc.sets.map((s: any) => s.name + '×' + s.count).join(' ')}`)
    const withSubs = diluc.artifacts.filter((a: any) => !a.empty && a.subs.length)
    ok(withSubs.length > 0, '圣遗物带副词条')
    ok(withSubs.every((a: any) => a.subs.every((s: any) => s.upNum >= 1)),
      '副词条都带强化次数（内核靠重复次数算的，不能丢）')
    ok(!!diluc.weapon.name, `武器名 ${diluc.weapon.name}`)
  }

  /* 角色级数据时间：明细页靠它说「这个角色什么时候同步的」，不能拿 UID 级时间冒充 ——
     展柜是分批攒的，角色之间能差好几天。这里把迪卢克的时间改成一个明显不同的时刻，
     再请求一次：角色级要跟着变，UID 级（来自 fetch_log）必须纹丝不动。
     注意夹具里所有角色共用同一个 stamp，所以「改了迪卢克、其它人不变」才算真证明。 */
  const seed = '2026-01-02T03:04:05.000Z'
  app.db.prepare('UPDATE avatar SET fetched_at = ? WHERE avatar_id = ?').run(seed, diluc.avatarId)
  const again = (await json(`/api/uid/${UID}?locale=chs`)).data
  const d2 = again.avatars.find((a: any) => a.avatarId === diluc.avatarId)
  ok(!!d2?.fetchedAt, '角色视图带自己的数据时间')
  eq(new Date(String(d2?.fetchedAt).replace(' ', 'T')).getTime(), new Date(seed).getTime(),
    '角色时间是它自己那次同步的时刻（avatar.fetched_at）')
  ok(again.avatars.filter((a: any) => a.avatarId !== diluc.avatarId)
    .every((a: any) => a.fetchedAt !== d2?.fetchedAt),
    '同 UID 的其它角色不受影响（各是各的时间）')
  eq(again.fetchedAt, chsView.fetchedAt,
    'UID 级时间不变（它来自 fetch_log，与 avatar 表无关）')
}

/* ---------------- 4. 视图：其它语言（这一层是本次的重点）---------------- */

console.log('\n=== 4. 视图（en / ja / cht）===')
{
  const en = (await json(`/api/uid/${UID}?locale=en`)).data
  const diluc = en.avatars.find((a: any) => a.nameZh === '迪卢克')
  if (chsView && en.locale === 'en') {
    ok(diluc && diluc.name !== diluc.nameZh,
      `英文名下不再是中文（${diluc?.name}）`, `得到 ${diluc?.name}`)
    ok(diluc.artifacts.every((a: any) => a.posName && !/[\u4e00-\u9fff]/.test(a.posName)),
      '英文下部位名不含汉字', JSON.stringify(diluc.artifacts.map((a: any) => a.posName)))
    const set = diluc.sets[0]
    ok(set && set.name !== set.nameZh, `英文套装名（${set?.name}）`)
    const subKeys = diluc.artifacts.flatMap((a: any) => a.subs.map((s: any) => s.label))
    ok(subKeys.length > 0 && subKeys.every((t: any) => !/[\u4e00-\u9fff]/.test(t)),
      '英文下词条名不含汉字', JSON.stringify(subKeys.slice(0, 4)))
  } else {
    console.log(`  （语言表里没有 en，跳过英文断言 —— 先跑 tools/sync_i18n.py）`)
  }

  const ja = (await json(`/api/uid/${UID}?locale=ja`)).data
  ok(ja.locale === (ja.locale === 'ja' ? 'ja' : 'chs'), 'ja 认得出或退回 chs')

  const cht = (await json(`/api/uid/${UID}?locale=CHT`)).data
  ok(cht.locale === 'cht' || cht.locale === 'chs', '大小写混写（CHT）也能认')
}

/* ---------------- 5. 语言退回与别名 ---------------- */

console.log('\n=== 5. 语言归一 ===')
{
  const alias = (await json(`/api/uid/${UID}?locale=zh-cn`)).data
  eq(alias.locale, 'chs', 'zh-cn → chs')
  const weird = (await json(`/api/uid/${UID}?locale=klingon`)).data
  eq(weird.locale, 'chs', '认不出的语言退回默认')
}

/* ---------------- 6. 错误形状 ---------------- */

console.log('\n=== 6. 错误形状 ===')
{
  const r404 = await get(`/api/uid/999999`)
  eq(r404.status, 404, '库里没有的 uid → 404')
  const b404 = await readJson(r404)
  eq(b404.ok, false, '失败响应带 ok:false')
  ok(!!b404.error?.code && !!b404.error?.message, `错误体有 code/message（${b404.error?.code}）`)

  const rBad = await fetch(app.url + '/api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'not-a-number' })
  })
  eq(rBad.status, 400, 'uid 不是数字 → 400')

  const rJunk = await fetch(app.url + '/api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{{'
  })
  eq(rJunk.status, 400, '请求体不是 JSON → 400')

  const rNo = await get('/api/nope')
  eq(rNo.status, 404, '不存在的接口 → 404')
}

/* ---------------- 7. 抓取（注入假 enka，不联网）---------------- */

console.log('\n=== 7. POST /api/fetch（用假 enka，不联网）===')
{
  const app2 = await startServer({
    port: 0,
    dbFile: ':memory:',
    fetchImpl: async (uid) => ({ ...REAL, uid })
  })
  const res = await fetch(app2.url + '/api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, locale: 'chs' })
  })
  const body = await readJson(res)
  eq(res.status, 200, '抓取成功')
  eq(body.meta.fetched, summary.avatarCount, 'meta.fetched 是本轮抓到的角色数')
  eq(body.data.count, summary.avatarCount, '抓完直接能返回视图')
  ok(repo.listUids(app2.db).includes(UID), '抓完数据确实落库了')

  /* 上游报错要变成 502 + 人话，而不是 500 堆栈 */
  const app3 = await startServer({
    port: 0, dbFile: ':memory:',
    fetchImpl: async () => { throw new Error('enka: 查不到这个 UID') }
  })
  const r3 = await fetch(app3.url + '/api/fetch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 123 })
  })
  eq(r3.status, 502, 'enka 业务错误 → 502')
  eq((await readJson(r3)).error.message, 'enka: 查不到这个 UID', '错误原文透传给人看')
  app3.server.close()
  app2.server.close()
}

/* ---------------- 8. 静态页与目录穿越 ---------------- */

console.log('\n=== 8. 静态文件 ===')
{
  const r = await get('/')
  eq(r.status, 200, '/ 返回 200')
  ok((r.headers.get('content-type') || '').includes('text/html'), '内容是 html')
  const html = await r.text()
  ok(html.includes('星天水镜'), '页面里有标题')
  ok(html.includes('/app.js') && html.includes('/style.css'), '页面引了脚本和样式')

  const js = await get('/app.js')
  ok((js.headers.get('content-type') || '').includes('javascript'), 'js 的 content-type 对')
  ok((await js.text()).length > 500, 'js 不是空文件')

  const css = await get('/style.css')
  ok((css.headers.get('content-type') || '').includes('text/css'), 'css 的 content-type 对')

  /* 白名单之外一律 404 —— 顺带就没有目录穿越这回事 */
  for (const p of ['/../package.json', '/../../etc/passwd', '/public/app.js']) {
    eq((await get(p)).status, 404, `白名单外的 ${p} → 404`)
  }
}

/* ---------------- 9. 武器三态：认不出这把武器 ≠ 没装备武器 ---------------- */
/*
 * 真实案例：奥黛塔拿的 11438，miao 和 i18n 表都还没收录，但 enka 照样给了
 * level/promote/affix —— 说明**是装备着的**。早先出口用 `name || '无武器'` 兜底，
 * 把它报成「无武器」，明细页还会因为 `if (weapon.name)` 整张武器卡消失。
 *
 * 夹具刻意用一个**不存在的 itemId**（11999），不用真实的 11438：那是真武器的 id，
 * 将来元数据一收录，这条测试就会莫名其妙变红。这里要的是「查不到」这个性质本身。
 */
console.log('\n=== 9. 武器三态 ===')
{
  /* 每个用例都拿一份**真响应**改一处。`raw` 用 EnkaPayload 标注：
     `REAL` 是 JSON.parse 出来的 any，标注之后改字段才有人管形状。 */
  interface WeaponCase {
    label: string
    expect: string
    edit: (raw: EnkaPayload) => void
  }
  const CASES: WeaponCase[] = [
    {
      label: '元数据不认识这把（itemId 换成查不到的）',
      expect: 'unknown',
      edit: (raw) => { weaponEntry(raw).itemId = 11999 }
    },
    {
      label: '角色压根没装备武器（把武器那条整个摘掉）',
      expect: 'none',
      edit: (raw) => {
        const a = raw.avatarInfoList!.find(x => x.avatarId === 10000016)!
        a.equipList = a.equipList!.filter(e => e.flat?.itemType !== 'ITEM_WEAPON')
      }
    },
    {
      label: '对照组（原样）',
      expect: 'ok',
      edit: () => {}
    }
  ]

  /* 迪卢克那条武器装备（夹具里必然有 —— 上面两个用例要改的就是它） */
  function weaponEntry (raw: EnkaPayload) {
    return raw.avatarInfoList!.find(x => x.avatarId === 10000016)!
      .equipList!.find(e => e.flat?.itemType === 'ITEM_WEAPON')!
  }

  for (const c of CASES) {
    const raw = structuredClone(REAL) as EnkaPayload
    c.edit(raw)
    const sum = ingestPayload(raw, { source: 'enka' })
    const a = await startServer({ port: 0, dbFile: ':memory:' })
    repo.saveFetch(a.db, { ...sum, stamp: '2026-09-13T00:00:00.000Z' })
    const view = await readJson(await fetch(a.url + `/api/uid/${sum.player.uid}`))
    const w = view.data.avatars.find((x: any) => x.avatarId === 10000016).weapon
    a.server.close()

    eq(w.state, c.expect, `state = ${c.expect}（${c.label}）`)
    if (c.expect === 'ok') {
      eq(w.name, '狼的末路', '  对照组照旧拿到名字')
      continue
    }
    /* 名字是空串：文案由前端按 state 选（「未知武器」/「无武器」），后端不写死 */
    eq(w.name, '', '  名字留空，不写死文案')
    if (c.expect === 'unknown') {
      ok(/^\/assets\/common\/item\/atk-[a-z]+\.webp$/.test(w.icon || ''),
        `  退回**武器类型**通用图（${String(w.icon).split('/').pop()}）`)
      /* 关键：等级/精炼是 enka 给的，跟元数据认不认识无关，必须留 */
      eq(w.level, 90, '  等级留着（证明是「装备着」而不是「没装备」）')
      eq(w.affix, 1 + 1, '  精炼留着')
      eq(w.attrs, {}, '  属性/描述为空（元数据里确实没有）')
      eq(w.desc, '', '')
    } else {
      eq(w.icon, null, '  真没装备时不给图（给张类型图反倒像有武器）')
      eq(w.level, 1, '  等级回落默认 1')
    }
  }
}

/* ---------------- 10. 限流 ---------------- */
/*
 * 公网一开放，/api/fetch 就是个「拿你的服务去打 enka」的口子，上游一限流全站 502，
 * 所以必须有闸。这里钉死三件事：
 *   ① 限的是**每个 IP**，不是一个 IP 超了就全站锁死；
 *   ② 还有一档**全局**的（换 IP 绕不过去），那是替 enka 上游挡的；
 *   ③ 默认**不认转发头** —— 那只是个请求头，谁都能伪造，认了等于没限。
 *
 * 测试一律注入假 enka（fetchImpl），不联网；档位用小数字，不真等一分钟。
 */
console.log('\n=== 10. 限流 ===')
{
  const fakeFetch = async (uid: number | string): Promise<unknown> => ({ ...REAL, uid })
  const post = (url: string, uid: number, headers: Record<string, string> = {}): Promise<Response> => fetch(url + '/api/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ uid })
  })

  /* ① 每 IP 一档 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch, trustProxy: true,
      rateLimit: { fetch: { limit: 2, windowMs: 60_000 }, fetchAll: { limit: 100, windowMs: 60_000 } }
    })
    const ip1 = { 'X-Forwarded-For': '203.0.113.7' }
    eq((await post(a.url, UID, ip1)).status, 200, '  每 IP：第 1 次放行')
    eq((await post(a.url, UID, ip1)).status, 200, '  第 2 次放行')
    const r3 = await post(a.url, UID, ip1)
    eq(r3.status, 429, '  第 3 次被拦（上限 2）')
    eq((await readJson(r3)).error.code, 'rate_limited', '  错误码 rate_limited')
    ok(Number(r3.headers.get('retry-after')) >= 1,
      `  带 Retry-After 头（${r3.headers.get('retry-after')} 秒）`)
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.8' })).status, 200,
      '  换个 IP 不受牵连（不是一超全站锁死）')
    a.server.close()
  }

  /* ② 全局一档：换 IP 也绕不过去 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch, trustProxy: true,
      rateLimit: { fetch: { limit: 10, windowMs: 60_000 }, fetchAll: { limit: 2, windowMs: 60_000 } }
    })
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.11' })).status, 200, '  全局：IP A 放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.12' })).status, 200, '  IP B 放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.13' })).status, 429,
      '  IP C 被拦（全局上限 2，换 IP 绕不开）')
    a.server.close()
  }

  /* ③ 默认不认转发头：伪造 IP 无效 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch,
      rateLimit: { fetch: { limit: 1, windowMs: 60_000 }, fetchAll: { limit: 100, windowMs: 60_000 } }
    })
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.20' })).status, 200,
      '  不认转发头：第 1 次放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.21' })).status, 429,
      '  换个伪造 IP 照样被拦（只认 TCP 对端）')
    a.server.close()
  }

  /* ④ 读接口另有一档；health 和静态页故意不限 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 2, windowMs: 60_000 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = (p: string): Promise<Response> => fetch(a.url + p, { headers: { 'X-Forwarded-For': '203.0.113.30' } })
    eq((await g(`/api/uid/${UID}`)).status, 200, '  读接口：第 1 次放行')
    eq((await g(`/api/uid/${UID}`)).status, 200, '  第 2 次放行')
    eq((await g(`/api/uid/${UID}`)).status, 429, '  第 3 次被拦（读上限 2）')
    eq((await g('/api/health')).status, 200, '  /api/health 不限（探活被拦会误报故障）')
    eq((await g('/')).status, 200, '  静态页不限')
    a.server.close()
  }

  /* ⑤ 窗口过了要能自己恢复 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 1, windowMs: 300 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = () => fetch(a.url + `/api/uid/${UID}`, { headers: { 'X-Forwarded-For': '203.0.113.40' } })
    eq((await g()).status, 200, '  短窗口：第 1 次放行')
    eq((await g()).status, 429, '  紧接着再来 → 429')
    await new Promise(r => setTimeout(r, 400))
    eq((await g()).status, 200, '  等过窗口 → 恢复（令牌桶在补）')
    a.server.close()
  }

  /* ⑥ 配额用完**不必等整个窗口** —— 这条专门钉「令牌桶 vs 固定窗口」的语义差。
        桶里没令牌时，能刷新的时刻是「补回 1 个」而不是「窗口翻页」：
        窗口 1000ms 补 2 个 → 500ms 补 1 个。所以「等 700ms」必须已经能刷。
        若哪天换回 limiter 的 RateLimiter（令牌桶之上还有一层窗口计数），这里会红。 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 2, windowMs: 1000 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = () => fetch(a.url + `/api/uid/${UID}`, { headers: { 'X-Forwarded-For': '203.0.113.50' } })
    eq((await g()).status, 200, '  打满前：第 1 次放行')
    eq((await g()).status, 200, '  第 2 次放行（配额刚好用尽）')
    const r3 = await g()
    eq(r3.status, 429, '  第 3 次被拦')
    ok(Number(r3.headers.get('retry-after')) <= 2,
      `  Retry-After 是「补 1 个」而不是整窗口（${r3.headers.get('retry-after')} 秒）`)
    await new Promise(r => setTimeout(r, 700))
    eq((await g()).status, 200, '  等 700ms（> 补充间隔、< 窗口）→ 已恢复，没被窗口锁死')
    a.server.close()
  }
}

/* ---------------- 收尾 ---------------- */

app.server.close()

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)
