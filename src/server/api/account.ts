/*
 * GET /api/uid/:uid —— 一个账号的完整视图（角色、武器、圣遗物、评分、面板）。
 * 前端进首页、切语言、抓取成功后都靠它重画。
 */
import { i18n } from '../../index.ts'
import { sendError, sendJson } from '../http.ts'
import type { Handler } from './context.ts'

export const account: Handler = (ctx, _req, res, url, [rawUid]) => {
  const uid = Number(rawUid)
  const view = ctx.viewOf(uid, url.searchParams.get('locale') || i18n.DEFAULT_LOCALE)
  if (!view) {
    sendError(res, 404, 'no_data', `库里没有 uid ${uid}。先抓一次：POST /api/fetch {"uid":${uid}}`)
    return
  }
  sendJson(res, 200, { ok: true, data: view })
}
