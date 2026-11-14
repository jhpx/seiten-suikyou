#!/usr/bin/env node
/*
 * YSIN vs miao 词条数对照。
 *
 * miao有效 = 圣遗物副词条 ÷ 单 roll 最大值 ÷ 0.85；
 * YSIN圣遗物 = YSIN 总词条数 − 武器词条。只有这两列能横向比较。
 *
 * 用法（数据已在库里时直接离线跑）：
 *   node src/cli/ysin-compare.ts --offline
 *   node src/cli/ysin-compare.ts --offline --uid 101242308
 */

import fs from 'node:fs'
import { openDb, type Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { evaluateCharacter } from '../gateway/ysin/ysin.ts'
import type { CharacterYsin } from '../gateway/ysin/ysin.ts'
import { schoolsFor } from '../gateway/ysin/schools.ts'
import { DEFAULT_DB_FILE } from '../config/constants.ts'
import { parseArgs, argValue } from '../common/util.ts'

interface Row {
  uid: number
  result: CharacterYsin
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const dbFile = argValue(args.db) || DEFAULT_DB_FILE
  const db: Db = openDb(dbFile)

  const uidArg = argValue(args.uid)
  const uids = uidArg ? [Number(uidArg)] : repo.listUids(db)

  const rows: Row[] = []
  const skipped: string[] = []
  for (const uid of uids) {
    const account = repo.loadAccountWithCharacters(db, uid)
    if (!account?.characters.length) { skipped.push(`uid ${uid}（无角色）`); continue }
    for (const character of account.characters) {
      const result = await evaluateCharacter(character)
      if (!result) { skipped.push(`uid ${uid} 角色 ${character.avatarId}（miao 不认识）`); continue }
      /* 没穿圣遗物的角色两边都是 0，属噪音，挪到跳过列表 */
      if (result.miaoEff === 0 && result.total === 0) {
        skipped.push(`uid ${uid} 角色 ${character.avatarId}（无圣遗物）`)
        continue
      }
      rows.push({ uid, result })
    }
  }

  rows.sort((a, b) => b.result.total - a.result.total)

  printTable(rows)
  if (skipped.length) console.log(`\n跳过 ${skipped.length} 个：${skipped.join('；')}`)

  writeMarkdown(rows)
  console.log('\n已写出 data/ysin-compare.md')
  return 0
}

function width (value: unknown): number {
  let w = 0
  for (const ch of String(value)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
const padW = (value: unknown, cols: number): string => {
  const text = String(value)
  return text + ' '.repeat(Math.max(0, cols - width(text)))
}

const diffOf = (r: CharacterYsin): number => r.artifactTotal - r.miaoValid
const pctOf = (r: CharacterYsin): number => (r.miaoValid ? diffOf(r) / r.miaoValid * 100 : 0)
const sign = (n: number): string => (n >= 0 ? '+' : '') + n

/**
 * 取这个角色「主展示」流派的正确分数：优先带精确等级倍率表的流派（目前仅甘雨·融化），
 * 其余按第一个流派。返回的词条分对所有流派都精确；数据分只有精确流派随技能等级正确，
 * 其余默认按 9/9/9 等价配置算（技能等级 ≠ 9 时数据分会偏差，见 docs）。
 */
function primaryScore (r: CharacterYsin): { school: string, sub: number, gear: number } | null {
  const group = schoolsFor(r.avatarId)
  if (!group || !group.schools.length) return null
  /* 与首页卡片 / 明细页默认选中一致：一律取第一个流派，不看哪个流派做了精确标定 */
  const pick = group.schools[0]
  const res = r.scores[pick.id]
  if (!res) return null
  return { school: pick.name, sub: res.subScore, gear: res.gearScore }
}

function printTable (rows: Row[]) {
  const header =
    padW('角色', 12) + padW('uid', 12) + padW('YSIN总词条', 12) + padW('其中武器', 10) +
    padW('YSIN圣遗物', 12) + padW('miao有效', 10) + padW('差', 10) + padW('偏差%', 8) +
    padW('无效词条', 10) + padW('词条分', 10) + padW('数据分', 10)
  console.log(header)
  console.log('─'.repeat(width(header)))
  for (const { uid, result: r } of rows) {
    const ps = primaryScore(r)
    console.log(
      padW(r.charName, 12) + padW(uid, 12) + padW(f2(r.total), 12) + padW(f2(r.weaponRolls), 10) +
      padW(f2(r.artifactTotal), 12) + padW(f2(r.miaoValid), 10) +
      padW(sign(round2(diffOf(r))), 10) + padW(sign(round1(pctOf(r))) + '%', 8) + padW(f2(r.invalidTotal), 10) +
      padW(ps ? f1(ps.sub) : '—', 10) + padW(ps ? f1(ps.gear) : '—', 10)
    )
  }

  const sum = (fn: (r: CharacterYsin) => number): number => rows.reduce((s, x) => s + fn(x.result), 0)
  const totalYsin = sum(r => r.artifactTotal)
  const totalMiao = sum(r => r.miaoValid)
  console.log('─'.repeat(width(header)))
  console.log(
    padW('合计', 12) + padW('', 12) + padW(f2(sum(r => r.total)), 12) + padW(f2(sum(r => r.weaponRolls)), 10) +
    padW(f2(totalYsin), 12) + padW(f2(totalMiao), 10) +
    padW(sign(round2(totalYsin - totalMiao)), 10) +
    padW(sign(round1((totalYsin - totalMiao) / totalMiao * 100)) + '%', 8) + padW('', 10)
  )

  const d = distribution(rows)
  console.log(`\n偏差分布（|YSIN圣遗物−miao有效| / miao有效，共 ${d.n} 个角色）：`)
  console.log(`  ${d.buckets.map(([label, n]) => `${label} ${n} 个`).join('　')}`)
  console.log(`  中位 ${sign(round1(d.median))}%　均值 ${sign(round1(d.avg))}%`)
  console.log('\n词条分 / 数据分 = score.ts 的 computeScores 算的伤害比：')
  console.log('  雷神·伤害 116 / 123，甘雨·伤害 126 / 126，甘雨·融化 125 / 150；详见 test/ysin-score.ts 第 5 节。')
  console.log('  账本统一扣掉武器副词条与套装 2 件套加成，技能等级 / 命座降抗进配置倍率。')
}

function distribution (rows: Row[]) {
  const pcts = rows.map(r => pctOf(r.result))
  const abs = pcts.map(Math.abs)
  const buckets: Array<[string, number]> = [
    ['±3%', abs.filter(a => a <= 3).length],
    ['3~5%', abs.filter(a => a > 3 && a <= 5).length],
    ['5~10%', abs.filter(a => a > 5 && a <= 10).length],
    ['>10%', abs.filter(a => a > 10).length]
  ]
  const sorted = [...pcts].sort((a, b) => a - b)
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : 0
  const avg = pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : 0
  return { buckets, median, avg, n: pcts.length }
}

function writeMarkdown (rows: Row[]) {
  const sum = (fn: (r: CharacterYsin) => number): number => rows.reduce((s, x) => s + fn(x.result), 0)
  const totalYsin = sum(r => r.artifactTotal)
  const totalMiao = sum(r => r.miaoValid)

  const lines: string[] = []
  lines.push('# YSIN vs miao 词条数对照')
  lines.push('')
  lines.push('## 口径')
  lines.push('')
  lines.push('| 列 | 含义 |')
  lines.push('| --- | --- |')
  lines.push('| **YSIN总词条** | YSIN 小程序显示的「总词条数」：面板扣掉角色基础值和圣遗物主词条，再 ÷ 一次强化均值。**含武器副词条和套装效果。** |')
  lines.push('| **其中武器** | 总词条里由武器副词条贡献的部分（阿莫斯之弓 49.6% 攻击 = 9.92 条）。 |')
  lines.push('| **YSIN圣遗物** | `YSIN总词条 − 其中武器`，只剩圣遗物副词条 + 套装效果。**只有这一列能和 miao 比。** |')
  lines.push('| **miao有效** | miao 页面「有效词条数」的口径：有效副词条 ÷ 单 roll 最大值，再 ÷0.85 换到均值分母。 |')
  lines.push('| **差 / 偏差%** | `YSIN圣遗物 − miao有效`。 |')
  lines.push('| **无效词条** | 该角色不吃、但装备上确实存在的属性条数（两边都不计入）。 |')
  lines.push('| **词条分** | `score.ts` 按 `100 × (A/A*) × (C/C*) × (R/R*) × (f_u/f_u*)` 算：分子是当前骨架 + 当前副词条，分母是同一骨架 + 标准词条并配平双爆；骨架因子两侧约掉。副词条账本由 `rollLedgerOf` 从面板反解。 |')
  lines.push('| **数据分** | `100 × D(你的实际配置) / D(默认整套)`。当前伤害由 miao 算一次，参考伤害由 `D(P*) = 100·D(P)/T` 反推。默认整套为 9 级技能、0 命、1 精。 |')
  lines.push('')
  lines.push('> 剩余偏差来自两处算法差异：① **套装效果** —— YSIN 从面板读，套装给的 80 精通 / 18% 攻击都算词条；miao 的 eff 只统计副词条。② **小词条** —— YSIN 按白字折成百分比（一条满值小攻击通常 0.4 条），miao 按小词条自身最大值算（1 条）。')
  lines.push('>')

  lines.push('>')
  lines.push('> 充能通过 `f_u` 进入伤害模型；没有这类机制的角色 `f_u ≡ 1`。网站那格「词条」按 `effectiveStatsFor` 的有效属性集合求和。')
  lines.push('')
  lines.push('## 对照表')
  lines.push('')
  lines.push('| 角色 | uid | YSIN总词条 | 其中武器 | YSIN圣遗物 | miao有效 | 差 | 偏差% | 无效词条 | 词条分 | 数据分 |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const { uid, result: r } of rows) {
    const ps = primaryScore(r)
    lines.push(`| ${r.charName} | ${uid} | ${f2(r.total)} | ${f2(r.weaponRolls)} | ${f2(r.artifactTotal)} | ${f2(r.miaoValid)} | ${sign(round2(diffOf(r)))} | ${sign(round1(pctOf(r)))}% | ${f2(r.invalidTotal)} | ${ps ? f1(ps.sub) : '—'} | ${ps ? f1(ps.gear) : '—'} |`)
  }
  lines.push(`| **合计** | | **${f2(sum(r => r.total))}** | **${f2(sum(r => r.weaponRolls))}** | **${f2(totalYsin)}** | **${f2(totalMiao)}** | **${sign(round2(totalYsin - totalMiao))}** | **${sign(round1((totalYsin - totalMiao) / totalMiao * 100))}%** | |`)
  lines.push('')

  const d = distribution(rows)
  lines.push('## 偏差分布')
  lines.push('')
  lines.push(`共 ${d.n} 个角色：${d.buckets.map(([label, n]) => `${label} **${n}** 个`).join('　')}，中位 **${sign(round1(d.median))}%**，均值 **${sign(round1(d.avg))}%**。`)
  lines.push('')

  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/ysin-compare.md', lines.join('\n'), 'utf8')
}

/* 展示层格式化：全项目唯一允许舍入的地方（见 AGENTS.md「数值精度」） */
const round1 = (n: number): number => Math.round(n * 10) / 10
const round2 = (n: number): number => Math.round(n * 100) / 100
const f2 = (n: number): string => round2(n).toFixed(2)
const f1 = (n: number): string => round1(n).toFixed(1)

main().then(code => process.exit(code)).catch(e => {
  console.error(`[出错] ${e.message}`)
  process.exit(1)
})
