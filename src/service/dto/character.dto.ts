/*
 * 角色域的传输对象（DTO）—— 给前端的最终形状，纯类型、零逻辑。
 *
 * 与 dbo/（数据库对象）对照：dbo 是库里/内存里的原文（数字 id、enka prop、无语言），
 * 这里是组装器（assembler/）翻译 + miao 算分后的结果（已本地化、已格式化）。
 *
 * 这里不 import 任何实现，只有类型；`MarkedArtifact` 借自 artifact.service.ts 的显示口径叶子。
 */
import type { MarkedArtifact } from '../artifact.service.ts'

/** 面板属性表的一行 */
export interface AttrRow {
  key: string
  /** 图标 key：dmg 行换成具体元素（pyro/dendro…），拿不到元素时留 'dmg'（CSS 里不画） */
  iconKey: string
  label: string
  value: string
  base: string
  baseZero: boolean
  plus: string
  weight: number
}

/** 内核的整包评分结果（`ArtisMark.getMarkDetail(profile, true)`）；形状按我们真正读的字段声明 */
export interface MarkDetail {
  mark?: string
  _mark?: number
  markClass?: string
  classTitle?: string
  isDefaultWeight?: boolean
  isCustomWeight?: boolean
  charWeight?: Record<string, number>
  sets?: Record<string, number>
  artis?: Record<number, MarkedArtifact>
}

/** 伤害表的一行。dmg 为 null = 这条不吃暴击（反应类伤害），页面上期望值独占整行 */
export interface DamageRow {
  title: string
  dmg: string | null
  avg: string
  /** 单位，拼在数值后面（目前只有坎蒂丝的「Q提升普攻伤害」是 '%'） */
  unit: string
}

/** 伤害表（明细页下侧的「伤害计算」表） */
export interface DamageView {
  rows: DamageRow[]
  /** buff 列表：「来源：描述」按冒号拆开 */
  buffs: Array<{ title: string; desc: string }>
  /** 角色 calc.js 的署名（miao 社区贡献者，比如「冰翼」） */
  createdBy: string
  enemyName: string
  enemyLv: number
}

/** 伤害请求的三种结果 —— 用判别联合而不是抛错 */
export type DamageResult =
  | { kind: 'ok', view: DamageView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

/** 模拟请求：用户改过的那几件（没改的不用传），形状是领域语义（套装名 + 部位 + 词条数值） */
export interface SimRequest {
  /** 武器：null / 不传 = 沿用角色当前武器 */
  weapon?: { itemId: number; level: number; affix: number } | null
  /** 圣遗物：只列被改过的部位 */
  artifacts?: Array<{
    set: string
    pos: number
    star: number
    level: number
    mainKey: string
    subs: Array<{ key: string; value: number }>
  }>
}

/** 模拟结果的三种情况 —— 与 DamageResult 同一个套路（用判别联合，不抛错） */
export type SimResult =
  | { kind: 'ok'; view: SimView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

/** 模拟的产物：与 shapeCharacter 同构的角色视图 + 伤害表 */
export interface SimView {
  /** 角色视图（面板 / 圣遗物卡 / 武器卡 …）—— 与明细页那份同构 */
  avatar: CharacterDto
  /** 伤害表（与 damageOf 同构）；算不出时是 null */
  damage: DamageView | null
}

/** 可选装备目录（页面渲染下拉框用） */
export interface SimCatalog {
  weapons: Array<{
    itemId: number
    name: string
    star: number
    affixText: string
    affixVals: string[][]
    main: { label: string; values: Record<string, string> }
    sub: { label: string; values: Record<string, string> } | null
  }>
  sets: Array<{ key: string; name: string; positions: number[]; star: number }>
  mains: Array<{ pos: number; options: Array<{ key: string; name: string; elem: boolean }> }>
  starLevels: Array<{ star: number; maxLevel: number }>
  subs: Array<{ key: string; name: string; int: boolean }>
}

/** 角色整卡视图 —— shapeCharacter 的产物，给前端 */
export interface CharacterDto {
  uid: number | null
  avatarId: number
  fetchedAt: string | null
  name: string
  nameZh: string
  star: number
  level: number | null
  cons: number
  fetter: number | null
  elem: string
  elemText: string
  elemBg: string
  rarityBg: string
  elemIcon: string
  splash: string
  imgs: Record<string, string>
  talent: Record<string, { level: number; original: number; plus: boolean; crown: boolean }>
  weapon: {
    state: 'none' | 'unknown' | 'ok'
    itemId: number
    name: string
    nameZh: string
    sName: string
    level: number | null
    affix: number | null
    promote: number | null
    star: number
    icon: string | null
    attrs: Array<{ key: string; label: string; value: string }>
    desc: string
  }
  score: {
    mark: string | undefined
    markValue: number | undefined
    markClass: string
    classTitle: string
    isDefaultWeight: boolean
    isCustomWeight: boolean
  }
  charWeight: Record<string, number>
  sets: Array<{ name: string; nameZh: string; count: number; icon: string | null }>
  panel: Array<{ key: string; label: string; value: number; text: string; kind: string; weight: number }>
  attrTable: AttrRow[]
  allAttr: Array<Record<string, unknown>>
  consList: boolean[]
  artifacts: Array<ReturnType<typeof import('../artifact.service.ts').artifactOf>>
}
