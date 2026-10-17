/*
 * GET /api/uids —— 列表页「切换账号」下拉的数据。
 */
import * as repo from '../../store/repo.ts'
import { fmtTime } from '../../view/shape.ts'
import { sendJson } from '../http.ts'
import type { Handler } from './context.ts'

export const uids: Handler = (ctx, _req, res) => {
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
