/*
 * Character —— 一个角色的养成状态（玩家实例）
 *
 * 与 miao 的 Character 同名但不同物：miao 那份是「图鉴 + 内核」（角色长什么样、怎么算分），
 * 这一份是「玩家把它练成什么样」（等级 / 命座 / 天赋 / 武器 / 圣遗物）—— 一个是静态配置，一个是动态实例。
 *
 * 落库：character 表那一行 + 它的 1 把武器（weapon 表）+ 5 件圣遗物（artifact 表）——
 * 三张表都以 (uid, avatar_id) 为键，各张表的列由各自的模型负责映射，Character 只管自己那一行。
 *
 * ⚠️ 三条不变量（跟评分有关，改错了分就变）：库里只存 id 与**原始值**，不存名字、不存解析后的属性
 * （见 docs/DESIGN-DATA-MODEL.md）；`skillLevelMap` 是 {天赋id: 等级}，a/e/q 的对应关系由 miao 元数据推、
 * 这里不猜；圣遗物原样交给 Artifact（它自己保证 appendPropIds 保序保重复）。
 */
import { num } from '../shared/util.ts'
import { colsOf, rowArgsOf, rowValuesOf } from './fields.ts'
import type { Field } from './fields.ts'
import { Weapon } from './weapon.ts'
import { Artifact } from './artifact.ts'
import type { EnkaAvatarInfo } from './enka.ts'

export class Character {
  /* 字段必须显式声明（TS 不从 constructor 赋值反推）。
     标量 number|null；cons / costume 是 number —— 它们的「没有」就是 0（没命座 / 没皮肤），不留 null。 */
  uid: number | null
  avatarId: number | null
  level: number | null
  promote: number | null
  cons: number
  fetter: number | null
  costume: number
  skillLevelMap: Record<string, number> | null
  weapon: Weapon
  artifacts: Artifact[]
  source: string
  fetchedAt: string | null

  constructor ({
    uid, avatarId, level, promote, cons, fetter, costume,
    skillLevelMap = null, weapon = Weapon.none(), artifacts = [], source = 'enka', fetchedAt = null
  }: {
    /* 标量外部来源、故意 unknown；num() 在这儿归一到 number|null（唯一的一次）。
       字符串/数组字段本就有明确类型，照实声明。 */
    uid?: unknown; avatarId?: unknown; level?: unknown; promote?: unknown; cons?: unknown
    fetter?: unknown; costume?: unknown; source?: string; fetchedAt?: string | null
    skillLevelMap?: Record<string, number> | null; weapon?: Weapon; artifacts?: Artifact[]
  }) {
    this.uid = num(uid)
    this.avatarId = num(avatarId)        // 角色的稳定数字 id（enka/官方叫 avatarId）
    this.level = num(level)
    this.promote = num(promote)          // 「突破等级」0~6（enka propMap['1002']，决定等级上限）
    this.cons = num(cons) ?? 0           // 命座数 = talentIdList.length
    this.fetter = num(fetter)            // 好感等级
    this.costume = num(costume) ?? 0     // 皮肤 id，0 = 无
    this.skillLevelMap = skillLevelMap   // {天赋id: 等级}
    this.weapon = weapon
    this.artifacts = artifacts
    this.source = source                 // 'enka' | 'mys' | ...（各源 level 基数不同）
    this.fetchedAt = fetchedAt
  }

  /* character 表的列 ↔ 领域字段（顺序 = 建表顺序）。
     武器与圣遗物各自另有表，所以这里没有它们 —— Character 只描述自己那一行。 */
  static FIELDS: Field[] = [
    ['uid', 'uid'], ['avatar_id', 'avatarId'], ['level', 'level'], ['promote', 'promote'],
    ['cons', 'cons'], ['fetter', 'fetter'], ['costume', 'costume'],
    ['skill_level_map', 'skillLevelMap', 'json'], ['source', 'source'], ['fetched_at', 'fetchedAt']
  ]

  static COLS: string[] = colsOf(Character.FIELDS)

  /** 按 FIELDS 顺序的各列值（写 character 行用）；JSON 列在 FIELDS 里标了，stamp 覆盖 fetched_at */
  toValues (stamp?: string): unknown[] {
    return rowValuesOf(this, Character.FIELDS, { fetchedAt: stamp ?? this.fetchedAt })
  }

  /** character 行 + 它的武器行 + 圣遗物行 → Character（后两者是别的表，调用方读好传进来） */
  static fromRow (
    row: Record<string, unknown> | null | undefined,
    artifacts: Artifact[] = [],
    weapon: Weapon = Weapon.none()
  ): Character | null {
    if (!row) return null
    return new Character({ ...rowArgsOf(row, Character.FIELDS), weapon, artifacts })
  }

  /** enka 的一个 avatarInfo → Character（含武器与圣遗物） */
  static ofEnka (info: EnkaAvatarInfo, source = 'enka'): Character {
    return new Character({
      avatarId: info.avatarId,
      level: info.propMap?.['4001']?.val,
      promote: info.propMap?.['1002']?.val,
      cons: info.talentIdList ? info.talentIdList.length : 0,
      fetter: info.fetterInfo?.expLevel,
      costume: info.costumeId,
      skillLevelMap: info.skillLevelMap || null,
      weapon: Weapon.ofEnka(info.equipList),
      /* 武器（没有 reliquary）、位置认不出的装备，Artifact.ofEnka 返回 null → 滤掉；再按位置排好
         （1花 2羽 3沙 4杯 5头，库里本来就按 pos 存）。 */
      artifacts: (info.equipList || [])
        .map(e => Artifact.ofEnka(e))
        .filter((a): a is Artifact => a !== null)
        .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)),
      source
    })
  }
}
