/*
 * status.enka.network 抓取与解析 —— 主页「数据源是否在线」指示灯的唯一数据源。
 *
 * 为什么不自己探活 enka/microgg：这个官方状态页已经把各区分服（含 MicroGG 镜像节点）
 * 算好了，自己逐个打接口既重复造轮子、又给上游添请求。
 * 后端每 5 分钟拉一次（HEALTH_CHECK_INTERVAL_MS），解析完缓存在内存，前端进页面读一次；
 * 点「刷新」时完全不碰状态查询。
 *
 * 解析策略：只吃服务端渲染的文本/标签，抽两段状态 + 区服配色。
 *   - 「For Genshin, … seem to be up, while … is dead」= Enka 官方 6 区 → regions；
 *   - 「china is up, while bilibili is dead (profile.microgg.cn)」= MicroGG 镜像 2 服 → microggServers。
 *   两边都叫 china/bilibili，但不是一回事，分开返回，前端用分组标签区分。
 *   配色直接从页面 <b style="color:#xxxxxx"> 抄，上游改色也跟着变。
 * 页面挂了 / 解析不出 → 一律 unknown，不报错、不阻塞。
 */
import { DEFAULT_UA, HEALTH_FETCH_TIMEOUT_MS } from '../../config/constants.ts'

export type StatusName = 'up' | 'down' | 'unknown'

export interface RegionStatus {
  /** 区域名（小写）：euro / usa / asia / cht / china / bilibili … */
  name: string
  status: StatusName
  /** 状态页给这个区服的标识色（#rrggbb），前端直接拿来染色 */
  color: string
}

/** 主页真正要用的就这两组。早期的「整站总状态 / 两个源的聚合状态」没人消费，不再算。 */
export interface EnkaStatusPage {
  /** Enka 官方 Genshin 各区分服 */
  regions: RegionStatus[]
  /** MicroGG 镜像节点自己的两个服（china / bilibili） */
  microggServers: RegionStatus[]
}

const STATUS_URL = 'https://status.enka.network'

/** 页面给每个区服的固定标识色。解析不到时的兜底值（原样抄自状态页）。 */
const FALLBACK_COLORS: Record<string, string> = {
  euro: '#e67e22',
  usa: '#5bb4ef',
  asia: '#e9c223',
  cht: '#75cd69',
  china: '#e74c3c',
  bilibili: '#ff6f9e'
}

/** MicroGG 镜像节点挂的两个服（状态页那段只列这两列）。 */
const MICROGG_SERVERS = ['china', 'bilibili'] as const

const colorOf = (colors: Map<string, string>, name: string): string =>
  colors.get(name) ?? FALLBACK_COLORS[name] ?? '#8a94a6'

/** 状态页没给 MicroGG 段时，两服仍以 unknown 占位，不能凭空消失。 */
const unknownMicrogg = (): RegionStatus[] =>
  MICROGG_SERVERS.map(name => ({ name, status: 'unknown', color: FALLBACK_COLORS[name] }))

/** 拉页面并解析；任何异常（网络/超时）都兜底成 unknown，不让健康检查把进程带崩。 */
export async function fetchEnkaStatus (timeoutMs: number = HEALTH_FETCH_TIMEOUT_MS): Promise<EnkaStatusPage> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(STATUS_URL, {
      signal: ctrl.signal,
      headers: { 'user-agent': DEFAULT_UA, accept: 'text/html' }
    })
    return parseEnkaStatus(await res.text())
  } catch {
    /* 官方区服无从得知，就留空让状态行收起来；镜像两服照旧占位 */
    return { regions: [], microggServers: unknownMicrogg() }
  } finally {
    clearTimeout(timer)
  }
}

/** 抄页面里 <b style="color:#xxxxxx">区服名</b> 的配色。 */
function parseColors (html: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of html.matchAll(/<b\s+style="color:\s*(#[0-9a-fA-F]{3,8})"\s*>\s*([^<]+?)\s*<\/b>/g)) {
    const name = m[2].trim().toLowerCase()
    if (name && !out.has(name)) out.set(name, m[1])
  }
  return out
}

/** 从一段纯文本里，按「区服名 → 下一个区服名 / 段落尾」切片判 up/down。 */
function statusesOf (text: string, names: readonly string[]): Map<string, StatusName> {
  const hits = names
    .map(name => ({ name, at: text.toLowerCase().indexOf(name) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
  const cut = text.indexOf('(profile')
  const out = new Map<string, StatusName>()
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].at : (cut > h.at ? cut : text.length)
    const seg = text.slice(h.at, end)
    out.set(h.name, /\b(dead|down|offline)\b/i.test(seg) ? 'down' : 'up')
  })
  return out
}

/** 纯函数：把页面 HTML 文本解析成结构化状态。抽出来方便单测，不依赖网络。 */
export function parseEnkaStatus (html: string): EnkaStatusPage {
  const colors = parseColors(html)
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')

  /* ① Enka 官方 Genshin 区服 */
  const upSet = new Set<string>()
  const downSet = new Set<string>()
  const gi = text.match(
    /For Genshin,\s*([^.]*?)\s*seem to be up\s*(?:,\s*while\s*([^.]*?)\s*(?:is|are)\s*dead)?/i
  )
  if (gi) {
    for (const part of (gi[1] ?? '').split(/,|\band\b/i)) {
      const r = part.trim().toLowerCase()
      if (r) upSet.add(r)
    }
    for (const part of (gi[2] ?? '').split(/,|\band\b/i)) {
      const r = part.trim().toLowerCase()
      if (r) downSet.add(r)
    }
  }
  const seen = new Set<string>()
  const regions: RegionStatus[] = []
  for (const name of [...upSet, ...downSet]) {
    if (seen.has(name)) continue
    seen.add(name)
    regions.push({ name, status: downSet.has(name) ? 'down' : 'up', color: colorOf(colors, name) })
  }

  /* ② MicroGG 镜像节点的两个服：单独一句「… (profile.microgg.cn)」。
        先按 <p> 切段再挑，别用跨段贪婪正则（会把前面 For Genshin 那句一起吞进来）。 */
  const paragraphs = html.match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? []
  const mgPara = paragraphs.find(p => /profile\.microgg\.cn/i.test(p))
  const mgText = mgPara
    ? mgPara.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    : ''
  const mgStatus = statusesOf(mgText, MICROGG_SERVERS)
  const microggServers: RegionStatus[] = MICROGG_SERVERS.map(name => ({
    name,
    status: mgStatus.get(name) ?? 'unknown',
    color: colorOf(colors, name)
  }))

  return { regions, microggServers }
}
