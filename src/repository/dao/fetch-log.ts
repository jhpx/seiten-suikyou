/*
 * fetch_log 表 —— 抓取流水，只增不改。
 *
 * 它不对应任何领域模型（没有 FetchLog 类），是运维视角的账本：
 * 成功一行（ok=1）、失败也一行（ok=0，note 带上游错误原文）。
 * 所以这里的出入参就是行本身，没有映射可做。
 */
import { and, desc, eq } from 'drizzle-orm'

import type { Conn } from '../db.ts'
import { fetchLog } from '../schema.ts'

export type FetchLogRow = typeof fetchLog.$inferSelect
export type NewFetchLogRow = typeof fetchLog.$inferInsert

export function insert (db: Conn, row: NewFetchLogRow): void {
  db.insert(fetchLog).values(row).run()
}

/**
 * 最后一次**成功**抓取。只认 ok=1：失败流水记的是「尝试过」，数据并没变新 ——
 * 把失败时刻当数据更新时间，页面会显示一个骗人的新鲜度。
 */
export function lastOk (db: Conn, uid: number): FetchLogRow | null {
  return db.select().from(fetchLog)
    .where(and(eq(fetchLog.uid, uid), eq(fetchLog.ok, 1)))
    .orderBy(desc(fetchLog.id)).limit(1).get() ?? null
}
