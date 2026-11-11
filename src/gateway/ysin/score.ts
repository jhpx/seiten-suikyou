/*
 * YSIN 词条分 / 数据分 —— 纯计算实现，不跑战斗引擎、不连网页
 *
 * ── 算的是什么 ────────────────────────────────────────────────────────────
 * 两个分数都是「同一个核心输出技能的期望伤害」在相除，分子完全相同：
 *
 *   词条分 = 100 × D_default(你的副词条) / D_default(配平后的 bench)
 *   数据分 = 100 × D(你的实际配置) / D(默认整套，写死技能 999)
 *
 * 词条分的分子分母都用「默认整套」基线（defaultBasis），把玩家当前配置约掉——
 * 同一套副词条无论玩家实际带什么武器 / 套装 / 天赋，词条分都给同一分（基准 161）。
 * 这正是 YSIN「词条分只衡量副词条」的口径。技能倍率在词条分里上下同乘、约掉；
 * 在数据分里分母写死 999，约不掉。
 * 详细的推导与网页实测见 docs/词条分的数学模型.md §3.4、§7.3。
 *
 * ── 为什么能不跑伤害模拟器 ──────────────────────────────────────────────
 * 伤害写成 D = K·A·(1+p·q)·R(E)。三个伤害共用同一个 K，取比值时约掉，
 * 只剩攻击、双爆、反应三项各自成比。K 里唯一会随配置变的是技能倍率，
 * 单独提出来叫 configRatio，其余武器 / 命座等配置倍率由调用方给。
 *
 * ── 精度 ──────────────────────────────────────────────────────────────────
 * 全程全精度，不中途取整；取整只发生在展示层（本模块的调用方 / 测试）。
 */

/** 参与评分的四类副词条数，顺序固定为「攻、精、暴、爆」 */
export interface Rolls {
  atk: number
  em: number
  cpct: number
  cdmg: number
}

/** 面板上真正进伤害公式的四个数。暴击与爆伤一律写小数（66.58% 写成 0.6658） */
export interface Panel {
  atk: number
  cpct: number
  cdmg: number
  mastery: number
}

/** 不含副词条时的装备基线：白字、武器与主词条的攻击、羽毛固定攻击、天生双爆与精通 */
export interface GearBasis {
  baseAtk: number
  /** 武器攻击% + 沙漏攻击%，写小数 */
  atkPct: number
  flatAtk: number
  baseCpct: number
  baseCdmg: number
  baseMastery: number
}

/** 角色·流派的预设数据，与你的账号无关 */
export interface SchoolPreset {
  name: string
  bench: Rolls
  /** 核心输出技能挂在哪个天赋上；技能等级只从这一维取 */
  coreTalent: 'a' | 'e' | 'q'
  /** 核心输出技能各等级的倍率之和，数组下标 = 显示等级 − 1 */
  talentScale: readonly number[]
  /** YSIN 引擎实测的等级倍率比（相对 9 级）；有它时优先用它，覆盖上面的游戏倍率表 */
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
  /** 你的装备基线，仅供展示面板（panel）使用。词条分与数据分的算分都按预设的
     defaultBasis 进行（数据分再乘核心天赋 / 命座 / 精炼等配置倍率）；玩家实际装备相对
     默认整套的强弱已经折算进 rolls 与配置倍率，不再单独读这里的 basis。 */
  basis: GearBasis
  /** 你的副词条数，原始值、不配平 */
  rolls: Rolls
  /** 你的天赋等级，游戏里显示的值 1..15 */
  talents: { a: number, e: number, q: number }
  /** 你的命座数 0..6，默认 0；只影响抗性这一类乘区，不改副词条面板 */
  cons?: number
  /** 武器精炼 / 命座之外的其他配置倍率，默认 1 */
  configMultiplier?: number
}

export interface ScoreResult {
  /** 词条分、极限分、达成率、数据分，全部全精度 */
  subScore: number
  maxScore: number
  reach: number
  gearScore: number
  /** 三个绝对伤害，由 dmgDefault 标定 */
  dmgYou: number
  dmgBench: number
  dmgDefault: number
  /** 中间量，方便对拍 */
  panel: Panel
  benchPanel: Panel
  balancedBench: Rolls
  balanceK: number
  configRatio: number
  /** 抗性乘区之比：默认整套 ÷ 你的命座。1 命甘雨是 1.025/0.9 = 1.138889 */
  resistanceRatio: number
}

/** 一条词条值多少：四档强化的均值。爆伤正好是暴击的两倍 */
export const ROLL = { atk: 0.05, em: 20, cpct: 0.033, cdmg: 0.066 } as const

/** 默认整套的技能等级写死 9（引擎内部 [8,8,8] 是 0 基） */
const DEFAULT_TALENT_LEVEL = 9

/** 词条数 → 面板 */
export function panelOf (rolls: Rolls, basis: GearBasis): Panel {
  return {
    atk: basis.baseAtk * (1 + basis.atkPct + ROLL.atk * rolls.atk) + basis.flatAtk,
    cpct: basis.baseCpct + ROLL.cpct * rolls.cpct,
    cdmg: basis.baseCdmg + ROLL.cdmg * rolls.cdmg,
    mastery: basis.baseMastery + ROLL.em * rolls.em
  }
}

/** 精通给反应伤害的加成：1 + 2.78E/(E+1400) */
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

/** 去掉 K 之后的伤害；取比值时 K 会约掉，所以这里不需要它 */
export function damageOf (panel: Panel, reaction: boolean): number {
  return panel.atk * (1 + panel.cpct * panel.cdmg) * reactionOf(panel.mastery, reaction)
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi)

/** 配平：把 k 条爆伤搬成暴击，搬到 q = 2p。只动 cpct / cdmg 两项 */
export function balanceOf (rolls: Rolls, basis: GearBasis): { rolls: Rolls, k: number } {
  const p = panelOf(rolls, basis)
  const V = 2 * p.cpct + p.cdmg
  const k = clamp(
    (V / 4 - p.cpct) / ROLL.cpct,
    -rolls.cpct,
    Math.min(rolls.cdmg, (1 - p.cpct) / ROLL.cpct)
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
    cdmg: scale(bench.cdmg)
  }
}

/** 技能等级倍率：优先用 YSIN 引擎实测标定，没有标定的等级回退到游戏倍率表 */
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

/**
 * 配置倍率 = 技能倍率 × 抗性倍率 × 其他配置倍率。
 * 三项都在「你的配置」和「默认整套」之间取比，所以直接进入数据分；
 * 词条分的分子分母都带这三项，会约掉。
 */
function configRatioOf (preset: SchoolPreset, input: ScoreInput): { ratio: number, resistanceRatio: number } {
  const level = input.talents[preset.coreTalent]
  const enemyRes = preset.enemyRes ?? 0.1
  const resistanceRatio = resistanceOf(enemyRes - shredOf(preset, input.cons ?? 0)) / resistanceOf(enemyRes)
  const ratio = talentRatioOf(preset, level) * resistanceRatio * (input.configMultiplier ?? 1)
  return { ratio, resistanceRatio }
}

/**
 * 一次算出四个分数和三个绝对伤害。
 *
 * 两分的「玩家副词条」侧都套在预设的 defaultBasis 上，把玩家当前配置约掉：
 *  · 词条分 = 100 × D_default(你的副词条) / D_default(配平后的 bench) —— 纯副词条质量，
 *    同一套副词条无论玩家带什么武器 / 套装 / 天赋都给同一分（161 基准点）。
 *  · 数据分 = 词条分 × 配置倍率（技能等级 / 命座降抗 / 武器精炼）。「玩家装备 = 默认整套」
 *    时配置倍率 = 1，数据分与词条分同值（网站实测 161 / 161）；武器精炼 / 命座 / 技能等级
 *    只进数据分，不进词条分。
 *
 * 这与 YSIN 网站口径一致：网站在默认整套下 D(你的副词条)=100189、D(配平 bench)=62095，
 * 数据分 = 100189/62095×100 = 161；换武器精炼到 5 精 D(你的副词条)=122492、D(配平 bench)
 * 随配置倍率放大到 75917，数据分 = 122492/62095×100 = 197，词条分仍是 161。
 */
export function computeScores (input: ScoreInput): ScoreResult {
  const { preset, basis, rolls } = input

  /* 基准词条固定按 defaultBasis 配平，不随玩家当前面板漂移——否则同一个角色不同玩家
     看到的「基准双爆」会不一样（之前曾算出 16.6/1.4 这种极端分裂），词条分也会随配置飘。 */
  const benchBalanced = balanceOf(preset.bench, preset.defaultBasis)
  const limitBalanced = balanceOf(limitOf(preset.bench), preset.defaultBasis)

  /* ── 两分共用 defaultBasis 的「玩家副词条」面板：把当前配置约掉 ── */
  const panelDefault = panelOf(rolls, preset.defaultBasis)
  const benchPanelDefault = panelOf(benchBalanced.rolls, preset.defaultBasis)
  const limitPanelDefault = panelOf(limitBalanced.rolls, preset.defaultBasis)
  const dSub = damageOf(panelDefault, preset.reaction)
  const dBench = damageOf(benchPanelDefault, preset.reaction)
  const dLimit = damageOf(limitPanelDefault, preset.reaction)
  const subScore = 100 * dSub / dBench
  const maxScore = 100 * dLimit / dBench
  const reach = 100 * subScore / maxScore

  const config = configRatioOf(preset, input)
  const configRatio = config.ratio
  const dmgDefault = preset.dmgDefault
  /* dBench 与下方 dDefaultBench 同为 defaultBasis 下的 bench，恒相等；显式写出便于核对 */
  const dDefaultBench = damageOf(panelOf(benchBalanced.rolls, preset.defaultBasis), preset.reaction)
  const dmgBench = dmgDefault * configRatio * (dBench / dDefaultBench)
  const dmgYou = dmgDefault * configRatio * (dSub / dDefaultBench)
  const gearScore = 100 * dmgYou / dmgDefault

  /* panel：玩家真实面板（用 gearBasisFrom 提取的 basis），仅供展示与调试，不参与算分 */
  const panel = panelOf(rolls, basis)

  return {
    subScore, maxScore, reach, gearScore,
    dmgYou, dmgBench, dmgDefault,
    panel, benchPanel: benchPanelDefault,
    balancedBench: benchBalanced.rolls,
    balanceK: benchBalanced.k,
    configRatio,
    resistanceRatio: config.resistanceRatio
  }
}
