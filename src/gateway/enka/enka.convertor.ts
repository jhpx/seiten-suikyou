/*
 * enka 转换器 —— 一对一：一个 enka 形状（playerInfo / avatarInfo / equip）→ 一个 dbo 对象。
 *
 * 与 enka.service.ts 对照：那边把整棵 payload 树组装成一个 Account（多对一），
 * 这里只做单点格式转换（一对一）。与 enka.fetch.ts 对照：那边只管把 JSON 拿回来。
 *
 * ⚠️ 转出来的 dbo 只保留：字段映射 + 纯取值（quality / subStatTotals / equipped / none），
 *    不解析属性 —— mainPropId / appendPropIdList 原样留给 miao 内核按 id 解析。
 */
import { num } from '../../common/util.ts'
import { AccountDbo } from '../../repository/dbo/account.ts'
import { CharacterDbo } from '../../repository/dbo/character.ts'
import { WeaponDbo } from '../../repository/dbo/weapon.ts'
import { ArtifactDbo } from '../../repository/dbo/artifact.ts'
import { StatDbo } from '../../repository/dbo/stat.ts'
import type { EnkaAvatarInfo, EnkaEquip, EnkaPlayerInfo } from './enka.dto.ts'

/* 装备槽位名 → 位置（与上游 EnkaData.js 的 artisIdxMap 一致） */
const POS_BY_EQUIP_TYPE: Record<string, number> = {
  EQUIP_BRACER: 1,   // 生之花
  EQUIP_NECKLACE: 2, // 死之羽
  EQUIP_SHOES: 3,    // 时之沙
  EQUIP_RING: 4,     // 空之杯
  EQUIP_DRESS: 5     // 理之冠
}

/* 兜底：部件 id 的第 4 位编了槽位，是 miao `Artifact.get()` 里 [4,2,5,1,3][name[3]-1] 的逆映射 */
const POS_BY_ID_DIGIT: Record<string, number> = { 4: 1, 2: 2, 5: 3, 1: 4, 3: 5 }

/** enka 的一件装备 → ArtifactDbo；不是圣遗物（比如武器）、或位置认不出 → null */
export function artifactFromEnka (equip: EnkaEquip | null | undefined): ArtifactDbo | null {
  if (!equip?.reliquary) return null
  const relq = equip.reliquary
  const pos = POS_BY_EQUIP_TYPE[equip.flat?.equipType ?? ''] ||
    POS_BY_ID_DIGIT[String(equip.itemId)[3]] || null
  if (!pos) return null
  return new ArtifactDbo({
    pos,
    itemId: equip.itemId,
    levelRaw: relq.level ?? 0,
    star: equip.flat?.rankLevel ?? 5,
    mainPropId: relq.mainPropId,
    appendPropIds: (relq.appendPropIdList || []).map(Number),
    mainStatValue: equip.flat?.reliquaryMainstat?.statValue,
    subStats: (equip.flat?.reliquarySubstats || [])
      .filter(s => s && s.appendPropId)
      .map(s => new StatDbo(s.appendPropId as string, s.statValue)),
    nameHash: equip.flat?.nameTextMapHash,
    setHash: equip.flat?.setNameTextMapHash
  })
}

/** enka 的 equipList → WeaponDbo；没装备武器 → none() */
export function weaponFromEnka (equipList: EnkaEquip[] | null | undefined): WeaponDbo {
  const w = (equipList || []).find(e => e.flat?.itemType === 'ITEM_WEAPON')
  if (!w) return WeaponDbo.none()
  /* enka 的 affixMap 是「额外精炼次数」（精1 存 0 或不存）→ +1 才是 1~5 */
  const affix = num(Object.values(w.weapon?.affixMap || {})[0])
  return new WeaponDbo({
    itemId: w.itemId,
    nameHash: w.flat?.nameTextMapHash,
    level: w.weapon?.level,
    promote: w.weapon?.promoteLevel,
    affix: (affix ?? 0) + 1
  })
}

/** enka 的一个 avatarInfo → CharacterDbo（含武器与圣遗物） */
export function characterFromEnka (info: EnkaAvatarInfo, source = 'enka'): CharacterDbo {
  return new CharacterDbo({
    avatarId: info.avatarId,
    level: info.propMap?.['4001']?.val,
    promote: info.propMap?.['1002']?.val,
    cons: info.talentIdList ? info.talentIdList.length : 0,
    fetter: info.fetterInfo?.expLevel,
    costume: info.costumeId,
    skillLevelMap: info.skillLevelMap || null,
    weapon: weaponFromEnka(info.equipList),
    artifacts: (info.equipList || [])
      .map(e => artifactFromEnka(e))
      .filter((a): a is ArtifactDbo => a !== null)
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)),
    source
  })
}

/** enka 的 playerInfo → AccountDbo（不含 characters 与 payloadHash） */
export function accountFromEnka (info: EnkaPlayerInfo, uid: number): AccountDbo {
  return new AccountDbo({
    uid,
    nickname: info.nickname,
    level: info.level,
    worldLevel: info.worldLevel,
    signature: info.signature,
    avatarIcon: info.profilePicture?.avatarID,
    nameCard: info.nameCardId
  })
}
