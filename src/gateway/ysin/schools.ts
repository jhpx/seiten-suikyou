/*
 * YSIN 流派预设库：把 schools.csv 的一行装配成 score.ts 要的 SchoolPreset。
 *
 * cPanel 六列进 defaultBasis；隐性面板加成、天赋倍率、命座降抗由各自的列补上，
 * 留空的列走统一默认值。所有角色 / 流派共用一个装配逻辑，不按 id 分支。
 *
 * 精度边界：未填天赋倍率表的行，技能等级 ≠ 9 时数据分不做等级修正；
 * 生命 / 防御 / 充能主导的流派，多出的条数不计分，界面归到「未计入」。
 */

import fs from 'node:fs'

import type { SchoolPreset } from './score.ts'
import { parseSchoolsCsv, CSV_PATH, type SchoolSeed, type CharacterSeed, type SchoolsFile } from './schools-csv.ts'

const FILE = CSV_PATH

function load (): SchoolsFile {
  if (!fs.existsSync(FILE)) return { source: '', fetchedAt: '', characters: [] }
  return parseSchoolsCsv(fs.readFileSync(FILE, 'utf8'))
}

const DATA = load()
const BY_ID = new Map(DATA.characters.map(c => [c.id, c]))

/** 没给天赋倍率表时用常数：倍率在词条分里约掉，数据分只在 9 级等价配置下精确 */
const FLAT_SCALE: readonly number[] = Array(15).fill(1)
/** YSIN / miao 默认敌人是 90 级小宝，全元素抗性 10% */
const DEFAULT_ENEMY_RES = 0.1

/** 找出这个角色在 YSIN 网页里有哪些流派；id 对不上就返回 null */
export function schoolsFor (avatarId: number): CharacterSeed | null {
  return BY_ID.get(avatarId) ?? null
}

/**
 * 一行 CSV → 计算用的预设。与角色无关：签名里连 avatarId 都没有，
 * 想加「只有某某角色才这样」的逻辑就得先改签名，避免偷偷长回特例。
 */
export function presetOf (seed: SchoolSeed): SchoolPreset {
  const basis = { ...seed.basis }
  for (const [key, delta] of Object.entries(seed.implicit ?? {})) {
    basis[key as keyof typeof basis] += delta
  }
  const preset: SchoolPreset = {
    name: seed.name,
    bench: seed.bench,
    benchRecharge: seed.extraBench.recharge,
    passiveCpct: seed.passiveCpct ?? 0,
    coreTalent: seed.talentSlot,
    talentScale: seed.talentScale?.length ? seed.talentScale : FLAT_SCALE,
    dmgDefault: seed.dmgDefault,
    defaultBasis: basis,
    reaction: seed.reaction,
    enemyRes: DEFAULT_ENEMY_RES
  }
  if (seed.rechargeModel) preset.rechargeModel = seed.rechargeModel
  if (seed.talentRatio) preset.talentRatioOverride = seed.talentRatio
  if (seed.consShred) preset.consResShred = seed.consShred
  return preset
}

/** 数据版本，给接口排查用 */
export const schoolsSource = { source: DATA.source, fetchedAt: DATA.fetchedAt }
