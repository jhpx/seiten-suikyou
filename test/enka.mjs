/*
 * 上游抓取测试 —— 「数据怎么拿回来」这一跳的守门人
 *
 * 和另外几个测试的分工：
 *   enka（本文件）  管「从上游拿到 JSON」：多源并行、什么时候算失败、失败信息够不够看
 *   pipeline       管「拿到之后」：ingest / repo / materialize 有没有把数据搞坏
 *   server         管「接口怎么给」：路由 / 静态文件 / 错误形状
 *   cli            管「命令行跑起来是什么样」
 *
 * 为什么不联网：这里全用假 fetch。真联网会把测试变成「看今天网络通不通」——
 * 上游一抖整套 npm test 就红，而那种红不带任何信息量。真联网验证是人肉做的一次性动作。
 *
 * 断言同样只在失败时打印。
 */
import { fetchEnka } from '../src/adapter/enka.js'

let pass = 0, fail = 0
function eq (actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; return }
  fail++
  console.log(`[FAIL] ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`)
}
function ok (cond, label) {
  if (cond) { pass++; return }
  fail++
  console.log(`[FAIL] ${label}`)
}

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
})
/* Node fetch 网络失败的真实形状：外层只有 `fetch failed`，原因在 cause.code 里 */
const netFail = (code = 'UND_ERR_CONNECT_TIMEOUT') =>
  Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error('Connect Timeout Error'), { code }) })

/** 造一个假 fetch，顺便记下每个源被打了几次、谁先回来（全靠它区分并行和串行） */
function spy (plan) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const hit = plan.find(p => url.includes(p.match))
    if (!hit) throw new Error('未预期的 URL：' + url)
    /* delay 用来造「两个源都成功但快慢不同」——并行下决定谁赢 */
    if (hit.delay) await new Promise(r => setTimeout(r, hit.delay))
    if (hit.throw) throw hit.throw
    return jsonRes(hit.body, hit.status)
  }
  return { calls, fetchImpl }
}

async function messageOf (fn) {
  try { await fn(); return null } catch (e) { return e.message }
}

/* ---------------- 1. 并行：谁先成功用谁 ---------------- */
console.log('=== 1. 并行打所有源，谁先成功用谁 ===')

{
  const { calls, fetchImpl } = spy([
    { match: 'microgg', body: { playerInfo: { nickname: '镜像' } } },
    { match: 'enka', body: { playerInfo: { nickname: '官方' } }, delay: 50 }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, '镜像', '热缓存时 microgg 先回来就用它（0.35s 那 10 倍优势不能丢）')
  eq(calls.length, 2, '两个源是同时打的，不是打完一个再打下一个')
}

{
  /* 这就是修「3 秒超时把 microgg 砍掉后只剩慢路」的场景：
     microgg 要回源米游社（实测 6s 起），并行下 enka 先回来，用户不用陪着等 */
  const { fetchImpl } = spy([
    { match: 'microgg', body: { playerInfo: { nickname: '镜像' } }, delay: 200 },
    { match: 'enka', body: { playerInfo: { nickname: '官方' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, '官方', 'microgg 慢时 enka 顶上，不干等它')
}

/* ---------------- 2. 一个源挂了另一个顶上 ---------------- */
console.log('\n=== 2. 一个源报错时，另一个源照样救得回来 ===')

{
  const { fetchImpl } = spy([
    { match: 'microgg', throw: netFail() },
    { match: 'enka', body: { playerInfo: { nickname: '兜底成功' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, '兜底成功', 'microgg 连不上时，enka 救回来')
}

{
  /* ★ 这次修的核心。microgg 的 424 是「它自己回源失败」
     （原文："Can't contact the data service. Either the game servers are down..."），
     不是「玩家没开展柜」——同一时刻 enka 手上往往有数据。
     老规则把 424 当业务结论直接抛，用户明明开了展柜却看到「未公开」。 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 424, body: {} },
    { match: 'enka', body: { playerInfo: { nickname: 'enka有数据' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, 'enka有数据', 'microgg 的 424 不当业务结论，enka 有数据就用 enka 的')
}

{
  /* 限流是「这个源现在忙」，不是对这条请求的答复 —— 同样不该拦住兜底源 */
  const { fetchImpl } = spy([
    { match: 'microgg', status: 429, body: {} },
    { match: 'enka', body: { playerInfo: { nickname: 'ok' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, 'ok', 'microgg 限流（429）时 enka 顶上')
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
  /* 这次踩的坑：老实现只说一句 `fetch failed`，查了 20 分钟才知道是 TCP 连不上。
     混合失败（一个网络挂、一个业务答复）时，每个源各自的原因都得在信息里。 */
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
  ok(msg.includes('8000'), '默认超时 8000ms（microgg 冷回源 6s、enka 上限 4.5s，都得留出赢的机会）')
}

/* ---------------- 4. 排查用的手动指定源 ---------------- */
console.log('\n=== 4. ENKA_SOURCE 指定单源 ===')

{
  const { calls, fetchImpl } = spy([{ match: 'enka', body: { playerInfo: { nickname: 'e' } } }])
  process.env.ENKA_SOURCE = 'enka'
  try {
    const out = await fetchEnka(101242308, { fetchImpl })
    eq(out.playerInfo.nickname, 'e', '只打指定的源')
    eq(calls.length, 1, '没去打 microgg（并行也挡在选源这一步）')
  } finally { delete process.env.ENKA_SOURCE }

  process.env.ENKA_SOURCE = '不存在的源'
  try {
    const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
    ok(msg.includes('microgg') && msg.includes('enka'), '写错源名时把可选值列出来')
  } finally { delete process.env.ENKA_SOURCE }
}

console.log(fail > 0
  ? `\n[FAIL] 上游抓取测试有 ${fail} 项不通过（通过 ${pass}）`
  : `\n[OK] 上游抓取正常：并行取最快、单源故障不拦住兜底、失败信息带原因（${pass} 项）`)
process.exit(fail > 0 ? 1 : 0)
