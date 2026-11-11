/*
 * YSIN 板块用例 —— 一个角色 → 全部流派的独立评分视图。
 *
 * 与 miao 评分各走各的路：不读 rubric 偏好、不改 miao 分数、不复用它的评级。
 * 判别「账号没数据 / 没这个角色」沿用 character.service.ts 的共用件。
 */
import type { Db } from '../config/db.ts'
import { loadOneCharacter, notFound } from './character.service.ts'
import { ysinViewOf } from './assembler/ysin.assembler.ts'
import type { YsinResult } from './dto/ysin.dto.ts'

export function characterYsin (db: Db, uid: number, avatarId: number, locale: string): YsinResult {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return notFound(db, uid, avatarId)
  return { kind: 'ok', view: ysinViewOf(character, locale) }
}
