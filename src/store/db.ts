/*
 * 本地库连接 —— 用 Node 自带的 node:sqlite，不引第三方驱动
 *
 * 为什么不用 better-sqlite3：那是个原生模块，装的时候要编译（Windows 上还要 MSVC），
 * 而本项目现在是「只有一个运行时依赖 lodash」的干净状态，测试里也有断言盯着。
 * Node 22 内置的 node:sqlite 够用了，代价是会打一条 experimental 警告 ——
 * package.json 的脚本里用 --disable-warning=ExperimentalWarning 关掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = path.join(HERE, 'schema.sql')

/*
 * ── 「库里 ↔ 程序」的**类型边界** ──────────────────────────────
 * SQLite 取出来的东西没有类型（`Record<string, SQLOutputValue>`，还带 bigint/Uint8Array）。所以凡是查库
 * 都走这三个函数：断言只发生在这一处，不散到 repo 每个查询上。默认行形状就是「一行原始值」，
 * 由模型的 fromRow 自己按列名取值；要别的形状（比如只需一两个列）就显式传类型参数。
 */
export type { DatabaseSync }

/** 取一行 → 调用方声明的行形状；没有 → undefined */
export function getRow<T = Record<string, unknown>> (db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined
}

/** 取多行 → 调用方声明的行形状数组 */
export function allRows<T = Record<string, unknown>> (db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[]
}

/*
 * 写一行。值常常来自模型的 `toValues(): unknown[]`，所以收数组、在这儿断言一次
 * （SQLite 自己不校验类型，真塞了非法值它会在运行时报错，跟以前一样）。
 */
export function runSql (db: DatabaseSync, sql: string, values: unknown[] = []): void {
  db.prepare(sql).run(...(values as SQLInputValue[]))
}

/*
 * 结构保证：schema.sql 是单一事实来源，永远是最新结构。
 *
 * 打开库时直接把 schema.sql 跑一遍（CREATE TABLE IF NOT EXISTS）——空库建表就位，
 * 已存在的库表在就不碰，不会破坏旧数据。
 *
 * 不做「增量迁移表」：数据全部可从 enka 重新抓取，老库没必要逐版本 ALTER 升级。
 * 因此一旦改了 schema.sql，老库不会自动长出新列——这种库请删掉 db 文件、重启后重新抓取。
 * 如果打开到一个版本号比当前旧的库（说明 schema.sql 改过而库没重建），直接报错提示删库重抓，
 * 而不是静默带着缺列的库跑（那样会在插入/读取新列时崩，更难查）。
 *
 * SCHEMA_VERSION 只作「当前结构代次」的戳记：每次打开都把 user_version 写成它，
 * 用来在上面的「旧库」判定里比对。改了 schema.sql 不必再 +1（没有迁移要逐版本走了），
 * 但保留这个常量让戳记有个去处。
 */
export const SCHEMA_VERSION = 5

export function openDb (file = ':memory:'): DatabaseSync {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  ensureSchema(db)
  return db
}

/*
 * 落地结构保证：跑一遍最新 schema.sql，并把代次戳上。
 * 旧库（user_version 比当前小）说明 schema.sql 改过而库没重建——没有增量迁移可补，
 * 直接报错让用户删库重抓，而不是带着缺列的库静默跑。
 */
function ensureSchema (db: DatabaseSync): void {
  const cur = getRow<{ user_version?: number }>(db, 'PRAGMA user_version')?.user_version ?? 0
  if (cur > 0 && cur < SCHEMA_VERSION) {
    throw new Error(`本地库结构过旧（v${cur} < v${SCHEMA_VERSION}），请删除 db 文件后重启（数据会从 enka 重新抓取）`)
  }
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/* 一个小工具：把一组写操作包在事务里。出错回滚，不留半截数据。 */
export function tx<T> (db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const ret = fn()
    db.exec('COMMIT')
    return ret
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
