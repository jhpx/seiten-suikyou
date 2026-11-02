/*
 * 多语言名字表。数据在 `vendor/i18n/`，由 `tools/sync_i18n.py` 从上游搬下来（勿手工编辑）。
 *
 * **目录形状就是上游形状，能原样的都原样**（见 vendor/i18n/VENDOR.md）：
 *   locs.json / avatars.json / weapons.json / relics.json —— enka `store/gi/` 字节级原样，
 *     角色名、武器名、套装名、词条名（`FIGHT_PROP_*`）全都直接查它。
 *   slots.json —— 5 个部位名，上游两份数据都没有，手写。
 *   textmap/{chs,cht,en,ja,ko}.json —— 部件名（「魔女的炎之花」这类），
 *     从 43 MB 的 TextMap 里挑出来的 `{hash: 文案}`；enka 不收录部件名。
 *
 * 主键全是**本地化无关的东西**：数字 TextMapHash、setId、部位序号、FIGHT_PROP_* 枚举名 ——
 * 文案只是渲染结果，换语言不用碰数据，加语言只是多一份 textmap 文件。
 *
 * ⚠️ 套装身份是 **setId**，不是 enka 玩家接口给的 `setNameTextMapHash`：
 *    后者（千岩 1337665995）在 locs.json 里**查不到名字**，
 *    而 setId（千岩 15017）经 `Sets[setId].Name` 能查到（→ 4007101907 → 千岩牢固）。
 *    setId 由 itemId 推（`relics.Items[itemId].SetId`），见 setIdOfItem。
 *
 * 出口一律容错：文件没同步、某语言缺条目、id 不在表里，都返回 null，不抛。
 * 界面文字在 ui.ts，两张表的统一出口在 i18n.ts；默认语言在 config.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_LOCALE } from '../config/constants.ts'
import { KEY_TO_PROP } from './stat.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, '..', '..', 'vendor', 'i18n')
const TEXTMAP_DIR = path.join(DIR, 'textmap')

/** 一种语言（`{ code, label }`）。label 是界面下拉里显示的名字，手写在下面 LOCALE_ROWS。 */
export interface LocaleRow { code: string; label: string }

/* 语言代码 → 显示名 + enka locs.json 的键。上游用 `zh-cn` / `zh-tw` 那种写法，我们代码里用 chs/cht。
   表里有没有这门语言，取决于 `textmap/` 下有没有对应文件 —— 那是「部件名能不能翻」的硬约束。 */
const LOCALE_ROWS: Array<{ code: string; label: string; locKey: string }> = [
  { code: 'chs', label: '简体中文', locKey: 'zh-cn' },
  { code: 'cht', label: '繁體中文', locKey: 'zh-tw' },
  { code: 'en', label: 'English', locKey: 'en' },
  { code: 'ja', label: '日本語', locKey: 'ja' },
  { code: 'ko', label: '한국어', locKey: 'ko' },
  { code: 'de', label: 'Deutsch', locKey: 'de' },
  { code: 'es', label: 'Español', locKey: 'es' },
  { code: 'fr', label: 'Français', locKey: 'fr' },
  { code: 'id', label: 'Bahasa Indonesia', locKey: 'id' },
  { code: 'it', label: 'Italiano', locKey: 'it' },
  { code: 'pt', label: 'Português', locKey: 'pt' },
  { code: 'tr', label: 'Türkçe', locKey: 'tr' },
  { code: 'vi', label: 'Tiếng Việt', locKey: 'vi' }
]

/* 上游文件的形状 —— 只声明我们用到的字段，其余（技能图标、成长曲线…）不关心。
   键一律是**字符串**：JSON 对象的键就是这样，别在这儿写 number 骗自己。 */
interface Locs { [locKey: string]: Record<string, string> | undefined }
interface NamedEntry { NameTextMapHash?: number | string }
interface Relics {
  Items: Record<string, { SetId?: number | string }>
  Sets: Record<string, { Name?: number | string }>
}

interface Bundle {
  locs: Locs
  avatars: Record<string, NamedEntry>
  weapons: Record<string, NamedEntry>
  relics: Relics
  slots: Record<string, Record<string, string>>
  textmap: Record<string, Record<string, string> | undefined>
  /** 实际可用的语言（`textmap/` 下有文件的那些），按 LOCALE_ROWS 的顺序 */
  available: LocaleRow[]
}

const EMPTY: Bundle = { locs: {}, avatars: {}, weapons: {}, relics: { Items: {}, Sets: {} }, slots: {}, textmap: {}, available: [] }
let cache: Bundle | null = null

/** 读一个 json；读不到就返回兜底值。
 *  不该因为「没有多语言数据」把评分带崩 —— 这些文件只管显示，不参与算分。 */
function readJson<T> (file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** `textmap/` 下实际有哪些语言。这是「语言清单」的唯一真相：
 *  只有 enka 的 locs 能翻角色名、没有 textmap 的话部件名会退回中文 —— 那不算支持这门语言。 */
function textmapLocales (): string[] {
  try {
    return fs.readdirSync(TEXTMAP_DIR)
      .map(f => f.replace(/\.json$/, ''))
      .filter(c => LOCALE_ROWS.some(r => r.code === c))
  } catch {
    return []
  }
}

function load (): Bundle {
  if (cache) return cache
  const codes = textmapLocales()
  const textmap: Record<string, Record<string, string> | undefined> = {}
  for (const c of codes) textmap[c] = readJson<Record<string, string> | undefined>(path.join(TEXTMAP_DIR, `${c}.json`), undefined)
  const bundle: Bundle = {
    locs: readJson<Locs>(path.join(DIR, 'locs.json'), {}),
    avatars: readJson<Record<string, NamedEntry>>(path.join(DIR, 'avatars.json'), {}),
    weapons: readJson<Record<string, NamedEntry>>(path.join(DIR, 'weapons.json'), {}),
    relics: readJson<Relics>(path.join(DIR, 'relics.json'), { Items: {}, Sets: {} }),
    slots: readJson<Record<string, Record<string, string>>>(path.join(DIR, 'slots.json'), {}),
    textmap,
    available: LOCALE_ROWS.filter(r => codes.includes(r.code)).map(r => ({ code: r.code, label: r.label }))
  }
  cache = bundle
  return bundle
}

/** 表里有哪些语言：[{ code, label }] —— 只列「部件名也能翻」的语言 */
export function locales (): LocaleRow[] {
  return load().available
}

/** 表在不在（同步脚本跑过没有） */
export function available (): boolean {
  const b = load()
  return b.available.length > 0 && Object.keys(b.locs).length > 0
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

/** 语言代码 → enka locs.json 的键（'chs' → 'zh-cn'） */
function locKey (code: string): string | null {
  const row = LOCALE_ROWS.find(r => r.code === code)
  return row ? row.locKey : null
}

/** 从一行多语言文案里挑一条：要的语言 → 英文 → 中文 → 放弃 */
const pick = (row: Record<string, string> | undefined, locale: string): string | null =>
  (row ? row[locale] ?? row.en ?? row.chs ?? null : null)

/** 通用出口：任何名字 hash → 文案。
 *  先查 enka 的 locs（角色 / 武器 / 套装 / 词条名都在里头），没有再现查 TextMap 提取件
 *  （部件名只在那儿）。两处都没有就 null，由显示层决定退回中文名还是「未知」。 */
export function name (hash: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  if (hash === null || hash === undefined || hash === '') return null
  const code = resolveLocale(locale)
  const key = String(hash)
  const b = load()
  const lk = locKey(code)
  const fromLocs = lk ? b.locs[lk]?.[key] : undefined
  if (fromLocs) return fromLocs
  /* 部件名只在 textmap 里；这门语言缺这条（上游 dump 滞后）就退回中文 —— 显示中文好过显示空白 */
  const table = b.textmap[code]
  const t = table?.[key] ?? b.textmap.chs?.[key]
  return t ?? null
}

/** 角色：avatarId → 文案（内部先换 hash） */
export function avatarName (id: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  if (id === null || id === undefined) return null
  return name(load().avatars[String(id)]?.NameTextMapHash, locale)
}

/** 武器：itemId → 文案 */
export function weaponName (itemId: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  if (itemId === null || itemId === undefined) return null
  return name(load().weapons[String(itemId)]?.NameTextMapHash, locale)
}

/**
 * 部件 id → 套装 id（enka 的 `relics.json`：`Items[itemId].SetId`）。
 *
 * 这是**套装身份的唯一来源**，也是为什么库里的 `set_hash` 不再参与显示：
 * `setNameTextMapHash` 在 locs.json 里查不到名字，setId 才能。
 * 查不到（老部件、散件 SetId=0）返回 null —— 显示层据此落「未知套装」。
 */
export function setIdOfItem (itemId: number | string | null | undefined): number | null {
  if (itemId === null || itemId === undefined) return null
  const b = load()
  const sid = b.relics.Items[String(itemId)]?.SetId
  if (sid === undefined || sid === null) return null
  return b.relics.Sets[String(sid)] ? Number(sid) : null
}

/** 套装：setId → 文案（`Sets[setId].Name` 是 locHash，再交给 name() 翻） */
export function setName (setId: number | string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  if (setId === null || setId === undefined) return null
  return name(load().relics.Sets[String(setId)]?.Name, locale)
}

/** 部位（1 花 2 羽 3 沙 4 杯 5 冠） */
export function slotName (pos: number | string, locale: string = DEFAULT_LOCALE): string | null {
  return pick(load().slots[String(pos)], resolveLocale(locale))
}

/** 词条：吃 miao 的短名（cpct / cdmg / hpPlus …）。key → FIGHT_PROP_* 的映射在 common/stat.ts
 *  （那边是对数值用的正确方向，这儿只是拿去官方文案表查名）。 */
export function statName (miaoKey: string, locale: string = DEFAULT_LOCALE): string | null {
  const prop = KEY_TO_PROP[miaoKey]
  return prop ? name(prop, locale) : null
}

/* ───────────── 中文反查（miao 的世界里只有中文名） ─────────────
 * 两个懒建的索引，都只服务「手上只有中文名」的调用方：
 *   zhHash  —— 中文名 → 官方 hash（fromZh 先换 hash 再翻；模拟器也用它补人工件的 nameHash）
 *   zhSetId —— 中文套装名 → setId（模拟器用：人工配装只给中文套装名）
 */
let zhHash: Map<string, number> | null = null
let zhSetId: Map<string, number> | null = null

/* 建在局部 const 上再赋值给模块变量：闭包里的 `let` 会被 TS 当成可变、narrowing 失效 */
function zhHashes (): Map<string, number> {
  if (!zhHash) {
    const m = new Map<string, number>()
    const b = load()
    /* enka 那份（角色 / 武器 / 套装 / 词条）+ 部件名那份，合成「中文 → hash」 */
    for (const table of [b.locs['zh-cn'], b.textmap.chs]) {
      for (const [hash, text] of Object.entries(table || {})) {
        if (text && !m.has(text)) m.set(text, Number(hash))
      }
    }
    zhHash = m
  }
  return zhHash
}

function zhSetIds (): Map<string, number> {
  if (!zhSetId) {
    const m = new Map<string, number>()
    const b = load()
    const zh = b.locs['zh-cn'] || {}
    for (const [sid, row] of Object.entries(b.relics.Sets)) {
      const text = row?.Name === undefined ? null : zh[String(row.Name)]
      if (text && !m.has(text)) m.set(text, Number(sid))
    }
    zhSetId = m
  }
  return zhSetId
}

/** 反向出口：手上只有中文名时换别的语言。用在套装（miao 的 `result.sets` 键是中文全名）。 */
export function fromZh (text: string | null | undefined, locale: string = DEFAULT_LOCALE): string | null {
  const h = text ? zhHashes().get(text) : undefined
  return h === undefined ? null : name(h, locale)
}

/**
 * 中文套装名 → setId。模拟器用：人工配装回传的是中文套装名，而显示层认 setId。
 *
 * 为什么需要它：**人工构造的圣遗物没有 enka 的 itemId/setId**（那是抓取时才有的东西），
 * 而显示层是从 setId 取本地化名的。补上 setId，人工件就走与真实件完全相同的显示路径。
 */
export function setIdOfZh (text: string | null | undefined): number | null {
  const sid = text ? zhSetIds().get(text) : undefined
  return sid === undefined ? null : sid
}

/** 中文名 → 官方文案 hash（部件名用：人工件的 nameHash 也是补出来的）。 */
export function hashOfZh (text: string | null | undefined): number | null {
  const h = text ? zhHashes().get(text) : undefined
  return h === undefined ? null : h
}

/** 供调试/测试用：拿到原始表（只读）。形状就是 vendor/i18n 里的文件。 */
export function raw (): Bundle {
  return load()
}
