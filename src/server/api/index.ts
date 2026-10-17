/*
 * 接口路由表 —— 后端**唯一**知道 URL 长什么样的地方。
 *
 * 一行 = 一个接口：方法、路径模板、限流档、handler。改路径只改这里，
 * 限流（rate-limit.ts）和提示语（context.ts 的 noData）都不再各自认路径字符串。
 *
 * URL 沿用「资源复数 + 层级只到资源」：/api/accounts、/api/accounts/:uid、
 * 其下的角色 /characters/:avatarId/damage；抓取是从 enka 取一份新的，挂成动作子资源 /refresh。
 */
import type { Handler, RouteParams } from './context.ts'
import { meta, health } from './meta.ts'
import { listAccounts, getAccount, refreshAccount } from './accounts.ts'
import { characterDamage } from './characters.ts'

/** 限流档位：read 只读库；fetch 会联网打 enka（最紧）；none = 不限。 */
type Limit = 'read' | 'fetch' | 'none'

interface Route {
  method: 'GET' | 'POST'
  /** 路径模板，`:name` 段是动态参数 */
  path: string
  limit: Limit
  handler: Handler
}

const ROUTES: Route[] = [
  /* —— 系统：语言表 / 界面文案 / 探活。不碰业务数据，故意不限流 —— */
  { method: 'GET', path: '/api/meta', limit: 'none', handler: meta },
  { method: 'GET', path: '/api/health', limit: 'none', handler: health },

  /* —— 账号：列表 → 单账号 → 刷新 → 其下的角色 —— */
  { method: 'GET', path: '/api/accounts', limit: 'read', handler: listAccounts },
  { method: 'GET', path: '/api/accounts/:uid', limit: 'read', handler: getAccount },
  /* 唯一会联网写库的接口，单独走抓取档（每 IP + 全局两道，保护 enka 上游） */
  { method: 'POST', path: '/api/accounts/:uid/refresh', limit: 'fetch', handler: refreshAccount },
  /* 伤害要跑一遍评分内核，比拼视图贵一个量级 —— 留读档，免得被轮询打满 CPU */
  { method: 'GET', path: '/api/accounts/:uid/characters/:avatarId/damage', limit: 'read', handler: characterDamage }
]

/* 模板 → 正则，启动时编译一次。
   `:name` 段编译成 (\d+)：非数字的路径根本匹配不上（直接 404），handler 里就不用再校验
   一遍 id 合不合法。将来若真需要字符串段，再在这里按段放宽。 */
const COMPILED = ROUTES.map(r => {
  const names: string[] = []
  const src = r.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    names.push(name)
    return '(\\d+)'
  })
  return { ...r, names, regex: new RegExp(`^${src}$`) }
})

/** 命中就返回「限流档 + handler + 解析好的参数」；方法或路径对不上返回 null（调用方回 404）。 */
export function matchRoute (
  method: string | undefined,
  pathname: string
): { limit: Limit; handler: Handler; params: RouteParams } | null {
  for (const r of COMPILED) {
    if (method !== r.method) continue
    const m = pathname.match(r.regex)
    if (!m) continue
    const params: RouteParams = {}
    r.names.forEach((name, i) => { params[name] = Number(m[i + 1]) })
    return { limit: r.limit, handler: r.handler, params }
  }
  return null
}
