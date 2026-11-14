/*
 * status.enka.network 的抓取与解析，供主页「数据源是否在线」指示灯使用。
 *
 * 每 5 分钟拉一次（HEALTH_CHECK_INTERVAL_MS / HEALTH_FETCH_TIMEOUT_MS），结果缓存在内存；
 * 取不到或解析不出一律 unknown。
 *
 * 解析按 <p> 分段：官方区服取「For Genshin」段，MicroGG 取带 (profile.microgg.cn) 的段。
 * 每个区服的状态是它后面第一个状态词；配色取自 <b style="color:#xxxxxx">。
 */

import { httpGet } from '../http.ts'
import { DEFAULT_UA, HEALTH_FETCH_TIMEOUT_MS } from '../../config/constants.ts'

export type StatusName = 'up' | 'down' | 'unknown'

export interface RegionStatus {
  /** 区域名（小写）：euro / usa / asia / cht / china / bilibili … */
  name: string
  status: StatusName
  /** 状态页给这个区服的标识色（#rrggbb），前端直接拿来染色 */
  color: string
}

/** 主页要用的两组区服状态 */
export interface EnkaStatusPage {
  /** Enka 官方 Genshin 各区分服 */
  regions: RegionStatus[]
  /** MicroGG 镜像节点自己的两个服（china / bilibili） */
  microggServers: RegionStatus[]
}

const STATUS_URL = 'https://status.enka.network'

/** 解析不到配色时的兜底值 */
const FALLBACK_COLORS: Record<string, string> = {
  euro: '#e67e22',
  usa: '#5bb4ef',
  asia: '#e9c223',
  cht: '#75cd69',
  china: '#e74c3c',
  bilibili: '#ff6f9e'
}

/** MicroGG 段的两个服 */
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
    const res = await httpGet(STATUS_URL, {
      signal: ctrl.signal,
      headers: { 'user-agent': DEFAULT_UA, accept: 'text/html' },
      insecureTls: true
    })
    return parseEnkaStatus(await res.text())
  } catch {
    /* 官方区服无从得知，就留空让状态行收起来；镜像两服照旧占位 */
    return { regions: [], microggServers: unknownMicrogg() }
  } finally {
    clearTimeout(timer)
  }
}

/** 按出现顺序取出「彩色加粗的区服名」——区服顺序和配色都照页面原样。 */
function namedTags (html: string): Array<{ name: string; color: string }> {
  const out: Array<{ name: string; color: string }> = []
  for (const m of html.matchAll(/<b\s+style="color:\s*(#[0-9a-fA-F]{3,8})"\s*>\s*([^<]+?)\s*<\/b>/g)) {
    const name = m[2].trim().toLowerCase()
    if (name) out.push({ name, color: m[1] })
  }
  return out
}

/** 抄页面里区服名的配色（同名取第一次，各区颜色一致）。 */
function parseColors (html: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const { name, color } of namedTags(html)) {
    if (!out.has(name)) out.set(name, color)
  }
  return out
}

/** 纯文本：去标签、去括号补注（(profile.microgg.cn) 里的点会把断句带偏）、收空白。 */
function plainText (html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * 区服的状态 = 它后面第一个状态词：并列主语共用后面的谓语。
 * 遇到句号 / 分号就停，跨句的状态词不算这句的谓语，给 unknown。
 */
function statusAfter (text: string, from: number): StatusName {
  const rest = text.slice(from)
  const hit = /\b(up|dead|down|offline|unknown)\b/i.exec(rest)
  if (!hit || hit.index === undefined) return 'unknown'
  const stop = rest.search(/[.;!?]/)
  if (stop >= 0 && stop < hit.index) return 'unknown'
  const word = hit[1].toLowerCase()
  if (word === 'up') return 'up'
  return word === 'unknown' ? 'unknown' : 'down'
}

/** 把一段里的每个区服都按「后面第一个状态词」判一次。 */
function statusesOf (text: string, names: readonly string[]): Map<string, StatusName> {
  const lower = text.toLowerCase()
  const out = new Map<string, StatusName>()
  for (const name of names) {
    const at = lower.indexOf(name)
    if (at >= 0) out.set(name, statusAfter(lower, at + name.length))
  }
  return out
}

/** 纯函数：把页面 HTML 文本解析成结构化状态。抽出来方便单测，不依赖网络。 */
export function parseEnkaStatus (html: string): EnkaStatusPage {
  const colors = parseColors(html)
  /* 先按 <p> 切段：每段是一句独立的状态说明，不能跨段贪心（会把别的游戏/镜像段吞进来）。 */
  const paragraphs = html.match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? []

  /* ① 认「For Genshin」那一段，逐个彩色区服名往后找状态词 */
  const regions: RegionStatus[] = []
  const giPara = paragraphs.find(p => /For Genshin/i.test(p))
  if (giPara) {
    const lower = plainText(giPara).toLowerCase()
    const seen = new Set<string>()
    for (const { name } of namedTags(giPara)) {
      if (seen.has(name)) continue
      seen.add(name)
      const at = lower.indexOf(name)
      regions.push({
        name,
        status: at >= 0 ? statusAfter(lower, at + name.length) : 'unknown',
        color: colorOf(colors, name)
      })
    }
  }

  /* ② MicroGG 镜像节点的两个服：单独一段，末尾带 (profile.microgg.cn)。
        这一段常写成「china, bilibili are dead」——两服共用后面一个谓语。 */
  const mgPara = paragraphs.find(p => /profile\.microgg\.cn/i.test(p))
  const mgStatus = mgPara ? statusesOf(plainText(mgPara), MICROGG_SERVERS) : new Map<string, StatusName>()
  const microggServers: RegionStatus[] = MICROGG_SERVERS.map(name => ({
    name,
    status: mgStatus.get(name) ?? 'unknown',
    color: colorOf(colors, name)
  }))

  return { regions, microggServers }
}
