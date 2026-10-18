/*
 * 按 uid 从上游取原始数据 —— 只负责「把 JSON 拿回来」，字段怎么翻译是 enka-account.ts 的事。
 *
 * 一组源，**同时打，谁先成功用谁**（hedged request）：上游在国内不稳，两条线的耗时曲线叠不起来，
 * 并行的总耗时是 min(两源) —— 代价是每次打扰两个上游，量由限流挡着。
 *
 * ⚠️ 424 在两个源上语义不同（enka = 玩家没开展柜，microgg = 它自己回源失败），所以**有一个源成功
 *    就用它，全失败才谈错误**；只有「所有源都是同一个非 429 的 4xx」才收敛成一句业务文案（见 summarize）。
 *    429 例外是因为它说的是「这个源现在忙」，不是对这条请求的答复。
 * ⚠️ 错误信息**不挂源名当硬前缀** —— 那是把个别源的故障说成全局结论。
 *
 * 可调项：ENKA_SOURCE=microgg 只打某个源（排查用）、ENKA_TIMEOUT_MS=8000 改超时
 * （源表、超时、UA 的默认值都在 `common/config.ts`）。
 * 响应里的 ttl 是上游给的缓存秒数，调用方应该尊重，别硬刷。
 */

/* 本文件的返回值就是「enka 原始响应」= 领域层那份形状契约（纯类型，剥类型后不留运行时依赖） */
import type { EnkaPayload } from '../domain/enka.ts'
import { DEFAULT_TIMEOUT_MS, DEFAULT_UA, SOURCES } from '../common/config.ts'

/* 上游用 HTTP 状态码表达业务错误，不翻译用户只看到一句「HTTP 424」。
   424 的文案取中性说法，不替用户下结论（分不清是没开展柜还是上游回源失败）。 */
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
 * 常见两个：UND_ERR_CONNECT_TIMEOUT（TCP 就连不上）、UND_ERR_HEADERS_TIMEOUT（连上了但对面不回）。
 * 取不到就退回 e.message —— 别让错误信息变成字符串 "undefined"。
 */
function pickCause (e: unknown): string {
  const err = e as { cause?: { code?: string; message?: string }; message?: string }
  const cause = err.cause
  if (!cause) return err.message ?? ''
  return cause.code ? `${cause.code}：${cause.message}` : (cause.message || err.message || '')
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

/* 试一个源。失败时抛出的 Error 带 source（哪个源）与 status（上游状态码；网络失败没有）。 */
async function trySource (
  source: { name: string; base: string },
  uid: number | string,
  { userAgent, timeoutMs, fetchImpl }: FetchEnkaOpts & { timeoutMs: number }
): Promise<EnkaPayload> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await (fetchImpl || fetch)(source.base + uid, {
      headers: { 'User-Agent': userAgent || DEFAULT_UA },
      signal: ctl.signal
    })
  } catch (e) {
    const name = (e as { name?: string })?.name
    const msg = name === 'AbortError' ? `超时（${timeoutMs}ms）` : `连不上 —— ${pickCause(e)}`
    throw Object.assign(new Error(msg), { source: source.name })
  } finally {
    /* ⚠️ 只护到响应头 —— clearTimeout 跑在 res.json() 之前，body 读取不受保护 */
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw Object.assign(new Error(ERRORS[res.status] || `HTTP ${res.status}`),
      { source: source.name, status: res.status })
  }
  /* 上游回的就是 enka 原始响应；里面到底有没有 playerInfo 由 ingest 校验（缺了会抛），
     这里只是把「我们拿的是哪份形状」写出来。 */
  return (await res.json()) as EnkaPayload
}

/* 全失败时说一句能直接看懂的话。所有源都回同一个 4xx（都没开展柜 / 都没这个人）→ 那是业务结论，
   报一句就够；其余情况逐个源列原因：只说「拿不到数据」等于把排查成本转嫁给下一个人。 */
function summarize (sources: Array<{ name: string }>, fails: SourceError[]): string {
  const status = fails[0].status
  if (status && status < 500 && status !== 429 && fails.every(f => f.status === status)) return fails[0].message
  const detail = sources.map((s, i) => `${s.name}：${fails[i].message}`).join('；')
  return sources.length > 1 ? `所有上游都拿不到数据 —— ${detail}` : detail
}

/**
 * 同时打所有源，返回最先成功那个的数据。
 * `opts.timeoutMs` 覆盖超时（不传就用 DEFAULT_TIMEOUT_MS）；`opts.source` 只打某一个源；
 * `opts.fetchImpl` 替换底层 fetch（测试用）。
 */
export async function fetchEnka (uid: number | string, opts: FetchEnkaOpts = {}): Promise<EnkaPayload> {
  const envTimeout = Number(process.env.ENKA_TIMEOUT_MS) || opts.timeoutMs || 0
  const only = process.env.ENKA_SOURCE || opts.source
  const sources = only ? SOURCES.filter(s => s.name === only) : SOURCES
  if (!sources.length) {
    throw new Error(`没有叫「${only}」的源（可选：${SOURCES.map(s => s.name).join(' / ')}）`)
  }
  const timeoutMs = envTimeout || DEFAULT_TIMEOUT_MS

  return await new Promise<EnkaPayload>((resolve, reject) => {
    /* 失败原因按索引存：若改成「谁先失败谁先进数组」，错误信息的次序每次都不一样 */
    const fails: SourceError[] = new Array(sources.length)
    let remaining = sources.length
    sources.forEach((source, i) => {
      /* 成功就 resolve，先到先得；失败的照常记账，等最后一个也失败才 reject。
         用 then 的二参接住 rejection，避免「已经 resolve 之后剩下的 promise 报 unhandled」。 */
      trySource(source, uid, { ...opts, timeoutMs }).then(resolve, (e) => {
        fails[i] = e
        if (--remaining === 0) reject(new Error(summarize(sources, fails)))
      })
    })
  })
}
