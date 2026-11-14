/*
 * YSIN 闭式 + 单次 D(P) 集成测试，分三段：
 *   ① computeScores 在零引擎调用下算出四个样本的词条分 / 数据分；
 *   ② currentDamageOf 只跑一次 miao；
 *   ③ evaluateCharacter 经 CSV 装配后，四个流派的结果仍落在整数读数上。
 * 样本数值与容差见下方各段。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ingestPayload } from '../src/gateway/enka/enka.service.ts'
import { toMiaoProfile } from '../src/gateway/miao/materialize.ts'
import { evaluateCharacter } from '../src/gateway/ysin/ysin.ts'
import { computeScores, type GearBasis, type Rolls, type SchoolPreset } from '../src/gateway/ysin/score.ts'
import { applyCurrentDamage, currentDamageOf } from '../src/gateway/ysin/score-miao.ts'

const ENKA = fileURLToPath(new URL('../.workbuddy/tmp/enka-3.json', import.meta.url))
const payload = JSON.parse(readFileSync(ENKA, 'utf8'))
const chars: any[] = (ingestPayload(payload, { source: 'enka' }) as any)?.account?.characters ?? []

let failed = 0
let passed = 0
function near (actual: number, expected: number, tol: number, label: string): void {
  const d = Math.abs(actual - expected)
  const ok = d <= tol
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}（期望 ${expected}，算得 ${actual.toFixed(4)}，差 ${d.toFixed(4)} ≤ ${tol}）`)
  ok ? passed++ : failed++
}
function eqInt (actual: number, expected: number, label: string): void {
  const got = Math.round(actual)
  const ok = got === expected
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}（线上 ${expected}，算得 ${actual.toFixed(2)} → ${got}）`)
  ok ? passed++ : failed++
}
function rel (actual: number, expected: number, pct: number, label: string): void {
  const e = Math.abs(actual - expected) / expected
  const ok = e <= pct
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}（线上 ${expected}，算得 ${actual.toFixed(1)}，相对误差 ${(e * 100).toFixed(3)}% ≤ ${(pct * 100).toFixed(1)}%）`)
  ok ? passed++ : failed++
}

// ───────────────────────────────────────────── 1. 闭式：四样本
console.log('=== 1. 闭式 T（零引擎调用）===')

const GANYU_BASIS: GearBasis = {
  baseAtk: 942.92, atkPct: 0.9624, flatAtk: 310.8,
  baseCpct: 0.05, baseCdmg: 1.5056, baseMastery: 80, baseRecharge: 1
}
const GANYU_ROLLS: Rolls = { atk: 10.790548, em: 2.681, cpct: 12.609091, cdmg: 11.657576, recharge: 0 }
const RAIDEN_BASIS: GearBasis = {
  baseAtk: 945.31, atkPct: 0, flatAtk: 310.8,
  baseCpct: 0.05, baseCdmg: 1.1216, baseMastery: 0,
  baseRecharge: 3.0945 - 0.055 * 9.19
}
const RAIDEN_ROLLS: Rolls = { atk: 7.58501, em: 1.1655, cpct: 10.60606, cdmg: 9.419697, recharge: 9.19 }

const FLAT_SCALE: readonly number[] = Array(15).fill(1)
function samplePreset (
  name: string, bench: Rolls, benchRecharge: number, passiveCpct: number,
  dmgDefault: number, defaultBasis: GearBasis, reaction: boolean
): SchoolPreset {
  return {
    name, bench, benchRecharge, passiveCpct, coreTalent: 'a', talentScale: FLAT_SCALE,
    dmgDefault, defaultBasis, reaction, enemyRes: 0.1
  }
}

const CASES = [
  {
    label: '甘雨·伤害', preset: samplePreset('甘雨·伤害', { atk: 4, em: 0, cpct: 9, cdmg: 9 }, 0, 0.2, 39762, GANYU_BASIS, false),
    basis: GANYU_BASIS, rolls: GANYU_ROLLS, dmg: 50020.8561, wantT: 125.6366, wantG: 125.8007
  },
  {
    label: '甘雨·融化', preset: samplePreset('甘雨·融化', { atk: 4, em: 3, cpct: 9, cdmg: 9 }, 0, 0.2, 62095, GANYU_BASIS, true),
    basis: GANYU_BASIS, rolls: GANYU_ROLLS, dmg: 93190.3532, wantT: 124.5828, wantG: 150.0771
  },
  {
    label: '甘雨·Q', preset: samplePreset('甘雨·Q', { atk: 4, em: 0, cpct: 9, cdmg: 9 }, 3, 0, 4383.4, GANYU_BASIS, false),
    basis: GANYU_BASIS, rolls: GANYU_ROLLS, dmg: 5228.6298, wantT: 118.5050, wantG: 119.2825
  },
  {
    label: '雷神·伤害', preset: {
      ...samplePreset('雷神·伤害', { atk: 4, em: 0, cpct: 9, cdmg: 9 }, 3, 0, 55067, RAIDEN_BASIS, false),
      coreTalent: 'q' as const,
      rechargeModel: {
        uBonus: 0.30, etaRate: 0.28, etaCap: 0.8,
        thetaRate: 0.4, thetaFlatRate: 0.25, thetaFlatCap: 0.75, phi0: 0.7362
      }
    },
    basis: RAIDEN_BASIS, rolls: RAIDEN_ROLLS, dmg: 67510.0353, wantT: 115.7571, wantG: 122.5962
  }
]

for (const c of CASES) {
  const got = computeScores({
    preset: c.preset, basis: c.basis, rolls: c.rolls,
    talents: { a: 10, e: 9, q: 10 }, cons: 0, dmgYou: c.dmg
  })
  /* T 容差 0.02：样本里的 r_A 只给到 4~5 位小数 */
  near(got.subScore, c.wantT, 0.02, `${c.label}：词条分 T`)
  near(got.gearScore, c.wantG, 0.02, `${c.label}：数据分 G = 100·D(P)/D0`)
  /* D(P*) 的反推只依赖 T 的相对精度，用相对容差而不是绝对差 */
  rel(got.dmgBench, 100 * c.dmg / c.wantT, 0.0001, `${c.label}：D(P*) = 100·D(P)/T`)
}

// ───────────────────────────────────────────── 2. 一次引擎调用 D(P)
console.log('\n=== 2. 单次 miao 伤害 D(P) ===')

const profileOf = (avatarId: number) => {
  const ch = chars.find(x => x.avatarId === avatarId)!
  return { ch, profile: toMiaoProfile(ch)! }
}
const GAN_YU = 10000037
const RAIDEN = 10000052
const ganyu = profileOf(GAN_YU)
const raiden = profileOf(RAIDEN)
const ganyuConsShred = [0.15, 0, 0, 0, 0, 0]

const g1 = await currentDamageOf({
  profile: ganyu.profile, entry: 1, talentSlot: 'a', passiveCpct: 0.2,
  consShred: ganyuConsShred, cons: 1
})
rel(g1!.dmgYou, 50014, 0.005, '甘雨·伤害 D(P) 50014')
const gR = await currentDamageOf({
  profile: ganyu.profile, entry: 2, talentSlot: 'a', passiveCpct: 0.2,
  consShred: ganyuConsShred, cons: 1
})
rel(gR!.dmgYou, 93193, 0.005, '甘雨·融化 D(P) 93193')
const gQ = await currentDamageOf({
  profile: ganyu.profile, entry: 3, talentSlot: 'q', passiveCpct: 0,
  consShred: ganyuConsShred, cons: 1
})
rel(gQ!.dmgYou, 5208, 0.005, '甘雨·Q D(P) 5208（miao 倍率差 0.4%）')
rel(gQ!.dmgCrit, 8279, 0.005, '甘雨·Q 暴击伤害 8279')
const r1 = await currentDamageOf({
  profile: raiden.profile, entry: 1, talentSlot: 'q', passiveCpct: 0, cons: 0
})
rel(r1!.dmgYou, 67498, 0.005, '雷神·伤害 D(P) 67498')

// ───────────────────────────────────────────── 3. 生产链路集成
/* 这一条把「CSV 的 entry / 被动暴击 / 命座降抗 / 充能转换」到装配的
   正确性一并验证：任何一列错位，词条分或数据分都会离开展柜整数。 */
console.log('\n=== 3. 集成：evaluateCharacter 经 CSV 走闭式 + 单次 D(P) ===')
const ganyuYsin = (await evaluateCharacter(chars.find(x => x.avatarId === GAN_YU)!))!
const raidenYsin = (await evaluateCharacter(chars.find(x => x.avatarId === RAIDEN)!))!
const sc = (ysin: any, id: string) => ysin.scores[id]

eqInt(sc(ganyuYsin, 'ganyu-1').subScore, 126, '甘雨·伤害 词条分 126')
eqInt(sc(ganyuYsin, 'ganyu-1').gearScore, 126, '甘雨·伤害 数据分 126')
eqInt(sc(ganyuYsin, 'ganyuR').subScore, 125, '甘雨·融化 词条分 125')
eqInt(sc(ganyuYsin, 'ganyuR').gearScore, 150, '甘雨·融化 数据分 150')
/* 甘雨 Q 的 T=118.505 落在 118.5 的显示边界，断言区间而不是取整 */
near(sc(ganyuYsin, 'ganyuQ').subScore, 118.5, 0.6, '甘雨·Q 词条分 118~119（边界）')
eqInt(sc(ganyuYsin, 'ganyuQ').gearScore, 119, '甘雨·Q 数据分 119')
eqInt(sc(raidenYsin, 'leidianjiangjun-1').subScore, 116, '雷神·伤害 词条分 116')
eqInt(sc(raidenYsin, 'leidianjiangjun-1').gearScore, 123, '雷神·伤害 数据分 123')

/* 词条分只衡量副词条：它与命座、天赋无关（参考侧同骨架，K 严格约掉）。
   这里用雷神 0 命与甘雨 1 命作反例：把 cons 改成 6，T 不变、G 才变。 */
const raidenSeed = (await import('../src/gateway/ysin/schools.ts')).schoolsFor(RAIDEN)!
  .schools.find(s => s.id === 'leidianjiangjun-1')!
const raidenPreset = (await import('../src/gateway/ysin/schools.ts')).presetOf(raidenSeed)
const raidenRolls = raidenYsin.ledger.artifact
const t0 = computeScores({
  preset: raidenPreset, basis: raidenYsin.basis,
  rolls: { atk: raidenRolls.atk ?? 0, em: raidenRolls.mastery ?? 0, cpct: raidenRolls.cpct ?? 0, cdmg: raidenRolls.cdmg ?? 0, recharge: raidenRolls.recharge ?? 0 },
  talents: { a: 6, e: 9, q: 10 }, cons: 0
})
const t6 = computeScores({
  preset: raidenPreset, basis: raidenYsin.basis,
  rolls: { atk: raidenRolls.atk ?? 0, em: raidenRolls.mastery ?? 0, cpct: raidenRolls.cpct ?? 0, cdmg: raidenRolls.cdmg ?? 0, recharge: raidenRolls.recharge ?? 0 },
  talents: { a: 6, e: 9, q: 10 }, cons: 6
})
near(t6.subScore, t0.subScore, 1e-9, '词条分与命座无关（K 严格约掉）')

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)
