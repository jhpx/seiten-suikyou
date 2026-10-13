/*
 * 限流 —— 闸门整体在这里，主服务只问一句「这次放不放行」
 *
 * 对外只有一个入口 createRateGate()：
 *   const gate = createRateGate({ trustProxy, rules: rateLimit })   // rules 传 false = 整个关掉
 *   const wait = gate.check(req, pathname)                          // 放行 null；拦下 = 还要等几秒
 * 于是主服务里限流只占三行，档位、取 IP、429 该等多久都不用它操心。
 *
 * 为什么用令牌桶而不是「整分钟清零」：固定窗口在边界上能翻倍（第 59 秒打满、第 61 秒又能打满，
 * 两秒里放了两次配额）。令牌桶匀速补充、没这个缝，同时允许短时突发（桶满时可一次取光），
 * 对「玩家连着换几次展柜再刷新」更友好。
 *
 * ⚠️ **用 TokenBucket，不要用同库的 RateLimiter**（2026-10-11 踩出来的）。RateLimiter 名字像令牌桶，
 *    其实是「令牌桶 + 每窗口次数上限」两层（它自己的类注释就写着 "a token bucket plus an additional
 *    check to limit how many tokens we can remove each interval"）—— 窗口里打满 N 次后，哪怕令牌桶
 *    3 秒就补回 1 个，也得干等整个窗口翻页：实测桶将空时 getWaitTime(1) 返回 59997ms。我们只要令牌桶。
 *
 * 依赖策略：`limiter` 零传递依赖、103KB、原生 ESM，比自己写补充速率与边界取整划算（2026-10-08 定）。
 * 库管不了的只有两件事，都在这儿：**按什么分桶**（库一个实例只管一条流，我们要按「IP + 接口类型」
 * 动态开桶）与**桶的回收**（每个来过的 IP 一个桶，不回收就是内存泄漏 —— 有人换着 IP 来能撑爆）。
 *
 * ⚠️ 生效范围只有**单进程**。多实例部署（Serverless、多容器）各数各的，那种场景得换成外部存储（Redis）。
 */
import type { IncomingMessage } from 'node:http'
import { TokenBucket } from 'limiter'

/* ---------------- 档位 ---------------- */

/** 一档限流：`windowMs` 毫秒内最多放行 `limit` 次 */
export interface RateRule { limit: number; windowMs: number }

/** 三档限流的档位（fetch 每 IP / fetchAll 全局 / read 每 IP） */
export interface RateRules { fetch: RateRule; fetchAll: RateRule; read: RateRule }

/*
 * 三档而不是一刀切：
 *   fetch    —— 会联网打 enka。上游有频率限制，打爆了就是全站 502，所以这档最要紧。
 *   fetchAll —— 全局一档，不分 IP。enka 限的是「我们这个出口」，
 *               一百个人各刷 5 次，对上游来说跟一个人刷 500 次没区别。
 *   read     —— 只读本地库，代价低，宽松些；但仍然要设上限，挡住脚本把 uid 扫一遍。
 * 静态文件和 /api/meta、/api/health 故意不限：health 是探活用的，被限住会误报故障。
 *
 * 三档都能用环境变量改（RATE_FETCH / RATE_FETCH_ALL / RATE_READ，填每分钟几次）；
 * 本地调试想彻底关掉就加 --no-rate-limit。
 */
const RATE_DEFAULTS: RateRules = {
  fetch: { limit: 20, windowMs: 60_000 },
  fetchAll: { limit: 30, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 }
}

/* 环境变量覆盖默认档位，填了非法值就当没填。overrides 是代码传进来的（测试用），优先级最高。 */
function rateRules (overrides?: Partial<RateRules> | null): RateRules {
  const perMin = (name: string, def: RateRule): RateRule => {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? { limit: n, windowMs: 60_000 } : def
  }
  return {
    fetch: perMin('RATE_FETCH', RATE_DEFAULTS.fetch),
    fetchAll: perMin('RATE_FETCH_ALL', RATE_DEFAULTS.fetchAll),
    read: perMin('RATE_READ', RATE_DEFAULTS.read),
    ...(overrides || {})
  }
}

/* ---------------- 客户端 IP ---------------- */

/*
 * 限流按 IP 分桶，所以「谁算这个 IP」是整套机制的底座。
 *
 * ⚠️ 为什么默认**不信** `X-Forwarded-For`：那只是个请求头，谁都能伪造。服务直接暴露时（默认绑 0.0.0.0
 * 给局域网用）根本没人在前面盖这个头，此时谁伪造一个就能绕过限流 —— 所以默认只看 TCP 对端地址。
 * 挂在反向代理后面时对端永远是代理自己（走 Cloudflare Tunnel 时全是 127.0.0.1），不认头等于没限流；
 * 那种拓扑下由部署方显式开 TRUST_PROXY=1 / --trust-proxy，含义是「我确认前面有代理，而且它会盖掉
 * 客户端自带的那个头」—— Cloudflare 给的 `CF-Connecting-IP` 正是这种头，所以优先认它。
 */
function clientIp (req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf.trim()) return normalizeIp(cf)
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim()) return normalizeIp(xff.split(',')[0])
  }
  return normalizeIp(req.socket?.remoteAddress)
}

/* IPv4 被嵌在 IPv6 里时写作 ::ffff:1.2.3.4 —— 前缀不剥掉的话，
   同一个 IP 会因为连接方式不同被记成两个桶，限流各算各的 */
function normalizeIp (ip: unknown): string {
  const s = String(ip || '').trim().replace(/^::ffff:/, '')
  return s || 'unknown'
}

/* ---------------- 令牌桶 ---------------- */

/* 最多留多少个桶，超了就淘汰最老的一批。防止有人换着 IP 来把内存撑爆 */
const MAX_KEYS = 10000
/* 多久才允许全表扫一次。扫描是 O(n)，不能每次请求都扫 */
const SWEEP_INTERVAL_MS = 60 * 1000
/* 一个桶这么久没请求过就删掉。实际窗口都是分钟级，一小时足够保守 */
const STALE_MS = 60 * 60 * 1000

/** 一个桶：令牌桶本体 + 最后一次被取用的时刻（回收用）。
 *  `now` 时间源只用于判断桶要不要回收 —— 令牌桶自己的走时由 limiter 内部负责，所以测试想验证
 *  「窗口过后恢复」得真等一小会儿（把 windowMs 设成几百毫秒即可）。 */
interface Bucket { limiter: TokenBucket; lastSeen: number }

/** `take()` 的结果：放行 / 拦下（拦下时给「还要等几毫秒」，用来填 Retry-After） */
type TakeResult = { ok: true } | { ok: false; retryAfterMs: number }

function createBuckets ({ now = () => Date.now() }: { now?: () => number } = {}) {
  /* key → { limiter, lastSeen }。Map 保持插入顺序，淘汰时从头删就是删最老的 */
  const buckets = new Map<string, Bucket>()
  let lastSweep = now()

  /** 取桶，没有就按 limit 次 / windowMs 毫秒 造一个 */
  function bucketFor (key: string, limit: number, windowMs: number): Bucket {
    let b = buckets.get(key)
    if (!b) {
      const bucket = new TokenBucket({ bucketSize: limit, tokensPerInterval: limit, interval: windowMs })
      /* TokenBucket 造出来是空桶，得先装满 —— 不装的话每个新 IP 的第一个请求反而被拒 */
      bucket.content = limit
      b = { limiter: bucket, lastSeen: 0 }
      buckets.set(key, b)
    }
    b.lastSeen = now()
    return b
  }

  /* 记一次请求：key 是桶名（谁在干什么，如 `ip:1.2.3.4:fetch`），limit/windowMs 是这一档的配额。
     放行返回 {ok:true}；拦下带「还要多久（毫秒）才能再来」，用来填 Retry-After 头。 */
  function take (key: string, limit: number, windowMs: number): TakeResult {
    const b = bucketFor(key, limit, windowMs)
    if (!b.limiter.tryRemoveTokens(1)) {
      /* getWaitTime(1) 给「还要多久才能取出 1 个」—— 就是补一个令牌的时间，不是等整窗口。
         取超出桶容量的数量它会抛 RangeError；我们只取 1 个、容量至少是 1，正常情况下碰不到，
         兜一下防它把请求打成 500 */
      let wait = windowMs
      try { wait = b.limiter.getWaitTime(1) } catch {}
      sweep()
      return { ok: false, retryAfterMs: Math.max(1, wait) }
    }
    sweep()
    return { ok: true }
  }

  /* 回收长期没动静的桶；表太大时按插入顺序淘汰最老的一成 */
  function sweep () {
    const t = now()
    if (t - lastSweep < SWEEP_INTERVAL_MS && buckets.size <= MAX_KEYS) return
    lastSweep = t
    for (const [k, b] of buckets) {
      if (t - b.lastSeen > STALE_MS) buckets.delete(k)
    }
    if (buckets.size > MAX_KEYS) {
      const drop = Math.ceil(buckets.size * 0.1)
      let i = 0
      for (const k of buckets.keys()) {
        if (i++ >= drop) break
        buckets.delete(k)
      }
    }
  }

  return { take, get size () { return buckets.size } }
}

/* ---------------- 对外：闸门 ---------------- */

/** 造一个限流闸门。`rules` 传 false = 不限流，此时返回 null —— 调用方只要判一下有没有闸门就行。
 *  trustProxy 含义见 clientIp；now 是时间源（测试用）。 */
export interface RateGate {
  rules: RateRules
  check: (req: IncomingMessage, pathname: string) => number | null
  readonly size: number
}

export function createRateGate ({ trustProxy = false, rules, now = () => Date.now() }: {
  trustProxy?: boolean
  rules?: Partial<RateRules> | false
  now?: () => number
} = {}): RateGate | null {
  if (rules === false) return null
  const r = rateRules(rules)
  const buckets = createBuckets({ now })

  /* 记一次，返回「还要等几秒」（填进 Retry-After）；放行返回 0 */
  const hit = (rule: RateRule, key: string): number => {
    const t = buckets.take(key, rule.limit, rule.windowMs)
    return t.ok ? 0 : Math.max(1, Math.ceil(t.retryAfterMs / 1000))
  }

  /* 这次请求放不放行：null = 放行；数字 = 拦下，且还要等这么多秒 */
  function check (req: IncomingMessage, pathname: string): number | null {
    const ip = clientIp(req, trustProxy)
    /* 抓取要连过两档才算过 —— 本 IP 一档、全局一档（保护 enka 上游） */
    if (req.method === 'POST' && pathname === '/api/fetch') {
      return hit(r.fetch, `ip:${ip}:fetch`) || hit(r.fetchAll, 'all:fetch') || null
    }
    if (req.method === 'GET' && (pathname === '/api/uids' || /^\/api\/uid\/\d+$/.test(pathname))) {
      return hit(r.read, `ip:${ip}:read`) || null
    }
    return null
  }

  return { rules: r, check, get size () { return buckets.size } }
}
