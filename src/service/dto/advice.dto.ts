/*
 * 刷圣遗物建议域的传输对象（DTO）—— 给前端的建议形状，纯类型 + 排序口径常量。
 */

/** 四种排序口径 —— 同一批数据、四种问法 */
export const ADVICE_SORTS = ['balance', 'junk', 'owners', 'boost'] as const
export type AdviceSort = typeof ADVICE_SORTS[number]

/** 一件圣遗物在建议里的样子 */
export interface AdvicePiece {
  avatarId: number | null
  /** 角色名（跟 locale 走） */
  name: string
  pos: number
  posName: string
  /** 原始分（0~70，排序用） */
  mark: number
  /** 内核格式化好的串（1 位小数，页面直接用） */
  markText: string
  markClass: string
  /** 这个角色身上属于该套装的件数：2 = 只吃 2 件套效果，4/5 = 想凑 4 件套 */
  setCount: number
  /** 这一行要给哪些部位画框（1~5） */
  framePos: number[]
  /** 初始 3 / 4 词条（null = 这件认不出来，页面不画角标） */
  initSubs: number | null
  /** 拼凑件：主套没穿满 5 件时补的 0 分占位 */
  missing?: boolean
}

export interface AdviceSet {
  nameZh: string
  name: string
  icon: string | null
  /** 三档明细：bad = D/C/B，mid = A/S，good = SS。SSS 及以上不入任何一档 */
  bad: AdvicePiece[]
  mid: AdvicePiece[]
  good: AdvicePiece[]
  count: { bad: number; mid: number; good: number; total: number; owners: number }
  /** ① 稀烂程度：Σ(42 − 单件分)，只算 SSS 以下的件 */
  gap: number
  /** ③ 均值落差：这套覆盖的角色，各自「自己的五件均值 − 自己最差件」的平均 */
  drop: number
  /** ④ 初始三词条占比 */
  rough: number
  /** 加权汇总得分（0~1） */
  score: number
  /** 这套在账号里出现过的最高星级 */
  star: number
  /** 有 5 星版本才刷得出来 */
  farmable: boolean
}

export interface AdviceView {
  minLevel: number
  /** 这份口径算不算 SS 件 */
  includeSS: boolean
  /** 四种排序各一份名次（套装 nameZh，已截到 topN） */
  orders: Record<AdviceSort, string[]>
  /** 全量套装（按「综合权衡」排好） */
  sets: AdviceSet[]
}

/** 一份视图里带两种口径：sets 是不含 SS 的，withSS 是含的 */
export type AdviceBundle = AdviceView & { withSS: AdviceView }
