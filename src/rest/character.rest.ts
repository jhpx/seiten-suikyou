/*
 * 角色控制器：伤害计算 + 模拟比对。
 *
 * 伤害要跑一遍评分内核，比拼视图贵一个量级 —— 路由上挂的是读档限流，别被轮询打满 CPU。
 * 三种「不算」在 service 里已经分成判别结果，这里只负责挑对应的 code。
 *
 * ⚠️ 模拟接口是**全站第一个收请求体**的接口：改后的配装是一份结构化对象
 * （武器 + 5 件圣遗物 + 每件的词条数值），塞进 URL 既超长又不可读。
 * 响应包络仍是那两种形状，路径参数与语言照旧走 URL。
 */
import type { Context, Handler } from 'hono'

import type { ApiContext, SimRequest } from '../service/context.ts'
import * as i18n from '../common/i18n.ts'
import { fail, noData, ok, uidParam } from './reply.ts'

/* 路径里的数字段（:uid / :avatarId 已被路由正则限死数字，uid 的格式校验交给 uidParam） */
const num = (c: Context, name: string): number => Number(c.req.param(name))

/* 语言从 query 取，跟账号视图同一口径 —— 少了它，模拟页右栏会永远显示默认语言 */
const localeOf = (c: Context): string => i18n.resolveLocale(c.req.query('locale'))

export const damage = (ctx: ApiContext): Handler => async (c) => {
  const uid = uidParam(c)
  if (uid === null) return fail(c, 400, 'bad_uid', 'UID 格式不对：应为 9 或 10 位纯数字')
  const avatarId = num(c, 'avatarId')
  const result = await ctx.characters.damage(uid, avatarId)

  if (result.kind === 'no_data') return fail(c, 404, 'no_data', noData(uid))
  if (result.kind === 'no_character') return fail(c, 404, 'no_character', `uid ${uid} 下没有角色 ${avatarId}`)
  return ok(c, result.view)
}

/** 可选装备目录：这个角色能换什么武器、什么套装、每个部位能选什么主词条 */
export const simCatalog = (ctx: ApiContext): Handler => (c) => {
  const uid = uidParam(c)
  if (uid === null) return fail(c, 400, 'bad_uid', 'UID 格式不对：应为 9 或 10 位纯数字')
  const avatarId = num(c, 'avatarId')
  const catalog = ctx.characters.simCatalog(uid, avatarId, localeOf(c))
  if (!catalog) return fail(c, 404, 'no_character', `uid ${uid} 下没有角色 ${avatarId}`)
  return ok(c, catalog)
}

/** 模拟：按改后的配装重算面板与伤害 */
export const simulate = (ctx: ApiContext): Handler => async (c) => {
  const uid = uidParam(c)
  if (uid === null) return fail(c, 400, 'bad_uid', 'UID 格式不对：应为 9 或 10 位纯数字')
  const avatarId = num(c, 'avatarId')

  /* body 坏掉（不是 JSON / 不是对象）当 400 —— 是请求写错了，不是服务出错 */
  let req: SimRequest
  try {
    const body = await c.req.json()
    req = (body && typeof body === 'object' ? body : {}) as SimRequest
  } catch {
    return fail(c, 400, 'bad_request', '请求体不是合法的 JSON')
  }

  const result = await ctx.characters.simulate(uid, avatarId, req, localeOf(c))
  if (result.kind === 'no_data') return fail(c, 404, 'no_data', noData(uid))
  if (result.kind === 'no_character') return fail(c, 404, 'no_character', `uid ${uid} 下没有角色 ${avatarId}`)
  return ok(c, result.view)
}
