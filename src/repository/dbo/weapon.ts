/*
 * Weapon —— 一把武器（值对象）
 *
 * 独立落 `weapon` 表：一个角色一把（1:1），键是 (uid, avatar_id) —— 和 artifact 一样是挂在角色下的子行，
 * 各张表各管自己的列。
 *
 * 三件事别搞混：
 *   · itemId   是**数字** id，名字 / 图标由 miao 元数据 + i18n 表按它查（库里不存名字）。
 *   · nameHash 是**武器名的官方文案 key**（enka 的 flat.nameTextMapHash）—— 它不是名字、是名字的 id，
 *     一个 key 覆盖全部语言。
 *   · affix    是精炼等级（1~5）。enka 给的是「额外精炼次数」（精1 存 0 或干脆没这个键），所以读时 +1。
 *
 * ⚠️ 「装备了但元数据不认识这把」和「压根没装备」是两回事。本值对象只回答前者之外的那半边：
 *    `equipped` = enka 说装了没有；「认不认识」要看出口能不能查到名字（service/character.service.ts）。
 */
import { num } from '../../common/util.ts'

export class WeaponDbo {
  /* 字段必须显式声明（TS 不从 constructor 赋值反推）—— 五个字段统统 number|null */
  itemId: number | null
  nameHash: number | null
  level: number | null
  promote: number | null
  affix: number | null

  constructor ({
    itemId, nameHash, level, promote, affix
  }: {
    /* 外部原始值一律 unknown（enka JSON / DB 列）；num() 在这儿归一（唯一的一次） */
    itemId?: unknown; nameHash?: unknown; level?: unknown; promote?: unknown; affix?: unknown
  } = {}) {
    this.itemId = num(itemId)       // 武器物品 id；null = 没装备
    this.nameHash = num(nameHash)   // 武器名文案 key
    this.level = num(level)
    this.promote = num(promote)     // 「突破等级」0~6（enka 的 weapon.promoteLevel）
    this.affix = num(affix)         // 精炼等级（1~5）
  }

  /* 「没装备武器」的那一个 —— 全 null，别拿 0 充数（0 级 / 精 0 都不是合法状态）。
     出口要显示默认值时自己 `?? 1`（见 kernel/materialize.ts）。 */
  static none (): WeaponDbo { return new WeaponDbo() }

  /* 到底装没装 —— 只看 itemId 有没有值（装备着但名字查不到 ≠ 没装：前者 enka 照样给 level/promote/affix） */
  get equipped (): boolean { return this.itemId !== null && this.itemId !== undefined }
}
