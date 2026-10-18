/*
 * 角色用例 —— 单个角色相关的请求：伤害计算。
 *
 * 与 account.service.ts 对照：那边管「账号」这一层的请求（列表 / 详情 / 摘要），
 * 这边管「角色」这一层的请求。控制器因此能按领域各找各的。
 *
 * 这里**不出现状态码** —— 「账号没数据」「没这个角色」用判别联合表达，
 * 由 rest 层决定回 404 还是别的。
 */
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { damageOf } from './view.service.ts'
import type { DamageView } from './view.service.ts'

/**
 * 伤害请求的三种结果 —— 用判别联合而不是抛错：
 * 「账号没抓过」和「账号有但没这个角色」对调用方是两种提示，控制器要分别回不同 code。
 */
export type DamageResult =
  | { kind: 'ok', view: DamageView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

export async function characterDamage (db: Db, uid: number, avatarId: number): Promise<DamageResult> {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  const character = (account.characters || []).find(ch => ch.avatarId === avatarId)
  if (!character) return { kind: 'no_character' }
  /* 算不出（没有伤害脚本 / 新角色先于 miao 更新）返回 null —— 接口照旧 200 + data:null，
     不当作错误：这是「暂时算不了」，不是「你请求错了」。 */
  return { kind: 'ok', view: await damageOf(character) }
}
