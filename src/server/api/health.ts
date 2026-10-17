/*
 * GET /api/health —— 存活探针 / 部署自检：回库里的 uid 数。
 */
import * as repo from '../../store/repo.ts'
import { sendJson } from '../http.ts'
import type { Handler } from './context.ts'

export const health: Handler = (ctx, _req, res) => {
  sendJson(res, 200, { ok: true, data: { uids: repo.listUids(ctx.db).length } })
}
