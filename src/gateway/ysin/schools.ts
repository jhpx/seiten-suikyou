/*
 * YSIN 流派预设库 —— 数据最初来自 YSIN 网页版本身，不是手写猜的。
 *
 * YSIN 网页版已停更，现在改为本地手维护，单一数据来源就是 schools.csv：
 *   - schools.csv 是给人编辑的源文件（一行一个流派，中文表头，Excel / 记事本都能改）
 *   - 后端（本文件）直接读 schools.csv，不再经过 schools.json 这一层
 *   - CSV 的读写与中文注释表头都在 ./schools-csv.ts
 *
 * 日常维护流程：
 *   1. 直接改 schools.csv（增删行、改数值，列说明见文件顶部 `#` 注释）
 *   2. 跑 node tools/ysin-schools-csv.ts validate 做一次体检（可选）
 *   3. 重启后端服务生效
 * 若以后拿到一份 schools.json（比如别人给的），跑：node tools/ysin-schools-csv.ts to-csv <json路径>
 *
 * 历史采集细节（仅作背景，现在不再需要）：原来靠 ../ysin-math/tools/ysin-schools.ts
 * 起浏览器逐角色逐流派点「开始计算」，读 tagNum / dText / cPanel 后，
 * 经 ../ysin-math/tools/ysin-schools-gen.ts 转成 schools.json，现已被 CSV 取代。
 *
 * 精度边界（重要）：
 *  - 只有甘雨·融化经过 75 项断言与线上逐位对拍，直接用 preset.ts 里那份精确标定；
 *  - 其他流派有网站的 bench / dmgDefault / 装备基线，但技能等级倍率表无法从网页导出，
 *    统一给一组常数（词条分不受影响，因为倍率在分子分母约掉；数据分在技能等级 ≠ 9 时
 *    不会做等级修正）。套装与天赋的隐性面板加成也不在 cPanel 里，同理只影响绝对读数。
 *  - 生命 / 防御 / 充能主导向的流派，当前 Rolls 只有攻精双爆四维，多出来的条数不计分，
 *    在界面上归到「未计入」。
 */
import fs from 'node:fs'

import type { SchoolPreset } from './score.ts'
import { GAN_YU_MELT } from './preset.ts'
import { parseSchoolsCsv, CSV_PATH, type SchoolSeed, type CharacterSeed, type SchoolsFile } from './schools-csv.ts'

const FILE = CSV_PATH

function load (): SchoolsFile {
  if (!fs.existsSync(FILE)) return { source: '', fetchedAt: '', characters: [] }
  return parseSchoolsCsv(fs.readFileSync(FILE, 'utf8'))
}

const DATA = load()
const BY_ID = new Map(DATA.characters.map(c => [c.id, c]))

/** 没有等级倍率表时用常数：倍率在词条分里约掉，数据分只在 9 级等价配置下精确 */
const FLAT_SCALE: readonly number[] = Array(15).fill(1)

/** 找出这个角色在 YSIN 网页里有哪些流派；id 对不上就返回 null */
export function schoolsFor (avatarId: number): CharacterSeed | null {
  return BY_ID.get(avatarId) ?? null
}

/** 甘雨的 avatarId —— 唯一逐位对拍过的「融化」流派挂在她身上 */
const GAN_YU_ID = 10000037

/** 种子 → 计算用的预设 */
export function presetOf (avatarId: number, seed: SchoolSeed): SchoolPreset {
  /* 唯一逐位对拍过的流派，用精确表（含 YSIN v4.8 实测倍率比与 1 命抗性） */
  if (avatarId === GAN_YU_ID && seed.name === '融化') return GAN_YU_MELT
  return {
    name: seed.name,
    bench: seed.bench,
    coreTalent: seed.talentSlot,
    talentScale: FLAT_SCALE,
    dmgDefault: seed.dmgDefault,
    defaultBasis: seed.basis,
    reaction: seed.reaction
  }
}

/** 数据版本，给接口排查用 */
export const schoolsSource = { source: DATA.source, fetchedAt: DATA.fetchedAt }
