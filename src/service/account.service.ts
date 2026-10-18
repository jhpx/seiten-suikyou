/*
 * 账号用例 —— 「一个请求要办成什么事」都写在这里，控制器只管把结果翻成 HTTP。
 *
 * 它做两件事：把仓储读出来的聚合交给视图层成型（accountView）、给列表页出摘要。
 * 控制器因此不需要知道「聚合怎么拼」「视图怎么建」。
 *
 * 角色相关的用例在 character.service.ts，与 rest / repository 的领域文件对照。
 *
 * 这里**不出现状态码** —— 判空就返回 null，由 rest 层决定回什么。
 */
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { buildAccountView, fmtTime } from './view.service.ts'

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
