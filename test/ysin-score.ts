/*
 * 词条分 / 数据分 —— 后端计算值与 YSIN 网页实测值对拍
 *
 * 线上基线来自 2026-11-08 的网页实证（../ysin-math/tools/ysin-data.ts 挂 CDP 走 YSIN 原生引擎，
 *  hook calculator.get 抓四个伤害，逐条记在 docs/YSIN-词条分算法.md §12.4）。
 *  甘雨·融化，副词条 20.7 / 6.7 / 12.6 / 11.7，默认整套 = 阿莫斯 1 精 / 乐团 4 /
 *  攻冰爆 / 90 级 0 命 / 技能 999，school.dText = 62095。
 *
 * 命座这一项在 2026-11-09 补进算法：甘雨 1 命「饮露」让霜华矢命中时敌人冰抗降 15%，
 * 默认小宝冰抗 10% → −5%，抗性乘区 0.9 → 1.025，倍率 1.138889。
 * 它只进数据分（默认整套写死 0 命），词条分上下约掉。线上 0 命 171、1 命 194，
 * 2~6 命与 1 命逐位相同（后面几命不改这个单次伤害数值）。
 *
 * 同一轮还修掉一个真会算错的地方：YSIN v4.8 的 9→10 级倍率是 1.057831，
 * 上游游戏倍率表给 1.058824。单看 171 分辨不出来，但乘上 1.138889 之后
 * 会算出 195 而不是 194。所以 10 级倍率按 YSIN 引擎实测标定（见 preset.ts）。
 *
 * 两组用例分开看，别混：
 *   A 组「独立预测」：只给天赋等级和命座，倍率来自引擎标定 + 抗性公式（纯游戏数据），
 *     词条分、数据分、绝对伤害都是后端自己算出来的，再和线上比。
 *   B 组「公式验算」：只有武器精炼没有独立模型，把线上实测的伤害倍率当输入，
 *     验的是「数据分 = 词条分 × 配置倍率」这条公式，不算独立预测。
 *
 * 已知边界：T5 换主词条会改装备基线（爆伤头 → 攻击头），那条基线数据没从网页读到，
 * 本模块目前把装备基线当输入，所以不覆盖；T6/T7 改的是配平点，同理。
 */
import {
  balanceOf,
  computeScores,
  damageOf,
  limitOf,
  panelOf,
  reactionOf,
  resistanceOf,
  type Rolls,
  type ScoreInput
} from '../src/gateway/ysin/score.ts'
import { GAN_YU_BASIS, GAN_YU_MELT, FROST_FLAKE_SCALE } from '../src/gateway/ysin/preset.ts'

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
  preset: GAN_YU_MELT,
  basis: GAN_YU_BASIS,
  rolls: YOUR_ROLLS,
  talents: { a: 9, e: 9, q: 9 }
}

// ───────────────────────────────────────────── 1. 面板、配平、伤害函数
console.log('=== 1. 面板 / 配平 / 伤害函数 ===')

const panel = panelOf(YOUR_ROLLS, GAN_YU_BASIS)
near(panel.atk, 3137.17, 0.01, '你的面板攻击 3137.17')
near(panel.cpct, 0.6658, 1e-9, '你的暴击率 66.58%')
near(panel.cdmg, 2.2782, 1e-9, '你的爆伤 227.82%')
eq(panel.mastery, 214, '你的精通 214')

const balanced = balanceOf(GAN_YU_MELT.bench, GAN_YU_BASIS)
near(balanced.k, 7.621212, 1e-5, '配平搬运 7.6212 条')
near(balanced.rolls.cpct, 16.621212, 1e-5, '配平后暴击条数 16.6212')
near(balanced.rolls.cdmg, 1.378788, 1e-5, '配平后爆伤条数 1.3788')
const benchPanel = panelOf(balanced.rolls, GAN_YU_BASIS)
near(benchPanel.cpct, 0.7985, 1e-9, '配平后暴击率 79.85%')
near(benchPanel.cdmg, 2 * 0.7985, 1e-9, '配平后爆伤 = 2 × 暴击率')
eq(limitOf(GAN_YU_MELT.bench), { atk: 7, em: 5, cpct: 15, cdmg: 15 }, '极限基准 7/5/15/15')
near(reactionOf(214, true), 1.36860, 1e-5, 'R(214) = 1.36860')
eq(reactionOf(214, false), 1, '不打反应时 R 恒为 1')
near(FROST_FLAKE_SCALE[9] / FROST_FLAKE_SCALE[8], 1.058824, 1e-5, '上游游戏倍率表 9→10 = 1.058824')
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
console.log('\n=== 3. 线上实测对拍（直接跑 node ../ysin-math/tools/ysin-data.ts 可复现）===')

interface OnlineRow {
  name: string
  talents: { a: number, e: number, q: number }
  /** 命座数，默认 0 */
  cons?: number
  /** 除技能、命座外的配置倍率。只有武器精炼用得到，由线上 dmgYou 反推，属输入 */
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

/* 为什么 10 级倍率必须用 YSIN 实测值标定：单项差 0.1% 取整看不出，复合命座就跨边界 */
const wrongGear = c1.gearScore * (FROST_FLAKE_SCALE[9] / FROST_FLAKE_SCALE[8]) / (105983 / 100189)
eq(Math.round(wrongGear), 195, '误用上游倍率 1.058824 会把 194 算成 195')

/* T5 换主词条：线上 dmgYou=80203、dmgBench=54842、dmgDefault=62095，
   词条分自己变成 146。本模块没拿到换装后的装备基线，只用线上中间量验恒等式。*/
const t5Sub = 100 * 80203 / 54842
const t5Gear = t5Sub * 54842 / 62095
eq(Math.round(t5Gear), 129, 'T5 主词条 攻/攻/攻：146 × 54842/62095 → 129')

/* 技能倍率必须只从核心天赋取：改 e / q 不该动任何分数 */
const onlyE = computeScores({ ...BASE, talents: { a: 9, e: 10, q: 9 } })
eq(Math.round(onlyE.gearScore), 161, '只升元素战技：数据分仍是 161')
eq(onlyE.configRatio, 1, '只升元素战技：配置倍率 = 1')

/* 两边都配平是另一种口径，不该混进 YSIN 分数 */
const bothBalanced = balanceOf(YOUR_ROLLS, GAN_YU_BASIS)
const symSub = 100 * damageOf(panelOf(bothBalanced.rolls, GAN_YU_BASIS), true) /
  damageOf(benchPanel, true)
near(symSub, 168.5, 0.5, '对称口径（两侧都配平）约 168.5，与主口径 161 不同')

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
console.log('未覆盖：T5 换主词条、T6/T7 改输出技能 —— 需要换装后的装备基线与配平点数据，本模块暂把它们当输入。')
process.exit(failed > 0 ? 1 : 0)
