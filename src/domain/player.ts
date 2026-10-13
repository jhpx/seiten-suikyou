/*
 * Player —— 一个玩家账号（聚合根）
 *
 * 对应 account 表那一行，外加它名下的角色们（`characters`，join 自 avatar / artifact 表）。
 * Player 是「一个 UID 下的全部」，Character 是「其中一个角色」。
 *
 * ⚠️ 账号信息是**分批变**的：有时只抓到角色列表、没抓到账号详情。所以写库时「本次没给值」的列
 *    用 COALESCE 保留库里旧值 —— `KEEP` 就是这份清单。
 * ⚠️ payloadHash（原始响应指纹）不是玩家属性，是「这一次抓取」的元信息，所以只在这儿**存着**，
 *    怎么算交给适配层（domain 不许碰 node:crypto）。
 */
import { num, str } from '../shared/util.ts'
import type { Character } from './character.ts'
import type { EnkaPlayerInfo } from './enka.ts'

export class Player {
  /* 字段必须显式声明（TS 不从 constructor 赋值反推）。数字 number|null，字符串缺了就是 null。 */
  uid: number | null
  nickname: string | null
  level: number | null
  worldLevel: number | null
  signature: string | null
  avatarIcon: number | null
  nameCard: number | null
  payloadHash: string | null
  fetchedAt: string | null
  characters: Character[]

  constructor ({
    uid, nickname, level, worldLevel, signature,
    avatarIcon, nameCard, payloadHash, fetchedAt, characters = []
  }: {
    /* 外部原始值一律 unknown（enka JSON / DB 列）；num() / str() 在这儿归一（唯一的一次），
       出了 constructor 类型就固定，ofEnka / fromRow 只是字段名映射。 */
    uid?: unknown; nickname?: unknown; level?: unknown; worldLevel?: unknown; signature?: unknown
    avatarIcon?: unknown; nameCard?: unknown; payloadHash?: unknown; fetchedAt?: unknown
    characters?: Character[]
  } = {}) {
    this.uid = num(uid)
    this.nickname = str(nickname)
    this.level = num(level)
    this.worldLevel = num(worldLevel)
    this.signature = str(signature)
    this.avatarIcon = num(avatarIcon)   // profilePicture.avatarID（存 id，不存图名）
    this.nameCard = num(nameCard)
    this.payloadHash = str(payloadHash) // 原始响应指纹：判断「内容有没有变」
    this.fetchedAt = str(fetchedAt)
    this.characters = characters
  }

  /* account 表的列，**顺序与 toValues 严格一致** */
  static COLS: string[] = ['uid', 'nickname', 'level', 'world_level', 'signature',
    'avatar_icon', 'name_card', 'fetched_at', 'payload_hash']

  /* 本次没给值的列保留库里旧值 —— 别拿 null 把已有的昵称 / 等级冲掉 */
  static KEEP: string[] = ['nickname', 'level', 'world_level', 'signature', 'avatar_icon', 'name_card']

  /** 按 COLS 顺序的各列值（写 account 行用）；stamp 覆盖 fetched_at */
  toValues (stamp?: string): unknown[] {
    return [this.uid, this.nickname, this.level, this.worldLevel, this.signature,
      this.avatarIcon, this.nameCard, stamp ?? this.fetchedAt, this.payloadHash]
  }

  /** account 行 → Player（characters 留空，由 repo 再挂上）。列名只在这里出现（一次） */
  static fromRow (row: Record<string, unknown> | null | undefined): Player | null {
    if (!row) return null
    return new Player({
      uid: row.uid,
      nickname: row.nickname,
      level: row.level,
      worldLevel: row.world_level,
      signature: row.signature,
      avatarIcon: row.avatar_icon,
      nameCard: row.name_card,
      payloadHash: row.payload_hash,
      fetchedAt: row.fetched_at
    })
  }

  /* enka 的 playerInfo → Player（不含 characters 与 payloadHash ——
     前者由调用方按 avatarInfoList 挂上，后者是适配层算的指纹）。 */
  static ofEnka (info: EnkaPlayerInfo, uid: number): Player {
    return new Player({
      uid,
      nickname: info.nickname,
      level: info.level,
      worldLevel: info.worldLevel,
      signature: info.signature,
      avatarIcon: info.profilePicture?.avatarID,
      nameCard: info.nameCardId
    })
  }
}
