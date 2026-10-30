#!/usr/bin/env node
/*
 * 升级本地库结构（不丢数据）。
 *
 * 用法：
 *   node scripts/upgrade-db.ts [--db <path>]
 * 不传 --db 时取与 app 一样的默认库：data/gs.db（相对当前工作目录）。
 *
 * 这版升级针对的是「纯新增表/索引」这类结构改动（本次 v5→v6 就是只多了一张
 * character_scenario 表，既有 5 张表一字没动）。做法：
 *   1. 先备份旧库（连同 -wal/-shm 一起拷，保证一致性）
 *   2. 用 app 自己的 schemaSql() 现算 DDL，对老库跑 CREATE TABLE IF NOT EXISTS ——
 *      只在老库上「长出」新表/新索引，已有表原样保留，里面的几百个账号评分数据不动
 *   3. 把 user_version 升到当前 SCHEMA_VERSION
 *   4. 用 app 的 openDb 重新打开一遍，证明升级后版本吻合、能正常起
 *
 * 为什么不是「删库重抓」：
 *   本次只是加表，旧数据全都能留。删库重抓既浪费 enka 配额、又得等抓完才有分。
 *
 * 幂等：已经是当前版本就直接结束；建表用 IF NOT EXISTS，误跑两遍无害。
 *
 * ⚠️ 只覆盖「新增表/索引」这类改动。如果哪次改动动了已有表的列（改名/删列/改类型），
 *    本脚本无法处理 —— 那种情况按项目既定策略删库重抓（数据本就能从 enka 重新抓）。
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

const dbFile = argValue(process.argv.slice(2), '--db') || path.join('data', 'gs.db')
const abs = path.resolve(dbFile)

console.log(`库文件  : ${abs}`)
console.log(`目标版本: v${SCHEMA_VERSION}`)

/* 库不存在 → 按 app 首次启动的逻辑直接建一个空 v6 库，省得再跑一遍 */
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
  for (const sql of schemaSql(schema)) client.exec(sql) // CREATE TABLE IF NOT EXISTS（幂等）
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
