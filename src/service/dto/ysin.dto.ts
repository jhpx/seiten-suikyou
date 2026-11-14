/*
 * YSIN 板块的传输对象 —— 明细页新增的独立评分区。
 *
 * 与 miao 那套完全分开：不共用评级、不共用档位色、分数不互相换算。
 * 后端一次返回这个角色的全部流派，前端切流派只重画板块、不再发请求。
 * 所有数值保持全精度，前端渲染时才按显示精度格式化。
 */

/** 词条对照表的一行。「其中武器」没有贡献时为 null，前端画破折号 */
export interface YsinRow {
  /** atk / em / cpct / cdmg */
  key: string
  /** 属性名，按当前语言给 */
  label: string
  /** 你的词条数（面板实测，不配平） */
  yours: number
  /** 武器贡献，是 yours 的一部分，不是另一份来源 */
  weapon: number | null
  /** 配平后的基准词条 */
  bench: number
  /** 双爆两行的原始基准值，其余行为 null */
  originalBench: number | null
}

/** 一个流派的全部展示数据 */
export interface YsinSchoolView {
  id: string
  /** 流派名，例如「融化」「伤害」 */
  name: string
  /** 评估对象：具体技能名 */
  skillName: string
  /** 天赋槽，按当前语言给（普攻 / 战技 / 爆发） */
  talentSlot: string
  /** 核心技能的当前等级 */
  talentLevel: number
  /** 词条分 */
  subScore: number
  /** 数据分 */
  gearScore: number
  /** 基准词条合计 */
  benchTotal: number
  /** 网站那一格「词条」数：按流派的有效属性，已扣掉武器与套装加成 */
  tagTotal: number
  /** 词条对照（只列有基准的 4 项） */
  rows: YsinRow[]
  /** 未计入的属性词条合计（充能 / 生命 / 防御） */
  uncounted: number
  /** 同一技能的三个期望伤害，读数是绝对值 */
  dmgYou: number
  dmgBench: number
  dmgDefault: number
  /** 你的那一发打出暴击时的伤害（网站另列的一格，不是期望值） */
  dmgCrit: number
  /** 默认整套的装备说明，来自网站 */
  wText: string
  aText: string
}

/** 整个板块 */
export interface YsinView {
  charName: string
  /** 总词条（整装口径，含武器与套装），与流派无关 */
  total: number
  /** 计分词条 = 整装有效词条 − 武器副词条（保留兼容；界面显示各流派的 tagTotal） */
  counted: number
  schools: YsinSchoolView[]
  /** 默认选中的流派 id */
  current: string
}

/** 判别联合：账号没数据 / 没这个角色 / 有数据但这个角色没有可用流派 */
export type YsinResult =
  | { kind: 'ok', view: YsinView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

/**
 * 一个角色的 YSIN 分数摘要（首页卡片用）—— 只取分数，不带词条对照与伤害。
 * 取的是**第一个流派**的读数，与明细页默认选中的流派一致，两边得对上。
 */
export interface YsinScoreView {
  avatarId: number
  /** 词条分；这个角色没有适用流派时为 null */
  subScore: number | null
  /** 数据分；同上 */
  gearScore: number | null
}

/** 账号级分数摘要：账号没数据 / 有数据（角色可能一个都没有） */
export type AccountYsinResult =
  | { kind: 'ok'; scores: YsinScoreView[] }
  | { kind: 'no_data' }
