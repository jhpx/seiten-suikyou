/*
 * Player —— 一个玩家账号（聚合根）
 *
 * 对应 account 表那一行，外加它名下的角色们（`characters`，join 自 avatar / artifact 表）。
 * 和 Character 的关系：Player 是「一个 UID 下的全部」，Character 是「其中一个角色」。
 *
 * ⚠️ 账号信息是**分批变**的：有时只抓到角色列表、没抓到账号详情。所以写库时，
 *    「本次没给值」的列用 COALESCE 保留库里的旧值 —— `KEEP` 就是这份清单。
 *
 * ⚠️ payloadHash（原始响应指纹）不是玩家属性，是「这一次抓取」的元信息，
 *    所以它只在这儿**存着**，怎么算交给适配层（domain 不许碰 node:crypto）。
 */
import { num } from './num.js'

export class Player {
  constructor ({
    uid, nickname = null, level = null, worldLevel = null, signature = null,
    avatarIcon = null, nameCard = null, payloadHash = null, fetchedAt = null, characters = []
  } = {}) {
    this.uid = uid
    this.nickname = nickname
    this.level = level
    this.worldLevel = worldLevel
    this.signature = signature
    this.avatarIcon = avatarIcon   // profilePicture.avatarID（存 id，不存图名）
    this.nameCard = nameCard
    this.payloadHash = payloadHash // 原始响应指纹：判断「内容有没有变」
    this.fetchedAt = fetchedAt
    this.characters = characters   // Character[]
  }

  /* account 表的列。**顺序与 toValues 严格一致** */
  static COLS = ['uid', 'nickname', 'level', 'world_level', 'signature',
    'avatar_icon', 'name_card', 'fetched_at', 'payload_hash']

  /* 本次没给值的列保留库里旧值（别拿 null 把已有的昵称 / 等级冲掉） */
  static KEEP = ['nickname', 'level', 'world_level', 'signature', 'avatar_icon', 'name_card']

  /** 按 COLS 顺序的各列值（写 account 行用）。stamp 覆盖 fetched_at */
  toValues (stamp) {
    return [this.uid, this.nickname, this.level, this.worldLevel, this.signature,
      this.avatarIcon, this.nameCard, stamp ?? this.fetchedAt, this.payloadHash]
  }

  /** account 行 → Player（characters 留空，由 repo 再挂上） */
  static fromRow (row) {
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

  /**
   * enka 的 playerInfo → Player（不含 characters 与 payloadHash ——
   * 前者由调用方按 avatarInfoList 挂上，后者是适配层算的指纹）。
   */
  static ofEnka (info, uid) {
    return new Player({
      uid,
      nickname: info.nickname ?? null,
      level: num(info.level),
      worldLevel: num(info.worldLevel),
      signature: info.signature ?? null,
      avatarIcon: num(info.profilePicture?.avatarID),
      nameCard: num(info.nameCardId)
    })
  }
}
