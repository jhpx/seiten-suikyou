/*
 * 账号域的行读写 —— account 表 + 它名下的抓取流水 fetch_log。
 * 这一层只认「行」，不认识 Account 类。
 *
 * repository 与 config 存储门面（../config/store.ts）的分工：
 * repository 是「一张表 ↔ 一行」，store 是「一个聚合 ↔ 几张表」。
 * 所以这里出去的永远是行类型（列名 + 类型都跟 ../config/schema.ts 对齐），
 * 想拿领域对象得再过仓储那道映射。上层因此不会为了查个昵称就把 Account 整包拼出来。
 *
 * fetch_log 以 uid 为键、只增不改，是账号的抓取账本：成功一行（ok=1）、失败也一行（ok=0）。
 * 它不对应任何领域模型，出入参就是行本身。
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import type { Conn } from '../config/db.ts'
import { account, fetchLog } from '../config/schema.ts'

export type AccountRow = typeof account.$inferSelect
export type NewAccountRow = typeof account.$inferInsert

/* `excluded.<列>` 是 SQLite upsert 里「本次想写的新值」 */
const excl = (col: SQLiteColumn): ReturnType<typeof sql> => sql`excluded.${sql.identifier(col.name)}`
/* 「本次没给值就留旧值」—— 账号信息是分批变的，别拿 null 把已有的昵称 / 等级冲掉 */
const keepOld = (col: SQLiteColumn): ReturnType<typeof sql> => sql`coalesce(${excl(col)}, ${col})`

/** 合并式写入：只覆盖本次给得出值的列，其余保留库里旧值 */
export function mergeAccount (db: Conn, row: NewAccountRow): void {
  db.insert(account)
    .values(row)
    .onConflictDoUpdate({
      target: account.uid,
      set: {
        nickname: keepOld(account.nickname),
        level: keepOld(account.level),
        worldLevel: keepOld(account.worldLevel),
        signature: keepOld(account.signature),
        avatarIcon: keepOld(account.avatarIcon),
        nameCard: keepOld(account.nameCard),
        fetchedAt: excl(account.fetchedAt),
        payloadHash: excl(account.payloadHash)
      }
    })
    .run()
}

/** 按 uid 找账号那一行，没有返回 null */
export function findAccount (db: Conn, uid: number): AccountRow | null {
  return db.select().from(account).where(eq(account.uid, uid)).get() ?? null
}

/** 库里有哪些 uid，升序（列表页的目录） */
export function listAccountUids (db: Conn): number[] {
  return db.select({ uid: account.uid }).from(account).orderBy(asc(account.uid)).all().map(r => r.uid)
}

/* ---------------- 抓取流水 ---------------- */

export type FetchLogRow = typeof fetchLog.$inferSelect
export type NewFetchLogRow = typeof fetchLog.$inferInsert

/** 记一行流水（成功、失败都走它） */
export function appendFetchLog (db: Conn, row: NewFetchLogRow): void {
  db.insert(fetchLog).values(row).run()
}

/**
 * 最后一次**成功**抓取。只认 ok=1：失败流水记的是「尝试过」，数据并没变新 ——
 * 把失败时刻当数据更新时间，页面会显示一个骗人的新鲜度。
 */
export function lastOkFetch (db: Conn, uid: number): FetchLogRow | null {
  return db.select().from(fetchLog)
    .where(and(eq(fetchLog.uid, uid), eq(fetchLog.ok, 1)))
    .orderBy(desc(fetchLog.id)).limit(1).get() ?? null
}
