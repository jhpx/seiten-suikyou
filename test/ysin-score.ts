/*
 * 词条分 / 数据分的计算值对拍。
 *
 * 基线数值来自 schools.csv 的标定与引擎读数；倍率、抗性、命座降抗作为输入，
 * 词条分、数据分、绝对伤害都由本模块算出后与基线比较。
 * A 组只给天赋与命座（独立预测）；B 组把伤害倍率作为输入，验的是恒等式。
 * 已知边界：换主词条会改装备基线，本模块把基线当输入，不覆盖 T5/T6/T7。
 */

import {
  balanceOf,
  computeScores,
  damageOf,
  limitOf,
  panelOf,
  reactionOf,
  resistanceOf,
  type GearBasis,
  type Rolls,
  type ScoreInput
} from '../src/gateway/ysin/score.ts'
import fs from 'node:fs'
import { presetOf, schoolsFor } from '../src/gateway/ysin/schools.ts'
import { parseSchoolsCsv, CSV_PATH } from '../src/gateway/ysin/schools-csv.ts'
import { rollLedgerOf, setPanelBonusOf, withNonArtifact, type StatRoll } from '../src/gateway/ysin/ysin.ts'
import type { ArtifactDbo } from '../src/repository/dbo/artifact.ts'

/* 基线不再从写死常量的 preset.ts 拿，而是从 schools.csv 读出来、走同一个 presetOf 装配。
   这样测试跑的就是产品链路上的预设，改 CSV 数据会立刻反映到对拍结果里。 */
const MELT_SEED = schoolsFor(10000037)!.schools.find(s => s.id === 'ganyuR')!
const MELT = presetOf(MELT_SEED)
const BASIS = MELT.defaultBasis
const SCALE = MELT.talentScale

let failed = 0
let passed = 0

function eq (actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}` +
    (ok ? '' : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`))
  ok ? passed++ : failed++
}

function near (actual: number, expected: number, tol: number, label: string): void {
  const d = Math.abs(actual - expected)
  const ok = d <= tol
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}` +
    `（期望 ${expected} ± ${tol}，实际 ${actual.toFixed(4)}，差 ${d.toFixed(4)}）`)
  ok ? passed++ : failed++
}

/** 相对误差断言：绝对伤害用，容差按百分比给 */
function rel (actual: number, expected: number, pct: number, label: string): void {
  const e = Math.abs(actual - expected) / expected
  const ok = e <= pct
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}` +
    `（线上 ${expected}，算得 ${actual.toFixed(1)}，相对误差 ${(e * 100).toFixed(4)}% ≤ ${(pct * 100).toFixed(2)}%）`)
  ok ? passed++ : failed++
}

const YOUR_ROLLS: Rolls = { atk: 20.7, em: 6.7, cpct: 12.6, cdmg: 11.7 }
const BASE: ScoreInput = {
  preset: MELT,
  basis: BASIS,
  rolls: YOUR_ROLLS,
  talents: { a: 9, e: 9, q: 9 }
}

// ───────────────────────────────────────────── 1. 面板、配平、伤害函数
console.log('=== 1. 面板 / 配平 / 伤害函数 ===')

const panel = panelOf(YOUR_ROLLS, BASIS)
near(panel.atk, 3137.17, 0.01, '你的面板攻击 3137.17')
/* 面板本身不含技能被动；甘雨重击的 +20% 暴击由 preset.passiveCpct 在评分时叠加，
   所以这里断言的是真实面板 46.58%，有效暴击 66.58% 在下面的配平里体现 */
near(panel.cpct, 0.4658, 1e-9, '你的面板暴击率 46.58%（+被动 20% = 66.58%）')
near(panel.cdmg, 2.2782, 1e-9, '你的爆伤 227.82%')
eq(panel.mastery, 214, '你的精通 214')

const balanced = balanceOf(MELT.bench, BASIS, MELT.passiveCpct)
near(balanced.k, 7.621212, 1e-5, '配平搬运 7.6212 条')
near(balanced.rolls.cpct, 16.621212, 1e-5, '配平后暴击条数 16.6212')
near(balanced.rolls.cdmg, 1.378788, 1e-5, '配平后爆伤条数 1.3788')
const benchPanel = panelOf(balanced.rolls, BASIS)
near(benchPanel.cpct, 0.5985, 1e-9, '配平后面板暴击率 59.85%')
near(benchPanel.cdmg, 2 * (benchPanel.cpct + (MELT.passiveCpct ?? 0)), 1e-9,
  '配平后有效爆伤 = 2 × 有效暴击率（59.85% + 被动 20% = 79.85%）')
eq(limitOf(MELT.bench), { atk: 7, em: 5, cpct: 15, cdmg: 15 }, '极限基准 7/5/15/15')
near(reactionOf(214, true), 1.36860, 1e-5, 'R(214) = 1.36860')
eq(reactionOf(214, false), 1, '不打反应时 R 恒为 1')
near(SCALE[9] / SCALE[8], 1.058824, 1e-5, '上游游戏倍率表 9→10 = 1.058824')
near(105983 / 100189, 1.057831, 1e-5, 'YSIN v4.8 实测 9→10 = 1.057831（两者差 0.1%）')
near(resistanceOf(0.1), 0.9, 1e-9, '小宝冰抗 10% → 抗性乘区 0.9')
near(resistanceOf(-0.05), 1.025, 1e-9, '1 命降抗 15% → 冰抗 −5% → 抗性乘区 1.025')
near(resistanceOf(-0.05) / resistanceOf(0.1), 1.138889, 1e-6, '1 命抗性倍率 1.138889')

// ───────────────────────────────────────────── 2. 基线：161 / 146 / 110
console.log('\n=== 2. 基线分数（技能 999）===')
const base = computeScores(BASE)
near(base.subScore, 161.35, 0.02, '词条分 161.35')
eq(Math.round(base.maxScore), 146, '极限分 146（线上 tProgress 146 / 110）')
eq(Math.round(base.reach), 110, '达成率 110')
eq(Math.round(base.gearScore), 161, '数据分 161')
rel(base.dmgYou, 100189, 0.0002, 'D(你的副词条) 对拍 100189')
rel(base.dmgBench, 62095, 0.0002, 'D(配平后的 bench) 对拍 62095')
eq(base.dmgDefault, 62095, 'D(默认整套) 62095')

// 网页默认配置显示 100/100：它的副词条是配平回写后的值，不是 bench 原始值
const atDefault = computeScores({ ...BASE, rolls: balanced.rolls })
eq(Math.round(atDefault.subScore), 100, '默认配置词条分 100（副词条用配平回写值）')
eq(Math.round(atDefault.gearScore), 100, '默认配置数据分 100')

// ───────────────────────────────────────────── 3. 线上分数对拍
console.log('\n=== 3. 基准读数对拍 ===')

interface OnlineRow {
  name: string
  talents: { a: number, e: number, q: number }
  /** 命座数，默认 0 */
  cons?: number
  /** 除技能、命座外的配置倍率。只有武器精炼用得到，由 dmgYou 反推，属输入 */
  mult?: number
  sub: number
  gear: number
  dmgYou: number
  dmgBench: number
  group: '预测' | '验算'
}

const L9 = { a: 9, e: 9, q: 9 }
const L10 = { a: 10, e: 10, q: 10 }
const ONLINE: OnlineRow[] = [
  { name: 'T0  0命 999', talents: L9, sub: 161, gear: 161, dmgYou: 100189, dmgBench: 62095, group: '预测' },
  { name: 'T1  0命 10/10/10', talents: L10, sub: 161, gear: 171, dmgYou: 105983, dmgBench: 65685, group: '预测' },
  { name: 'T9  0命 只升普攻', talents: { a: 10, e: 9, q: 9 }, sub: 161, gear: 171, dmgYou: 105983, dmgBench: 65685, group: '预测' },
  { name: 'T10 0命 只升 Q', talents: { a: 9, e: 9, q: 10 }, sub: 161, gear: 161, dmgYou: 100189, dmgBench: 62095, group: '预测' },
  { name: 'T13 1命 999', talents: L9, cons: 1, sub: 161, gear: 184, dmgYou: 114105, dmgBench: 70719, group: '预测' },
  { name: 'T14 2命 999', talents: L9, cons: 2, sub: 161, gear: 184, dmgYou: 114105, dmgBench: 70719, group: '预测' },
  { name: 'T4  6命 999', talents: L9, cons: 6, sub: 161, gear: 184, dmgYou: 114105, dmgBench: 70719, group: '预测' },
  { name: 'T11 1命 10/10/10', talents: L10, cons: 1, sub: 161, gear: 194, dmgYou: 120702, dmgBench: 74808, group: '预测' },
  { name: 'T12 6命 10/10/10', talents: L10, cons: 6, sub: 161, gear: 194, dmgYou: 120702, dmgBench: 74808, group: '预测' },
  { name: 'T3  0命 武器 5 精', talents: L9, mult: 122492 / 100189, sub: 161, gear: 197, dmgYou: 122492, dmgBench: 75917, group: '验算' }
]

console.log('实验                    组别  线上(词条/数据)  算得(词条/数据)  配置倍率  抗性倍率')
for (const row of ONLINE) {
  const got = computeScores({
    ...BASE,
    talents: row.talents,
    cons: row.cons ?? 0,
    configMultiplier: row.mult ?? 1
  })
  const mine = [Math.round(got.subScore), Math.round(got.gearScore)]
  eq(mine, [row.sub, row.gear], `${row.name}：整数分 ${row.sub} / ${row.gear}`)
  rel(got.dmgYou, row.dmgYou, 0.0002, `${row.name}：D(你的副词条)`)
  rel(got.dmgBench, row.dmgBench, 0.0002, `${row.name}：D(配平后的 bench)`)
  near(got.gearScore, got.subScore * got.dmgBench / got.dmgDefault, 1e-9,
    `${row.name}：恒等式 数据分 = 词条分 × D(bench)/D(default)`)
  console.log(`  ${row.name.padEnd(24)} ${row.group}    ${row.sub} / ${row.gear}          ` +
    `${mine[0]} / ${mine[1]}          ${got.configRatio.toFixed(6)}   ${got.resistanceRatio.toFixed(6)}`)
}

// ───────────────────────────────────────────── 4. 公式边界
console.log('\n=== 4. 恒等式与边界 ===')

/* 用户给的数据点：0 命 171、1 命 194。命座只动抗性乘区，不动词条分 */
const c0 = computeScores({ ...BASE, talents: L10 })
const c1 = computeScores({ ...BASE, talents: L10, cons: 1 })
eq([Math.round(c0.gearScore), Math.round(c1.gearScore)], [171, 194], '用户数据点：0 命 171 → 1 命 194')
eq(Math.round(c1.subScore), Math.round(c0.subScore), '1 命不改词条分（抗性乘区上下约掉）')
near(c1.resistanceRatio, 1.138889, 1e-6, '1 命的倍率全来自抗性 0.9 → 1.025')
near(c1.dmgYou / c0.dmgYou, 1.138889, 1e-5, '1 命把分子放大 1.138889 倍')

/* 10 级倍率单项差 0.1% 取整看不出，复合命座就会跨边界 */
const wrongGear = c1.gearScore * (SCALE[9] / SCALE[8]) / (105983 / 100189)
eq(Math.round(wrongGear), 195, '误用上游倍率 1.058824 会把 194 算成 195')

/* T5 换主词条会改装备基线，本模块把它当输入，只用中间量验恒等式 */
const t5Sub = 100 * 80203 / 54842
const t5Gear = t5Sub * 54842 / 62095
eq(Math.round(t5Gear), 129, 'T5 主词条 攻/攻/攻：146 × 54842/62095 → 129')

/* 技能倍率必须只从核心天赋取：改 e / q 不该动任何分数 */
const onlyE = computeScores({ ...BASE, talents: { a: 9, e: 10, q: 9 } })
eq(Math.round(onlyE.gearScore), 161, '只升元素战技：数据分仍是 161')
eq(onlyE.configRatio, 1, '只升元素战技：配置倍率 = 1')

/* 两边都配平是另一种口径，不该混进 YSIN 分数 */
const bothBalanced = balanceOf(YOUR_ROLLS, BASIS, MELT.passiveCpct)
const symSub = 100 * damageOf(panelOf(bothBalanced.rolls, BASIS), true) /
  damageOf(benchPanel, true)
near(symSub, 169.1, 0.5, '对称口径（两侧都配平）约 169.1，与主口径 161 不同')

// ───────────────────────────────────────────── 5. 三个角色的基准读数
/*
 * 温迪的套装没有对应读数，本地从面板反解词条仍可计算，但不列入断言。
 * 下面三个流派的基准读数：
 *   雷电将军·伤害 116 / 123，Q 期望 67498、Q 暴击 109100（词条 36.8）
 *   甘雨·伤害     126 / 126，两段射期望 50014（词条 35.1）
 *   甘雨·融化     125 / 150，两段射期望 93193（词条 37.7）
 *
 * 这一组钉住三件事：
 *   ① 传进 computeScores 的 rolls 必须是**圣遗物副词条**，不含武器副词条与套装加成；
 *      拿整装词条算，甘雨会变成 140 / 161 而不是 126 / 125。
 *   ② 评分基线要含引擎的隐性加成（甘雨连射 20% 暴击、乐团 80 精通），来自 CSV 的
 *      「隐性面板加成」列，不是代码里的角色判断。
 *   ③ 技能等级倍率 / 命座降抗也来自 CSV 的数据列。
 *
 * 输入是这三个展柜角色的面板基线与圣遗物词条，全部写死在这里，不依赖网络或数据库。
 */
console.log('\n=== 5. 三个角色的基准读数 ===')

interface SiteCase {
  label: string
  avatarId: number
  schoolId: string
  basis: GearBasis
  /** 圣遗物副词条：已从面板反解值里扣掉武器副词条与套装 2 件套加成 */
  rolls: Rolls
  talents: { a: number, e: number, q: number }
  cons: number
  sub: number
  gear: number
  dmg: number
  /** 网站另给的「暴击」那一格，只给了雷神 */
  crit?: number
}

const SHOWCASE: SiteCase[] = [
  {
    label: '甘雨·伤害', avatarId: 10000037, schoolId: 'ganyu-1',
    basis: { baseAtk: 942.92, atkPct: 0.9624, flatAtk: 310.8, baseCpct: 0.05, baseCdmg: 1.5056, baseMastery: 80 },
    rolls: { atk: 10.790548, em: 2.681000, cpct: 12.609091, cdmg: 11.657576 },
    talents: { a: 10, e: 9, q: 10 }, cons: 1,
    sub: 126, gear: 126, dmg: 50014
  },
  {
    label: '甘雨·融化', avatarId: 10000037, schoolId: 'ganyuR',
    basis: { baseAtk: 942.92, atkPct: 0.9624, flatAtk: 310.8, baseCpct: 0.05, baseCdmg: 1.5056, baseMastery: 80 },
    rolls: { atk: 10.790548, em: 2.681000, cpct: 12.609091, cdmg: 11.657576 },
    talents: { a: 10, e: 9, q: 10 }, cons: 1,
    sub: 125, gear: 150, dmg: 93193
  }
]

/* 雷神·伤害 要走 f_u 和一次引擎 D(P)，无引擎近似差 1 分，由 test/ysin-miao.ts 覆盖 */
for (const c of SHOWCASE) {
  const seed = schoolsFor(c.avatarId)?.schools.find(s => s.id === c.schoolId)
  if (!seed) { console.log(`[FAIL] ${c.label}：找不到流派 ${c.schoolId}`); failed++; continue }
  const got = computeScores({
    preset: presetOf(seed),
    basis: c.basis,
    rolls: c.rolls,
    talents: c.talents,
    cons: c.cons
  })
  eq([Math.round(got.subScore), Math.round(got.gearScore)], [c.sub, c.gear], `${c.label}：词条分 / 数据分`)
  rel(got.dmgYou, c.dmg, 0.005, `${c.label}：期望伤害`)
  if (c.crit !== undefined) rel(got.dmgCrit, c.crit, 0.005, `${c.label}：暴击伤害`)
}

// ───────────────────────────────────────────── 6. 通用性：不认角色、不认流派 id
console.log('\n=== 6. 通用口径（不按角色 / 流派写死）===')

const stat = (key: string, rolls: number): StatRoll => ({ key, value: 0, rolls, effective: true })
const four = (setId: number, n = 4): ArtifactDbo[] =>
  Array.from({ length: n }, () => ({ setId })) as unknown as ArtifactDbo[]

/* 套装 2 件套面板加成从元数据文案里读，任何套装都走同一段代码 */
near(setPanelBonusOf(four(15020)).recharge ?? 0, 20 / 5.5, 1e-9, '绝缘 4 件：2 件套充能 20% → 3.6364 条')
near(setPanelBonusOf(four(15003)).mastery ?? 0, 80 / 20, 1e-9, '乐团 4 件：2 件套精通 80 点 → 4 条')
near(setPanelBonusOf(four(15044)).atk ?? 0, 18 / 5, 1e-9, '风起之日 4 件：2 件套攻击 18% → 3.6 条（新套装无需登记）')
eq(setPanelBonusOf(four(15020, 1)), {}, '只穿 1 件时 2 件套不生效')

/* 账本：甘雨的阿莫斯 49.62% 攻击 + 乐团 80 精通，从面板反解值里一次扣干净 */
const ledger = rollLedgerOf(
  [stat('atk', 20.714548), stat('mastery', 6.681), stat('cpct', 12.609091), stat('cdmg', 11.657576)],
  { atk: 9.924 }, four(15003)
)
near(ledger.artifact.atk, 10.790548, 1e-5, '甘雨：整装攻击 20.71 条 − 阿莫斯 9.924 条 = 圣遗物 10.79 条')
near(ledger.artifact.mastery, 2.681, 1e-9, '甘雨：整装精通 6.681 条 − 乐团 4 条 = 圣遗物 2.681 条')
near(ledger.artifact.cpct, 12.609091, 1e-9, '角色被动属引擎隐性加成，不进面板，因此不从词条里扣')
eq(ledger.artifact.hp, undefined, '账本只记给过的属性，下游用 ?? 0 取')

/* 扣掉的非圣遗物加成挪回基线后，panelOf 应还原玩家真实面板（甘雨 攻击 2669.9 / 精通 133.62） */
const fullBasis = withNonArtifact(
  { baseAtk: 942.92, atkPct: 0.4662, flatAtk: 310.8, baseCpct: 0.05, baseCdmg: 1.5056, baseMastery: 0 },
  ledger.bonus
)
const realPanel = panelOf(
  { atk: ledger.artifact.atk, em: ledger.artifact.mastery, cpct: ledger.artifact.cpct, cdmg: ledger.artifact.cdmg },
  fullBasis
)
near(realPanel.atk, 2669.917, 0.1, '补全基线后攻击面板还原为 2669.9')
near(realPanel.mastery, 133.62, 0.01, '补全基线后精通面板还原为 133.62')

/* 预设装配：改 id / 名字不该改变任何计算量；CSV 全部流派都能装配出合法预设 */
const sample = schoolsFor(10000002)!.schools[0]
eq(presetOf(sample).defaultBasis, presetOf({ ...sample, id: 'anything', name: '随便' }).defaultBasis,
  'presetOf 不认流派 id / 名字，同一行数据装配结果一致')
let allPresets = 0
let badPreset = 0
for (const ch of parseSchoolsCsv(fs.readFileSync(CSV_PATH, 'utf8')).characters) {
  for (const seed of ch.schools) {
    const p = presetOf(seed)
    if (!(p.dmgDefault > 0) || p.talentScale.length === 0 || !Number.isFinite(p.defaultBasis.baseAtk)) badPreset++
    allPresets++
  }
}
eq(badPreset, 0, `CSV 全部 ${allPresets} 个流派都能装配出合法预设（无角色特判）`)

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
console.log('未覆盖：T5 换主词条、T6/T7 改输出技能 —— 需要换装后的装备基线与配平点数据，本模块暂把它们当输入。')
process.exit(failed > 0 ? 1 : 0)
