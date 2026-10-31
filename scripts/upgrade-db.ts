#!/usr/bin/env node
/*
 * 升级本地库结构（不丢数据）。
 *
 * 用法：
 *   node scripts/upgrade-db.ts [--db <path>]
 * 不传 --db 时取与 app 一样的默认库：data/gs.db（相对当前工作目录）。
 *
 * 覆盖两类改动：
 *   · 新增表/索引（任意版本）：跑 CREATE TABLE / CREATE INDEX ... IF NOT EXISTS 即可；
 *   · 已知的表改名（v6→v7：character_scenario → character_rubric）：ALTER TABLE RENAME，数据保留。
 *
 * 支持来源版本：v5 / v6 → v7。
 *   · v5：没有 character_scenario，按「新增表」处理，直接建空的 character_rubric；
 *   · v6：有旧表 character_scenario，先改名（表 + 列）再升。
 *   比 v5 更早的库不保证列一致，脚本会拒绝并提示删库重抓。
 *
 * 做法：
 *   1. 先备份旧库（连同 -wal/-shm 一起拷，保证一致性）
 *   2. 做已知的表改名（只在「老表在、新表不在」时动）
 *   3. 用 app 自己的 schemaSql() 现算 DDL，对老库跑 CREATE TABLE IF NOT EXISTS ——
 *      只长出新表/新索引，已有表原样保留，几百个账号的评分/规则偏好不动
 *   4. 把 user_version 升到当前 SCHEMA_VERSION
 *   5. 用 app 的 openDb 重新打开一遍，证明升级后版本吻合、能正常起
 *
 * 为什么不是「删库重抓」：
 *   能留就留。删库重抓既浪费 enka 配额、又得等抓完才有分。
 *
 * 幂等：已经是当前版本就直接结束；建表与改名都带存在性判断，误跑两遍无害。
 *
 * ⚠️ 超出上面两类（改列名/删列/改类型等）本脚本不处理 —— 那种情况按项目既定策略删库重抓
 *    （数据本就能从 enka 重新抓）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { schemaSql, SCHEMA_VERSION, openDb } from '../src/config/db.ts'
import * as schema from '../src/config/schema.ts'

function argValue (argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key)
  return i >= 0 ? argv[i + 1] : undefined
}

function readVersion (file: string): number {
  const probe = new DatabaseSync(file)
  try {
    const row = probe.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    return Number(row?.user_version ?? 0)
  } finally {
    probe.close()
  }
}

/* 已知的表/列改名：v6→v7 把表 character_scenario 换成 character_rubric、列 scenario 换成 rubric。
   CREATE TABLE IF NOT EXISTS 不会搬老表，所以得显式 RENAME；每一步都带存在性判断，误跑/重复跑无害。 */
function renameLegacyTables (client: DatabaseSync): void {
  const hasTable = (name: string): boolean => !!client.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name)
  const hasColumn = (table: string, col: string): boolean =>
    (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .some(r => r.name === col)

  if (hasTable('character_scenario') && !hasTable('character_rubric')) {
    client.exec('ALTER TABLE character_scenario RENAME TO character_rubric')
    console.log('已把表 character_scenario 改名为 character_rubric')
  }
  if (hasTable('character_rubric') && hasColumn('character_rubric', 'scenario') && !hasColumn('character_rubric', 'rubric')) {
    client.exec('ALTER TABLE character_rubric RENAME COLUMN scenario TO rubric')
    console.log('已把列 scenario 改名为 rubric（保留原有规则偏好）')
  }
}

const dbFile = argValue(process.argv.slice(2), '--db') || path.join('data', 'gs.db')
const abs = path.resolve(dbFile)

console.log(`库文件  : ${abs}`)
console.log(`目标版本: v${SCHEMA_VERSION}`)

/* 库不存在 → 按 app 首次启动的逻辑直接建一个空库，省得再跑一遍 */
if (!fs.existsSync(abs)) {
  console.log('库不存在，按 app 首次启动逻辑创建一个空库…')
  openDb(abs)
  console.log(`已创建空库（v${SCHEMA_VERSION}）。`)
  process.exit(0)
}

const cur = readVersion(abs)
console.log(`当前版本: v${cur}`)

if (cur === SCHEMA_VERSION) {
  console.log('已经是最新版本，无需升级。')
  process.exit(0)
}
if (cur > SCHEMA_VERSION) {
  console.error(`当前 v${cur} 比代码 v${SCHEMA_VERSION} 还新 —— 别用旧代码打开新库，退出。`)
  process.exit(1)
}
/* 最低支持 v5：v5 的 5 张基表与当前列一致，且还没有 character_scenario —— 纯加表即可。
   更早的库结构无法保证列对得上，不硬升，按既定策略删库重抓。cur=0（空/未知）放行去建表。 */
const MIN_SUPPORTED_VERSION = 5
if (cur > 0 && cur < MIN_SUPPORTED_VERSION) {
  console.error(`库版本 v${cur} 太旧：只支持从 v${MIN_SUPPORTED_VERSION} 起升到 v${SCHEMA_VERSION}。`)
  console.error('更早版本的表结构已无法保证一致，请删库重抓（数据能从 enka 重新拉）。')
  process.exit(1)
}

/* —— 备份：先把 WAL 落盘，再连同 -wal/-shm 一起拷 —— */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
for (const ext of ['', '-wal', '-shm']) {
  const f = abs + ext
  if (fs.existsSync(f)) fs.copyFileSync(f, `${abs}.bak.${stamp}${ext}`)
}
console.log(`已备份到: ${abs}.bak.${stamp}（含 -wal/-shm）`)

/* —— 升级：用和 app 完全相同的方式建表，只长出新表/新索引，已有表不动 —— */
const client = new DatabaseSync(abs)
try {
  client.exec('PRAGMA journal_mode = WAL')
  client.exec('PRAGMA foreign_keys = ON')
  renameLegacyTables(client) // v6→v7：老表改名（有数据也保留）
  for (const sql of schemaSql(schema)) client.exec(sql) // CREATE TABLE / INDEX IF NOT EXISTS（幂等）
  client.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
} finally {
  client.close()
}
console.log('已补齐新表/索引，并刷新 user_version。')

/* —— 验证：用 app 自己的 openDb 打开，版本不符会当场抛错 —— */
openDb(abs)
const after = readVersion(abs)
const tables = new DatabaseSync(abs)
try {
  const rows = tables.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>
  console.log('现有表:')
  for (const r of rows) console.log('  - ' + r.name)
} finally {
  tables.close()
}

console.log(`\n升级完成：v${cur} → v${after}（${after === SCHEMA_VERSION ? 'OK' : '版本对不上，请检查'}）。`)
console.log('提示：升级只补了新表，旧数据原样保留，无需重新抓取。')
