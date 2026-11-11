/*
 * uid 使用统计的传输对象（DTO）—— 给前端的统计形状，纯类型、零逻辑。
 *
 * 全部字段都由 repository/account.repo.ts 现算（只读 fetch_log，不改表结构）。
 * 口径统一为「成功抓取（ok=1）才算使用」，失败的尝试不计入。
 */

/** 一个自然日的新增 uid 数（按机器本地时区分桶，见 repo 注释） */
export interface DailyNewUid {
  /** 本地自然日，格式 YYYY-MM-DD */
  date: string
  /** 当天首次成功抓取的 uid 数 */
  count: number
}

/** `/api/stats` 返回的 uid 使用统计 */
export interface UidStats {
  /** 当前已使用过的 uid 总数（成功抓取过去重） */
  totalUids: number
  /** 最早一条成功抓取（ISO UTC）；库空时为 null */
  earliestFetch: string | null
  /** 每日新增 uid 数，按日升序 */
  newUidsByDay: DailyNewUid[]
  /** 回头客：成功抓取 ≥ 2 次的 uid 数（多次使用、长期留存） */
  returningUids: number
  /** 跨日留存：在 ≥ 2 个不同本地自然日有成功抓取的 uid 数 */
  multiDayUids: number
  /** 近 7 天内有成功抓取的去重 uid 数 */
  activeLast7d: number
  /** 近 30 天内有成功抓取的去重 uid 数 */
  activeLast30d: number
  /** 人均成功抓取次数（总次数 / 去重 uid 数，两位小数） */
  avgFetchesPerUid: number
}
