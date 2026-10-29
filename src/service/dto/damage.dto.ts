/*
 * 伤害域的传输对象（DTO）—— 给前端的伤害表形状，纯类型、零逻辑。
 */

/** 伤害表的一行。dmg 为 null = 这条不吃暴击（反应类伤害），页面上期望值独占整行 */
export interface DamageRow {
  title: string
  dmg: string | null
  avg: string
  /** 单位，拼在数值后面（目前只有坎蒂丝的「Q提升普攻伤害」是 '%'） */
  unit: string
}

/** 伤害表（明细页下侧的「伤害计算」表） */
export interface DamageView {
  rows: DamageRow[]
  /** buff 列表：「来源：描述」按冒号拆开 */
  buffs: Array<{ title: string; desc: string }>
  /** 角色 calc.js 的署名（miao 社区贡献者，比如「冰翼」） */
  createdBy: string
  enemyName: string
  enemyLv: number
}

/** 伤害请求的三种结果 —— 用判别联合而不是抛错 */
export type DamageResult =
  | { kind: 'ok', view: DamageView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }
