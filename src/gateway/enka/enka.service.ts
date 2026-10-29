/*
 * enka 服务 —— 抓取用例的「外部数据加工」一段：把整包响应收拢成一次抓取的产出（IngestResult）。
 *
 * 为什么叫 service：它编排了三件事（校验 payload → 调 convertor 逐个转 dbo → 算抓取指纹），
 * 输出是「这次抓取得到了什么」，不是单纯的一对一格式转换。
 * 但它**不碰**「并发去重 / 落库 / 失败留痕」—— 那是 service/account.service.ts 的 createIngestService。
 *
 * 与 enka.convertor.ts 对照：那边是单点一对一（一个形状 → 一个 dbo）；这里是多对一组装 + 校验。
 * 与 enka.fetch.ts 对照：那边只管把 JSON 拿回来，不管怎么加工。
 */
import { createHash } from 'node:crypto'

import { num } from '../../common/util.ts'
import type { EnkaPayload, IngestResult } from './enka.dto.ts'
import { accountFromEnka, characterFromEnka } from './enka.convertor.ts'

/** 整包响应（enka /api/uid/{uid} 的原始 JSON）→ 一个账号（含名下角色） */
export function ingestPayload (payload: EnkaPayload, { source = 'enka' }: { source?: string } = {}): IngestResult {
  const info = payload.playerInfo
  if (!info) throw new Error('这不是有效的 enka 响应：没有 playerInfo 字段')
  const uid = num(payload.uid) ?? num(info.uid)
  if (!uid) throw new Error('响应里找不到 uid')
  const avatars = payload.avatarInfoList || []

  const account = accountFromEnka(info, uid)
  /* 指纹只算「会不会影响评分」的部分（ttl 这类每次都变的不算）。它是「这一次抓取」的元信息、
     不是玩家属性，而且要 node:crypto —— 所以留在这一层算，模型只负责存下来。 */
  account.payloadHash = createHash('sha1')
    .update(JSON.stringify({ info, list: avatars }))
    .digest('hex')
    .slice(0, 16)
  account.characters = avatars.map(avatar => characterFromEnka(avatar, source))
  /* uid 是「这一包响应」的属性、不在单个角色的数据里，所以在这儿统一挂上（写库时它是主键的一部分） */
  for (const character of account.characters) character.uid = uid

  return { account, characterCount: avatars.length, ttl: num(payload.ttl), source }
}
