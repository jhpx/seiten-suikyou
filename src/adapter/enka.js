/*
 * 按 uid 从 enka 取原始数据
 *
 * 只负责「把 JSON 拿回来」，字段怎么翻译是 ingest 的事。
 * 注意两点：
 *   1. enka 用 HTTP 状态码表达业务错误，得分开解释，不然用户只看到一句「HTTP 424」。
 *   2. 响应里的 ttl 是 enka 给的缓存秒数，调用方应该尊重它，别硬刷。
 */
const DEFAULT_UA = 'seiten-suikyou/0.1 (artifact score viewer)'

export async function fetchEnka (uid, { userAgent, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(`https://enka.network/api/uid/${uid}`, {
      headers: { 'User-Agent': userAgent || DEFAULT_UA },
      signal: ctl.signal
    })
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`enka: 请求超时（${timeoutMs}ms）`)
    throw new Error(`enka: 请求失败 —— ${e.message}`)
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 400) throw new Error('enka: UID 格式不对')
  if (res.status === 404) throw new Error('enka: 查不到这个 UID')
  if (res.status === 424) throw new Error('enka: 该玩家的角色详情未公开（需要在游戏资料页开启角色展柜）')
  if (res.status === 429) throw new Error('enka: 请求太频繁，稍后再试')
  if (res.status === 500) throw new Error('enka: 服务端错误')
  if (res.status === 503) throw new Error('enka: 游戏维护中')
  if (!res.ok) throw new Error(`enka: HTTP ${res.status}`)

  return await res.json()
}
