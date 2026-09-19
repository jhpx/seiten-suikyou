/*
 * ingest —— 把 enka 的原始响应翻译成「库里存的那几行」
 *
 * 这一步刻意只做四件事：
 *   1. 挑字段（enka 的响应里有大量我们用不到的东西）
 *   2. 位置映射（equipType → 1花 2羽 3沙 4杯 5头）
 *   3. 记下来源，方便读的时候按来源归一化（各源的 level 基数不一样）
 *   4. 顺手带走官方的「文案 key」（nameTextMapHash / setNameTextMapHash）——
 *      它是名字的 id 不是名字，存下来多语言就不用重新抓一遍
 *
 * 它**不解析属性**。enka 给的是 mainPropId / appendPropIdList 这种原始 prop id，
 * 原样存库；id → 属性 的换算交给 miao 内核（ArtisAttr.getData）做。
 * 理由见 docs/DESIGN-DATA-MODEL.md：内核是靠 appendPropIdList 里「同一个 id 出现几次」
 * 算词条数和副词条有效率的，我们提前解析就会把这信息丢掉。
 */
import { createHash } from 'node:crypto'

/* enka 的装备槽位名 → 圣遗物位置（和上游 EnkaData.js 的 artisIdxMap 一致） */
const POS_BY_EQUIP_TYPE = {
  EQUIP_BRACER: 1,   // 生之花
  EQUIP_NECKLACE: 2, // 死之羽
  EQUIP_SHOES: 3,    // 时之沙
  EQUIP_RING: 4,     // 空之杯
  EQUIP_DRESS: 5     // 理之冠
}

/* 兜底：部件 item id 的第 4 位数字编了槽位。
   这是 miao `Artifact.get()` 里那个 [4,2,5,1,3][name[3]-1] 的逆映射。 */
const POS_BY_ID_DIGIT = { 4: 1, 2: 2, 5: 3, 1: 4, 3: 5 }

const num = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const posOf = (equip) => POS_BY_EQUIP_TYPE[equip.flat?.equipType] ||
  POS_BY_ID_DIGIT[String(equip.itemId)[3]] || null

/* 武器：equipList 里 itemType 为 ITEM_WEAPON 的那条 */
function weaponOf (equipList) {
  const w = (equipList || []).find(e => e.flat?.itemType === 'ITEM_WEAPON')
  if (!w) return {}
  const affix = Object.values(w.weapon?.affixMap || {})[0]
  return {
    weapon_item_id: num(w.itemId),
    /* 武器名的官方文案 key。多语言靠它，不靠我们自建名字表 */
    weapon_name_hash: num(w.flat?.nameTextMapHash),
    weapon_level: num(w.weapon?.level),
    weapon_promote: num(w.weapon?.promoteLevel),
    /* enka 的 affixMap 是「额外精炼次数」，精1 存的是 0 或不存 → +1 */
    weapon_affix: (num(affix) ?? 0) + 1
  }
}

/* 圣遗物：只认带 reliquary 的（武器没有），原始 prop id 原样带走 */
function artifactsOf (equipList) {
  const out = []
  for (const e of equipList || []) {
    const re = e.reliquary
    if (!re) continue
    const pos = posOf(e)
    if (!pos) continue
    out.push({
      pos,
      item_id: num(e.itemId),
      level_raw: num(re.level) ?? 0,
      star: num(e.flat?.rankLevel) ?? 5,
      main_prop_id: num(re.mainPropId),
      append_prop_ids: (re.appendPropIdList || []).map(Number),
      /* 官方文案 key：本件名字 / 套装名字（同套装 5 件共用同一个 set_hash） */
      name_hash: num(e.flat?.nameTextMapHash),
      set_hash: num(e.flat?.setNameTextMapHash)
    })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

export function ingestAvatar (ds, source = 'enka') {
  return {
    avatar_id: num(ds.avatarId),
    level: num(ds.propMap?.['4001']?.val),
    promote: num(ds.propMap?.['1002']?.val),
    cons: ds.talentIdList ? ds.talentIdList.length : 0,
    fetter: num(ds.fetterInfo?.expLevel),
    costume: num(ds.costumeId) ?? 0,
    /* 天赋等级表是 {天赋id: 等级}，存原样；elem 与 a/e/q 的对应关系
       由 miao 的元数据在 materialize 时推，不在这儿猜 */
    skill_level_map: ds.skillLevelMap || null,
    ...weaponOf(ds.equipList),
    source,
    artifacts: artifactsOf(ds.equipList)
  }
}

/**
 * 整包响应 → 账号 + 角色们
 * @param {object} payload enka /api/uid/{uid} 的原始 JSON
 * @returns {{uid:number, account:object, avatars:object[], ttl:number|null, source:string, avatarCount:number}}
 */
export function ingestPayload (payload, { source = 'enka' } = {}) {
  const info = payload.playerInfo
  if (!info) {
    throw new Error('这不是有效的 enka 响应：没有 playerInfo 字段')
  }
  const uid = num(payload.uid) ?? num(info.uid)
  if (!uid) {
    throw new Error('响应里找不到 uid')
  }
  const list = payload.avatarInfoList || []

  return {
    uid,
    account: {
      uid,
      nickname: info.nickname ?? null,
      level: num(info.level),
      world_level: num(info.worldLevel),
      signature: info.signature ?? null,
      /* 头像 / 名片也用 id 存 —— 图是渲染的事，id 才和语言无关 */
      avatar_icon: num(info.profilePicture?.avatarID),
      name_card: num(info.nameCardId),
      /* 指纹只算「会不会影响评分」的部分，ttl 这类每次都变的不算 */
      payload_hash: createHash('sha1')
        .update(JSON.stringify({ info, list }))
        .digest('hex')
        .slice(0, 16)
    },
    avatars: list.map(ds => ingestAvatar(ds, source)),
    avatarCount: list.length,
    ttl: num(payload.ttl),
    source
  }
}
