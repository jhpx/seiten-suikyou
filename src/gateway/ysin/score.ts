/*
 * YSIN 词条分 / 数据分。
 *
 * 词条分 T = 100·D(P)/D(P*)：P* 与 P 共用骨架，只把副词条换成标准词条并配平双爆；
 * 骨架因子约掉，剩下四个面板比 T = 100·(A/A*)·(C/C*)·(R/R*)·(f_u/f_u*)，C = 1 + min(p,1)·q。
 * 数据分 G = 100·D(P)/D0：P0 是流派默认整套，跨骨架；有 D(P) 时直接算，否则走近似。
 *
 * 双爆用 V = 2p+q 表示预算，配平取 p=V/4、q=V/2；f_u 合并充能转攻击 / 转增伤两条渠道。
 * 全程全精度，取整只在展示层。
 */

/** 参与评分的四条面板副词条；recharge 只有充能机制的角色才用得到 */
export interface Rolls {
  atk: number
  em: number
  cpct: number
  cdmg: number
  recharge?: number
}

/** 面板上真正进伤害公式的五个数。暴击与爆伤一律写小数（66.58% 写成 0.6658） */
export interface Panel {
  atk: number
  cpct: number
  cdmg: number
  mastery: number
  recharge: number
}

/** 不含副词条时的装备基线：白字、武器与主词条的攻击、羽毛固定攻击、天生双爆/精通/充能 */
export interface GearBasis {
  baseAtk: number
  /** 武器攻击% + 沙漏攻击%，写小数 */
  atkPct: number
  flatAtk: number
  baseCpct: number
  baseCdmg: number
  baseMastery: number
  /** 不含圣遗物副词条时的充能（小数，100% 写 1）。缺省按 1 处理 */
  baseRecharge?: number
}

/**
 * 充能转换模型：u 先加上 uBonus（薙草在爆发期间的 30%），再按两条渠道转伤害。
 * 数值全部来自游戏数据 / 逆向确认，不是拟合参数；没有该机制时整个对象缺省。
 */
export interface RechargeModel {
  /** 武器在爆发期间的充能加成，薙草 = 0.30 */
  uBonus: number
  /** 充能 → 攻击%（白字口径）的每点转换率，薙草 = 0.28 */
  etaRate: number
  /** 攻击% 上限，薙草 = 0.8 */
  etaCap: number
  /** 充能 → 增伤的每点转换率，雷神天赋 = 0.4 */
  thetaRate: number
  /** 套装（绝缘四）充能 → 增伤的每点转换率，= 0.25 */
  thetaFlatRate: number
  /** 套装增伤上限，= 0.75 */
  thetaFlatCap: number
  /** 与充能无关的伤害加成总和 Φ0，雷神 = 0.27 + 0.4662 = 0.7362 */
  phi0: number
}

/** 角色·流派的预设数据，与你的账号无关 */
export interface SchoolPreset {
  name: string
  bench: Rolls
  /** 标准词条的充能条数 t_u；缺省 0 */
  benchRecharge?: number
  /** 技能自带暴击 β（甘雨重击 0.2，Q 0）；缺省 0 */
  passiveCpct?: number
  /** 充能转换模型；缺省表示该流派不吃充能，f_u ≡ 1 */
  rechargeModel?: RechargeModel
  /** 核心输出技能挂在哪个天赋上；技能等级只从这一维取 */
  coreTalent: 'a' | 'e' | 'q'
  /** 核心输出技能各等级的倍率之和，数组下标 = 显示等级 − 1 */
  talentScale: readonly number[]
  /** 等级倍率比（相对 9 级）；有它时覆盖上面的游戏倍率表 */
  talentRatioOverride?: Readonly<Record<number, number>>
  /** 默认敌人对该元素的抗性，写小数；YSIN / miao 默认小宝 10% */
  enemyRes?: number
  /** 各命座给核心输出技能带来的抗性降低，下标 = 命座数 − 1，只累加已解锁的部分 */
  consResShred?: readonly number[]
  /** 默认整套下同一技能的期望伤害（网页 school.dText 可以直接读到） */
  dmgDefault: number
  /** 默认整套的装备基线 */
  defaultBasis: GearBasis
  /** 不打反应时精通不产生伤害，R(E) 恒为 1 */
  reaction: boolean
}

export interface ScoreInput {
  preset: SchoolPreset
  /** 你的装备基线（玩家骨架：白字、主词条、武器/套装/被动等非圣遗物副词条的量） */
  basis: GearBasis
  /** 你的圣遗物副词条数（已扣掉武器 / 套装 / 被动等来源），原始值、不配平 */
  rolls: Rolls
  /** 你的天赋等级，游戏里显示的值 1..15 */
  talents: { a: number, e: number, q: number }
  /** 你的命座数 0..6，默认 0；只影响抗性这一类乘区，不改副词条面板 */
  cons?: number
  /** 武器精炼 / 命座之外的其他配置倍率，默认 1 */
  configMultiplier?: number
  /** 引擎给出的当前伤害；给了直接算数据分，不给走无引擎近似 */
  dmgYou?: number
}

export interface ScoreResult {
  /** 词条分、极限分、达成率、数据分，全部全精度 */
  subScore: number
  maxScore: number
  reach: number
  gearScore: number
  /** 三个绝对伤害：当前 / 参考 / 默认整套 */
  dmgYou: number
  dmgBench: number
  dmgDefault: number
  /** 同一发技能打出暴击时的伤害（网站另列的一格） */
  dmgCrit: number
  /** 当前真实面板（不含技能被动暴击 β，β 只在评分时叠加） */
  panel: Panel
  /** 真正拿去算分的词条数。恒等于 input.rolls —— 扣减只在 ysin.ts 的账本里做一次 */
  scoringRolls: Rolls
  /** 参考侧面板（已配平；同样不含 β） */
  benchPanel: Panel
  /** 参考侧配平后的词条数（atk/em/cpct/cdmg） */
  balancedBench: Rolls
  balanceK: number
  configRatio: number
  /** 抗性乘区之比：默认整套 ÷ 你的命座。1 命甘雨是 1.025/0.9 = 1.138889 */
  resistanceRatio: number
}

/** 一条词条值多少：四档强化的均值。爆伤正好是暴击的两倍，充能 5.5% */
export const ROLL = { atk: 0.05, em: 20, cpct: 0.033, cdmg: 0.066, recharge: 0.055 } as const

/** 默认整套的技能等级写死 9（引擎内部 [8,8,8] 是 0 基） */
const DEFAULT_TALENT_LEVEL = 9

/** 词条数 → 面板（不含技能被动 β；β 在评分时单独叠加） */
export function panelOf (rolls: Rolls, basis: GearBasis): Panel {
  return {
    atk: basis.baseAtk * (1 + basis.atkPct + ROLL.atk * rolls.atk) + basis.flatAtk,
    cpct: basis.baseCpct + ROLL.cpct * rolls.cpct,
    cdmg: basis.baseCdmg + ROLL.cdmg * rolls.cdmg,
    mastery: basis.baseMastery + ROLL.em * rolls.em,
    recharge: (basis.baseRecharge ?? 1) + ROLL.recharge * (rolls.recharge ?? 0)
  }
}

/** 精通给反应伤害的加成：1 + 2.78E/(E+1400)；不打反应时恒为 1 */
export function reactionOf (mastery: number, enabled: boolean): number {
  return enabled ? 1 + 2.78 * mastery / (mastery + 1400) : 1
}

/**
 * 抗性乘区，与 vendor/miao/models/dmg/DmgCalc.js 同一个分段函数。
 * res 写小数：小宝冰抗 10% 传 0.1 得 0.9；降到 −5% 传 −0.05 得 1.025。
 * 负抗性只按一半计（1 − kx/200），这是原神自己的规则，不是近似。
 */
export function resistanceOf (res: number): number {
  const kx = res * 100
  if (kx >= 75) return 1 / (1 + 3 * kx / 100)
  if (kx >= 0) return (100 - kx) / 100
  return 1 - kx / 200
}

/** 双爆因子 C = 1 + min(p,1)·q；p>1 时按 1 截断 */
export function critOf (p: number, q: number): number {
  return 1 + Math.min(p, 1) * q
}

/** 参考侧双爆配平：p* = clamp(V/4, γ, λ) 再截到 1，q* = V − 2p*。γ 是基线暴击，λ 是上限 */
export function balanceCrit (V: number, gamma: number, lambda = 1): { p: number, q: number } {
  let p = Math.min(Math.max(V / 4, gamma), lambda)
  p = Math.min(p, 1)
  return { p, q: V - 2 * p }
}

/** 充能残差因子 f_u：攻击渠道按白字展开（η·a0/A），增伤渠道按 Φ0 展开 */
export function fuOf (u: number, A: number, baseAtk: number, model: RechargeModel): number {
  const ue = u + model.uBonus
  const over = Math.max(ue - 1, 0)
  const eta = Math.min(model.etaRate * over, model.etaCap)
  const theta = model.thetaRate * over + Math.min(model.thetaFlatRate * ue, model.thetaFlatCap)
  return (1 + eta * baseAtk / A) * (1 + theta / (1 + model.phi0))
}

/** 去掉 K 之后的伤害；取比值时 K 会约掉，所以这里不需要它 */
export function damageOf (panel: Panel, reaction: boolean): number {
  return panel.atk * critOf(panel.cpct, panel.cdmg) * reactionOf(panel.mastery, reaction)
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi)

/**
 * 把 k 条爆伤搬成暴击，搬到 q = 2p，只动 cpct / cdmg 两项。
 * 保留给测试与旧调用；computeScores 用 balanceCrit。beta 是技能自带暴击。
 */
export function balanceOf (rolls: Rolls, basis: GearBasis, beta = 0): { rolls: Rolls, k: number } {
  const p = panelOf(rolls, basis)
  const pEff = p.cpct + beta
  const V = 2 * pEff + p.cdmg
  const k = clamp(
    (V / 4 - pEff) / ROLL.cpct,
    -rolls.cpct,
    Math.min(rolls.cdmg, (1 - pEff) / ROLL.cpct)
  )
  return {
    rolls: { ...rolls, cpct: rolls.cpct + k, cdmg: rolls.cdmg - k },
    k
  }
}

/** 极限基准：把 bench 每项放大到 5/3 倍再取整 */
export function limitOf (bench: Rolls): Rolls {
  const scale = (x: number): number => Math.round(5 * x / 3)
  return {
    atk: scale(bench.atk),
    em: scale(bench.em),
    cpct: scale(bench.cpct),
    cdmg: scale(bench.cdmg),
    recharge: bench.recharge === undefined ? undefined : scale(bench.recharge)
  }
}

/** 技能等级倍率：优先用覆盖表，没覆盖的等级回退到游戏倍率表 */
function talentRatioOf (preset: SchoolPreset, level: number): number {
  const override = preset.talentRatioOverride?.[level]
  if (override !== undefined) return override
  const now = preset.talentScale[level - 1]
  const base = preset.talentScale[DEFAULT_TALENT_LEVEL - 1]
  if (!now || !base) throw new Error(`${preset.name}：技能等级 ${level} 没有倍率数据`)
  return now / base
}

/** 命座给核心输出技能的抗性降低，只累加已经解锁的命座 */
function shredOf (preset: SchoolPreset, cons: number): number {
  const shreds = preset.consResShred ?? []
  const n = Math.min(Math.max(0, Math.floor(cons)), shreds.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += shreds[i]
  return sum
}

/** 配置因子 ρ_K 中与「天赋 + 命座」有关的部分：技能倍率比 × 抗性比 × 额外倍率 */
function configRatioOf (preset: SchoolPreset, input: ScoreInput): { ratio: number, resistanceRatio: number } {
  const level = input.talents[preset.coreTalent]
  const enemyRes = preset.enemyRes ?? 0.1
  const resistanceRatio = resistanceOf(enemyRes - shredOf(preset, input.cons ?? 0)) / resistanceOf(enemyRes)
  const ratio = talentRatioOf(preset, level) * resistanceRatio * (input.configMultiplier ?? 1)
  return { ratio, resistanceRatio }
}

/** 一套词条在某个骨架上产生的 φ(x) = A·C·R；f_u 另算，因为它依赖充能模型 */
function phiOf (rolls: Rolls, basis: GearBasis, beta: number, reaction: boolean): number {
  const A = basis.baseAtk * (1 + basis.atkPct + ROLL.atk * rolls.atk) + basis.flatAtk
  const p = basis.baseCpct + beta + ROLL.cpct * rolls.cpct
  const q = basis.baseCdmg + ROLL.cdmg * rolls.cdmg
  const E = basis.baseMastery + ROLL.em * rolls.em
  return A * critOf(p, q) * reactionOf(E, reaction)
}

/**
 * 一次算出四个分数和三个绝对伤害。
 * 词条分的分子分母共用骨架，K(σ) 约掉，只剩 A、C、R、f_u 四个比。
 * 数据分有 input.dmgYou 时按定义式算；否则用 G = T·ρ_K·φ(x*)/φ(x0) 近似，
 * 骨架与默认不同时该近似缺 Φ0（武器/套装增伤）。
 */
export function computeScores (input: ScoreInput): ScoreResult {
  const { preset, basis } = input
  /* rolls 已是圣遗物副词条（调用方扣过武器 / 套装 / 被动），本模块不再扣一次 */
  const rolls = input.rolls
  const beta = preset.passiveCpct ?? 0
  const t: Rolls = {
    atk: preset.bench.atk,
    em: preset.bench.em,
    cpct: preset.bench.cpct,
    cdmg: preset.bench.cdmg,
    recharge: preset.benchRecharge ?? 0
  }

  /* ── 当前侧：玩家骨架 + 玩家副词条 ── */
  const A = basis.baseAtk * (1 + basis.atkPct + ROLL.atk * rolls.atk) + basis.flatAtk
  const p = basis.baseCpct + beta + ROLL.cpct * rolls.cpct
  const q = basis.baseCdmg + ROLL.cdmg * rolls.cdmg
  const E = basis.baseMastery + ROLL.em * rolls.em
  const u = (basis.baseRecharge ?? 1) + ROLL.recharge * (rolls.recharge ?? 0)

  /* 参考侧：同一骨架 + 标准词条，再配平 */
  const Astar = basis.baseAtk * (1 + basis.atkPct + ROLL.atk * t.atk) + basis.flatAtk
  const pRaw = basis.baseCpct + beta + ROLL.cpct * t.cpct
  const qRaw = basis.baseCdmg + ROLL.cdmg * t.cdmg
  const Vstar = 2 * pRaw + qRaw
  const gamma = basis.baseCpct + beta
  const bal = balanceCrit(Vstar, gamma)
  const Estar = basis.baseMastery + ROLL.em * t.em
  const ustar = (basis.baseRecharge ?? 1) + ROLL.recharge * (t.recharge ?? 0)

  const C = critOf(p, q)
  const Cstar = critOf(bal.p, bal.q)
  const rRatio = reactionOf(E, preset.reaction) / reactionOf(Estar, preset.reaction)
  const fuRatio = preset.rechargeModel
    ? fuOf(u, A, basis.baseAtk, preset.rechargeModel) / fuOf(ustar, Astar, basis.baseAtk, preset.rechargeModel)
    : 1

  const subScore = 100 * (A / Astar) * (C / Cstar) * rRatio * fuRatio

  /* 极限分：bench × 5/3，同样按参考侧配平 */
  const lim = limitOf(t)
  const limA = basis.baseAtk * (1 + basis.atkPct + ROLL.atk * lim.atk) + basis.flatAtk
  const limP = basis.baseCpct + beta + ROLL.cpct * lim.cpct
  const limQ = basis.baseCdmg + ROLL.cdmg * lim.cdmg
  const limBal = balanceCrit(2 * limP + limQ, gamma)
  const limE = basis.baseMastery + ROLL.em * lim.em
  const limU = (basis.baseRecharge ?? 1) + ROLL.recharge * (lim.recharge ?? 0)
  const limFu = preset.rechargeModel
    ? fuOf(limU, limA, basis.baseAtk, preset.rechargeModel) / fuOf(ustar, Astar, basis.baseAtk, preset.rechargeModel)
    : 1
  const maxScore = 100 * (limA / Astar) * (critOf(limBal.p, limBal.q) / Cstar) *
    (reactionOf(limE, preset.reaction) / reactionOf(Estar, preset.reaction)) * limFu
  const reach = 100 * subScore / maxScore

  /* ── 数据分 ── */
  const config = configRatioOf(preset, input)
  const configRatio = config.ratio
  const dmgDefault = preset.dmgDefault

  let gearScore: number
  let dmgYou: number
  if (input.dmgYou !== undefined && input.dmgYou > 0) {
    /* 精确口径：D(P) 由引擎给出，数据分就是定义式 */
    dmgYou = input.dmgYou
    gearScore = 100 * dmgYou / dmgDefault
  } else {
    /* 无引擎近似：G = T·ρ_K·φ(x*)/φ(x0) */
    const phiStar = Astar * Cstar * reactionOf(Estar, preset.reaction) *
      (preset.rechargeModel ? fuOf(ustar, Astar, basis.baseAtk, preset.rechargeModel) : 1)
    const b0 = preset.defaultBasis
    const p0Raw = b0.baseCpct + beta + ROLL.cpct * t.cpct
    const q0Raw = b0.baseCdmg + ROLL.cdmg * t.cdmg
    const bal0 = balanceCrit(2 * p0Raw + q0Raw, b0.baseCpct + beta)
    const A0 = b0.baseAtk * (1 + b0.atkPct + ROLL.atk * t.atk) + b0.flatAtk
    const E0 = b0.baseMastery + ROLL.em * t.em
    const u0 = (b0.baseRecharge ?? 1) + ROLL.recharge * (t.recharge ?? 0)
    const phi0 = phiOf(t, b0, beta, preset.reaction) *
      (preset.rechargeModel ? fuOf(u0, A0, b0.baseAtk, preset.rechargeModel) : 1)
    /* phiOf 用的是未配平的 C，这里换成配平后的 C0 */
    const phi0Bal = phi0 / critOf(p0Raw, q0Raw) * critOf(bal0.p, bal0.q)
    gearScore = subScore * configRatio * (phiStar / phi0Bal)
    dmgYou = dmgDefault * gearScore / 100
  }

  /* 参考伤害由 T 反推：D(P*) = 100·D(P)/T */
  const dmgBench = 100 * dmgYou / subScore

  /* 期望 → 暴击：(1+q)/(1+p_eff·q)，用当前面板双爆 */
  const dmgCrit = dmgYou * (1 + q) / critOf(p, q)

  const benchRolls: Rolls = {
    atk: t.atk, em: t.em, cpct: t.cpct, cdmg: t.cdmg, recharge: t.recharge
  }
  const balanceK = (qRaw - 2 * pRaw) / (4 * ROLL.cpct)
  const balancedBench: Rolls = {
    ...benchRolls,
    cpct: benchRolls.cpct + balanceK,
    cdmg: benchRolls.cdmg - balanceK
  }

  return {
    subScore, maxScore, reach, gearScore,
    dmgYou, dmgBench, dmgDefault, dmgCrit,
    panel: panelOf(rolls, basis),
    scoringRolls: rolls,
    benchPanel: panelOf(balancedBench, basis),
    balancedBench,
    balanceK,
    configRatio,
    resistanceRatio: config.resistanceRatio
  }
}
