/*
 * Character —— 一个角色的养成状态（玩家实例）
 *
 * 与 miao 的 Character 同名但不同物：miao 那份是「图鉴 + 内核」（角色长什么样、怎么算分），
 * 这一份是「玩家把它练成什么样」（等级 / 命座 / 天赋 / 武器 / 圣遗物）。
 * 一个是静态配置，一个是动态实例 —— 所以不共用、不互相依赖。
 *
 * 落库：avatar 表那一行 + 它的 5 件圣遗物（artifact 表）。武器是 1:1 的，直接嵌进
 * 这一行（weapon_* 五列），所以 COLS 把 Weapon.COLS 接在中间。
 *
 * ⚠️ 三条不变量（跟评分有关，改错了分就变）：
 *   · 库里只存 id 与**原始值**，不存名字、不存解析后的属性（见 docs/DESIGN-DATA-MODEL.md）。
 *   · `skillLevelMap` 是 {天赋id: 等级}，a/e/q 的对应关系由 miao 元数据推，这里不猜。
 *   · 圣遗物原样交给 Artifact（它自己保证 appendPropIds 保序保重复）。
 */
import { num } from './num.js'
import { Weapon } from './weapon.js'
import { Artifact } from './artifact.js'

/* JSON 列（skill_level_map）读回：解坏了当空，别让手工改过的库把整包读挂 */
const parseMap = (text) => {
  if (!text) return null
  try { return JSON.parse(text) ?? null } catch { return null }
}

export class Character {
  constructor ({
    uid, avatarId, level = null, promote = null, cons = 0, fetter = null, costume = 0,
    skillLevelMap = null, weapon = Weapon.none(), artifacts = [], source = 'enka', fetchedAt = null
  }) {
    this.uid = uid
    this.avatarId = avatarId             // avatarId，角色的稳定数字 id
    this.level = level
    this.promote = promote
    this.cons = cons                     // 命座数 = talentIdList.length
    this.fetter = fetter                 // 好感等级
    this.costume = costume               // 皮肤 id，0 = 无
    this.skillLevelMap = skillLevelMap   // {天赋id: 等级}，读写时自己 JSON 编解码
    this.weapon = weapon                 // Weapon
    this.artifacts = artifacts           // Artifact[]
    this.source = source                 // 'enka' | 'mys' | ...（各源等级基数不同）
    this.fetchedAt = fetchedAt
  }

  /* avatar 表的列。武器那几列从 Weapon.COLS 接进来 —— 列名只写一遍，改列只需动 Weapon。
     **顺序与 toValues 严格一致** */
  static COLS = ['uid', 'avatar_id', 'level', 'promote', 'cons', 'fetter', 'costume',
    'skill_level_map', ...Weapon.COLS, 'source', 'fetched_at']

  /** 按 COLS 顺序的各列值（写 avatar 行用）。JSON 列在这儿编码；stamp 覆盖 fetched_at */
  toValues (stamp) {
    return [this.uid, this.avatarId, this.level, this.promote, this.cons, this.fetter,
      this.costume, JSON.stringify(this.skillLevelMap),
      ...this.weapon.toValues(), this.source, stamp ?? this.fetchedAt]
  }

  /** avatar 行 + 它的圣遗物们 → Character */
  static fromRow (row, artifacts = []) {
    if (!row) return null
    return new Character({
      uid: row.uid,
      avatarId: row.avatar_id,
      level: row.level,
      promote: row.promote,
      cons: row.cons,
      fetter: row.fetter,
      costume: row.costume,
      skillLevelMap: parseMap(row.skill_level_map),
      weapon: Weapon.fromRow(row),
      artifacts,
      source: row.source,
      fetchedAt: row.fetched_at
    })
  }

  /** enka 的一个 avatarInfo → Character（含武器与圣遗物） */
  static ofEnka (ds, source = 'enka') {
    return new Character({
      avatarId: num(ds.avatarId),
      level: num(ds.propMap?.['4001']?.val),
      promote: num(ds.propMap?.['1002']?.val),
      cons: ds.talentIdList ? ds.talentIdList.length : 0,
      fetter: num(ds.fetterInfo?.expLevel),
      costume: num(ds.costumeId) ?? 0,
      skillLevelMap: ds.skillLevelMap || null,
      weapon: Weapon.ofEnka(ds.equipList),
      /* 武器（没有 reliquary）、位置认不出的装备，Artifact.ofEnka 会返回 null，滤掉。
         按位置排好（1花 2羽 3沙 4杯 5头），库里本来就按 pos 存。 */
      artifacts: (ds.equipList || [])
        .map(Artifact.ofEnka).filter(Boolean).sort((a, b) => a.pos - b.pos),
      source
    })
  }
}
