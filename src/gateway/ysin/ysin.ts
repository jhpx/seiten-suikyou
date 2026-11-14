/*
 * YSIN 词条与评分网关：从面板反解词条、拆出圣遗物副词条账本，再交给 score.ts 算分。
 *
 * 词条数 = (面板总值 − 角色基础值 − 圣遗物主词条) ÷ 单条基准值；三围先折成百分比。
 * 反解出的是「整装词条」，含武器副词条与 2 件套加成。算分前扣掉这两份得到 artifact，
 * 扣掉的 bonus 折进 basis，保证 panelOf(artifact, basis) 仍等于玩家真实面板。
 * 角色 / 流派的差异都在 schools.csv，这里不按 id 分支。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArtisAttr, Weapon as MiaoWeapon } from '../../index.ts'
import { toMiaoProfile } from '../miao/materialize.ts'
import { setIdOfItem } from '../../common/names.ts'
import { usefulAttr } from '../../../vendor/miao/resources/meta-gs/artifact/artis-mark.js'
import type { CharacterDbo } from '../../repository/dbo/character.ts'
import type { ArtifactDbo } from '../../repository/dbo/artifact.ts'
import { computeScores, ROLL, type GearBasis, type Rolls, type ScoreResult } from './score.ts'
import { applyCurrentDamage, currentDamageOf } from './score-miao.ts'
import { presetOf, schoolsFor } from './schools.ts'

/* 套装元数据：YSIN 把 2 件套给面板的加成也算进了「词条」，扣减时要按套装通用地读出来 */
const SET_DATA_PATH = fileURLToPath(new URL(
  '../../../vendor/miao/resources/meta-gs/artifact/data.json', import.meta.url))
interface ArtifactSetMeta {
  name: string
  idxs?: Record<string, { id: number }>
  skills?: Record<string, string>
}

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

/* 套装 2 件套文案里出现的属性名 → 本模块的 7 项 key。
   例：「元素充能效率提高20%。」「元素精通提高80点。」「攻击力提高18%。」 */
const SET_ATTR_KEY: Record<string, string> = {
  '元素充能效率': 'recharge',
  '元素精通': 'mastery',
  '攻击力': 'atk',
  '暴击率': 'cpct',
  '暴击伤害': 'cdmg',
  '生命值': 'hp',
  '防御力': 'def'
}

/* enka 的 setId → 套装元数据。enka 与 miao 用两套 id，靠部件 itemId 反查连起来 */
const SET_BY_ID: Map<number, ArtifactSetMeta> = (() => {
  const map = new Map<number, ArtifactSetMeta>()
  const data = JSON.parse(fs.readFileSync(SET_DATA_PATH, 'utf8')) as Record<string, ArtifactSetMeta>
  for (const set of Object.values(data)) {
    for (const part of Object.values(set.idxs ?? {})) {
      const sid = setIdOfItem(part.id)
      if (sid) map.set(sid, set)
    }
  }
  return map
})()

/**
 * 当前装备里生效的 2 件套「面板加成」折算成词条数。
 *
 * 通用规则：同一 setId 凑够 2 件就生效一次（4 件也只算 2 件套那一层），
 * 从元数据的 skills.2 文案里读数值与属性，再除以该属性的一条均值。
 * 4 件套那种「转增伤」「条件下才触发」的效果不进面板，文案里没有「提高 X」也就不会被解析。
 */
export function setPanelBonusOf (artifacts: ArtifactDbo[]): Record<string, number> {
  const count = new Map<number, number>()
  for (const a of artifacts || []) {
    const sid = a.setId ?? setIdOfItem(a.itemId)
    if (sid) count.set(sid, (count.get(sid) ?? 0) + 1)
  }
  const out: Record<string, number> = {}
  for (const [sid, n] of count) {
    if (n < 2) continue
    const text = SET_BY_ID.get(sid)?.skills?.['2'] ?? ''
    const m = /(.+?)提高\s*([\d.]+)\s*(%|点)/.exec(text)
    if (!m) continue
    const key = SET_ATTR_KEY[m[1]]
    if (!key) continue
    out[key] = (out[key] ?? 0) + Number(m[2]) / ROLL_BASE[key]
  }
  return out
}

/** 词条账本：把面板反解值拆成「圣遗物副词条」和「其他来源」，全角色同一套算法 */
export interface RollLedger {
  /** 面板反解的整装词条（7 项，含武器副词条与套装面板加成） */
  gross: Record<string, number>
  /** 非圣遗物来源：武器副词条 + 生效的 2 件套面板加成 */
  bonus: Record<string, number>
  /** 圣遗物副词条 = gross − bonus；评分与网站那格「词条」都用它 */
  artifact: Record<string, number>
}

export function rollLedgerOf (
  stats: StatRoll[],
  weaponByKey: Record<string, number>,
  artifacts: ArtifactDbo[]
): RollLedger {
  const bonus = setPanelBonusOf(artifacts)
  const gross: Record<string, number> = {}
  const artifact: Record<string, number> = {}
  for (const s of stats) {
    gross[s.key] = s.rolls
    const nonArtifact = (weaponByKey[s.key] ?? 0) + (bonus[s.key] ?? 0)
    artifact[s.key] = Math.max(0, s.rolls - nonArtifact)
    bonus[s.key] = nonArtifact
  }
  return { gross, bonus, artifact }
}

/**
 * 把刚从词条里扣掉的非圣遗物加成挪回装备基线。
 *
 * 这样 basis 与 defaultBasis 是同一种东西：「除圣遗物副词条外的一切面板量」。
 * computeScores 用 panelOf(圣遗物词条, basis) 就能还原玩家真实面板（暴击伤害那格
 * 要读真实双爆）；词条分的参考侧也用同一份 basis + 标准词条，不再切到 defaultBasis。
 * 不挪的话，武器带暴击/爆伤副词条的角色（天空之翼、护摩之杖…）会被少算双爆。
 */
export function withNonArtifact (basis: GearBasis, bonus: Record<string, number>): GearBasis {
  return {
    ...basis,
    atkPct: basis.atkPct + (bonus.atk ?? 0) * ROLL.atk,
    baseCpct: basis.baseCpct + (bonus.cpct ?? 0) * ROLL.cpct,
    baseCdmg: basis.baseCdmg + (bonus.cdmg ?? 0) * ROLL.cdmg,
    baseMastery: basis.baseMastery + (bonus.mastery ?? 0) * ROLL.em,
    /* 充能也要挪回来：F(σ) 的口径是「除圣遗物副词条外的一切面板量」，
       武器 / 套装给的充能（薙草、绝缘 2 件套）必须计入，否则 f_u 会少算 */
    baseRecharge: (basis.baseRecharge ?? 1) + (bonus.recharge ?? 0) * ROLL.recharge
  }
}

/**
 * 网站那格「词条 xx.x」：按流派的有效属性，把圣遗物副词条加起来。
 * 不打反应时精通不产生伤害，网站也不把它计入这一格。
 */
function tagTotalOf (artifact: Record<string, number>, effective: Set<string>, reaction: boolean): number {
  let sum = 0
  for (const [key, n] of Object.entries(artifact)) {
    if (!effective.has(key)) continue
    if (key === 'mastery' && !reaction) continue
    sum += n
  }
  return sum
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
  /** 你的装备基线：白字、主词条、天生双爆，以及武器 / 套装给的一切非圣遗物加成。
      与 defaultBasis 同口径（「除圣遗物副词条外的全部面板量」），
      仅供展示真实面板与换算暴击伤害；算分走预设的 defaultBasis。
      详见 gearBasisFrom / withNonArtifact 与 score.ts computeScores 的注释。 */
  basis: GearBasis
  /** 整装词条 → 圣遗物副词条 的账本，评分与网站词条格共用 */
  ledger: RollLedger
  /** 总词条数扣掉武器 —— 只剩圣遗物副词条 + 套装效果，能和 miao 放同一张表比 */
  artifactTotal: number
  /** miao 侧：所有副词条 ÷ 单 roll 最大值，不按角色过滤 */
  miaoEff: number
  /** miao 侧：只算有效副词条，再 ÷0.85 把分母换到均值 */
  miaoValid: number
  /** miao 侧：被过滤掉的废词条（已 ÷0.85） */
  miaoOnly: number
  /**
   * 每个流派的分数（词条分 / 数据分），key = 流派 id。
   * 由 score.ts 的 computeScores 算出，输入是同一份圣遗物副词条账本。
   *
   * 口径边界（与 docs 一致）：
   *  - 词条分：分子分母同配，技能倍率 / 命座 / 精炼全部约掉，对所有流派都精确；
   *  - 数据分：分母写死默认整套，预设带天赋倍率表时随技能等级正确变化；
   *    没带倍率表的流派按 9/9/9 等价配置算，技能等级 ≠ 9 时会有偏差。
   */
  scores: Record<string, ScoreResult>
  /**
   * 网站那一格「词条 xx.x」，按流派给。与上面的 total 不是一回事：
   * total 是整装词条，这里是账本里的圣遗物副词条，再按该流派的有效属性求和
   * （不打反应时精通不算，所以同一角色不同流派会差几条）。
   */
  siteTagTotals: Record<string, number>
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
 * 把「目前配置」拆成 score.ts 要的装备基线：把面板反解出来的那一整份净加成减掉，
 * 剩下的是白字、主词条与天生双爆。武器副词条 / 套装效果也藏在这份净加成里，
 * 所以调用方还要用 withNonArtifact 把它们补回来，才是完整的装备基线。
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
    baseMastery: (attr.mastery ?? 0) - (value.get('mastery') ?? 0),
    /* 充能：miao 面板是百分数（309.45 表示 309.45%），先扣掉副词条那份，再折成小数 */
    baseRecharge: ((attr.recharge ?? 100) - (value.get('recharge') ?? 0)) / 100
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

export async function evaluateCharacter (character: CharacterDbo): Promise<CharacterYsin | null> {
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
  const ledger = rollLedgerOf(stats, weaponByKey, character.artifacts || [])
  /* 词条扣掉的那部分要挪回基线，panelOf(圣遗物词条, basis) 才等于玩家真实面板 */
  const basis = withNonArtifact(gearBasisFrom(attr, base, main, stats), ledger.bonus)
  const talent = (profile.talent || {}) as Record<string, number>
  const talents = { a: talent.a ?? 9, e: talent.e ?? 9, q: talent.q ?? 9 }

  /* 分数用账本里的圣遗物副词条；词条分的分子分母都用玩家骨架 basis（当前 vs
     标准词条），网站那格「词条」也从同一份账本求和，不会再出现两套扣减逻辑。 */
  const scores: Record<string, ScoreResult> = {}
  const siteTagTotals: Record<string, number> = {}
  const group = schoolsFor(profile.id)
  if (group) {
    const rolls: Rolls = {
      atk: ledger.artifact.atk ?? 0,
      em: ledger.artifact.mastery ?? 0,
      cpct: ledger.artifact.cpct ?? 0,
      cdmg: ledger.artifact.cdmg ?? 0,
      recharge: ledger.artifact.recharge ?? 0
    }
    for (const seed of group.schools) {
      const preset = presetOf(seed)
      /* 词条分走闭式：同一骨架 + 标准词条，参考侧不跑引擎 */
      const base = computeScores({ preset, basis, rolls, talents, cons: character.cons ?? 0 })
      if (seed.entry !== undefined) {
        /* 数据分还需要一次当前伤害 D(P)；引擎没算出条目时保留无引擎近似 */
        const dmg = await currentDamageOf({
          profile, entry: seed.entry, talentSlot: seed.talentSlot,
          passiveCpct: seed.passiveCpct ?? 0, consShred: seed.consShred,
          cons: character.cons ?? 0, enemyRes: preset.enemyRes
        })
        scores[seed.id] = dmg ? applyCurrentDamage(base, dmg) : base
      } else {
        /* 没有 entry 的流派走无引擎近似 */
        scores[seed.id] = base
      }
      siteTagTotals[seed.id] = tagTotalOf(ledger.artifact, effective, preset.reaction)
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
    ledger,
    artifactTotal: total - weaponRolls,
    miaoEff,
    miaoValid,
    miaoOnly,
    scores,
    siteTagTotals
  }
}
