/*
 * 接口路由表 —— 把 URL 匹配到各自的 handler。
 *
 * 匹配规则写在这里、实现在各自文件里：加一个接口 = 加一行 + 一个文件，
 * server/index.ts 一行都不用动（它只管装配、CORS、限流与静态托管）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ApiContext, Handler } from './context.ts'
import { meta } from './meta.ts'
import { health } from './health.ts'
import { uids } from './uids.ts'
import { account } from './account.ts'
import { damage } from './damage.ts'
import { fetchAccount } from './fetch.ts'

interface Route {
  method: 'GET' | 'POST'
  /** 锚定匹配；捕获组作为 params 原样交给 handler（uid / avatarId） */
  pattern: RegExp
  handler: Handler
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/api\/meta$/, handler: meta },
  { method: 'GET', pattern: /^\/api\/health$/, handler: health },
  { method: 'GET', pattern: /^\/api\/uids$/, handler: uids },
  { method: 'GET', pattern: /^\/api\/uid\/(\d+)$/, handler: account },
  { method: 'GET', pattern: /^\/api\/uid\/(\d+)\/character\/(\d+)\/damage$/, handler: damage },
  { method: 'POST', pattern: /^\/api\/fetch$/, handler: fetchAccount }
]

/** 命中就交给 handler 并返回 true；没命中返回 false，由调用方回 404。 */
export async function routeApi (
  ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL
): Promise<boolean> {
  for (const r of ROUTES) {
    if (req.method !== r.method) continue
    const m = url.pathname.match(r.pattern)
    if (!m) continue
    await r.handler(ctx, req, res, url, m.slice(1))
    return true
  }
  return false
}
