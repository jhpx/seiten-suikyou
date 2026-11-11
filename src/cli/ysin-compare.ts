#!/usr/bin/env node
/*
 * YSIN vs miao 词条数对照 —— 命令行工具
 *
 * 把一个账号里每个角色的「有效词条数」按两套口径列出来，但**必须先把口径拉齐**：
 *
 *   miao有效   = 圣遗物副词条 ÷ 单 roll 最大值，再 ÷0.85 换到均值分母（页面「有效词条数」的口径）
 *   YSIN圣遗物 = YSIN 总词条数 − 武器词条，即「圣遗物副词条 + 套装效果」折算出的条数
 *
 * 只有这两列能横着比。YSIN 总词条数把武器也算进去了（阿莫斯之弓 49.6% 攻击 = 9.92 条），
 * 直接跟 miao 比会凭空多出十来条。
 *
 * 剩余差异来自两处，都是算法本身，不是算错：
 *   ① 套装效果：YSIN 从面板读，套装给的 80 精通、18% 攻击都算词条；miao 的 eff 只统计副词条。
 *   ② 小词条：YSIN 按白字折成百分比（一条满值小攻击通常 0.4 条），miao 按小词条自身最大值算（1 条）。
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
import { presetOf, schoolsFor } from '../gateway/ysin/schools.ts'
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
      const result = evaluateCharacter(character)
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
  const group = schoolsFor(r.charName)
  if (!group || !group.schools.length) return null
  let pick = group.schools[0]
  for (const s of group.schools) {
    if (presetOf(r.charName, s).talentRatioOverride) { pick = s; break }
  }
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
  console.log('\n词条分 / 数据分 = score.ts 的 computeScores 直接算的伤害比（与网站逐一核对）：')
  console.log('  甘雨·融化 0命 10/10/10 → 词条分 161、数据分 171；1命 → 数据分 194。')
  console.log('  其中数据分只有带等级倍率表的流派（目前仅甘雨·融化）随技能等级正确，其余默认按 9/9/9 算。')
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
  lines.push('| **词条分** | score.ts 的 computeScores 直接算的伤害比：`100 × D_default(你的副词条) / D_default(配平后的 bench)`。分子分母都用预设默认整套基线，把当前配置约掉，**只衡量副词条质量**——同一套副词条不管带什么武器 / 套装都给同一分（甘雨·融化基准 161）。倍率、命座、精炼在分子分母约掉，对所有流派精确。 |')
  lines.push('| **数据分** | 同一引擎算的 `[A]/[C]`，C=默认整套（技能写死 9/9/9、0 命、1 精、默认主词条）。只有带等级倍率表的流派（目前仅甘雨·融化）随技能等级正确，其余默认按 9/9/9 算。 |')
  lines.push('')
  lines.push('> 剩余偏差来自两处算法差异：① **套装效果** —— YSIN 从面板读，套装给的 80 精通 / 18% 攻击都算词条；miao 的 eff 只统计副词条。② **小词条** —— YSIN 按白字折成百分比（一条满值小攻击通常 0.4 条），miao 按小词条自身最大值算（1 条）。')
  lines.push('>')
  lines.push('> **词条分 / 数据分** 现在是伤害期望比值，由 score.ts 的 computeScores 算出，与 YSIN 网页版逐一核对：甘雨·融化 0 命 10/10/10 → 词条分 161、数据分 171；1 命 → 数据分 194（1 命降冰抗 15%）。')
  lines.push('>')
  lines.push('> 充能：「充能词条一般不会参与评分，因为**不穿绝缘**的情况下，大部分角色充能与伤害无关」（装备页帮助第 3 条）。**绝缘 4 件套是例外** —— 4 件套把充能的 25% 转成爆发增伤，所以穿绝缘时充能按 5 折计入；香菱 19.4 条充能若全剔掉只有 114.8，与实测 120 对不上。')
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
