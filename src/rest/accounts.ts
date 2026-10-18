/*
 * 账号控制器：列表 / 单账号 / 刷新。
 *
 * 只做 HTTP 关切 —— 取参、把 service 的结果翻成状态码与响应形状。
 */
import type { Handler } from 'hono'

import { errMessage } from '../common/util.ts'
import type { ApiContext } from '../service/context.ts'
import { fail, noData, ok } from './reply.ts'
import { localeOf, num } from './params.ts'

export const list = (ctx: ApiContext): Handler => (c) => ok(c, ctx.accounts.list())

export const detail = (ctx: ApiContext): Handler => (c) => {
  const uid = num(c, 'uid')
  const view = ctx.accounts.view(uid, localeOf(c))
  return view ? ok(c, view) : fail(c, 404, 'no_data', noData(uid))
}

/* 唯一会联网写库的接口，单独走抓取档（每 IP + 全局两道，保护 enka 上游）。
   请求体用不上 —— uid 在路径里、locale 在 query 里。 */
export const refresh = (ctx: ApiContext): Handler => async (c) => {
  const uid = num(c, 'uid')
  try {
    const summary = await ctx.ingest(uid)
    return ok(c, ctx.accounts.view(uid, localeOf(c)), {
      fetched: summary.characterCount,
      source: summary.source
    })
  } catch (e) {
    /* enka 的业务错误（未公开 / 查不到 / 太频繁）在 message 里已经是人话了，
       对浏览器来说这类都是「上游没给数据」，用 502（网关上游失败）最贴切。 */
    return fail(c, 502, 'fetch_failed', errMessage(e))
  }
}
