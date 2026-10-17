/*
 * GET /api/accounts/:uid/characters/:avatarId/damage —— 明细页下侧的「伤害计算」表。
 *
 * data 为 null = 角色算不出伤害（没配 calc.js / 脚本崩了 / 元数据不认识），页面不出这一块；
 * 这与「角色不存在」是两件事，所以分开两种 404。
 */
import * as repo from '../../store/repo.ts'
import { damageOf } from '../../view/shape.ts'
import { sendError, sendJson } from '../http.ts'
import { noData } from './context.ts'
import type { Endpoint } from './context.ts'

export const characterDamage: Endpoint = async (ctx, _req, res, _url, { uid, avatarId }) => {
  const account = repo.loadAccountWithCharacters(ctx.db, uid)
  if (!account) {
    sendError(res, 404, 'no_data', noData(uid))
    return
  }
  const ch = (account.characters || []).find(c => c.avatarId === avatarId)
  if (!ch) {
    sendError(res, 404, 'no_character', `uid ${uid} 下没有角色 ${avatarId}`)
    return
  }
  sendJson(res, 200, { ok: true, data: await damageOf(ch) })
}
