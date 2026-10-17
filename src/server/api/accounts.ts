/*
 * /api/accounts 一族 —— 账号是这个服务的主资源，三个动作都在同一个文件里：
 *
 *   GET  /api/accounts            列表（列表页「切换账号」下拉）
 *   GET  /api/accounts/:uid       一个账号的完整视图（角色、武器、圣遗物、评分、面板）
 *   POST /api/accounts/:uid/refresh  联网打 enka 抓一份新的进库，抓完直接回最新视图
 *
 * uid 从路径里来（路由表已经保证是数字），locale 从 query 来 —— 所以刷新不需要请求体，
 * 也就不需要解析 JSON、不用区分 bad_body / bad_uid 那一堆 400。
 */
import { i18n } from '../../index.ts'
import * as repo from '../../store/repo.ts'
import { fmtTime } from '../../view/shape.ts'
import { errMessage, sendError, sendJson } from '../http.ts'
import { noData } from './context.ts'
import type { Handler } from './context.ts'

export const listAccounts: Handler = (ctx, _req, res) => {
  const list = repo.listUids(ctx.db).map(uid => {
    const acc = repo.loadAccount(ctx.db, uid)
    return {
      uid,
      nickname: acc?.nickname ?? null,
      level: acc?.level ?? null,
      worldLevel: acc?.worldLevel ?? null,
      avatarCount: repo.listCharacterIds(ctx.db, uid).length,
      fetchedAt: fmtTime(repo.lastFetch(ctx.db, uid)?.fetched_at)   /* ISO UTC → 本地时区文本 */
    }
  })
  sendJson(res, 200, { ok: true, data: list })
}

export const getAccount: Handler = (ctx, _req, res, url, { uid }) => {
  const view = ctx.viewOf(uid, url.searchParams.get('locale') || i18n.DEFAULT_LOCALE)
  if (!view) {
    sendError(res, 404, 'no_data', noData(uid))
    return
  }
  sendJson(res, 200, { ok: true, data: view })
}

export const refreshAccount: Handler = async (ctx, req, res, url, { uid }) => {
  /* 参数全在 URL 里，请求体用不上。但仍然要把它读掉 —— 不读的话带 body 的连接上
     残留数据会卡住同一个 keep-alive 连接的下一个请求。 */
  req.resume()
  const locale = url.searchParams.get('locale') || i18n.DEFAULT_LOCALE

  try {
    const summary = await ctx.handleFetch(uid)
    sendJson(res, 200, {
      ok: true,
      data: ctx.viewOf(uid, locale),
      meta: { fetched: summary.characterCount, source: summary.source }
    })
  } catch (e) {
    /* enka 的业务错误（未公开 / 查不到 / 太频繁）在 message 里已经是人话了，
       对浏览器来说这类都是「上游没给数据」，用 502 表达「网关上游失败」最贴切。 */
    sendError(res, 502, 'fetch_failed', errMessage(e))
  }
}
