/*
 * 多语言名字表。数据来自 `vendor/i18n/names.json`（`tools/sync_i18n.py` 从官方数据提取，勿手工编辑）。
 *
 * 主键全是**本地化无关的东西**：数字 TextMapHash、部位序号、FIGHT_PROP_* 枚举名 —— 文案只是渲染结果，
 * 换语言不用碰数据，加语言只是多一列。角色要绕一下：enka 只给 avatarId、不给角色名 hash，所以表里
 * 另存了一份 byId.avatar 补这一跳。
 *
 * 出口一律容错：表没同步、某语言缺条目、id 不在表里，都返回 null，不抛。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { t as uiT, all as uiAll } from './ui.ts'
import { KEY_TO_PROP } from '../domain/stat.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TABLE = path.join(HERE, '..', '..', 'vendor', 'i18n', 'names.json')

/** 默认语言：简体中文。与 miao 自带的中文名口径一致。 */
export const DEFAULT_LOCALE = 'chs'

/** names.json 里一种语言（`{ code, label }`） */
export interface LocaleRow { code: string; label: string }

/** names.json 的表结构（生成物，字段见 tools/sync_i18n.py）；
 *  索引里一律带 `| undefined`，因为「查不到」是这个模块最常见的出口。 */
export interface NamesTable {
  locales: LocaleRow[]
  names: Array<Record<string, string>>
  nameIndex: Record<string, number | undefined>
  slots: Record<string, Record<string, string>>
  stats: Record<string, Record<string, string>>
  byId: Record<string, Record<string, number | undefined>>
}

const EMPTY: NamesTable = { locales: [], names: [], nameIndex: {}, slots: {}, stats: {}, byId: {} }
let cache: NamesTable | null = null

function load (): NamesTable {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(TABLE, 'utf8')) as NamesTable
    } catch {
      /* 还没跑过同步脚本。静默降级成只有中文 —— 不该因为「没有多语言数据」把评分带崩 */
      cache = EMPTY
    }
  }
  return cache
}

/** 表里有哪些语言：[{ code, label }] */
export function locales (): LocaleRow[] {
  return load().locales
}

/** 表在不在（同步脚本跑过没有） */
export function available (): boolean {
  return locales().length > 0
}

/* 常见别名的归一：都是 BCP-47 那套写法，归一后按表里的 code 对 */
const ALIASES: Record<string, string> = {
  zh: 'chs', 'zh-cn': 'chs', 'zh-hans': 'chs', cn: 'chs',
  'zh-tw': 'cht', 'zh-hk': 'cht', 'zh-hant': 'cht', tw: 'cht',
  jp: 'ja', kr: 'ko', 'pt-br': 'pt'
}

/** 语言代码认不认。'zh-cn' / 'ZH-CN' / 'cht' 这类写法都收，认不出就退回默认语言。 */
export function resolveLocale (want?: string | null): string {
  const rows = locales()
  if (!rows.length || !want) return DEFAULT_LOCALE
  const key = String(want).toLowerCase()
  const code = ALIASES[key] || key
  return rows.some(r => r.code === code) ? code : DEFAULT_LOCALE
}

/** 界面文字（按钮/标题/提示）另有一张手写小表，见 ui.ts。包一层再出口，
 *  语言解析和别处用同一套规则 —— 不会出现「名字回落中文、界面文字回落英文」的割裂。 */
export function uiText (key: string, locale: string | null = DEFAULT_LOCALE, vars: Record<string, unknown> | null = null): string {
  return uiT(key, resolveLocale(locale), vars)
}

export function uiTable (locale: string | null = DEFAULT_LOCALE): Record<string, string> {
  return uiAll(resolveLocale(locale))
}

/** 从一行多语言文案里挑一条：要的语言 → 英文 → 中文 → 放弃 */
const pick = (row: Record<string, string> | undefined, locale: string): string | null =>
  (row ? row[locale] ?? row.en ?? row.chs ?? null : null)

/** 通用出口：任何名字 hash → 文案。
 *  表里存的是「名字组 + hash 索引」而不是 hash → 文案的直接映射：官方把同一段文案复用在几十处
 *  （「胡桃」有 49 个键），enka 返回其中任意一个，索引把它们全指到同一组。 */
export function name (hash: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  if (hash === null || hash === undefined) return null
  const table = load()
  const gi = table.nameIndex[String(hash)]
  return gi === undefined ? null : pick(table.names[gi], resolveLocale(locale))
}

/* 「byId 里查 id → hash → 文案」这一跳，四类名字形状完全一样，收成一个工厂。
   id 允许 null/undefined（与上面的 name() 一致）：`String(null)` 查不到就返 null，
   调用方不必为了「没装备武器」这种正常情况先判空。 */
const byIdName = (kind: string) => (id: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null => {
  if (id === null || id === undefined) return null
  const h = (load().byId[kind] || {})[String(id)]
  return h ? name(h, locale) : null
}

/** 角色：avatarId → 文案（内部先换 hash） */
export const avatarName = byIdName('avatar')

/** 武器：itemId → 文案 */
export const weaponName = byIdName('weapon')

/** 套装：按 enka 给的 hash 查（库里存的就是 hash；表里 byId.set 那层给别处用） */
export const setNameByHash = name

/** 部位（1 花 2 羽 3 沙 4 杯 5 冠） */
export function slotName (pos: number | string, locale: string = DEFAULT_LOCALE): string | null {
  return pick(load().slots[String(pos)], resolveLocale(locale))
}

/** 词条：吃 miao 的短名（cpct / cdmg / hpPlus …）。key → FIGHT_PROP_* 的映射在 domain/stat.ts
 *  （那边是对数值用的正确方向，这儿只是拿去官方文案表查名）。 */
export function statName (miaoKey: string, locale: string = DEFAULT_LOCALE): string | null {
  const prop = KEY_TO_PROP[miaoKey]
  return prop ? pick(load().stats[prop], resolveLocale(locale)) : null
}

/* 中文名 → 组号，懒建，只服务下面那个反向出口 */
let zhMap: Map<string, number> | null = null
function zhIndex (): Map<string, number> {
  if (!zhMap) {
    /* 建在局部 const 上再赋值给 zhMap：闭包里的 `let` 会被 TS 当成可变、narrowing 失效 */
    const m = new Map<string, number>()
    load().names.forEach((row, i) => {
      if (row.chs && !m.has(row.chs)) m.set(row.chs, i)
    })
    zhMap = m
  }
  return zhMap
}

/**
 * 反向出口：手上只有 miao 的中文名时用它换别的语言。实际只有套装那一行用到 —— miao 的 `result.sets`
 * 键是官方中文全名（「炽烈的炎之魔女」），我们手上没有它的 hash、只有名字，表里每种语言都有，反查就够。
 */
export function fromZh (text: string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  const gi = text ? zhIndex().get(text) : undefined
  return gi === undefined ? null : pick(load().names[gi], resolveLocale(locale))
}

/** 供调试/测试用：拿到原始表（只读） */
export function raw (): NamesTable {
  return load()
}
