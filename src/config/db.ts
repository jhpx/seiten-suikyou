/*
 * 本地库连接 —— node:sqlite（Node 自带）外面套一层 drizzle。
 *
 * 不用 better-sqlite3：那是原生模块，装的时候要编译，而本项目一直保持「依赖全是纯 JS」。
 * node:sqlite 的代价只是那条 experimental 警告，package.json 的脚本里用 --disable-warning 关掉。
 *
 * 它的 API 是**同步**的：查询直接返回结果、不用 await，事务回调也不能写成 async
 * （drizzle 在类型上就挡）。所以 repo 一路同步。
 *
 * 不做增量迁移：数据全都能从 enka 重新抓。改完结构后老库不会自己长出新列 ——
 * user_version 比当前旧时直接抛错提示删库，而不是带着缺列的库静默跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { is, getTableName } from 'drizzle-orm'
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import * as schema from './schema.ts'

/** 当前结构代次。改了 schema.ts 就 +1，老库会被挡在 openDb 门口（没有迁移可补）。 */
export const SCHEMA_VERSION = 7

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

/* ---------------- 表定义 → DDL ---------------- */

/*
 * 建表语句从 drizzle 自己的表元数据（getTableConfig）现算：结构仍然只写一份（schema.ts），
 * 只是不落成 .sql 文件、也不记迁移历史。drizzle-kit 的 CLI 连不上 node:sqlite 的进程内库
 * （含 :memory:），所以不走它。ensureSchema 打开库时按这里现算 CREATE TABLE 跑一遍。
 *
 * 覆盖范围 = 本项目用到的：单列/复合主键、NOT NULL、自增、外键、普通索引。
 */

type TableConfig = ReturnType<typeof getTableConfig>

const q = (name: string): string => `"${name}"`
const qList = (cols: SQLiteColumn[]): string => cols.map(c => q(c.name)).join(', ')

/* SQL 字面量。目前只有自增主键（那走 AUTOINCREMENT，不经过这里）——
   真要用 .default() 就补在这里，而不是悄悄漏掉一个约束。 */
function literal (value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(Number(value))
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new Error(`ddl: 不认识的默认值 ${String(value)}，请在 db.ts 的 literal() 里补上`)
}

/* 按外键依赖排序：被引用的表先建（ESM 的模块命名空间按字母序给值，靠不住）。 */
function dependencyOrder (tables: TableConfig[]): TableConfig[] {
  const done: TableConfig[] = []
  const pending = [...tables]
  while (pending.length) {
    const ready = pending.findIndex(t => t.foreignKeys.every(fk =>
      done.some(other => other.name === getTableName(fk.reference().foreignTable))))
    done.push(...pending.splice(ready < 0 ? 0 : ready, 1))
  }
  return done
}

function createTable (cfg: TableConfig): string {
  /* 主键有两种写法，drizzle 存在两个地方：
       · 列上 `.primaryKey()` / `.primaryKey({autoIncrement})` → 只在列上标 primary
       · 表尾 `primaryKey({ columns })` → 落在 cfg.primaryKeys，列上没有标记
     单列的写在列定义里（AUTOINCREMENT 只认 `"id" integer PRIMARY KEY AUTOINCREMENT` 这种形式），
     复合的只能在表尾写 PRIMARY KEY (…)。 */
  const compositePk = cfg.primaryKeys[0] ?? null
  const inline = compositePk ? null : cfg.columns.find(c => c.primary) ?? null

  const cols = cfg.columns.map(col => {
    /* autoIncrement 只存在于 integer 列上，SQLiteColumn 这个宽类型里没有 —— 按需问一下 */
    const autoInc = (col as SQLiteColumn & { autoIncrement?: boolean }).autoIncrement === true
    const parts = [q(col.name), col.getSQLType()]
    if (inline && col.name === inline.name) {
      /* 主键列不写 NOT NULL：自增主键要让 drizzle 插的 null 走「自动分配」，
         加了 NOT NULL 反而会撞 constraint（`integer primary key` 本身就非空）。 */
      parts.push('PRIMARY KEY')
      if (autoInc) parts.push('AUTOINCREMENT')
      return '  ' + parts.join(' ')
    }
    if (col.notNull) parts.push('NOT NULL')
    /* `.primaryKey()` 也会把 hasDefault 标成 true（drizzle 内部就这么记的），所以还要看有没有真默认值 */
    if (col.hasDefault && col.default !== undefined && !autoInc) parts.push(`DEFAULT ${literal(col.default)}`)
    return '  ' + parts.join(' ')
  })

  if (compositePk) cols.push(`  PRIMARY KEY (${qList(compositePk.columns)})`)
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference()
    cols.push(`  FOREIGN KEY (${qList(ref.columns)}) REFERENCES ${q(getTableName(ref.foreignTable))} (${qList(ref.foreignColumns)})` +
      (fk.onDelete ? ` ON DELETE ${fk.onDelete.toUpperCase()}` : ''))
  }

  return `CREATE TABLE IF NOT EXISTS ${q(cfg.name)} (\n${cols.join(',\n')}\n)`
}

/** 模块里的所有表 → 一串可依次执行的 DDL（建表 + 建索引） */
export function schemaSql (mod: Record<string, unknown>): string[] {
  const tables = dependencyOrder(
    Object.values(mod).filter(v => is(v, SQLiteTable)).map(t => getTableConfig(t))
  )
  return tables.flatMap(cfg => [
    createTable(cfg),
    ...cfg.indexes.map(idx =>
      `CREATE INDEX IF NOT EXISTS ${q(idx.config.name)} ON ${q(cfg.name)} (${qList(idx.config.columns as SQLiteColumn[])})`)
  ])
}
