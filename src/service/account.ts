/*
 * 账号用例 —— 「一个请求要办成什么事」都写在这里，控制器只管把结果翻成 HTTP。
 *
 * 它做三件事：把仓储读出来的聚合交给视图层成型（accountView）、给列表页出摘要、
 * 判断伤害请求该 404 还是给数据。控制器因此不需要知道「聚合怎么拼」「视图怎么建」。
 *
 * 这里**不出现状态码** —— 判空、判不存在就返回 null / 判别结果，由 rest 层决定回什么。
 */
import type { Db } from '../repository/db.ts'
import * as repo from '../repository/index.ts'
import { buildAccountView, damageOf, fmtTime } from './view.ts'
import type { DamageView } from './view.ts'

/** 列表页一行（只有昵称等级这类概要，不带角色） */
export interface AccountSummary {
  uid: number
  nickname: string | null
  level: number | null
  worldLevel: number | null
  avatarCount: number
  fetchedAt: string | null
}

export function listAccounts (db: Db): AccountSummary[] {
  return repo.listUids(db).map(uid => {
    const acc = repo.loadAccount(db, uid)
    return {
      uid,
      nickname: acc?.nickname ?? null,
      level: acc?.level ?? null,
      worldLevel: acc?.worldLevel ?? null,
      avatarCount: repo.listCharacterIds(db, uid).length,
      /* ISO UTC → 本地时区文本（出口就转，库里和接口外都不留时区问题） */
      fetchedAt: fmtTime(repo.lastFetch(db, uid)?.fetchedAt)
    }
  })
}

/** 库里有多少个账号 —— 探活用，不拼整包视图 */
export function countAccounts (db: Db): number {
  return repo.listUids(db).length
}

/** 一整包视图（账号 + 角色 + 评分 + 本地化）。库里没有 → null，上层回 404 */
export function accountView (db: Db, uid: number, locale: string): ReturnType<typeof buildAccountView> | null {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return null
  return buildAccountView({ account, locale, fetchedAt: repo.lastFetch(db, uid)?.fetchedAt || null })
}

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
