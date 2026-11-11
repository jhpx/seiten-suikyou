/*
 * YSIN 词条算法网关 —— 按 YSIN 小程序真实的算法重写，不改动 miao 内核。
 *
 * ── 结论先说：YSIN 算的不是「圣遗物副词条有多少条」 ─────────────────────────────
 * 它算的是「你**整套装备**在某个属性上，扣掉角色天生数值和圣遗物主词条之后，还剩多少个
 * 标准词条」。所以 5 件圣遗物理论上限 45 条，YSIN 却能报出 51.7 —— 因为它把**武器副词条**
 * 和**套装效果**也算进了同一个池子。这一点用甘雨实测可以逐位对上（见文末算例）。
 *
 * ── 单条词条的基准值（一次强化的均值）────────────────────────────────────────
 *   生命% 5 ／ 攻击% 5 ／ 防御% 6.2 ／ 元素精通 20 ／ 暴击率 3.3 ／ 暴击伤害 6.6 ／ 充能 5.5
 * 这组数直接来自 YSIN 自己的源码（词条收益提示里的 case 分支），不是社区传言。
 *
 * ── 每个属性的词条数 ────────────────────────────────────────────────────────
 *   净加成 = 面板总值 − 角色基础值 − 圣遗物主词条
 *   词条数 = 净加成 ÷ 上面那组基准值
 *
 * 三围（生命/攻击/防御）要先把固定值折成百分比，因为面板给的是「白字+绿字」的总和：
 *   净加成% = (面板总三围 − 白字 − 固定值主词条) ÷ 白字 × 100 − 百分比主词条
 * 这样副属性里的小攻击、沙漏上的攻击%、武器上的攻击% 就会落进同一个百分比里。
 *
 * 基础值直接取 miao 的 `Attr.getBase()`：暴击 5、爆伤 50+突破、精通 0、充能 100、三围是白字。
 * 突破加成已经含在里面，不需要另外加。
 *
 * ── 甘雨实测（uid 101242308，阿莫斯之弓）────────────────────────────────────
 *   面板：攻击 2669.917 / 白字 942.92 / 精通 133.62 / 暴击 46.61 / 爆伤 227.5
 *   主词条：羽毛 小攻击 310.8、沙漏 攻击% 46.62、理之冠 爆伤 62.16
 *   攻击 = ((2669.917 − 942.92 − 310.8)/942.92×100 − 46.62)/5 = 20.71
 *   精通 = 133.62 / 20                                        = 6.68
 *   暴击 = (46.61 − 5) / 3.3                                  = 12.61
 *   爆伤 = (227.5 − 88.4 − 62.16) / 6.6                       = 11.66
 *   合计 51.66 → 小程序显示 20.7 / 6.7 / 12.6 / 11.7，总 51.7 ✔
 *
 * 精通 133.62 里有 80 点是套装效果（副词条只有 53.62）——miao 的面板会把套装算进去，
 * 所以只要读面板，这类来源自动就带上了。
 *
 * ── 顺带更正两个常见误解 ────────────────────────────────────────────────────
 * ① 渊星（AbyssalEvaluator）的 `__SUB_STAT_BENEFIT` 把精通记成 19.75，而且**只**扫圣遗物
 *    副词条、不含武器和套装。它跟 YSIN 小程序不是同一套数，照抄渊星会系统性偏低。
 * ② YSIN 的「词条分（毕业值）」是**伤害期望比值**，不是「词条数 ÷ 默认词条数」。
 *
 * ── 词条分的官方口径（网页版帮助页原文，逐字抄）──────────────────────────────
 *    词条分：  [A] = 目前圣遗物 + 目前配置
 *              [B] = 默认圣遗物 + 目前配置        →  A / B × 100
 *    数据分：  [C] = 默认圣遗物 + 默认配置        →  A / C × 100
 *    默认圣遗物 = 18 双爆 + 4 条 + 3×(有效属性数−3) 条 → 3/4/5 有效分别是 22/25/28
 *    默认配置   = 5 星角色 + 专武 + 技能 999
 *    而且「由于不考虑主属性，不合适的主属性不会影响词条分，但会影响数据分」。
 *
 *    关键约束（装备页帮助第 3 条）：
 *      「充能词条一般不会参与评分，因为**不穿绝缘**的情况下，大部分角色充能与伤害无关」
 *    → 默认把充能踢出集合；**穿绝缘 4 件套是例外**，4 件套会把充能效率的 25% 转成元素爆发
 *      增伤，此时充能确实换伤害。实测香菱（绝缘4，19.4 条充能）词条分 120，若把充能全剔掉
 *      只剩 114.8，显然不对；按 5 折计入得 122.3，与实测差 1.9%。
 *
 * ── 为什么本模块给的是近似值 ────────────────────────────────────────────────
 * 精确复现 161 需要 YSIN 自己的伤害引擎（逐角色「流派」的倍率/反应/套装），miao 的
 * calc.js 是另一套模型，跑出来的比值差 5%~15%。所以这里退一步：用「计分词条数 ÷ 默认
 * 条数」当近似，实测 甘雨 167.0 / 小程序 161（+3.7%）、香菱 122.3 / 小程序 120（+1.9%）。
 * 偏差来自伤害的边际递减（攻击条多了会被稀释），不是舍入。要更准只能把 YSIN 的引擎搬过来。
 */
import { ArtisAttr, Weapon as MiaoWeapon } from '../../index.ts'
import { toMiaoProfile } from '../miao/materialize.ts'
import { setIdOfItem } from '../../common/names.ts'
import { usefulAttr } from '../../../vendor/miao/resources/meta-gs/artifact/artis-mark.js'
import type { CharacterDbo } from '../../repository/dbo/character.ts'
import type { ArtifactDbo } from '../../repository/dbo/artifact.ts'
import { computeScores, type GearBasis, type Rolls, type ScoreResult } from './score.ts'
import { presetOf, schoolsFor } from './schools.ts'

/* 一次强化的均值 —— YSIN 源码里的「基数」 */
const ROLL_BASE: Record<string, number> = {
  hp: 5,
  atk: 5,
  def: 6.2,
  mastery: 20,
  cpct: 3.3,
  cdmg: 6.6,
  recharge: 5.5
}

/* 三围的固定值形态（花/羽毛/小攻击副词条） */
const FLAT_KEY: Record<string, string> = { atk: 'atkPlus', hp: 'hpPlus', def: 'defPlus' }
/* 固定值 → 它所属的百分比属性（miao 侧统用） */
const FLAT_TO_PCT: Record<string, string> = { atkPlus: 'atk', hpPlus: 'hp', defPlus: 'def' }

/* YSIN 只认这 7 个属性；元素伤/物伤/治疗只可能是主词条，不进词条统计 */
const SEVEN = ['atk', 'hp', 'def', 'cpct', 'cdmg', 'mastery', 'recharge']

/* 武器元数据的属性 key → 本模块的 key（miao 用 atkPct 这类写法） */
const WEAPON_KEY: Record<string, string> = {
  atkPct: 'atk',
  hpPct: 'hp',
  defPct: 'def',
  cpct: 'cpct',
  cdmg: 'cdmg',
  mastery: 'mastery',
  recharge: 'recharge'
}

/* 角色在 usefulAttr 里查不到时的兜底流派（攻暴爆充） */
const DEFAULT_GENRE = new Set(['atk', 'cpct', 'cdmg', 'recharge'])

/*
 * 这个角色哪些属性算有效 —— 取 miao `usefulAttr` 里 weight > 0 的 7 标准项。
 * （dmg / phy / heal 不在 YSIN 的 7 项里，不纳入。）
 */
export function effectiveStatsFor (charName: string): Set<string> {
  /* usefulAttr 是静态字面量表，没有索引签名；用 Record 收一下才能按名字取值 */
  const cfg = (usefulAttr as Record<string, Record<string, number> | undefined>)[charName]
  if (!cfg) return new Set(DEFAULT_GENRE)
  const out = new Set<string>()
  for (const key of SEVEN) {
    if ((cfg[key] ?? 0) > 0) out.add(key)
  }
  return out
}

export interface StatRoll {
  key: string
  /** 扣掉基础值与主词条后的净加成：百分比属性是百分数，三围已折成等价百分比 */
  value: number
  /** 词条数 = value ÷ 一次强化均值 */
  rolls: number
  effective: boolean
}

export interface CharacterYsin {
  avatarId: number
  charName: string
  /** 7 个属性各多少条（无效属性也给，方便看废词条占比） */
  stats: StatRoll[]
  /** 有效属性合计 —— 就是这个角色在 YSIN 小程序里显示的「总词条数」 */
  total: number
  /** 无效属性合计（YSIN 不展示，也不计入总分） */
  invalidTotal: number
  /** 其中来自武器的词条数（小程序把它算进总词条了） */
  weaponRolls: number
  /** 武器贡献按属性拆开，供「其中武器」列用；没有的属性不给键 */
  weaponByKey: Record<string, number>
  /** 你的「不含副词条」装备基线：白字、主词条、天生双爆与精通。
      仅供展示与调试；算分（词条分 / 数据分）走预设的 defaultBasis，不再读这里。
      详见 gearBasisFrom 与 score.ts computeScores 的注释。 */
  basis: GearBasis
  /** 总词条数扣掉武器 —— 只剩圣遗物副词条 + 套装效果，能和 miao 放同一张表比 */
  artifactTotal: number
  /** miao 侧：所有副词条 ÷ 单 roll 最大值，不按角色过滤 */
  miaoEff: number
  /** miao 侧：只算有效副词条，再 ÷0.85 把分母换到均值 */
  miaoValid: number
  /** miao 侧：被过滤掉的废词条（已 ÷0.85） */
  miaoOnly: number
  /** 词条分（毕业度）的近似值 —— 口径见 scoreOf 的注释，与小程序有 ±4% 偏差。
      仅用于「与 miao 条数对照」这类辅助视图；真正的分数请看下方 `scores`。 */
  score: ScoreBreakdown
  /**
   * 每个流派**正确**的分数（词条分 / 数据分，与网站逐一核对过的伤害比），key = 流派 id。
   * 由 score.ts 的 computeScores 算出，不再用条数近似。
   *
   * 口径边界（与 docs 一致）：
   *  - 词条分：分子分母同配，技能倍率 / 命座 / 精炼全部约掉，对所有流派都精确；
   *  - 数据分：分母写死默认整套，只有预设带等级倍率表（目前仅甘雨·融化）时才随
   *    技能等级正确；其余流派默认按 9/9/9 等价配置算，技能等级 ≠ 9 时数据分会偏差。
   */
  scores: Record<string, ScoreResult>
}

/** 词条分的中间量，展示层要不要用由调用方决定 */
export interface ScoreBreakdown {
  /** 真正参与计分的属性：有效属性里剔掉充能（绝缘 4 件套除外） */
  counted: string[]
  /** 参与计分的词条数合计（含武器副词条、充能已折算） */
  rolls: number
  /** 默认圣遗物的条数：18 双爆 + 4 + 3×(N−3)，即 22 / 25 / 28 */
  defaultRolls: number
  /** rolls ÷ defaultRolls × 100 */
  value: number
  /** 是否穿绝缘 4 件套 —— 决定充能算不算进计分 */
  emblem: boolean
  /** 参与计分的充能条数（折算前，已扣武器） */
  rechargeRolls: number
}

/* 把 5 件圣遗物的主词条按 key 累加（key 与面板属性同名，如 atkPlus / atk / cdmg） */
function mainSumOf (artifacts: ArtifactDbo[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const artifact of artifacts || []) {
    const data = ArtisAttr.getData({
      mainId: artifact.mainPropId ?? 0,
      attrIds: artifact.appendPropIds || [],
      level: Math.max(0, (Number(artifact.levelRaw) || 1) - 1),
      star: artifact.star ?? 5
    }, 1, 'gs') as { main?: { key?: string; value?: number } }
    const key = data.main?.key
    if (key) out.set(key, (out.get(key) || 0) + (data.main?.value || 0))
  }
  return out
}

/*
 * 面板口径的 7 项词条数。
 * miao 的 `attr` 是「白字 + 绿字」的总和，`base` 是白字与天生数值，`main` 是主词条贡献。
 */
function panelRolls (
  attr: Record<string, number>,
  base: Record<string, number>,
  main: Map<string, number>
): StatRoll[] {
  return SEVEN.map(key => {
    const baseValue = base[key] ?? 0
    const mainValue = main.get(key) ?? 0
    let value: number
    if (FLAT_KEY[key]) {
      /* 三围：先把固定值主词条从总面板里剔掉，剩下的绿字按白字折成百分比 */
      const white = baseValue || 1
      const flatMain = main.get(FLAT_KEY[key]) ?? 0
      value = ((attr[key] ?? 0) - baseValue - flatMain) / white * 100 - mainValue
    } else {
      value = (attr[key] ?? 0) - baseValue - mainValue
    }
    return { key, value, rolls: value / ROLL_BASE[key], effective: false }
  })
}

/*
 * 把「目前配置」拆成 score.ts 要的装备基线：把副词条那部分从面板里减掉，剩下的
 * 就是白字、主词条、天生双爆和套装精通。
 *
 * 这么减完再交给 panelOf(rolls, basis) 会正好还原 miao 的 attr 面板，因为
 * panelRolls 和 panelOf 用的是同一套公式，只是方向相反：
 *   attr.atk   = base.atk × (1 + (value.atk + main.atk)/100) + main.atkPlus
 *   panelOf    = base.atk × (1 + atkPct + 0.05·rolls.atk) + flatAtk
 * 而 0.05·rolls.atk 就是 value.atk/100，双爆 / 精通同理。
 * 所以这不是近似，是把同一份面板换一种写法。
 *
 * 单位：miao 面板里的双爆是百分数（46.61 表示 46.61%），score.ts 要小数，故 ÷100。
 */
function gearBasisFrom (
  attr: Record<string, number>,
  base: Record<string, number>,
  main: Map<string, number>,
  stats: StatRoll[]
): GearBasis {
  const value = new Map(stats.map(s => [s.key, s.value]))
  return {
    baseAtk: base.atk ?? 0,
    atkPct: (main.get('atk') ?? 0) / 100,
    flatAtk: main.get('atkPlus') ?? 0,
    baseCpct: ((attr.cpct ?? 0) - (value.get('cpct') ?? 0)) / 100,
    baseCdmg: ((attr.cdmg ?? 0) - (value.get('cdmg') ?? 0)) / 100,
    baseMastery: (attr.mastery ?? 0) - (value.get('mastery') ?? 0)
  }
}

/* 武器副词条贡献了多少条 —— 只用于把「整装词条」拆成「武器 + 圣遗物」 */
function weaponRollsOf (character: CharacterDbo, base: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  const weapon = MiaoWeapon.get(character.weapon?.itemId) as
    { calcAttr?: (lv: number, promote: number) => { attr?: { key?: string; value?: number } } } | undefined
  if (!weapon?.calcAttr) return out
  const calc = weapon.calcAttr(character.weapon.level ?? 1, character.weapon.promote ?? 0)
  const rawKey = calc?.attr?.key ?? ''
  const key = WEAPON_KEY[rawKey]
  const value = calc?.attr?.value ?? 0
  if (!key || !value) return out
  /* 万一哪天有武器带固定值副词条，先按白字折成百分比 */
  const isFlat = rawKey.endsWith('Plus')
  const pct = isFlat ? value / (base[key] || 1) * 100 : value
  out[key] = pct / ROLL_BASE[key]
  return out
}

/* 计分时不看的属性。官方口径：充能与伤害无关，只是循环问题，没有统一标准 —— 但绝缘是例外 */
const SCORE_EXCLUDE = new Set(['recharge'])

/* 绝缘之旗印的 setId —— 4 件套把「元素充能效率的 25%」换成元素爆发增伤 */
const EMBLEM_SET_ID = 15020

/*
 * 绝缘 4 件套下充能的折算权重。
 * 理论系数就是 4 件套的 25%，但那只作用在大招区、且要除以增伤基数，实际收益低于面值；
 * 香菱实测（19.4 条充能、词条分 120）反解出来约 0.44，先取整数半权 0.5 → 122.3（+1.9%）。
 * 只有一个实测点，不做更细的拟合；以后拿到更多绝缘角色的分数再校准。
 */
const EMBLEM_RECHARGE_WEIGHT = 0.5

/* 5 件里至少 4 件是绝缘 —— 只有凑满 4 件套才有「充能换增伤」这条
 *  · setId 优先（人工/模拟件换套装时 itemId 还是原件那一个），没有就从 itemId 推 */
export function isEmblem4 (artifacts: ArtifactDbo[]): boolean {
  let n = 0
  for (const a of artifacts || []) {
    if ((a.setId ?? setIdOfItem(a.itemId)) === EMBLEM_SET_ID) n++
  }
  return n >= 4
}

/*
 * 默认圣遗物的条数：18 条双爆 + 4 条 + 每多一种有效属性再加 3 条。
 * 3 有效 → 22、4 有效 → 25、5 有效 → 28，和帮助页的「22-28 词条」对上。
 */
export function defaultRollsOf (effectiveCount: number): number {
  return 22 + 3 * Math.max(0, effectiveCount - 3)
}

/*
 * 词条分 = 参与计分的词条数 ÷ 默认条数 × 100。
 * 只做「条数」层面的近似 —— 真正的定义是伤害期望 A/B，攻击/精通多了会被稀释，
 * 这一层递减这里没有，所以和实测差 ±4%（数据点见文件头）。
 *
 * 分子要扣掉武器副词条：A、B 两套都戴着同一把武器，它在伤害比值里是约掉的，
 * 留在分子里会白送几十条（甘雨 阿莫斯 9.9 条攻击，直接多出 40 分）。
 */
export function scoreOf (stats: StatRoll[], weaponByKey: Record<string, number> = {}, emblem = false): ScoreBreakdown {
  const counted: string[] = []
  let rolls = 0
  let rechargeRolls = 0
  for (const s of stats) {
    if (!s.effective) continue
    if (SCORE_EXCLUDE.has(s.key)) {
      if (!emblem) continue
      rechargeRolls = s.rolls - (weaponByKey[s.key] ?? 0)
      rolls += rechargeRolls * EMBLEM_RECHARGE_WEIGHT
      counted.push(s.key)
      continue
    }
    counted.push(s.key)
    rolls += s.rolls - (weaponByKey[s.key] ?? 0)
  }
  const defaultRolls = defaultRollsOf(counted.length)
  return { counted, rolls, defaultRolls, value: rolls / defaultRolls * 100, emblem, rechargeRolls }
}

export function evaluateCharacter (character: CharacterDbo): CharacterYsin | null {
  const profile = toMiaoProfile(character)
  if (!profile) return null

  const attr = (profile.attr || {}) as Record<string, number>
  const base = (profile.base || {}) as Record<string, number>
  const main = mainSumOf(character.artifacts || [])

  const effective = effectiveStatsFor(profile.char.name)
  const stats = panelRolls(attr, base, main).map(s => ({ ...s, effective: effective.has(s.key) }))

  let total = 0
  let invalidTotal = 0
  for (const s of stats) {
    if (s.effective) total += s.rolls
    else invalidTotal += s.rolls
  }

  const weaponByKey = weaponRollsOf(character, base)
  let weaponRolls = 0
  for (const s of stats) {
    if (s.effective) weaponRolls += weaponByKey[s.key] ?? 0
  }

  /* miao 侧：只聚合副词条（用 ArtisAttr 已经算好的 eff），÷0.85 换到均值分母。
     全程全精度，舍入只在最外层展示（AGENTS.md「数值精度」）。 */
  let miaoEff = 0
  let miaoValid = 0
  let miaoOnly = 0
  const effByKey = new Map<string, number>()
  for (const artifact of character.artifacts || []) {
    const data = ArtisAttr.getData({
      mainId: artifact.mainPropId ?? 0,
      attrIds: artifact.appendPropIds || [],
      level: Math.max(0, (Number(artifact.levelRaw) || 1) - 1),
      star: artifact.star ?? 5
    }, 1, 'gs') as { attrs: Array<{ key: string; eff: number }> }
    for (const a of data.attrs || []) {
      const key = FLAT_TO_PCT[a.key] ?? a.key
      effByKey.set(key, (effByKey.get(key) || 0) + a.eff)
    }
  }
  for (const [key, rawEff] of effByKey) {
    miaoEff += rawEff
    if (effective.has(key)) miaoValid += rawEff / 0.85
    else miaoOnly += rawEff / 0.85
  }

  const charName = profile.char.name
  const basis = gearBasisFrom(attr, base, main, stats)
  const byKey = new Map(stats.map(s => [s.key, s.rolls]))
  const talent = (profile.talent || {}) as Record<string, number>
  const talents = { a: talent.a ?? 9, e: talent.e ?? 9, q: talent.q ?? 9 }

  /* 每个流派的正确分数（伤害比）。basis 与 rolls 跟上面完全一致，保证和网站同口径。
     没有匹配流派时 scores 为空，不影响上面的条数统计。 */
  const scores: Record<string, ScoreResult> = {}
  const group = schoolsFor(charName)
  if (group) {
    const rolls: Rolls = {
      atk: byKey.get('atk') ?? 0,
      em: byKey.get('mastery') ?? 0,
      cpct: byKey.get('cpct') ?? 0,
      cdmg: byKey.get('cdmg') ?? 0
    }
    for (const seed of group.schools) {
      scores[seed.id] = computeScores({
        preset: presetOf(charName, seed),
        basis,
        rolls,
        talents,
        cons: character.cons ?? 0
      })
    }
  }

  return {
    avatarId: character.avatarId!,
    charName,
    stats,
    total,
    invalidTotal,
    weaponRolls,
    weaponByKey,
    basis,
    artifactTotal: total - weaponRolls,
    miaoEff,
    miaoValid,
    miaoOnly,
    score: scoreOf(stats, weaponByKey, isEmblem4(character.artifacts || [])),
    scores
  }
}
