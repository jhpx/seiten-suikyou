/*
 * 多语言名字表。
 *
 * 数据来自 `vendor/i18n/names.json`（由 `tools/sync_i18n.py` 从官方数据提取，勿手工编辑）。
 *
 * 主键全是**本地化无关的东西**：数字 TextMapHash、部位序号、FIGHT_PROP_* 枚举名 ——
 * 文案只是渲染结果，换语言不用碰数据，加语言只是多一列。
 *
 * 角色要绕一下：enka 只给 avatarId、不给角色名的 hash，所以表里另存了一份
 * byId.avatar 来补这一跳。
 *
 * 出口一律容错：表没同步、某语言缺条目、id 不在表里，都返回 null，不抛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { t as uiT, all as uiAll } from './ui.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TABLE = path.join(HERE, '..', '..', 'vendor', 'i18n', 'names.json')

/** 默认语言：简体中文。与 miao 自带的中文名口径一致。 */
export const DEFAULT_LOCALE = 'chs'

const EMPTY = { locales: [], names: [], nameIndex: {}, slots: {}, stats: {}, byId: {} }
let cache = null

function load () {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(TABLE, 'utf8'))
    } catch {
      /* 还没跑过同步脚本。静默降级成只有中文 —— 不该因为「没有多语言数据」把评分带崩 */
      cache = EMPTY
    }
  }
  return cache
}

/** 表里有哪些语言：[{ code, label }] */
export function locales () {
  return load().locales
}

/** 表在不在（同步脚本跑过没有） */
export function available () {
  return locales().length > 0
}

/* 常见别名的归一：都是 BCP-47 那套写法，归一后按表里的 code 对 */
const ALIASES = {
  zh: 'chs', 'zh-cn': 'chs', 'zh-hans': 'chs', cn: 'chs',
  'zh-tw': 'cht', 'zh-hk': 'cht', 'zh-hant': 'cht', tw: 'cht',
  jp: 'ja', kr: 'ko', 'pt-br': 'pt'
}

/** 语言代码认不认。'zh-cn' / 'ZH-CN' / 'cht' 这类写法都收，认不出就退回默认语言。 */
export function resolveLocale (want) {
  const rows = locales()
  if (!rows.length || !want) return DEFAULT_LOCALE
  const key = String(want).toLowerCase()
  const code = ALIASES[key] || key
  return rows.some(r => r.code === code) ? code : DEFAULT_LOCALE
}

/** 界面文字（按钮/标题/提示）另有一张手写小表，见 ui.js。包一层再出口，
 *  语言解析和别处用同一套规则 —— 不会出现「名字回落中文、界面文字回落英文」的割裂。 */
export function uiText (key, locale = DEFAULT_LOCALE, vars = null) {
  return uiT(key, resolveLocale(locale), vars)
}

export function uiTable (locale = DEFAULT_LOCALE) {
  return uiAll(resolveLocale(locale))
}

/* miao 的词条短名 → 官方的 FIGHT_PROP_* 枚举名。
   手写的，因为 miao 那边只有短名（cpct/cdmg/…），而官方文案按 FIGHT_PROP_* 组织。
   这 20 个 key 就是 miao `Meta.getMeta('gs','arti')` 里 mainIdMap + attrIdMap 的全集。 */
const STAT_PROP = {
  hp: 'FIGHT_PROP_HP',
  hpPlus: 'FIGHT_PROP_HP_PERCENT',
  atk: 'FIGHT_PROP_ATTACK',
  atkPlus: 'FIGHT_PROP_ATTACK_PERCENT',
  def: 'FIGHT_PROP_DEFENSE',
  defPlus: 'FIGHT_PROP_DEFENSE_PERCENT',
  mastery: 'FIGHT_PROP_ELEMENT_MASTERY',
  recharge: 'FIGHT_PROP_CHARGE_EFFICIENCY',
  cpct: 'FIGHT_PROP_CRITICAL',
  cdmg: 'FIGHT_PROP_CRITICAL_HURT',
  heal: 'FIGHT_PROP_HEAL_ADD',
  dmg: 'FIGHT_PROP_ADD_HURT',
  phy: 'FIGHT_PROP_PHYSICAL_ADD_HURT',
  pyro: 'FIGHT_PROP_FIRE_ADD_HURT',
  electro: 'FIGHT_PROP_ELEC_ADD_HURT',
  hydro: 'FIGHT_PROP_WATER_ADD_HURT',
  dendro: 'FIGHT_PROP_GRASS_ADD_HURT',
  anemo: 'FIGHT_PROP_WIND_ADD_HURT',
  geo: 'FIGHT_PROP_ROCK_ADD_HURT',
  cryo: 'FIGHT_PROP_ICE_ADD_HURT'
}

/** 从一行多语言文案里挑一条：要的语言 → 英文 → 中文 → 放弃 */
const pick = (row, locale) => (row ? row[locale] ?? row.en ?? row.chs ?? null : null)

/**
 * 通用出口：任何名字 hash → 文案。
 *
 * 表里存的是「名字组 + hash 索引」而不是 hash → 文案的直接映射：官方把同一段文案
 * 复用在几十处（「胡桃」有 49 个键），enka 返回其中任意一个，索引把它们全指到同一组。
 */
export function name (hash, locale = DEFAULT_LOCALE) {
  if (hash === null || hash === undefined) return null
  const table = load()
  const gi = table.nameIndex[String(hash)]
  return gi === undefined ? null : pick(table.names[gi], resolveLocale(locale))
}

/* 「byId 里查 id → hash → 文案」这一跳，四类名字形状完全一样，收成一个工厂 */
const byIdName = (kind) => (id, locale = DEFAULT_LOCALE) => {
  const h = (load().byId[kind] || {})[String(id)]
  return h ? name(h, locale) : null
}

/** 角色：avatarId → 文案（内部先换 hash） */
export const avatarName = byIdName('avatar')

/** 武器：itemId → 文案 */
export const weaponName = byIdName('weapon')

/** 圣遗物部件：itemId → 文案 */
export const pieceName = byIdName('piece')

/** 套装：按 setId 查（表里也有这层映射，方便别处用） */
export const setName = byIdName('set')

/** 套装：按 enka 给的 hash 查（库里存的就是 hash） */
export const setNameByHash = name

/** 部位（1 花 2 羽 3 沙 4 杯 5 冠） */
export function slotName (pos, locale = DEFAULT_LOCALE) {
  return pick(load().slots[String(pos)], resolveLocale(locale))
}

/** 词条：吃 miao 的短名（cpct / cdmg / hpPlus …） */
export function statName (miaoKey, locale = DEFAULT_LOCALE) {
  const prop = STAT_PROP[miaoKey]
  return prop ? pick(load().stats[prop], resolveLocale(locale)) : null
}

/* 中文名 → 组号，懒建，只服务下面那个反向出口 */
let zhMap = null
function zhIndex () {
  if (!zhMap) {
    zhMap = new Map()
    load().names.forEach((row, i) => {
      if (row.chs && !zhMap.has(row.chs)) zhMap.set(row.chs, i)
    })
  }
  return zhMap
}

/**
 * 反向出口：手上只有 miao 的中文名时用它换别的语言。
 *
 * 实际场景只有套装那一行 —— miao 的 `result.sets` 键是官方中文全名（「炽烈的炎之魔女」），
 * 我们手上没有它的 hash，只有名字；表里每种语言都有，反查就够了。
 */
export function fromZh (text, locale = DEFAULT_LOCALE) {
  const gi = text ? zhIndex().get(text) : undefined
  return gi === undefined ? null : pick(load().names[gi], resolveLocale(locale))
}

/** 供调试/测试用：拿到原始表（只读） */
export function raw () {
  return load()
}
