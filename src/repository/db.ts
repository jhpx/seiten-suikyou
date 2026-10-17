/*
 * 本地库连接 —— node:sqlite（Node 自带）外面套一层 drizzle。
 *
 * 为什么不用 better-sqlite3：那是原生模块，装的时候要编译（Windows 上还要 MSVC），
 * 而本项目一直保持「依赖全是纯 JS」。node:sqlite 的代价只是那条 experimental 警告，
 * package.json 的脚本里用 --disable-warning=ExperimentalWarning 关掉。
 *
 * 它的 API 是**同步**的（驱动名里的 'sync' 就是这意思）：查询直接返回结果、不用 await，
 * 事务回调也不能写成 async（drizzle 在类型上就挡）。所以 repo 一路同步。
 *
 * 结构保证：schema.ts 是唯一的结构来源，打开库时现算 DDL 跑一遍（CREATE TABLE IF NOT EXISTS）
 * —— 空库建表就位，已存在的库表在就不碰。不做增量迁移：数据全都能从 enka 重新抓，
 * 老库没必要逐版本 ALTER 升级。所以改完结构后老库不会自己长出新列，请删 db 文件重启重抓
 * （user_version 比当前旧时这里直接抛错提示，而不是带着缺列的库静默跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { schemaSql } from './ddl.ts'
import * as schema from './schema.ts'

/** 当前结构代次。改了 schema.ts 就 +1，老库会被挡在 openDb 门口（没有迁移可补）。 */
export const SCHEMA_VERSION = 5

export function openDb (file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const client = new DatabaseSync(file)
  client.exec('PRAGMA journal_mode = WAL')
  client.exec('PRAGMA foreign_keys = ON')   // 外键级联（删角色带走武器/圣遗物）靠它
  ensureSchema(client)
  return drizzle({ client })
}

/** 库对象（drizzle 查询入口）；`db.$client` 是底下的 DatabaseSync */
export type Db = ReturnType<typeof openDb>

/** 事务里的连接 —— repo 的函数两种都收（顶层 db 与 tx 的查询接口同形） */
export type Conn = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

function ensureSchema (client: DatabaseSync): void {
  const row = client.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const cur = Number(row?.user_version ?? 0)
  if (cur > 0 && cur < SCHEMA_VERSION) {
    throw new Error(`本地库结构过旧（v${cur} < v${SCHEMA_VERSION}），请删除 db 文件后重启（数据会从 enka 重新抓取）`)
  }
  for (const sql of schemaSql(schema)) client.exec(sql)
  client.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}
