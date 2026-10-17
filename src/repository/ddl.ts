/*
 * 表定义 → DDL。
 *
 * 为什么不是 drizzle-kit 生成：kit 的 push/studio 确实能连 node:sqlite，但它只认**文件**库
 * —— 而 openDb 与测试用的是同进程的 DatabaseSync（含 :memory:），交给 CLI 就够不着了。
 * 所以建表语句从 drizzle 自己的表元数据（getTableConfig）现算：结构仍然只写一份（schema.ts），
 * 只是不落成 .sql 文件、也不记迁移历史。
 *
 * 覆盖范围 = 本项目用到的：单列/复合主键、NOT NULL、自增、外键、普通索引。
 * 将来加唯一约束 / CHECK / 生成列时在这里补一条，别让它被静默丢掉。
 */
import { is, getTableName } from 'drizzle-orm'
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

type TableConfig = ReturnType<typeof getTableConfig>

const q = (name: string): string => `"${name}"`
const qList = (cols: SQLiteColumn[]): string => cols.map(c => q(c.name)).join(', ')

/* SQL 字面量。目前只有自增主键（那走 AUTOINCREMENT，不经过这里）——
   真要用 .default() 就补在这里，而不是悄悄漏掉一个约束。 */
function literal (value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(Number(value))
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new Error(`ddl: 不认识的默认值 ${String(value)}，请在 ddl.ts 的 literal() 里补上`)
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
