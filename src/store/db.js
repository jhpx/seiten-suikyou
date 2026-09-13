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
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = path.join(HERE, 'schema.sql')

/* 结构版本。改了 schema.sql 就 +1，migrate 会把老库升上来。 */
export const SCHEMA_VERSION = 2

/*
 * 增量迁移表：MIGRATIONS[v] 把「版本 v」的库升到「版本 v+1」。
 *
 * 为什么需要这张表：schema.sql 全是 CREATE TABLE IF NOT EXISTS，对空库没问题，
 * 但表已经存在时它一列也不会加。所以老库只能靠 ALTER 逐版本补。
 * 新库不走这里 —— 空库直接跑 schema.sql 就已经是最新结构。
 */
const MIGRATIONS = {
  /* v1 → v2：补上数据源自带的「官方文案 key」（多语言用） */
  1: (db) => {
    db.exec('ALTER TABLE artifact ADD COLUMN name_hash INTEGER')
    db.exec('ALTER TABLE artifact ADD COLUMN set_hash INTEGER')
    db.exec('ALTER TABLE avatar ADD COLUMN weapon_name_hash INTEGER')
  }
}

export function openDb (file = ':memory:') {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate (db) {
  const cur = db.prepare('PRAGMA user_version').get().user_version || 0
  if (cur >= SCHEMA_VERSION) return false

  if (cur === 0) {
    /* 空库：schema.sql 就是最新结构，一次到位，不用再逐版本 ALTER */
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  } else {
    for (let v = cur; v < SCHEMA_VERSION; v++) {
      if (!MIGRATIONS[v]) throw new Error(`缺 v${v} → v${v + 1} 的迁移，降级处理会丢数据，拒绝启动`)
      MIGRATIONS[v](db)
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return true
}

/* 一个小工具：把一组写操作包在事务里。出错回滚，不留半截数据。 */
export function tx (db, fn) {
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
