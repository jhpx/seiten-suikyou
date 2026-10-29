/*
 * 角色域的传输对象（DTO）—— 给前端的角色整卡形状，纯类型、零逻辑。
 *
 * 与 repository/dbo/（数据库对象）对照：dbo 是库里/内存里的原文（数字 id、enka prop、无语言），
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
