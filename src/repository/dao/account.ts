/*
 * account 表的行读写 —— 这一层只认「行」，不认识 Account 类。
 *
 * DAO 与仓储（../index.ts）的分工：DAO 是「一张表 ↔ 一行」，仓储是「一个聚合 ↔ 几张表」。
 * 所以这里出去的永远是 `AccountRow`（列名 + 类型都跟 schema.ts 对齐），
 * 想拿领域对象得再过仓储那道映射。上层因此不会为了查个昵称就把 Account 整包拼出来。
 */
import { asc, eq, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

import type { Conn } from '../db.ts'
import { account } from '../schema.ts'

export type AccountRow = typeof account.$inferSelect
export type NewAccountRow = typeof account.$inferInsert

/* `excluded.<列>` 是 SQLite upsert 里「本次想写的新值」 */
const excl = (col: SQLiteColumn): ReturnType<typeof sql> => sql`excluded.${sql.identifier(col.name)}`
/* 「本次没给值就留旧值」—— 账号信息是分批变的，别拿 null 把已有的昵称 / 等级冲掉 */
const keepOld = (col: SQLiteColumn): ReturnType<typeof sql> => sql`coalesce(${excl(col)}, ${col})`

/** 合并式写入：只覆盖本次给得出值的列，其余保留库里旧值 */
export function upsert (db: Conn, row: NewAccountRow): void {
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

export function select (db: Conn, uid: number): AccountRow | null {
  return db.select().from(account).where(eq(account.uid, uid)).get() ?? null
}

export function selectUids (db: Conn): number[] {
  return db.select({ uid: account.uid }).from(account).orderBy(asc(account.uid)).all().map(r => r.uid)
}
