/*
 * POST /api/fetch —— 联网打 enka 抓数据进库，抓完直接回最新视图。
 * 会联网，所以单独走 fetch 限流（见 rate-limit.ts）。
 */
import { i18n } from '../../index.ts'
import { errMessage, readBody, sendError, sendJson } from '../http.ts'
import type { Handler } from './context.ts'

export const fetchAccount: Handler = async (ctx, req, res, url) => {
  /* 客户端给的体：只有 uid / locale 两个字段，都在这里当场认形状 */
  let body: Record<string, unknown>
  try { body = await readBody(req) } catch (e) { sendError(res, 400, 'bad_body', errMessage(e)); return }

  const uid = Number(body.uid)
  if (!Number.isInteger(uid) || uid <= 0) {
    sendError(res, 400, 'bad_uid', '请求体里要有一个正整数 uid')
    return
  }
  const locale = (typeof body.locale === 'string' ? body.locale : null) ||
    url.searchParams.get('locale') || i18n.DEFAULT_LOCALE

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
