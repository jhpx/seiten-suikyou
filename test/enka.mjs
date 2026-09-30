/*
 * 上游抓取测试 —— 「数据怎么拿回来」这一跳的守门人
 *
 * 和另外几个测试的分工：
 *   enka（本文件）  管「从上游拿到 JSON」：多源顺序、什么时候该换源、失败信息够不够看
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

/** 造一个假 fetch，顺便记下每个源被打了几次 —— fallback 该不该发生全靠它 */
function spy (plan) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const hit = plan.find(p => url.includes(p.match))
    if (!hit) throw new Error('未预期的 URL：' + url)
    if (hit.throw) throw hit.throw
    return jsonRes(hit.body, hit.status)
  }
  return { calls, fetchImpl }
}

async function messageOf (fn) {
  try { await fn(); return null } catch (e) { return e.message }
}

/* ---------------- 1. 源顺序 ---------------- */
console.log('=== 1. 源顺序（国内镜像优先）===')

{
  const { calls, fetchImpl } = spy([{ match: 'microgg', body: { playerInfo: { nickname: '阿空' } } }])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, '阿空', '主源返回的数据原样透传')
  eq(calls.length, 1, '主源成功时不打第二个源')
  ok(calls[0].includes('microgg'), '第一个打的是国内镜像 profile.microgg.cn')
}

/* ---------------- 2. 什么时候该换源 ---------------- */
console.log('\n=== 2. 什么时候该换源 ===')

{
  /* 网络层失败 → 换源 */
  const { calls, fetchImpl } = spy([
    { match: 'microgg', throw: netFail() },
    { match: 'enka', body: { playerInfo: { nickname: '兜底成功' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, '兜底成功', '主源连不上时，第二个源救回来')
  eq(calls.length, 2, '两个源都试了')
}

{
  /* ★ 业务答复 → 不换源。这条最重要：424 是「这个玩家没开展柜」，
     在哪个源上都一样，换源只是白打一次上游。 */
  const { calls, fetchImpl } = spy([{ match: 'microgg', status: 424, body: {} }])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('未公开'), '424 翻译成人话，不是「HTTP 424」')
  eq(calls.length, 1, '424 时只打一次 —— 业务答复换源没用')
}

{
  const { calls, fetchImpl } = spy([{ match: 'microgg', status: 404, body: {} }])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('查不到'), '404 翻译成人话')
  eq(calls.length, 1, '404 时只打一次')
}

{
  /* 5xx 是源自己坏了 —— 这个该换源 */
  const { calls, fetchImpl } = spy([
    { match: 'microgg', status: 502, body: {} },
    { match: 'enka', body: { playerInfo: { nickname: 'ok' } } }
  ])
  const out = await fetchEnka(101242308, { fetchImpl })
  eq(out.playerInfo.nickname, 'ok', '主源 5xx 时换源成功')
  eq(calls.length, 2, '5xx 会换源（那是源自己的故障）')
}

/* ---------------- 3. 失败信息要够看 ---------------- */
console.log('\n=== 3. 失败信息要够看 ===')

{
  /* 这次踩的坑：老实现只说一句 `fetch failed`，查了 20 分钟才知道是 TCP 连不上。
     全部失败时，每个源各自的原因都得在信息里。 */
  const { fetchImpl } = spy([
    { match: 'microgg', throw: netFail('UND_ERR_CONNECT_TIMEOUT') },
    { match: 'enka', throw: netFail('UND_ERR_HEADERS_TIMEOUT') }
  ])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
  ok(msg.includes('microgg') && msg.includes('enka'), '两个源都被点名')
  ok(msg.includes('UND_ERR_CONNECT_TIMEOUT') && msg.includes('UND_ERR_HEADERS_TIMEOUT'),
    '每个源各自的原因都在（不是一句 fetch failed）')
}

{
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const { fetchImpl } = spy([{ match: 'microgg', throw: abort }])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl, source: 'microgg', timeoutMs: 3000 }))
  ok(msg.includes('超时') && msg.includes('3000'), '超时说清了是谁、多久')
}

{
  /* 单源失败时产品前缀不该和源名撞车（实际跑出过 `enka: enka: 超时`）。
     源名只在多源时才需要标 —— 只有一个源时，标了纯属重复。 */
  const { fetchImpl } = spy([{ match: 'enka', throw: netFail() }])
  const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl, source: 'enka' }))
  eq(msg.match(/enka/g).length, 1, '单源失败时「enka」只出现一次（不重复前缀）')
}

/* ---------------- 4. 排查用的手动指定源 ---------------- */
console.log('\n=== 4. ENKA_SOURCE 指定单源 ===')

{
  const { calls, fetchImpl } = spy([{ match: 'enka', body: { playerInfo: { nickname: 'e' } } }])
  process.env.ENKA_SOURCE = 'enka'
  try {
    const out = await fetchEnka(101242308, { fetchImpl })
    eq(out.playerInfo.nickname, 'e', '只打指定的源')
    eq(calls.length, 1, '没去打 microgg')
  } finally { delete process.env.ENKA_SOURCE }

  process.env.ENKA_SOURCE = '不存在的源'
  try {
    const msg = await messageOf(() => fetchEnka(101242308, { fetchImpl }))
    ok(msg.includes('microgg') && msg.includes('enka'), '写错源名时把可选值列出来')
  } finally { delete process.env.ENKA_SOURCE }
}

console.log(fail > 0
  ? `\n[FAIL] 上游抓取测试有 ${fail} 项不通过（通过 ${pass}）`
  : `\n[OK] 上游抓取正常：镜像优先、业务答复不换源、失败信息带原因（${pass} 项）`)
process.exit(fail > 0 ? 1 : 0)
