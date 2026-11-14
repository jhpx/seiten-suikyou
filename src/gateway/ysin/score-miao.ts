/*
 * 当前伤害 D(P)：词条分改闭式后，数据分仍然需要的那一次引擎调用。
 *
 * miao 的甘雨 1 命降抗只作用于非 Q 技能；Q 流派按 CSV 的命座降抗补乘 consK，
 * 非 Q 流派不重复乘。
 */

import { calcDamage } from '../miao/damage.ts'
import type { MiaoProfile } from '../miao/materialize.ts'
import { resistanceOf, type ScoreResult } from './score.ts'

/** 抗性乘区，与 score.ts / miao 同一个分段函数：小宝冰抗 10% → 0.9；−5% → 1.025 */
export { resistanceOf }

/** 命座降抗的抗性比；只给 talentSlot==='q' 且 unlock 了对应命座的流派用 */
export function consResistanceK (consShred: number[], cons: number, enemyRes = 0.1): number {
  const n = Math.min(Math.max(0, Math.floor(cons)), consShred.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += consShred[i]
  if (sum <= 0) return 1
  return resistanceOf(enemyRes - sum) / resistanceOf(enemyRes)
}

export interface CurrentDamageInput {
  /** 当前真实配装（toMiaoProfile 产物） */
  profile: MiaoProfile
  /** 评分条目在角色 calc.js details 里的下标 */
  entry: number
  /** 输出技能类型：决定 Q 流派的命座降抗补偿 */
  talentSlot?: 'a' | 'e' | 'q'
  /** 角色被动给该技能的额外暴击（小数，甘雨重击 0.2）；只用于「期望 → 暴击」换算 */
  passiveCpct?: number
  /** 命座降抗（6 项，小数） */
  consShred?: number[]
  /** 玩家命座数 */
  cons?: number
  /** 默认敌人抗性（小数） */
  enemyRes?: number
}

export interface CurrentDamageResult {
  /** 当前这发技能的期望伤害（已含 Q 流派命座降抗补偿） */
  dmgYou: number
  /** 期望那发打出暴击时的伤害（用真实面板双爆换算） */
  dmgCrit: number
}

/**
 * 算一次当前配装的期望伤害；calc.js 没算出该条目时返回 null，调用方退回无引擎路径。
 */
export async function currentDamageOf (input: CurrentDamageInput): Promise<CurrentDamageResult | null> {
  const data = await calcDamage(input.profile, { enemyLv: 90 })
  const avg = data?.entries[input.entry]?.avg ?? null
  if (avg == null) return null

  const consK = (input.talentSlot === 'q' && input.consShred?.length)
    ? consResistanceK(input.consShred, input.cons ?? 0, input.enemyRes)
    : 1
  const dmgYou = avg * consK

  /* 期望 → 暴击：(1+q)/(1+p·q)；p 用技能有效暴击（含被动 β） */
  const attr = input.profile.attr as Record<string, number>
  const cpct = Math.min((attr.cpct ?? 0) / 100 + (input.passiveCpct ?? 0), 1)
  const cdmg = (attr.cdmg ?? 0) / 100
  const dmgCrit = dmgYou * (1 + cdmg) / (1 + cpct * cdmg)

  return { dmgYou, dmgCrit }
}

/**
 * 把一次引擎伤害覆写进闭式结果：数据分回到定义式 G = 100·D(P)/D0，
 * 参考伤害由 D(P*) = 100·D(P)/T 反推。词条分 / 极限分 / 达成率不动。
 */
export function applyCurrentDamage (base: ScoreResult, dmg: CurrentDamageResult): ScoreResult {
  return {
    ...base,
    dmgYou: dmg.dmgYou,
    dmgCrit: dmg.dmgCrit,
    gearScore: 100 * dmg.dmgYou / base.dmgDefault,
    dmgBench: 100 * dmg.dmgYou / base.subScore
  }
}
