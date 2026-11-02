/*
 * 规则评分 —— 让用户「选一个 miao 内置的评分规则」来给角色算分，而不是永远用 miao 自动选那套。
 *
 * 为什么需要它：miao 的 `ArtisMark.getMarkDetail(profile)` 内部由 `char.getArtisCfg()` 读角色的
 * **实际配装**（武器/命座/套装/主词条/面板）自动挑一套 attrWeight，没有「用指定规则算分」的公开 API。
 * 但每个角色在 `artis.js` 里本来就按这些条件分了好多套权重（阿蕾奇诺 纯火/通用、迪希雅 血牛/通用…），
 * `tools/gen_artis_table.ts` 已经把这些规则（名字+条件+权重）抽出来存进 `src/gateway/miao/rubrics.json`（生成物，跟本模块同目录）。
 *
 * 本模块的做法：**逐件圣遗物的 mark 数学 100% 复用 miao 的 `ArtisMark.getMark`**（不动），
 * 只把「选哪套权重」从 miao 自动选换成「用户指定」。具体：
 *   ① 从 rubrics.json 取出选定规则的原始 attrWeight；
 *   ② 叠一层 miao 的「武器/套装适配」（护摩加生命、绝缘4 充能齐平、西风系暴击拉满——
 *      移植自 ArtisMarkCfg.getCharArtisCfg 的 def() 块，按真实 build 现算，因为用户选的是规则、
 *      不是配装）；
 *   ③ 用这套权重重建 charCfg（移植自 ArtisMarkCfg.getCfg 的 attrs 构建，纯函数）；
 *   ④ 跑和 `getMarkDetail` 同款的 mark 循环，输出 MarkDetail 形状。
 *
 * 这样评分与 miao 逐字一致——只有「规则选择」这一个输入被换掉。gen_artis_table 的校验报告里
 * `scoreWithWeights(profile, 某规则.weights)` 必须等于 miao 在该 build 下自动选该规则时的结果。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtisMark, Artifact, Meta, Format, Data } from '../../index.ts'
import type { MiaoProfile } from './materialize.ts'
import { avatarName, resolveLocale } from '../../common/names.ts'
import { rubricName } from '../../common/rubric-names.ts'

/* 武器/套装适配表（与 ArtisMarkCfg.weaponCfg 逐字一致） */
const WEAPON_CFG: Record<string, { attr: string; abbr?: string; max?: number; min?: number }> = {
  磐岩结绿: { attr: 'hp', abbr: '绿剑', max: 30, min: 15 },
  猎人之径: { attr: 'mastery' },
  薙草之稻光: { attr: 'recharge', abbr: '薙刀' },
  护摩之杖: { attr: 'hp', abbr: '护摩', max: 18, min: 10 }
}

/* rubrics.json 的位置：与本模块同目录（生成物，由 tools/gen_artis_table.ts 产出；不是 vendor 的上游镜像） */
const RUBRICS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'rubrics.json')

export interface RubricLite {
  name: string
  /** 展示用全名（「角色名-规则名」，与 miao 的 classTitle 同形）；提交仍用 name */
  label: string
  cond: string
  weights: number[]
  isBase: boolean
  deps: string
}

interface RubricData {
  keys: string[]
  rubrics: Record<string, RubricLite[]>
}

let cache: RubricData | null = null
function loadRubrics (): RubricData {
  if (!cache) cache = JSON.parse(readFileSync(RUBRICS_PATH, 'utf-8')) as RubricData
  return cache
}

/** 一个角色（按 avatar_id）的全部评分规则；无 artis.js / 查不到返回 null */
export function getRubrics (avatarId: number): RubricLite[] | null {
  const { rubrics } = loadRubrics()
  return rubrics[String(avatarId)] ?? null
}

/**
 * 展示用的「角色名-规则名」→ 当前语言。
 *
 * 为什么放在这儿：规则名（以及它在页面上怎么念）只有这个模块知道，两处都要用 ——
 *   ① 下拉的选项（character.service.listRubrics）；
 *   ② 评分卡上「自动匹配到哪条 / 单规则角色的规则名」（assembler 的 score.rubricLabel）。
 *
 * title 有两种来源，都得认：
 *   · miao 自动选时给的 classTitle —— 就是 rubrics.json 里的 label（「芙宁娜-通用」）；
 *   · 用户选了某条规则时，我们传给 scoreWithWeights 的是**裸规则名**（「输出」）。
 * 认不出就原样返回（宁可露中文，也别显示空白）。
 *
 * 角色名走官方文案表（avatar_id → 5 种语言都有），规则名走 rubric-names.ts 的意译表。
 */
export function rubricLabel (avatarId: number, title: string, locale: string): string {
  const t = (title || '').trim()
  if (!t) return ''
  const list = getRubrics(avatarId) || []
  const hit = list.find(r => r.label === t) || list.find(r => r.name === t)
  if (!hit) return t
  /* 语言码先归一：avatarName 内部会认，rubricName 不会 —— 不归一就会出现
     「角色名是韩文、规则名还是中文」这种半截翻译（kr / ko-KR 这类写法都得认） */
  const loc = resolveLocale(locale)
  const charName = avatarName(avatarId, loc) || ''
  const ruleName = rubricName(hit.name, loc)
  return charName ? `${charName}-${ruleName}` : ruleName
}

/** 按名字取某个规则的权重数组；名字不存在或角色无规则返回 null */
export function findRubricWeights (avatarId: number, name: string | null | undefined): number[] | null {
  if (!name) return null
  const list = getRubrics(avatarId)
  if (!list) return null
  const hit = list.find(s => s.name === name)
  return hit ? hit.weights : null
}

/* 把规则的权重数组（按 keys 顺序）转成 miao 的 attrWeight 对象 */
function weightsToObj (weights: number[]): Record<string, number> {
  const { keys } = loadRubrics()
  const o: Record<string, number> = {}
  keys.forEach((k, i) => { o[k] = weights[i] || 0 })
  return o
}

/*
 * 武器/套装适配（移植自 ArtisMarkCfg.getCharArtisCfg 的 def() 块）。
 * 入参是规则的原始权重，按角色的**真实 build** 现叠一层：护摩/绿剑/薙草/绝缘4/西风。
 * 返回叠好适配的权重对象。
 */
function applyAdaptation (raw: Record<string, number>, profile: MiaoProfile): Record<string, number> {
  const w = { ...raw }
  const wn = profile.weapon?.name || ''
  const affix = profile.weapon?.affix || 1
  if (!profile.isGs) return w

  const check = (key: string, max = 75, maxPlus = 75, isWeapon = true): boolean => {
    const original = w[key] || 0
    if (original < max) {
      const plus = isWeapon ? maxPlus * (1 + affix / 5) / 2 : maxPlus
      w[key] = Math.min(Math.round(original + plus), max)
      return true
    }
    return false
  }
  const weaponCheck = (key: string, maxAffix = 20, minAffix = 10, max = 100): boolean => {
    const original = w[key] || 0
    if (original === max) return false
    const plus = minAffix + (maxAffix - minAffix) * (affix - 1) / 4
    w[key] = Math.min(Math.round(original + plus), max)
    return true
  }

  if (w.atk > 0 && WEAPON_CFG[wn]) {
    const cfg = WEAPON_CFG[wn]
    weaponCheck(cfg.attr, cfg.max ?? 20, cfg.min ?? 10)
  }
  const maxWeight = Math.max(w.atk || 0, w.hp || 0, w.def || 0, w.mastery || 0)
  if (profile.artis?.is?.('绝缘4')) check('recharge', maxWeight, 75, false)
  if (/^西风(长枪|大剑|剑|猎弓|秘典)$/.test(wn) && (w.cpct || 0) < 100) w.cpct = 100
  return w
}

/*
 * 用一套（已叠适配的）权重重建 charCfg（移植自 ArtisMarkCfg.getCfg 的 attrs 构建，纯函数）。
 * 与 miao 的 getCfg 唯一差别：权重是我们给的，不是 getCharArtisCfg 自动选的。
 */
function buildCharCfg (weight: Record<string, number>, profile: MiaoProfile, title = '', isDefaultWeight = false, isCustomWeight = false) {
  const char = profile.char
  const game = profile.game
  const attrs: Record<string, any> = {}
  const baseAttr = char?.baseAttr || { hp: 14000, atk: 230, def: 700 }
  const { attrMap } = Meta.getMeta(game, 'arti')
  for (const key of Object.keys(attrMap)) {
    const attr: any = (attrMap as any)[key]
    const k = attr.base || ''
    const w = weight[k || key]
    if (!w || w * 1 === 0) continue
    const ret: any = { ...attr, weight: w, fixWeight: w, mark: w / attr.value }
    if (!k) {
      ret.mark = w / attr.value
    } else {
      const plus = k === 'atk' ? 520 : 0
      ret.mark = w / attrMap[k].value / (baseAttr[k] + plus) * 100
      ret.fixWeight = w * attr.value / attrMap[k].value / (baseAttr[k] + plus) * 100
    }
    attrs[key] = ret
  }
  const posMaxMark = ArtisMark.getMaxMark(attrs, game)
  return { attrs, classTitle: title, posMaxMark, isDefaultWeight, isCustomWeight }
}

/*
 * 核心出口：用指定规则的权重给一个角色算分。
 * 返回与 `ArtisMark.getMarkDetail(profile, true)` 同款的 MarkDetail 形状，供 shapeCharacter 直接消费。
 * 不传规则（weights 为 null）时调用方应回退到 miao 自动选。
 *
 * title 是规则名（用户选了某个 miao 规则时传进来）：它直接成为 classTitle（页面据此显示
 * 「你选了哪套权重」），并把 isCustomWeight 置真 —— 即便这套权重和 miao 自动选出来的一模一样，
 * 也是用户**主动选的**，不再是 miao 默认。
 */
export function scoreWithWeights (profile: MiaoProfile, weights: number[], title?: string | null): Record<string, unknown> {
  const adapted = applyAdaptation(weightsToObj(weights), profile)
  const charCfg = buildCharCfg(adapted, profile, title ?? '', false, !!title) as any
  const { game, artis, elem, id } = profile
  const artisRet: Record<number, unknown> = {}
  let totalMark = 0
  if (artis?.forEach) {
    artis.forEach((arti: any, idx: number) => {
      const mark = ArtisMark.getMark({ charCfg, idx, arti, elem, game, id })
      totalMark += mark
      const artifact = Artifact.get(arti, game)
      artisRet[idx] = {
        ...artifact.getData('name,abbr,set:setName,img'),
        level: arti.level,
        main: ArtisMark.formatArti(arti.main, charCfg.attrs, true, game),
        attrs: ArtisMark.formatArtiAttrs(arti.attrs, charCfg.attrs, game),
        pMax: ArtisMark.getPosMaxMark(charCfg, idx, ArtisMark.getMainKey(idx, arti.main?.key, elem, game, id), game),
        _mark: mark,
        mark: Format.comma(mark, 1),
        markClass: ArtisMark.getMarkClass(mark)
      }
    })
  }
  artis.mark = totalMark
  artis.markClass = ArtisMark.getMarkClass(totalMark / (profile.isGs ? 5 : 6))
  const setData = artis.getSetData?.()
  return {
    classTitle: charCfg.classTitle,
    artis: artisRet,
    mark: Format.comma(totalMark, 1),
    _mark: artis.mark,
    markClass: artis.markClass,
    isDefaultWeight: charCfg.isDefaultWeight,
    isCustomWeight: charCfg.isCustomWeight,
    charWeight: Object.fromEntries(Object.entries(charCfg.attrs).map(([k, ds]) => [k, (ds as any).weight])),
    sets: setData ? Data.getData(setData, 'sets,names,imgs') : {}
  }
}
