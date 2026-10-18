/*
 * 角色控制器：伤害计算（目前只有这一个）。
 *
 * 伤害要跑一遍评分内核，比拼视图贵一个量级 —— 路由上挂的是读档限流，别被轮询打满 CPU。
 * 三种「不算」在 service 里已经分成判别结果，这里只负责挑对应的 code。
 */
import type { Context, Handler } from 'hono'

import type { ApiContext } from '../service/context.ts'
import { fail, noData, ok } from './reply.ts'

/* 路径里的数字段（:uid / :avatarId 已被路由正则限死数字，直接转） */
const num = (c: Context, name: string): number => Number(c.req.param(name))

export const damage = (ctx: ApiContext): Handler => async (c) => {
  const uid = num(c, 'uid')
  const avatarId = num(c, 'avatarId')
  const result = await ctx.characters.damage(uid, avatarId)

  if (result.kind === 'no_data') return fail(c, 404, 'no_data', noData(uid))
  if (result.kind === 'no_character') return fail(c, 404, 'no_character', `uid ${uid} 下没有角色 ${avatarId}`)
  return ok(c, result.view)
}
