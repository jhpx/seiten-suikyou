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

/* ---------------- uid 使用统计（只读 fetch_log，不改表结构） ---------------- */

/** uidUsageRaw 的返回形状 —— 与 service/dto/stats.dto.ts 的 UidStats 一一对应，
 *  只是这里多带一个 okFetchTotal（算人均用），最终整成 UidStats 是 service 的活。 */
export interface UidUsageRaw {
  totalUids: number
  earliestFetch: string | null
  newUidsByDay: DailyNewUid[]
  returningUids: number
  multiDayUids: number
  activeLast7d: number
  activeLast30d: number
  okFetchTotal: number
}

/** newUidsByDay 一行：某本地日的新增 uid 数 */
export interface DailyNewUid {
  date: string
  count: number
}

/**
 * uid 使用统计。全部从 fetch_log（只增不改的抓取账本）现算，不新增任何表 / 列。
 * 口径：只认 ok=1（成功抓取），失败的尝试不计入「使用」。
 *
 * 自然日按机器本地时区算（与出口 fmtTime 同口径，不写死 +8）：ISO 里的尾随 Z 先去掉，
 * 再让 strftime 的 'localtime' 修饰符转本地 —— 避免 SQLite 对 `…Z` 解析不一致。
 */
export function uidUsageRaw (db: Conn): UidUsageRaw {
  /* 当前已使用过的 uid 总数（成功抓取过去重） */
  const totalUids = Number(
    (db.get(sql`SELECT COUNT(DISTINCT "uid") AS n FROM "fetch_log" WHERE "ok" = 1`) as { n: number } | undefined)?.n ?? 0)

  /* 最早一条成功抓取（库龄起点，给前端做上下文） */
  const earliestFetch = (db.get(sql`SELECT MIN("fetched_at") AS t FROM "fetch_log" WHERE "ok" = 1`) as { t: string | null } | undefined)?.t ?? null

  /* 每日新增：先取每个 uid 首次成功抓取的本地日，再按日汇总。
     ⚠️ 必须用 MIN("fetched_at") 包住 strftime —— SQLite 的「裸列」规则下，
     只写 strftime("fetched_at") 会取组内「任意一行」的日期（通常是先插入那行），
     不一定是首次抓取日。 */
  const dayRows = db.all(sql`
    SELECT day, COUNT(*) AS count FROM (
      SELECT "uid", strftime('%Y-%m-%d', replace(MIN("fetched_at"), 'Z', ''), 'localtime') AS day
      FROM "fetch_log" WHERE "ok" = 1 GROUP BY "uid"
    ) GROUP BY day ORDER BY day
  `) as Array<{ day: string, count: number }>
  const newUidsByDay: DailyNewUid[] = dayRows.map(r => ({ date: r.day, count: Number(r.count) }))

  /* 回头客：成功抓取 ≥ 2 次（多次使用、长期留存） */
  const returningUids = Number(
    (db.get(sql`
      SELECT COUNT(*) AS n FROM (
        SELECT "uid" FROM "fetch_log" WHERE "ok" = 1 GROUP BY "uid" HAVING COUNT(*) >= 2
      )`) as { n: number } | undefined)?.n ?? 0)

  /* 跨日留存：在 ≥ 2 个不同本地自然日有成功抓取 */
  const multiDayUids = Number(
    (db.get(sql`
      SELECT COUNT(*) AS n FROM (
        SELECT "uid" FROM "fetch_log" WHERE "ok" = 1
        GROUP BY "uid"
        HAVING COUNT(DISTINCT strftime('%Y-%m-%d', replace("fetched_at", 'Z', ''), 'localtime')) >= 2
      )`) as { n: number } | undefined)?.n ?? 0)

  /* 近 7 / 30 天活跃：这段时间内有成功抓取的去重 uid 数 */
  const since = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
  const activeLast7d = countActiveSince(db, since(7))
  const activeLast30d = countActiveSince(db, since(30))

  /* 成功抓取总次数 / 去重 uid 数 = 人均抓取次数 */
  const totals = db.get(sql`SELECT COUNT(*) AS total, COUNT(DISTINCT "uid") AS uids FROM "fetch_log" WHERE "ok" = 1`) as { total: number, uids: number } | undefined
  const okFetchTotal = Number(totals?.total ?? 0)

  return {
    totalUids,
    earliestFetch,
    newUidsByDay,
    returningUids,
    multiDayUids,
    activeLast7d,
    activeLast30d,
    okFetchTotal
  }
}

/** 某时间点之后有成功抓取的去重 uid 数（cutoff 为 ISO UTC，与 fetched_at 同格式可字典序比） */
function countActiveSince (db: Conn, cutoff: string): number {
  return Number(
    (db.get(sql`SELECT COUNT(DISTINCT "uid") AS n FROM "fetch_log" WHERE "ok" = 1 AND "fetched_at" >= ${cutoff}`) as { n: number } | undefined)?.n ?? 0)
}
