/*
 * 按 uid 从上游取原始数据 —— 只负责「把 JSON 拿回来」，字段怎么翻译是 ingest 的事。
 *
 * ── 为什么是「一组源」而且**同时打**
 *
 * enka.network 在国内曾经直连拿不到。实测（2026-09-30）：它解析到 Cloudflare
 * （172.67.149.137 / 104.21.29.169），**TCP 连接阶段就超时**，undici 报 UND_ERR_CONNECT_TIMEOUT，
 * 10s 无响应；那时国内镜像 profile.microgg.cn 只要 0.28s 就回 57KB 完整数据。
 *
 * miao 原版早就遇到过，解法在 miao-plugin/config/system/profile_system.js：
 * 那里定义了一组可切换的源 —— miaoApi / enkaApi / mggApi / hutaoApi / homoApi / avocadoApi，
 * 其中 mggApi 就是 profile.microgg.cn。我们搬内核时只搬了 components / models / resources / tools，
 * config/ 和 apps/ 留在原地，这层「多源」机制一起丢了 —— 于是「上游一断，抓取功能整体归零」。
 *
 * 补回来之后先写成**串行**（先打 microgg，不行再打 enka）。实测（2026-10-11）发现这顺序不好使，
 * 因为两个源的耗时曲线叠不起来：
 *   microgg  缓存热 0.35s —— 但它要回源米游社，缓存一过期实测 5.9~6.2s，抖起来 5~10s，
 *            连续请求还会回 429。它的「快」有前提，不是常态。
 *   enka     稳定 2.3~4.5s。而且现在国内能直连了（09-30 那条「TCP 就超时」已经不成立）。
 * 串行只能二选一：等 microgg 就得陪着它偶尔的 6 秒；不等就得按超时砍 —— 砍掉等于把这个源废了
 * （曾经把 microgg 超时压到 3s，结果它次次被砍，看起来「只剩 enka 在干活」）。
 *
 * 所以改成**同时打，谁先成功用谁**（hedged request）：热缓存 microgg 0.35s 赢，
 * 它慢或挂了时 enka 的 2~4s 顶上 —— 总耗时是 min(两源)，不是「第一条路的耗时 + 第二条路的耗时」。
 * 代价是每次请求打扰两个上游；上游都是只读展柜查询，量由服务端限流挡着（见 rate-limit.js）。
 *
 * ── 一个必须说清的取舍
 *
 * 串行版有条规则：「上游明确答复（404 没这个人 / 424 没开展柜）→ 直接抛，别换源」。
 * 并行了这条就不成立，两个源本来就都会被打。这是**故意的**，因为那规则在 microgg 身上是错的：
 * 它回 424 时给的解释是
 *   {"status":424,"detail":"Can't contact the data service. ..."}
 * —— 那是它自己回源失败，不是「玩家没开展柜」，而同一时刻 enka 往往正常返回数据。
 * 按老规则会把 microgg 的临时故障当成业务结论抛给用户，用户明明开了展柜却看到「未公开」。
 * 现在只要有一个源成功就用它，全失败时才谈错误（见 summarize）。
 *
 * 代理：Node 22 的 fetch **不认** HTTPS_PROXY（NODE_USE_ENV_PROXY 是 Node 24 才有的），
 * 也没有可导入的 undici（只暴露全局 fetch，不暴露 ProxyAgent）。要挂得自己用 node:net
 * 手写 CONNECT 隧道，或引入 proxy-agent（会破 test/arch.mjs 的「依赖只有 lodash」）。
 * 目前靠国内镜像解决，不需要代理。
 *
 * 可调项：ENKA_SOURCE=microgg 只打某个源（排查用）、ENKA_TIMEOUT_MS=8000 改超时。
 * 响应里的 ttl 是上游给的缓存秒数，调用方应该尊重，别硬刷。
 */

/* 本文件的返回值就是「enka 原始响应」= 领域层那份形状契约（纯类型，剥类型后不留运行时依赖） */
import type { EnkaPayload } from '../domain/enka.ts'

interface Source { name: string; base: string }
const SOURCES: Source[] = [
  /* 国内镜像：热缓存最快（0.35s），但会回源、会限流 */
  { name: 'microgg', base: 'https://profile.microgg.cn/api/uid/' },
  /* 官方源：稳定 2~4.5s，是并行里「保底的那一票」 */
  { name: 'enka', base: 'https://enka.network/api/uid/' }
]

const DEFAULT_UA = 'seiten-suikyou/0.1 (artifact score viewer)'

/* 并行下这个超时是「最坏等多久」，不是加分项 —— 谁先回来就用谁，慢的那个没人等。
   8s 的依据：microgg 冷回源 6s、enka 抖动上限 4.5s，两边都得留出赢的机会。 */
const DEFAULT_TIMEOUT_MS = 8000

/* 上游用 HTTP 状态码表达业务错误，不翻译的话用户只看到一句「HTTP 424」。
   ⚠️ 424 在两个源上语义不同（enka 是「玩家没开展柜」，microgg 是「它自己回源失败」），
   分不开，所以文案取中性说法，不替用户下结论。 */
const ERRORS: Record<number, string> = {
  400: 'UID 格式不对',
  404: '查不到这个 UID',
  424: '拿不到这个玩家的数据（角色详情未公开，或上游回源失败）',
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
function pickCause (e: unknown): string {
  const err = e as { cause?: { code?: string; message?: string }; message?: string }
  const c = err.cause
  if (!c) return err.message ?? ''
  return c.code ? `${c.code}：${c.message}` : (c.message || err.message || '')
}

/** 一次上游请求的失败：Error 上挂 source（哪个源）与 status（上游状态码；网络失败没有） */
type SourceError = Error & { source: string; status?: number }

export interface FetchEnkaOpts {
  userAgent?: string
  timeoutMs?: number
  /** 只打某一个源（排查用），可选值见 SOURCES */
  source?: string
  /** 替换底层 fetch（测试用） */
  fetchImpl?: typeof fetch
}
type TrySourceOpts = FetchEnkaOpts & { timeoutMs: number }

/* 试一个源。失败时抛出的 Error 带 source（哪个源）和 status（上游给的状态码；网络失败没有）。 */
async function trySource (src: Source, uid: number | string, { userAgent, timeoutMs, fetchImpl }: TrySourceOpts): Promise<EnkaPayload> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await (fetchImpl || fetch)(src.base + uid, {
      headers: { 'User-Agent': userAgent || DEFAULT_UA },
      signal: ctl.signal
    })
  } catch (e) {
    const name = (e as { name?: string })?.name
    const msg = name === 'AbortError' ? `超时（${timeoutMs}ms）` : `连不上 —— ${pickCause(e)}`
    throw Object.assign(new Error(msg), { source: src.name })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw Object.assign(new Error(ERRORS[res.status] || `HTTP ${res.status}`),
      { source: src.name, status: res.status })
  }
  /* 上游回的就是 enka 原始响应；里面到底有没有 playerInfo 由 ingest 校验（缺了会抛），
     这里只是把「我们拿的是哪份形状」写出来。 */
  return (await res.json()) as EnkaPayload
}

/*
 * 全失败时说一句能直接看懂的话。
 * 所有源都回同一个 4xx（都没开展柜 / 都没这个人）→ 那是业务结论，报一句就够 ——
 * 尤其 424，「去游戏资料页开展柜」这个动作得让用户看到，而不是看两个源各骂一句。
 *   429 例外：它是「这个源现在忙」，不是对这条请求的答复，不能当业务结论。
 * 其余情况逐个源列原因 —— 只说「拿不到数据」等于把排查成本原样转嫁给下一个人。
 */
function summarize (list: Source[], fails: SourceError[]): string {
  const st = fails[0].status
  if (st && st < 500 && st !== 429 && fails.every(f => f.status === st)) return fails[0].message
  const detail = list.map((s, i) => `${s.name}：${fails[i].message}`).join('；')
  return list.length > 1 ? `所有上游都拿不到数据 —— ${detail}` : detail
}

/**
 * 同时打所有源，返回最先成功那个的数据。
 *
 * `opts.timeoutMs` 覆盖超时（不传就用 DEFAULT_TIMEOUT_MS）；
 * `opts.source` 只打某一个源（排查用）；`opts.fetchImpl` 替换底层 fetch（测试用）。
 */
export async function fetchEnka (uid: number | string, opts: FetchEnkaOpts = {}): Promise<EnkaPayload> {
  const override = Number(process.env.ENKA_TIMEOUT_MS) || opts.timeoutMs || 0
  const only = process.env.ENKA_SOURCE || opts.source
  const list = only ? SOURCES.filter(s => s.name === only) : SOURCES
  if (!list.length) {
    throw new Error(`没有叫「${only}」的源（可选：${SOURCES.map(s => s.name).join(' / ')}）`)
  }
  const timeoutMs = override || DEFAULT_TIMEOUT_MS

  return await new Promise<EnkaPayload>((resolve, reject) => {
    /* 失败原因按索引存：若改成「谁先失败谁先进数组」，错误信息的次序每次都不一样 */
    const fails: SourceError[] = new Array(list.length)
    let remaining = list.length
    list.forEach((src, i) => {
      /* 成功就 resolve，先到先得；失败的照常记账，等最后一个也失败才 reject。
         用 then 的二参接住 rejection，避免「已经 resolve 之后剩下的 promise 报 unhandled」 */
      trySource(src, uid, { ...opts, timeoutMs }).then(resolve, (e) => {
        fails[i] = e
        if (--remaining === 0) reject(new Error(summarize(list, fails)))
      })
    })
  })
}
