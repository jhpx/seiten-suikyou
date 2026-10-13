/*
 * Weapon —— 一把武器（值对象）
 *
 * 它**不单独落表**：一个角色一把武器（1:1），五列就挂在 avatar 表上 ——
 * 所以这里的 COLS 是「avatar 表里属于武器的列」，由 Character.toValues 接在后面。
 *
 * 三件事别搞混：
 *   · itemId  是**数字** id，名字 / 图标由 miao 元数据 + i18n 表按它查（库里不存名字）。
 *   · nameHash 是**武器名的官方文案 key**（enka 的 flat.nameTextMapHash）—— 多语言的入口，
 *     它不是名字，是名字的 id，一个 key 覆盖全部语言。
 *   · affix   是精炼等级（1~5）。enka 给的是「额外精炼次数」（精1 = 0 或干脆没这个键），
 *     所以读的时候 +1。
 *
 * ⚠️ 「装备了但元数据不认识这把」和「压根没装备」是两回事。这个值对象只回答
 *    「enka 说装备了没有」（`equipped`）；「认不认识」要看出口能不能查到名字（view/shape.js）。
 */
import { num } from '../shared/util.ts'
import type { EnkaEquip } from './enka.ts'

/** 构造 Weapon 的入参：标量外部来源，故意 unknown；归一在 constructor 里做 */
export interface WeaponInit {
  itemId?: unknown
  nameHash?: unknown
  level?: unknown
  promote?: unknown
  affix?: unknown
}

/* avatar 表里属于武器的那几列（列名声明，改 schema 时编译器会提醒） */
export interface WeaponRow {
  weapon_item_id?: unknown
  weapon_name_hash?: unknown
  weapon_level?: unknown
  weapon_promote?: unknown
  weapon_affix?: unknown
}

export class Weapon {
  /* ⚠️ 字段必须**显式声明**（TS 不从 constructor 赋值反推字段）—— 五个字段统统 number|null */
  itemId: number | null
  nameHash: number | null
  level: number | null
  promote: number | null
  affix: number | null

  constructor ({
    itemId = null, nameHash = null, level = null, promote = null, affix = null
  }: WeaponInit = {}) {
    /* 类型不变量：五个字段统统 number|null（由这儿一次性归一，ofEnka / fromRow 都不再 num） */
    this.itemId = num(itemId)       // 武器物品 id；null = 没装备
    this.nameHash = num(nameHash)   // 武器名文案 key
    this.level = num(level)
    this.promote = num(promote)     // 突破等级
    this.affix = num(affix)         // 精炼等级（1~5）
  }

  /* avatar 表里属于武器的列。**顺序与 toValues 严格一致**（改一个必须动另一个） */
  static COLS: string[] = ['weapon_item_id', 'weapon_name_hash', 'weapon_level', 'weapon_promote', 'weapon_affix']

  /* 「没装备武器」的那一个 —— 全 null，别拿 0 充数（0 级 / 精0 都不是合法状态）。
     出口要显示默认值时自己 `?? 1`（见 adapter/materialize.js）。 */
  static none (): Weapon { return new Weapon() }

  /** 按 COLS 顺序的各列值（插进 avatar 行用） */
  toValues (): Array<number | null> { return [this.itemId, this.nameHash, this.level, this.promote, this.affix] }

  /** avatar 行里那五列 → Weapon */
  static fromRow (row: WeaponRow): Weapon {
    return new Weapon({
      itemId: row.weapon_item_id,
      nameHash: row.weapon_name_hash,
      level: row.weapon_level,
      promote: row.weapon_promote,
      affix: row.weapon_affix
    })
  }

  /* 到底装没装武器 —— 只看 itemId 有没有值。
     （装备着但名字查不到 ≠ 没装：前者 enka 照样给 level/promote/affix。） */
  get equipped (): boolean { return this.itemId !== null && this.itemId !== undefined }

  /** enka 的 equipList → Weapon；没装备武器 → none() */
  static ofEnka (equipList: EnkaEquip[] | null | undefined): Weapon {
    const w = (equipList || []).find(e => e.flat?.itemType === 'ITEM_WEAPON')
    if (!w) return Weapon.none()
    /* enka 的 affixMap 是「额外精炼次数」：精1 存的是 0 或不存 → +1 才是 1~5。
       +1 是**业务语义**（不是类型转换），所以留在 ofEnka；类型归一到此为止，后面交给 constructor。 */
    const affix = num(Object.values(w.weapon?.affixMap || {})[0])
    return new Weapon({
      itemId: w.itemId,
      nameHash: w.flat?.nameTextMapHash,
      level: w.weapon?.level,
      promote: w.weapon?.promoteLevel,
      affix: (affix ?? 0) + 1
    })
  }
}
