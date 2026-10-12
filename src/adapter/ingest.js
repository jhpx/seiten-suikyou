/*
 * ingest —— 把 enka 的原始响应翻译成「领域模型」
 *
 * 只做三件事：挑字段（playerInfo / avatarInfoList）、算一次抓取的指纹、
 * 把整包组装成一个 Player（含它名下的 Character 们）。
 * 「某个字段长什么样、装备怎么映射到部位」都交给模型自己的 ofEnka
 * （domain/{player,character,weapon,artifact}.js）—— 适配器不再逐字段抄。
 *
 * 它**不解析属性**：mainPropId / appendPropIdList 原样存库，id → 属性 交给 miao 内核。
 * 内核靠「同一个 id 出现几次」算词条数，提前解析会把这信息丢掉（见 docs/DESIGN-DATA-MODEL.md）。
 */
import { createHash } from 'node:crypto'

import { num } from '../domain/num.js'
import { Player } from '../domain/player.js'
import { Character } from '../domain/character.js'

/**
 * 整包响应 → 一个玩家
 * @param {object} payload enka /api/uid/{uid} 的原始 JSON
 * @returns {{player: Player, avatarCount: number, ttl: number|null, source: string}}
 */
export function ingestPayload (payload, { source = 'enka' } = {}) {
  const info = payload.playerInfo
  if (!info) throw new Error('这不是有效的 enka 响应：没有 playerInfo 字段')
  const uid = num(payload.uid) ?? num(info.uid)
  if (!uid) throw new Error('响应里找不到 uid')
  const list = payload.avatarInfoList || []

  const player = Player.ofEnka(info, uid)
  /* 指纹只算「会不会影响评分」的部分，ttl 这类每次都变的不算。
     它是「这一次抓取」的元信息、不是玩家属性，要 node:crypto —— 所以留在适配层算，
     模型只负责把它存下来（domain 不许碰 crypto）。 */
  player.payloadHash = createHash('sha1')
    .update(JSON.stringify({ info, list }))
    .digest('hex')
    .slice(0, 16)
  player.characters = list.map(ds => Character.ofEnka(ds, source))
  /* uid 是「这一包响应」的属性，不在单个角色的数据里 —— 所以在这儿统一挂上，
     别让每个 Character 自己猜（写库时 uid 是主键的一部分）。 */
  for (const ch of player.characters) ch.uid = uid

  return {
    player,
    avatarCount: list.length,
    ttl: num(payload.ttl),
    source
  }
}
