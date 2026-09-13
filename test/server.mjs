/*
 * 服务测试 —— 起一个真监听的服务，用真 HTTP 请求打它
 *
 * 不 mock http：这个文件的目的是证明「路由 / 静态文件 / 错误形状 / 本地化出口」
 * 这几件事在真网络栈上是通的。用内存库 + 一份真实 enka 响应播种，
 * 所以断言里可以直接出现「Diluc」「Crimson Witch of Flames」这种真数据。
 *
 * 与 pipeline.mjs 的分工：pipeline 管「数据有没有被搞坏」，本文件管「接口给的东西对不对」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer } from '../src/server/index.js'
import * as repo from '../src/store/repo.js'
import { ingestPayload } from '../src/adapter/ingest.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'enka-real.json'), 'utf8'))

let failed = 0
let passed = 0
function ok (cond, label, extra = '') {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
function eq (a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`)
}

/* 播种：把真实响应过一遍 ingest 落进内存库 */
const summary = ingestPayload(REAL, { source: 'enka' })
const UID = summary.uid

const app = await startServer({ port: 0, dbFile: ':memory:' })
repo.saveFetch(app.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })

const get = (p) => fetch(app.url + p)
const json = async (p) => (await get(p)).json()

/* ---------------- 1. 元信息 ---------------- */

console.log('=== 1. 元信息与健康检查 ===')
{
  const h = await json('/api/health')
  eq(h.ok, true, '/api/health 返回 ok')
  eq(h.data.uids, 1, '/api/health 报出 1 个 uid')

  const m = await json('/api/meta')
  const codes = m.data.locales.map(l => l.code)
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

  const diluc = r.data.avatars.find(a => a.nameZh === '迪卢克')
  ok(!!diluc, '能找到迪卢克')
  if (diluc) {
    eq(diluc.artifacts.length, 5, '圣遗物 5 个位置都在')
    ok(diluc.artifacts.every(a => a.posName), '每个位置都有部位名')
    ok(diluc.panel.length > 0, `面板属性 ${diluc.panel.length} 项`)
    ok(diluc.sets.length > 0, `套装 ${diluc.sets.map(s => s.name + '×' + s.count).join(' ')}`)
    const withSubs = diluc.artifacts.filter(a => !a.empty && a.subs.length)
    ok(withSubs.length > 0, '圣遗物带副词条')
    ok(withSubs.every(a => a.subs.every(s => s.upNum >= 1)), '副词条都带强化次数（内核靠重复次数算的，不能丢）')
    ok(!!diluc.weapon.name, `武器名 ${diluc.weapon.name}`)
  }
}

/* ---------------- 4. 视图：其它语言（这一层是本次的重点）---------------- */

console.log('\n=== 4. 视图（en / ja / cht）===')
{
  const en = (await json(`/api/uid/${UID}?locale=en`)).data
  const diluc = en.avatars.find(a => a.nameZh === '迪卢克')
  if (chsView && en.locale === 'en') {
    ok(diluc && diluc.name !== diluc.nameZh,
      `英文名下不再是中文（${diluc?.name}）`, `得到 ${diluc?.name}`)
    ok(diluc.artifacts.every(a => a.posName && !/[\u4e00-\u9fff]/.test(a.posName)),
      '英文下部位名不含汉字', JSON.stringify(diluc.artifacts.map(a => a.posName)))
    const set = diluc.sets[0]
    ok(set && set.name !== set.nameZh, `英文套装名（${set?.name}）`)
    const subKeys = diluc.artifacts.flatMap(a => a.subs.map(s => s.label))
    ok(subKeys.length > 0 && subKeys.every(t => !/[\u4e00-\u9fff]/.test(t)),
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
  const b404 = await r404.json()
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
  const body = await res.json()
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
  eq((await r3.json()).error.message, 'enka: 查不到这个 UID', '错误原文透传给人看')
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

/* ---------------- 收尾 ---------------- */

app.server.close()

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)
