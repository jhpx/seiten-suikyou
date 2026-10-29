/*
 * 角色组装器 —— 把 dbo + miao 计算结果 + i18n 翻译拼成 DTO（给前端的最终形状）。
 *
 * 与 character.service.ts（编排用例）对照：那边管「一个请求要办成什么事」（load → 找角色 →
 * materialize → 算分 → 组装 → return），这边的函数只负责「把已经算好的东西拼成页面要的形状」。
 *
 * 变化原因单一：页面要的字段/结构变了，才动这里。词条怎么念（statLabel / pctText 等口径）
 * 在 artifact.service.ts，这里只调它、不自己定口径。
 */
import { Format, i18n, Weapon as MiaoWeapon } from '../../index.ts'
import { toMiaoProfile, deriveTalent } from '../../gateway/miao/materialize.ts'
import type { MiaoProfile } from '../../gateway/miao/materialize.ts'
import { buildSimProfile, mainKeysOf, promoteOf, simCatalog, subAttrKeys, artifactNameOf, artifactMaxLevel } from '../../gateway/miao/simulate.ts'
import type { SimDraft } from '../../gateway/miao/simulate.ts'
import { calcDamage } from '../../gateway/miao/damage.ts'
import type { MiaoDamage } from '../../gateway/miao/damage.ts'
import { ArtifactDbo, setMaxStar } from '../../dbo/artifact.ts'
import { WeaponDbo } from '../../dbo/weapon.ts'
import { isIntegerStatKey } from '../../dbo/stat.ts'
import { CharacterDbo } from '../../dbo/character.ts'
import { fmtTime } from '../../common/util.ts'
/* 显示口径 + 圣遗物卡片：叶子模块，单向引用，不成环 */
import {
  statLabel, pctText, attrValueText, KEY_TITLE,
  artifactOf, artifactIcon, assetSeg, artiLabel, shortLabel
} from '../artifact.service.ts'
import type { AttrRow, CharacterDto, DamageRow, DamageView, MarkDetail, SimCatalog, SimView } from '../dto/character.dto.ts'

/* ───────────────────────── 显示口径（面板 / 武器 / 词条数值） ───────────────────────── */

/*
 * 武器副属性的 key 归一 → **标准词条 key**（dbo/stat.ts 那一套）。
 */
const WEAPON_KEY_FIX: Record<string, string> = {
  atkPct: 'atk', hpPct: 'hp', defPct: 'def'
}

/* 面板要显示哪几项、怎么格式化；顺序就是展示顺序（生命/攻击/防御整数，其余百分比） */
const PANEL_ROWS: Array<[string, string]> = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'],
  ['mastery', 'int'], ['recharge', 'pct'],
  ['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']
]

/* 属性 → 面板行（含权重前的原料）。shapeCharacter 给每行再挂权重 */
function panelOf (attr: Record<string, number> | null | undefined, locale: string): Array<{ key: string; label: string; value: number; text: string; kind: string }> {
  const rows: Array<{ key: string; label: string; value: number; text: string; kind: string }> = []
  for (const [key, kind] of PANEL_ROWS) {
    const v = attr?.[key]
    if (!v) continue
    rows.push({ key, label: statLabel(key, locale), value: v, text: kind === 'int' ? Format.comma(v, 0) : pctText(v), kind })
  }
  return rows
}

export function panelText (attr: Record<string, number> | null | undefined, locale: string): string {
  return panelOf(attr, locale).map(p => `${p.label} ${p.text}`).join('  ')
}

/* 角色图像资源 —— 照抄 miao 的 CharImg.getImgs（models/character/CharImg.js:87）。 */
function charImgs (char: any): Record<string, string> {
  const base = `assets/meta-gs/character/${assetSeg(char.name)}/`
  const talentCons = char.talentCons || {}
  const imgs: Record<string, string> = {
    splash: `${base}imgs/splash.webp`,
    face: `${base}imgs/face.webp`,
    card: `${base}imgs/card.webp`,
    banner: `${base}imgs/banner.webp`
  }
  for (let i = 1; i <= 6; i++) imgs[`cons${i}`] = `${base}icons/cons-${i}.webp`
  imgs.a = `assets/common/item/atk-${char.weaponType || 'sword'}.webp`
  for (const t of ['e', 'q']) {
    imgs[t] = talentCons[t] > 0 ? imgs[`cons${talentCons[t]}`] : `${base}icons/talent-${t}.webp`
  }
  return imgs
}

/* 画布底图 / 元素图标按元素分文件 */
const ELEM_BG = new Set(['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo'])
const elemOf = (elem: string): string => (ELEM_BG.has(elem) ? elem : 'hydro')
const ELEM_UI: Record<string, string> = {
  pyro: 'elemPyro', hydro: 'elemHydro', cryo: 'elemCryo', electro: 'elemElectro',
  anemo: 'elemAnemo', geo: 'elemGeo', dendro: 'elemDendro'
}
const elemNameLocalized = (elem: string, loc: string): string =>
  (ELEM_UI[elem] ? i18n.uiText(ELEM_UI[elem], loc) : '') || Format.elemName(elem)

/* 面板属性表 —— 顺序和键照抄 miao 模板的 attrMap */
const ATTR_TABLE: Array<[string, string]> = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'], ['mastery', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'], ['recharge', 'pct']
]

/* 三种加成单列：元素伤害 / 物伤加成 / 治疗加成 —— 按角色挑，不是三个都出 */
const DMG_ATTRS: Array<[string, string]> = [['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']]

/* 面板属性名 —— 中文下跟 miao 出图用字对齐 */
const ATTR_TITLE_ZH: Record<string, string> = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能',
  dmg: '元素伤加成', phy: '物伤加成', heal: '治疗加成'
}

export function attrTableOf (profile: Pick<MiaoProfile, 'attr' | 'base'>, locale: string, charWeight: Record<string, number> = {}, elem = ''): AttrRow[] {
  const attr = profile.attr || {}
  const base = profile.base || {}
  const zh = locale === 'chs' || locale === 'cht'
  const dmgIcon = ELEM_BG.has(elem) ? elem : 'dmg'
  const labelOf = (key: string, iconKey: string): string => {
    if (!zh) return statLabel(key, locale)
    if (key !== 'dmg') return ATTR_TITLE_ZH[key]
    return iconKey === 'dmg' ? ATTR_TITLE_ZH.dmg : (KEY_TITLE[iconKey] || ATTR_TITLE_ZH.dmg)
  }
  const makeRow = ([key, kind]: [string, string]): AttrRow => {
    const total = attr[key] ?? 0
    const baseValue = base[key] ?? 0
    const fmt = (v: number): string => (kind === 'int' ? Format.comma(v, 0) : pctText(v))
    const iconKey = key === 'dmg' ? dmgIcon : key
    return {
      key,
      iconKey,
      label: labelOf(key, iconKey),
      value: fmt(total),
      base: fmt(baseValue),
      baseZero: !baseValue,
      plus: fmt(total - baseValue),
      weight: charWeight[key] || 0
    }
  }
  return [...ATTR_TABLE.map(makeRow), ...DMG_ATTRS.filter(([key]) => (charWeight[key] || 0) > 0).map(makeRow)]
}

/* 词条按权重分三档，页面靠这个类名上色 */
function weightClass (weight: number): string {
  return weight > 79.9 ? 'great' : (weight > 0 ? 'useful' : 'nouse')
}

const DEFAULT_WEIGHT_LABEL = '默认'
const CUSTOM_WEIGHT_LABEL = '自定义'

export function classTitleOf (result: MarkDetail | null | undefined): string {
  const title = result?.classTitle || ''
  if (!title) return title
  const i = title.indexOf('-')
  if (result?.isDefaultWeight) {
    return i < 0 ? DEFAULT_WEIGHT_LABEL : DEFAULT_WEIGHT_LABEL + title.slice(i)
  }
  if (result?.isCustomWeight && title.slice(i + 1) === '通用') {
    return CUSTOM_WEIGHT_LABEL + title.slice(i)
  }
  return title
}

/* ───────────────────────── 角色整卡组装 ───────────────────────── */

/** 一个角色 → 角色整卡 DTO */
export function shapeCharacter (ch: CharacterDbo, profile: MiaoProfile, result: MarkDetail, locale: string = i18n.DEFAULT_LOCALE): CharacterDto {
  const loc = i18n.resolveLocale(locale)
  const char = profile.char
  const artifactsByPos = new Map((ch.artifacts || []).map(a => [a.pos, a] as const))
  const talent = deriveTalent(char, ch.skillLevelMap || {})
  const cw = result.charWeight || {}

  const sets = Object.entries(result.sets || {}).map(([name, count]) => ({
    name: i18n.fromZh(name, loc) || name,
    nameZh: name,
    count,
    icon: artifactIcon(name, 1)
  }))

  const panel = panelOf(profile.attr, loc).map(p => ({ ...p, weight: cw[p.key] || 0 }))

  const allAttrRaw = profile.artis?.getAllAttr?.() || []
  const rawAll: Record<string, number> = {}
  const coreArtis: Record<string, { attrs?: Array<{ key: string; value: number }> }> = profile.artis?.artis || {}
  for (const arti of Object.values(coreArtis)) {
    for (const at of arti.attrs || []) rawAll[at.key] = (rawAll[at.key] || 0) + at.value
  }
  const enkaAll = ArtifactDbo.subStatTotals(ch.artifacts)
  const allAttr = Array.from({ length: 9 }, (_, i) => {
    const a = allAttrRaw[i]
    if (!a || !a.key) return {}
    return {
      key: a.key,
      label: shortLabel(a.key, loc),
      value: attrValueText(a.key, a.value, rawAll[a.key], enkaAll.get(a.key)),
      upNum: a.upNum || 0,
      eff: a.eff ?? '-',
      cls: weightClass(cw[a.key] || 0)
    }
  })

  const consList = [1, 2, 3, 4, 5, 6].map(i => i <= (profile.cons ?? 0))

  const talentRaw = char.getAvatarTalent(talent, profile.cons ?? 0, 'original') || {}
  const talentView = Object.fromEntries(['a', 'e', 'q'].map(k => {
    const t = talentRaw[k]
    const level = t?.level ?? talent[k] ?? 0
    const original = t?.original ?? level
    return [k, { level, original, plus: level > original, crown: original >= 10 }]
  }))

  /* 武器：`MiaoWeapon.get` 认不出时返回 false，先归一到 Weapon | null */
  const wObj = ch.weapon.equipped ? (MiaoWeapon.get(ch.weapon.itemId) || null) : null
  const weaponAttrs: Array<{ key: string; label: string; value: string }> = []
  let weaponDesc = ''
  if (wObj) {
    const wCalc = (wObj.calcAttr?.(profile.weapon.level, profile.weapon.promote) || {}) as {
      atkBase?: number
      attr?: { key: string; value: number }
    }
    if (wCalc.atkBase) {
      weaponAttrs.push({
        key: 'atkBase',
        label: statLabel('atkBase', loc),
        value: Format.comma(wCalc.atkBase, 0)
      })
    }
    if (wCalc.attr?.key) {
      const key = WEAPON_KEY_FIX[wCalc.attr.key] || wCalc.attr.key
      weaponAttrs.push({
        key,
        label: statLabel(key, loc),
        value: isIntegerStatKey(key)
          ? Format.comma(wCalc.attr.value, 0)
          : pctText(wCalc.attr.value)
      })
    }
    weaponDesc = (wObj.getAffixDesc?.(profile.weapon.affix) as { desc?: string } | undefined)?.desc || ''
  }

  const wName = (ch.weapon.equipped ? i18n.weaponName(ch.weapon.itemId, loc) : null) ||
    profile.weapon.name || ''

  const imgs = charImgs(char)
  const elem = profile.elem || char.elem || ''

  return {
    uid: profile.uid,
    avatarId: profile.id,
    fetchedAt: fmtTime(ch.fetchedAt),
    name: i18n.avatarName(profile.id, loc) || char.name,
    nameZh: char.name,
    star: char.star || 5,
    level: profile.level,
    cons: profile.cons ?? 0,
    fetter: profile.fetter ?? null,
    elem,
    elemText: elemNameLocalized(elem, loc),
    elemBg: `assets/common/bg/bg-${elemOf(elem)}.webp`,
    rarityBg: `assets/common/item/bg${char.star === 4 ? 4 : 5}.png`,
    elemIcon: `assets/common/elem/${elemOf(elem)}.png`,
    splash: imgs.splash,
    imgs,
    talent: talentView,
    weapon: {
      state: !ch.weapon.equipped ? 'none' : (wName ? 'ok' : 'unknown'),
      itemId: ch.weapon.itemId ?? 0,
      name: wName,
      nameZh: profile.weapon.name || '',
      sName: wObj?.sName || profile.weapon.name || '',
      level: profile.weapon.level,
      affix: profile.weapon.affix,
      promote: profile.weapon.promote,
      star: wObj?.star ?? 0,
      icon: wObj
        ? `assets/meta-gs/weapon/${assetSeg(wObj.type)}/${assetSeg(wObj.name)}/icon.webp`
        : (ch.weapon.equipped ? `assets/common/item/atk-${char.weaponType || 'sword'}.webp` : null),
      attrs: weaponAttrs,
      desc: weaponDesc
    },
    score: {
      mark: result.mark,
      markValue: result._mark,
      markClass: result.markClass || 'D',
      classTitle: classTitleOf(result),
      isDefaultWeight: !!result.isDefaultWeight,
      isCustomWeight: !!result.isCustomWeight
    },
    charWeight: cw,
    sets,
    panel,
    attrTable: attrTableOf(profile, loc, cw, elem),
    allAttr,
    consList,
    artifacts: [1, 2, 3, 4, 5].map(pos =>
      artifactOf(pos, result.artis?.[pos], artifactsByPos.get(pos), loc, profile.artis?.artis?.[pos]))
  }
}

/* ───────────────────────── 伤害组装 ───────────────────────── */

/** 一个角色 → 伤害表 DTO。返回 null 表示算不出（没配 calc.js / 脚本算崩 / materialize 搭不出 profile） */
export async function damageOf (ch: CharacterDbo): Promise<DamageView | null> {
  const profile = toMiaoProfile(ch)
  if (!profile) return null
  const dmg = await calcDamage(profile)
  if (!dmg) return null
  return damageToView(dmg)
}

/** 归一化 miao 的原始伤害结果 → DamageView（伤害组装，供 damageOf 与 characterSim 共用） */
export function damageToView (dmg: MiaoDamage): DamageView {
  return {
    rows: dmg.entries.map((e): DamageRow => ({
      title: e.title,
      dmg: e.dmg === null ? null : Format.comma(e.dmg, 0),
      avg: e.avg === null ? '' : Format.comma(e.avg, 0),
      unit: e.unit
    })),
    buffs: dmg.buffs.map(msg => {
      const i = msg.indexOf('：')
      return i < 0 ? { title: msg, desc: '' } : { title: msg.slice(0, i), desc: msg.slice(i + 1) }
    }),
    createdBy: dmg.createdBy,
    enemyName: dmg.enemyName,
    enemyLv: dmg.enemyLv
  }
}

/* ───────────────────────── 模拟组装 ───────────────────────── */

/* miao 的文案里夹着 <nobr> 这类排版标记，出口统一洗掉 */
const plainText = (text: string): string => String(text || '').replace(/<[^>]*>/g, '')

/* 「等级档位 → 数值」翻成「等级档位 → 显示文本」；键转字符串（JSON 键没有数字） */
function levelValues (vals: Record<number, number>, fmt: (v: number) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [lv, v] of Object.entries(vals)) out[lv] = fmt(v)
  return out
}

/** 主词条的显示名：直接走面板那套标签（statLabel），必须带 locale */
function mainStatName (key: string, locale: string): string {
  return statLabel(key, locale)
}

/** 把「人工配装」翻成领域模型，让 shapeCharacter 走同一条成型路径 */
function simCharacterOf (ch: CharacterDbo, profile: MiaoProfile, draft: SimDraft): CharacterDbo {
  const artifacts = (ch.artifacts || []).map(a => {
    const spec = (draft.artifacts || []).find(s => s.pos === a.pos)
    if (!spec) return a
    const name = artifactNameOf(spec.set, spec.pos)
    if (!name) return a
    const setHash = i18n.hashOfZh(spec.set)
    return new ArtifactDbo({
      pos: a.pos,
      itemId: a.itemId,
      levelRaw: spec.level,
      star: spec.star,
      mainPropId: 0,
      appendPropIds: [],
      mainStatValue: null,
      subStats: [],
      nameHash: i18n.hashOfZh(name),
      setHash
    })
  })

  const weapon = draft.weapon
    ? new WeaponDbo({
        itemId: draft.weapon.itemId,
        nameHash: i18n.hashOfZh((MiaoWeapon.get(draft.weapon.itemId) || null)?.name || ''),
        level: draft.weapon.level,
        promote: promoteOf(draft.weapon.level),
        affix: draft.weapon.affix
      })
    : ch.weapon

  return new CharacterDbo({
    uid: ch.uid,
    avatarId: ch.avatarId,
    level: ch.level,
    promote: ch.promote,
    cons: ch.cons,
    fetter: ch.fetter,
    costume: ch.costume,
    skillLevelMap: ch.skillLevelMap,
    weapon,
    artifacts,
    source: ch.source,
    fetchedAt: ch.fetchedAt
  })
}

/** 可选装备目录 → SimCatalog DTO */
export function simCatalogToDto (character: CharacterDbo, locale: string): SimCatalog | null {
  const profile = toMiaoProfile(character)
  if (!profile) return null
  const char = profile.char
  const weaponType = char.weaponType || ''
  const raw = simCatalog(weaponType)
  const loc = i18n.resolveLocale(locale)
  return {
    weapons: raw.weapons.map(w => {
      const subKey = w.sub ? (WEAPON_KEY_FIX[w.sub.key] || w.sub.key) : ''
      return {
        itemId: w.itemId,
        name: i18n.weaponName(w.itemId, loc) || w.name,
        star: w.star,
        affixText: plainText(w.affixText),
        affixVals: w.affixVals,
        main: { label: statLabel('atkBase', loc), values: levelValues(w.atks, v => Format.comma(v, 0)) },
        sub: subKey
          ? {
            label: statLabel(subKey, loc),
            values: levelValues(w.sub!.values, v => isIntegerStatKey(subKey) ? Format.comma(v, 0) : pctText(v))
          }
          : null
      }
    }),
    sets: raw.sets.map(s => ({
      key: s.set,
      name: i18n.fromZh(s.set, loc) || s.set,
      positions: s.positions,
      star: setMaxStar(s.set)
    })),
    mains: [1, 2, 3, 4, 5].map(pos => ({
      pos,
      options: mainKeysOf(pos).map(key => ({
        key,
        name: mainStatName(key, loc),
        elem: key === 'dmg'
      }))
    })),
    starLevels: [5, 4, 3, 2, 1].map(star => ({ star, maxLevel: artifactMaxLevel(star) })),
    subs: subAttrKeys().map(key => ({
      key,
      name: artiLabel(key, loc),
      int: isIntegerStatKey(key)
    }))
  }
}

/* 组装模拟结果里「改后的角色视图」+「伤害表」，供 character.service 的 characterSim 调用 */
export function simViewOf (character: CharacterDbo, profile: MiaoProfile, result: MarkDetail, draft: SimDraft, locale: string, damage: DamageView | null): SimView {
  const view = shapeCharacter(simCharacterOf(character, profile, draft), profile, result, locale)
  return { avatar: view, damage }
}
