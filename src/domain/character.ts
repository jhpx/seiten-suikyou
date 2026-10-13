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
import { encodeJson, num, parseJson } from '../shared/util.ts'
import { Weapon } from './weapon.ts'
import type { WeaponRow } from './weapon.ts'
import { Artifact } from './artifact.ts'
import type { EnkaAvatarInfo } from './enka.ts'

/** 构造 Character 的入参：标量外部来源，故意 unknown；归一在 constructor 里做 */
export interface CharacterInit {
  uid?: unknown
  avatarId?: unknown
  level?: unknown
  promote?: unknown
  cons?: unknown
  fetter?: unknown
  costume?: unknown
  skillLevelMap?: Record<string, number> | null
  weapon?: Weapon
  artifacts?: Artifact[]
  source?: string
  fetchedAt?: string | null
}

/*
 * avatar 表的一行（含属于武器的那几列 —— 所以 extends WeaponRow）。
 * SQLite 的东西没有类型，这里声明的是**列名**；标量列一律 unknown。
 */
export interface CharacterRow extends WeaponRow {
  uid?: unknown
  avatar_id?: unknown
  level?: unknown
  promote?: unknown
  cons?: unknown
  fetter?: unknown
  costume?: unknown
  skill_level_map?: unknown
  source?: string            // 列是 NOT NULL（'enka' | 'mys' | …）
  fetched_at?: string | null
}

export class Character {
  /* ⚠️ 字段必须**显式声明**（TS 不从 constructor 赋值反推字段）。
     标量 number|null；cons / costume 是 number（「没有」就是 0，见下）。 */
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
  }: CharacterInit) {
    /* 类型不变量：标量字段 number|null（由 constructor 一次性归一，ofEnka / fromRow 不再 num）。
       cons / costume 例外地**不是 null**：它们的「没有」就是 0（没命座 / 没皮肤），
       所以用 `?? 0` 落到领域默认，而不是留 null。 */
    this.uid = num(uid)
    this.avatarId = num(avatarId)        // avatarId，角色的稳定数字 id
    this.level = num(level)
    this.promote = num(promote)
    this.cons = num(cons) ?? 0           // 命座数 = talentIdList.length
    this.fetter = num(fetter)            // 好感等级
    this.costume = num(costume) ?? 0     // 皮肤 id，0 = 无
    this.skillLevelMap = skillLevelMap   // {天赋id: 等级}，读写时自己 JSON 编解码
    this.weapon = weapon                 // Weapon
    this.artifacts = artifacts           // Artifact[]
    this.source = source                 // 'enka' | 'mys' | ...（各源等级基数不同）
    this.fetchedAt = fetchedAt
  }

  /* avatar 表的列。武器那几列从 Weapon.COLS 接进来 —— 列名只写一遍，改列只需动 Weapon。
     **顺序与 toValues 严格一致** */
  static COLS: string[] = ['uid', 'avatar_id', 'level', 'promote', 'cons', 'fetter', 'costume',
    'skill_level_map', ...Weapon.COLS, 'source', 'fetched_at']

  /** 按 COLS 顺序的各列值（写 avatar 行用）。JSON 列在这儿编码；stamp 覆盖 fetched_at */
  toValues (stamp?: string): unknown[] {
    return [this.uid, this.avatarId, this.level, this.promote, this.cons, this.fetter,
      this.costume, encodeJson(this.skillLevelMap),
      ...this.weapon.toValues(), this.source, stamp ?? this.fetchedAt]
  }

  /** avatar 行 + 它的圣遗物们 → Character */
  static fromRow (row: CharacterRow | null | undefined, artifacts: Artifact[] = []): Character | null {
    if (!row) return null
    return new Character({
      uid: row.uid,
      avatarId: row.avatar_id,
      level: row.level,
      promote: row.promote,
      cons: row.cons,
      fetter: row.fetter,
      costume: row.costume,
      skillLevelMap: parseJson<Record<string, number>>(row.skill_level_map),
      weapon: Weapon.fromRow(row),
      artifacts,
      source: row.source,
      fetchedAt: row.fetched_at
    })
  }

  /** enka 的一个 avatarInfo → Character（含武器与圣遗物） */
  static ofEnka (ds: EnkaAvatarInfo, source = 'enka'): Character {
    /* 只映射字段：脏值 → number 交给 constructor，默认值（costume 的 0）也交给它 */
    return new Character({
      avatarId: ds.avatarId,
      level: ds.propMap?.['4001']?.val,
      promote: ds.propMap?.['1002']?.val,
      cons: ds.talentIdList ? ds.talentIdList.length : 0,
      fetter: ds.fetterInfo?.expLevel,
      costume: ds.costumeId,
      skillLevelMap: ds.skillLevelMap || null,
      weapon: Weapon.ofEnka(ds.equipList),
      /* 武器（没有 reliquary）、位置认不出的装备，Artifact.ofEnka 会返回 null，滤掉。
         按位置排好（1花 2羽 3沙 4杯 5头），库里本来就按 pos 存。 */
      artifacts: (ds.equipList || [])
        .map(e => Artifact.ofEnka(e))
        .filter((a): a is Artifact => a !== null)
        /* pos 由 ofEnka 保证非空，`?? 0` 只是让编译器闭嘴（排序语义不变） */
        .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)),
      source
    })
  }
}
