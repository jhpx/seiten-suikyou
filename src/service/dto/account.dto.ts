/*
 * 账号域的传输对象（DTO）—— 给前端的账号形状，纯类型、零逻辑。
 */
import type { CharacterDto } from './character.dto.ts'
import type { AdviceBundle } from './advice.dto.ts'

/** 列表页一行（只有昵称等级这类概要，不带角色） */
export interface AccountSummary {
  uid: number
  nickname: string | null
  level: number | null
  worldLevel: number | null
  avatarCount: number
  fetchedAt: string | null
}

/** 一整包账号视图（账号 + 角色们 + 评分 + 建议）—— buildAccountView 的产物 */
export interface AccountView {
  locale: string
  fetchedAt: string | null
  account: {
    uid: number | null
    nickname: string | null
    level: number | null
    worldLevel: number | null
    signature: string | null
  } | null
  count: number
  skipped: Array<number | null>
  avatars: CharacterDto[]
  advice: AdviceBundle
}
