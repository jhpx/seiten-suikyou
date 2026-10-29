/*
 * StatDbo —— 一条词条的数据对象（prop + value）。
 *
 * 词条的三套名字对照（语义名 / enka prop / miao key）是**词汇表**，在 common/stat.ts ——
 * 那是「词条怎么叫」的字典，不是存储对象。这里只描述「一条词条 = 类型 + 数值」。
 *
 * 类型用 enka 的字符串 prop 表示 —— 和 `sub_stats` 落库的形状一致，存读对称、不用来回换名；
 * 拿 miao 短 key 走 `key` getter（内核的词汇，只在显示/对数值时用）。
 */
import { num } from '../../common/util.ts'
import { enkaPropKey } from '../../common/stat.ts'

export class StatDbo {
  /* 字段必须显式声明（TS 不从 constructor 的 `this.x = ...` 反推） */
  prop: string
  value: number | null

  constructor (prop: string, value: unknown) {
    this.prop = prop
    /* 词条数值一律 number|null，在这儿转唯一的一次 —— 下游（subStatTotals / enkaNumsOf）直接信任它 */
    this.value = num(value)
  }

  /** miao 短 key（cpct / hpPlus …）；认不出返回 null */
  get key (): string | null { return enkaPropKey(this.prop) }
}
