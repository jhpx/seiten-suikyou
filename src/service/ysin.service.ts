/*
 * YSIN 板块用例 —— 一个角色 → 全部流派的独立评分视图。
 *
 * 与 miao 评分各走各的路：不读 rubric 偏好、不改 miao 分数、不复用它的评级。
 * 判别「账号没数据 / 没这个角色」沿用 character.service.ts 的共用件。
 *
 * 另外还有一条**账号级**用例（accountYsinScores）：首页卡片要一次看全所有角色的分数，
 * 走明细页那条路就得每个角色发一次请求 —— 所以这里一次算齐。
 */
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { loadOneCharacter, notFound } from './character.service.ts'
import { ysinScoreOf, ysinViewOf } from './assembler/ysin.assembler.ts'
import type { AccountYsinResult, YsinResult } from './dto/ysin.dto.ts'

export function characterYsin (db: Db, uid: number, avatarId: number, locale: string): YsinResult {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return notFound(db, uid, avatarId)
  return { kind: 'ok', view: ysinViewOf(character, locale) }
}

/**
 * 账号级 YSIN 分数摘要 —— 每个角色一行（首页卡片用）。
 *
 * 口径与明细页一致：取第一个流派的词条分 / 数据分，没有适用流派的两个分数是 null。
 * 分数保持全精度，格式化留给展示层。
 */
export function accountYsinScores (db: Db, uid: number): AccountYsinResult {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  return { kind: 'ok', scores: (account.characters || []).map(ysinScoreOf) }
}
