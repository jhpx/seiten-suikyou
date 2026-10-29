/*
 * 模拟比对域的传输对象（DTO）—— 模拟请求 / 结果 / 装备目录，纯类型、零逻辑。
 */
import type { CharacterDto } from './character.dto.ts'
import type { DamageView } from './damage.dto.ts'

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
