/*
 * 按 uid 从上游取原始数据 —— 只负责「把 JSON 拿回来」，字段怎么翻译是 ingest 的事。
 *
 * ── 为什么是「一组源」而不是一个 URL
 *
 * enka.network 在国内直连拿不到。实测（2026-09-30）：
 *   enka.network  → 解析到 Cloudflare（172.67.149.137 / 104.21.29.169），
 *                   **TCP 连接阶段就超时**，undici 报 UND_ERR_CONNECT_TIMEOUT，10s 无响应。
 *   microgg 镜像   → 0.28s 返回 57KB 完整数据，且不挑 UA（带自己的 UA / 不带都是 200）。
 *
 * miao 原版早就遇到过，解法在 miao-plugin/config/system/profile_system.js：
 * 那里定义了一组可切换的源 —— miaoApi / enkaApi / mggApi / hutaoApi / homoApi / avocadoApi，
 * 其中 mggApi 就是国内镜像 profile.microgg.cn。config/profile_default.js 的注释还写着
 * 「用 Miao-Plugin 默认 UA 请求国服 UID 时，会默认重定向 enka.network 到 profile.microgg.cn」。
 * —— 但那条路的前提是 **enka.network 连得上**（重定向发生在 HTTP 层），现在连不上，所以得直接打镜像。
 *
 * 我们搬内核时只搬了 components / models / resources / tools，config/ 和 apps/ 留在原地，
 * 这层「多源」机制一起丢了 —— 于是「上游一断，抓取功能整体归零」。这里按同样思路补回来。
 *
 * ── 两个判断原则
 *
 * ① 「拿不到响应」→ 换下一个源；「拿到响应但上游说不行」→ 直接抛。
 *    404 没这个人、424 没开角色展柜，换源结果一模一样，别白打一遍。
 *    ⚠️ 只有 5xx 例外 —— 那是源自己坏了，换源有意义。
 * ② 全部失败时把**每个源各自的原因**拼进错误信息。
 *    只说「fetch failed」等于把排查成本原样转嫁给下一个人。
 *
 * 代理：Node 22 的 fetch **不认** HTTPS_PROXY（NODE_USE_ENV_PROXY 是 Node 24 才有的），
 * 也没有可导入的 undici（只暴露全局 fetch，不暴露 ProxyAgent）。本项目 tools/ 下那几个
 * Python 脚本能挂 socks5h://127.0.0.1:4080，运行时这条路暂时没有 —— 要挂得自己用 node:net
 * 手写 CONNECT 隧道，或引入 proxy-agent（会破 test/arch.mjs 的「依赖只有 lodash」）。
 * 目前靠国内镜像解决，不需要代理。
 *
 * 可调项：ENKA_SOURCE=microgg 只打某个源（排查用）、ENKA_TIMEOUT_MS=8000 改单源超时。
 * 响应里的 ttl 是上游给的缓存秒数，调用方应该尊重，别硬刷。
 */

const SOURCES = [
  /* 国内镜像排前面：实测 0.28s，且不挑 UA */
  { name: 'microgg', base: 'https://profile.microgg.cn/api/uid/' },
  /* 官方源兜底：海外或挂着代理时反而它通 */
  { name: 'enka', base: 'https://enka.network/api/uid/' }
]

const DEFAULT_UA = 'seiten-suikyou/0.1 (artifact score viewer)'
/* 这是**单个源**的超时，不是所有源加起来。镜像正常 0.3s，10s 足够判定它挂了 */
const DEFAULT_TIMEOUT_MS = 10000

/* 上游用 HTTP 状态码表达业务错误，不翻译的话用户只看到一句「HTTP 424」 */
const ERRORS = {
  400: 'UID 格式不对',
  404: '查不到这个 UID',
  424: '该玩家的角色详情未公开（需要在游戏资料页开启角色展柜）',
  429: '请求太频繁，稍后再试',
  500: '服务端错误',
  503: '游戏维护中'
}

/*
 * fetch 失败时真正的原因藏在 e.cause 里，外层只有一句干巴巴的 `fetch failed`。
 * 常见两个：UND_ERR_CONNECT_TIMEOUT（TCP 就连不上，被墙或目标不可达）、
 * UND_ERR_HEADERS_TIMEOUT（连上了但对面不回）。
 * 取不到就退回 e.message —— 别让错误信息变成字符串 "undefined"。
 */
function pickCause (e) {
  const c = e.cause
  if (!c) return e.message
  return c.code ? `${c.code}：${c.message}` : (c.message || e.message)
}

/* 试一个源。抛出的 Error 带 `retryable` —— 告诉上层「换源有没有用」。 */
async function trySource (src, uid, { userAgent, timeoutMs, fetchImpl }) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await (fetchImpl || fetch)(src.base + uid, {
      headers: { 'User-Agent': userAgent || DEFAULT_UA },
      signal: ctl.signal
    })
  } catch (e) {
    const msg = e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : `连不上 —— ${pickCause(e)}`
    throw Object.assign(new Error(msg), { retryable: true, source: src.name })
  } finally {
    clearTimeout(timer)
  }

  if (ERRORS[res.status]) {
    /* 5xx 是源自己的故障，换个源可能就好；其余是上游对这条请求的明确答复，换源没用 */
    throw Object.assign(new Error(ERRORS[res.status]), { retryable: res.status >= 500, source: src.name })
  }
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status >= 500, source: src.name })
  }
  return res.json()
}

/**
 * @param {number|string} uid
 * @param {object}   [opts]
 * @param {string}   [opts.userAgent]
 * @param {number}   [opts.timeoutMs]   单个源的超时（不是所有源加起来）
 * @param {string}   [opts.source]      只打某一个源（排查用），可选值见 SOURCES
 * @param {Function} [opts.fetchImpl]   替换底层 fetch（测试用）
 */
export async function fetchEnka (uid, opts = {}) {
  const timeoutMs = Number(process.env.ENKA_TIMEOUT_MS) || opts.timeoutMs || DEFAULT_TIMEOUT_MS

  const only = process.env.ENKA_SOURCE || opts.source
  const list = only ? SOURCES.filter(s => s.name === only) : SOURCES
  if (!list.length) {
    throw new Error(`enka: 没有叫「${only}」的源（可选：${SOURCES.map(s => s.name).join(' / ')}）`)
  }

  /* 源名只在多源时报 —— 单源时报了会变成「enka: enka: 超时」（源名恰好也叫 enka） */
  const tag = (e) => (list.length > 1 ? `${e.source}：${e.message}` : e.message)

  const fails = []
  for (const src of list) {
    try {
      return await trySource(src, uid, { ...opts, timeoutMs })
    } catch (e) {
      /* 上游已经给了明确答复（没这个人 / 没开展柜），别再打扰别的源 */
      if (!e.retryable) throw new Error(`enka: ${e.message}`)
      fails.push(tag(e))
    }
  }
  const detail = list.length > 1 ? `所有上游都拿不到数据 —— ${fails.join('；')}` : fails.join('；')
  throw new Error(`enka: ${detail}`)
}
