/*
 * 上游抓取测试：多源并行、失败判定、错误信息、状态页解析。
 * 全程用假 fetch，不联网；断言只在失败时打印。
 */

import { fetchEnka } from '../src/gateway/enka/enka.fetch.ts'
import { parseEnkaStatus } from '../src/gateway/enka/enka.status.ts'

let pass = 0, fail = 0
function eq (actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; return }
  fail++
  console.log(`[FAIL] ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`)
}
function ok (cond: unknown, label: string): void {
  if (cond) { pass++; return }
  fail++
  console.log(`[FAIL] ${label}`)
}

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
})
/* Node fetch 网络失败的真实形状：外层只有 `fetch failed`，原因在 cause.code 里 */
const netFail = (code = 'UND_ERR_CONNECT_TIMEOUT') =>
  Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error('Connect Timeout Error'), { code }) })

/** 一个假响应的「计划」：命中哪个源、回什么、要不要慢一点 / 抛出来 */
interface Plan {
  match: string
  body?: unknown
  status?: number
  delay?: number
  throw?: unknown
}

/** 造一个假 fetch，顺便记下每个源被打了几次、谁先回来（全靠它区分并行和串行）。
    真的 Response 有一大堆字段，我们只用到 url / ok / status / json —— 所以断言成 `typeof fetch`。 */
function spy (plan: Plan[]): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    const hit = plan.find(p => url.includes(p.match))
    if (!hit) throw new Error('未预期的 URL：' + url)
    /* delay 用来造「两个源都成功但快慢不同」——并行下决定谁赢 */
    if (hit.delay) await new Promise(r => setTimeout(r, hit.delay))
    if (hit.throw) throw hit.throw
    return jsonRes(hit.body, hit.status)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/**
 * 跑一段「应当抛错」的代码，把人话错误取回来。
 * ⚠️ 没抛错时返回**空串**（不是 null）：全部调用点紧接着就 `.includes(...)`，
 *    返回 null 会让测试以 TypeError 崩掉，反而不如让它落在一条正常的断言失败上。
 */
async function messageOf (fn: () => unknown): Promise<string> {
  try { await fn(); return '' } catch (e) { return e instanceof Error ? e.message : String(e) }
}

/* ---------------- 1. 并行：谁先成功用谁 ---------------- */
console.log('=== 1. 并行打所有源，谁先成功用谁 ===')

{
  const { calls, fetchImpl } = spy([
    { match: 'microgg', body: { playerInfo: { nickname: '镜像' } } },
    { match: 'enka', body: { playerInfo: { nickname: '官方' } }, delay: 50 }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo?.nickname, '镜像', '热缓存时 microgg 先回来就用它（0.35s 那 10 倍优势不能丢）')
  eq(calls.length, 2, '两个源是同时打的，不是打完一个再打下一个')
}

{
  /* 一个源慢、另一个源先回来时，用先回来的那个 */
  const { fetchImpl } = spy([
    { match: 'microgg', body: { playerInfo: { nickname: '镜像' } }, delay: 200 },
    { match: 'enka', body: { playerInfo: { nickname: '官方' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo?.nickname, '官方', 'microgg 慢时 enka 顶上，不干等它')
}

/* ---------------- 2. 一个源挂了另一个顶上 ---------------- */
console.log('\n=== 2. 一个源报错时，另一个源照样救得回来 ===')

{
  const { fetchImpl } = spy([
    { match: 'microgg', throw: netFail() },
    { match: 'enka', body: { playerInfo: { nickname: '兜底成功' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo?.nickname, '兜底成功', 'microgg 连不上时，enka 救回来')
}

{
  /* microgg 的 424 表示它自己回源失败，不能当业务结论拦住另一个源 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 424, body: {} },
    { match: 'enka', body: { playerInfo: { nickname: 'enka有数据' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo?.nickname, 'enka有数据', 'microgg 的 424 不当业务结论，enka 有数据就用 enka 的')
}

{
  /* 限流是「这个源现在忙」，不是对这条请求的答复 —— 同样不该拦住兜底源 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 429, body: {} },
    { match: 'enka', body: { playerInfo: { nickname: 'ok' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo?.nickname, 'ok', 'microgg 限流（429）时 enka 顶上')
}

/* ---------------- 3. 全失败时才谈错误 ---------------- */
console.log('\n=== 3. 全失败时的错误信息 ===')

{
  /* 两个源都说没这个人 —— 那才是业务结论 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 404, body: {} },
    { match: 'enka', status: 404, body: {} }
  ])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('查不到'), '两个源都 404 → 翻译成人话')
  ok(!msg.includes('所有上游'), '业务结论不套「所有上游都拿不到数据」的壳')
}

{
  /* 两个源都说没开展柜 —— 用户需要看到「去游戏资料页开一下」这个动作 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 424, body: {} },
    { match: 'enka', status: 424, body: {} }
  ])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('未公开'), '两个源都 424 → 翻译成人话（不是「HTTP 424」）')
}

{
  /* 混合失败（一个网络挂、一个业务答复）时，每个源各自的原因都得在信息里 */
  const { fetchImpl } = spy([
    { match: 'microgg', throw: netFail('UND_ERR_CONNECT_TIMEOUT') },
    { match: 'enka', throw: netFail('UND_ERR_HEADERS_TIMEOUT') }
  ])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('microgg') && msg.includes('enka'), '两个源都被点名')
  ok(msg.includes('UND_ERR_CONNECT_TIMEOUT') && msg.includes('UND_ERR_HEADERS_TIMEOUT'),
    '每个源各自的原因都在（不是一句 fetch failed）')
  /* 老实现的前缀是硬编码的模块名 `enka:`，microgg 回 429 时也报 `enka: 请求太频繁`，
     排查时能把人带沟里 —— 前缀必须是源名，不能挂死一个源 */
  ok(!msg.startsWith('enka:'), '错误信息不挂死「enka:」前缀')
}

{
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const { fetchImpl } = spy([
    { match: 'microgg', throw: abort },
    { match: 'enka', throw: abort }
  ])
  /* 故意用 4321 而不是 8000：撞上默认值就分不清「覆盖生效」还是「本来就这个数」 */
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl, timeoutMs: 4321 }))
  ok(msg.includes('超时') && msg.includes('4321'), '超时说清了等多久')
}

{
  /* 不传 timeoutMs 时用默认那份 —— 并行下它是「最坏等多久」，慢的源没人等它 */
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const { fetchImpl } = spy([
    { match: 'microgg', throw: abort },
    { match: 'enka', throw: abort }
  ])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('15000'), '默认超时 15000ms（microgg 冷回源实测约 11s、enka 抖动上限约 4.5s，留余量让冷号也能赢一次）')
}

/* ---------------- 4. 排查用的手动指定源 ---------------- */
console.log('\n=== 4. ENKA_SOURCE 指定单源 ===')

{
  const { calls, fetchImpl } = spy([{ match: 'enka', body: { playerInfo: { nickname: 'e' } } }])
  process.env.ENKA_SOURCE = 'enka'
  try {
    const out = await fetchEnka(101242308, { fetchImpl })
    eq(out.playerInfo?.nickname, 'e', '只打指定的源')
    eq(calls.length, 1, '没去打 microgg（并行也挡在选源这一步）')
  } finally { delete process.env.ENKA_SOURCE }

  process.env.ENKA_SOURCE = '不存在的源'
  try {
    const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
    ok(msg.includes('microgg') && msg.includes('enka'), '写错源名时把可选值列出来')
  } finally { delete process.env.ENKA_SOURCE }
}

/* ---------------- 5. status.enka.network 解析（纯函数，不联网） ---------------- */
console.log('\n=== 5. 状态页解析：区服配色 + MicroGG 两服 ===')

{
  /* 仿状态页的服务端渲染文本：官方 6 区一句、MicroGG 镜像两服一句 */
  const color = (c: string, name: string) => `<b style="color: ${c}">${name}</b>`
  const html = `<p>Enka.Network is <b class="green">up.</b></p>
    <p>For Genshin, ${color('#e67e22', 'euro')}, ${color('#5bb4ef', 'usa')}, ${color('#e9c223', 'asia')},
       ${color('#75cd69', 'cht')}, ${color('#e74c3c', 'china')} seem to be up,
       while ${color('#ff6f9e', 'bilibili')} is <span class="red">dead</span>.</p>
    <p>${color('#e74c3c', 'china')} is up, while ${color('#ff6f9e', 'bilibili')} is
       <span class="red">dead</span> <span>(profile.microgg.cn)</span>.</p>`
  const p = parseEnkaStatus(html)

  eq(p.regions.length, 6, '官方 6 个区服全解出来')
  eq(p.regions[0], { name: 'euro', status: 'up', color: '#e67e22' }, 'euro 在线且抄到橙')
  eq(p.regions[5], { name: 'bilibili', status: 'down', color: '#ff6f9e' }, 'bilibili 离线且抄到粉')
  eq(p.regions.map(r => r.color), ['#e67e22', '#5bb4ef', '#e9c223', '#75cd69', '#e74c3c', '#ff6f9e'], '6 区各自不同身份色')
  /* MicroGG 段是单独一句，别被前面 For Genshin 那句带偏 */
  eq(p.microggServers.map(s => [s.name, s.status]), [['china', 'up'], ['bilibili', 'down']], 'MicroGG 两服 china 在线 / bilibili 离线')
  eq(p.microggServers.every(s => /^#[0-9a-fA-F]{6}$/.test(s.color)), true, 'MicroGG 两服也带身份色')

  /* 页面没有 MicroGG 段时，两服仍以 unknown 占位，不能凭空消失 */
  const plain = parseEnkaStatus('<p>Enka.Network is up.</p>')
  eq(plain.microggServers.map(s => s.status), ['unknown', 'unknown'], '缺 MicroGG 段时两服兜底 unknown')
}

{
  /* 并列主语共用后面的谓语，两服都要跟着同一个状态词判 */
  const color = (c: string, name: string) => `<b style="color: ${c}">${name}</b>`
  const html = `<p>For Genshin, ${color('#e67e22', 'euro')}, ${color('#5bb4ef', 'usa')},
      ${color('#e9c223', 'asia')}, ${color('#75cd69', 'cht')}, ${color('#e74c3c', 'china')},
      ${color('#ff6f9e', 'bilibili')} seem to be up.</p>
    <p>${color('#e74c3c', 'china')}, ${color('#ff6f9e', 'bilibili')} are
      <span class="red">dead</span> <span>(profile.microgg.cn)</span>.</p>`
  const p = parseEnkaStatus(html)
  eq(p.microggServers.map(s => s.status), ['down', 'down'], 'china, bilibili are dead → 两服都判挂（不是只挂最后一个）')
  eq(p.regions.map(r => r.status), ['up', 'up', 'up', 'up', 'up', 'up'], '同一页的官方 6 区仍全在线')
  eq(p.regions.map(r => r.name), ['euro', 'usa', 'asia', 'cht', 'china', 'bilibili'], '区服顺序照页面原样')
}

{
  /* 措辞变化不影响区服解析 */
  const color = (c: string, name: string) => `<b style="color: ${c}">${name}</b>`
  const html = `<p>For Genshin, ${color('#e67e22', 'euro')}, ${color('#5bb4ef', 'usa')} are dead.</p>`
  const p = parseEnkaStatus(html)
  eq(p.regions.map(r => r.status), ['down', 'down'], '全挂的措辞也能解出区服与状态')
}

console.log(fail > 0
  ? `\n[FAIL] 上游抓取测试有 ${fail} 项不通过（通过 ${pass}）`
  : `\n[OK] 上游抓取正常：并行取最快、单源故障不拦住兜底、失败信息带原因（${pass} 项）`)
process.exit(fail > 0 ? 1 : 0)
