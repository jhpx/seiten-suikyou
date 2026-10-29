/*
 * enka-account —— 把 enka 的原始响应翻译成「账号 + 名下角色」
 *
 * 纯翻译：不进库、不联网、不知道 HTTP。只做三件事：挑字段、算一次抓取的指纹、组装成一个 Account。
 * 「用例」部分（并发去重、落库、失败留痕）在 service/account.service.ts 的 createIngestService。
 *
 * 它**不解析属性**：mainPropId / appendPropIdList 原样存库，id → 属性 交给 miao 内核 ——
 * 内核靠「同一个 id 出现几次」算词条数，提前解析会把这信息丢掉。
 */
import { createHash } from 'node:crypto'

import { num } from '../../common/util.ts'
import { AccountDbo } from '../../dbo/account.ts'
import { CharacterDbo } from '../../dbo/character.ts'
import type { EnkaPayload } from '../../dbo/enka.ts'

export interface IngestResult {
  account: AccountDbo
  characterCount: number
  ttl: number | null
  source: string
}

/** 整包响应（enka /api/uid/{uid} 的原始 JSON）→ 一个账号（含名下角色） */
export function ingestPayload (payload: EnkaPayload, { source = 'enka' }: { source?: string } = {}): IngestResult {
  const info = payload.playerInfo
  if (!info) throw new Error('这不是有效的 enka 响应：没有 playerInfo 字段')
  const uid = num(payload.uid) ?? num(info.uid)
  if (!uid) throw new Error('响应里找不到 uid')
  const avatars = payload.avatarInfoList || []

  const account = AccountDbo.ofEnka(info, uid)
  /* 指纹只算「会不会影响评分」的部分（ttl 这类每次都变的不算）。它是「这一次抓取」的元信息、
     不是玩家属性，而且要 node:crypto —— 所以留在这一层算，模型只负责存下来。 */
  account.payloadHash = createHash('sha1')
    .update(JSON.stringify({ info, list: avatars }))
    .digest('hex')
    .slice(0, 16)
  account.characters = avatars.map(avatar => CharacterDbo.ofEnka(avatar, source))
  /* uid 是「这一包响应」的属性、不在单个角色的数据里，所以在这儿统一挂上（写库时它是主键的一部分） */
  for (const character of account.characters) character.uid = uid

  return { account, characterCount: avatars.length, ttl: num(payload.ttl), source }
}
