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
import { deriveTalent } from '../../gateway/miao/materialize.ts'
import { rubricLabel } from '../../gateway/miao/rubric.ts'
import type { MiaoProfile } from '../../gateway/miao/materialize.ts'
import { ArtifactDbo } from '../../repository/dbo/artifact.ts'
import { isIntegerStatKey } from '../../common/stat.ts'
import { CharacterDbo } from '../../repository/dbo/character.ts'
import { fmtTime } from '../../common/util.ts'
/* 显示口径 + 圣遗物卡片：叶子模块，单向引用，不成环 */
import {
  statLabel, pctText, attrValueText, KEY_TITLE,
  artifactOf, artifactSetIcon, assetSeg, shortLabel, setIdOf
} from '../artifact.service.ts'
import type { AttrRow, CharacterDto, MarkDetail } from '../dto/character.dto.ts'

/* ───────────────────────── 显示口径（面板 / 武器 / 词条数值） ───────────────────────── */

/*
 * 武器副属性的 key 归一 → **标准词条 key**（common/stat.ts 那一套）。
 */
export const WEAPON_KEY_FIX: Record<string, string> = {
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

/* 角色图像资源 —— 参照 miao 的图片资源结构，前端自行拼 assets/ 路径。
 *
 * face 是这里面唯一走本地小图的一张。全站用到它的就三处：首页两种卡片 + 模拟器圆框，
 * 最大只画到 107px（卡片 112px 宽 → .cc-face 是 120%×92% 的 contain，正方形源图落到 107）。
 * 上游那张 256×256、平均 46KB，编码得很保守 —— 一个 57 角色的账号首页光头像就要拉 2.6MB。
 * character/thumbs/<avatarId>/face.webp 是缩到 196px、q0.82 重编的本地件（见 tools/gen_flower.py）：
 * 196 对 2 倍屏要的 214 设备像素只是 1.09 倍放大，看不出来；57 个角色降到 0.75MB。
 * splash 反过来必须用原图 —— 明细页立绘按 1400px 宽摆，小图在那儿是糊的。
 * ⚠️ 小图用 avatarId 定位（不是中文名）：官方改译名换不掉 id，跟武器 thumbs 一个套路。
 * 目录形状照圣遗物：`thumbs/<avatarId>/face.webp`，id 当文件夹、文件名说清是哪张。
 * 返回里原本还有 card / banner 两张（840×400、845×140），前端一处都没引用过，
 * 已连同仓库里那 262 张图一起删掉（2026-11-09）。要加回来得先有页面真的用它。 */
function charImgs (char: any, avatarId: number | null | undefined): Record<string, string> {
  const base = `assets/meta-gs/character/${assetSeg(char.name)}/`
  const talentCons = char.talentCons || {}
  const imgs: Record<string, string> = {
    splash: `${base}imgs/splash.webp`
  }
  /* 头像只有 thumbs 这一种。avatarId 是主键，实际永远有；万一没有就别拼一条假路径
     （原来兜底拼的是 imgs/face.webp，那张原图 2026-11-09 已删，拼出来必然 404）。
     前端是 `imgs.face || imgs.splash`，字段缺了自然退回立绘。 */
  if (avatarId) imgs.face = `assets/meta-gs/character/thumbs/${avatarId}/face.webp`
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
  /* 规则标题（miao 口径的中文「角色名-规则名」）：classTitle 与 rubricLabel 都用它推 */
  const title = classTitleOf(result)

  /* 套装归属按**自己库里的每件圣遗物**数，不按 miao 的 `result.sets`：
   * miao 那边是按**套装显示名**分组的，同一套在不同时刻可能被它吐成两个名（裂套的真凶）。
   * 身份用 setId（enka 的套装 id，由 itemId 推 / 人工件直接给），跨角色、跨刷新都稳定。
   * 名字查不到就显示「未知套装」，绝不退回 miao 显示名。
   * 对照 MEMORY 数据通路铁律：库里只存数字 id、不存名字。 */
  const bySet = new Map<number | null, number>()
  for (const a of ch.artifacts || []) {
    if (a.pos == null) continue
    const setId = setIdOf(a)
    bySet.set(setId, (bySet.get(setId) || 0) + 1)
  }
  const sets = [...bySet.entries()]
    .map(([setId, count]) => {
      const nameZh = (setId === null ? null : i18n.setName(setId, 'zh')) || ''
      return {
        name: (setId === null ? null : i18n.setName(setId, loc)) || i18n.uiText('unknownSet', loc),
        nameZh,
        setId,
        count,
        /* 图标目录按 setId 摆（稳定数字身份），不按中文名 —— 见 artifactSetIcon 的注释 */
        icon: artifactSetIcon(setId)
      }
    })
    /* 件数多的在前，同数按名字排 —— 固定顺序，别让它在两次请求之间抖 */
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))

  const panel = panelOf(profile.attr, loc).map(p => ({ ...p, weight: cw[p.key] || 0 }))

  const allAttrRaw = profile.artis?.getAllAttr?.() || []
  const rawAll: Record<string, number> = {}
  /* effByKey 收的是**未舍入**的原始 eff（ArtisAttr.getData 的产物），用于全精度聚合。
     ⚠️ allAttr[].eff 是 miao formatArti 已经 ÷0.85 + round1 过的**展示字符串**，只能用于显示，
        不能拿来累加 —— 见 AGENTS.md「数值精度」。 */
  const effByKey: Record<string, number> = {}
  const coreArtis: Record<string, { attrs?: Array<{ key: string; value: number; eff?: number }> }> = profile.artis?.artis || {}
  for (const arti of Object.values(coreArtis)) {
    for (const at of arti.attrs || []) {
      rawAll[at.key] = (rawAll[at.key] || 0) + at.value
      effByKey[at.key] = (effByKey[at.key] || 0) + (at.eff || 0)
    }
  }
  const enkaAll = ArtifactDbo.subStatTotals(ch.artifacts)
  const allAttr = Array.from({ length: 10 }, (_, i) => {
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

  /* 有效 / 无效词条的「当量」（不是条数）：从**原始 eff** 聚合，全程全精度；舍入只在展示层
     （前端 detail.js 的 toFixed(1)）做。按权重 > 0 分有效（网格里的金/白）/ 无效（灰色 nouse），
     与右侧网格的配色口径一致。÷0.85 只是把 miao 的「单 roll 最大值」分母换成「均值」，
     属于口径转换、不是舍入 —— 所以一档词条的当量落在 0.82~1.18，均值 1.0。 */
  let effValid = 0
  let effInvalid = 0
  for (const [key, rawEff] of Object.entries(effByKey)) {
    const shown = rawEff / 0.85
    if ((cw[key] || 0) > 0) effValid += shown
    else effInvalid += shown
  }

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

  /* 武器图分两个尺寸：icon 是上游原图，留给明细页那张 100px 的武器卡
     （点进去才加载，不占首屏）；thumb 是缩到 96px 的本地预处理件，
     首页卡片 28×38px、模拟器 40px 用它 —— 原图 256px 白下十倍像素。
     小图按 enka 武器 id 命名、不按类型分目录：id 全局唯一，也不绑中文译名。
     认不出这把武器时两边都退回通用类型图，别让首页变空。 */
  const wIcon = wObj
    ? `assets/meta-gs/weapon/${assetSeg(wObj.type)}/${assetSeg(wObj.name)}/icon.webp`
    : (ch.weapon.equipped ? `assets/common/item/atk-${char.weaponType || 'sword'}.webp` : null)
  const wThumb = wObj && ch.weapon.itemId
    ? `assets/meta-gs/weapon/thumbs/${ch.weapon.itemId}.webp`
    : wIcon

  const imgs = charImgs(char, ch.avatarId)
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
      icon: wIcon,
      thumb: wThumb,
      attrs: weaponAttrs,
      desc: weaponDesc
    },
    score: {
      mark: result.mark,
      markValue: result._mark,
      markClass: result.markClass || 'D',
      classTitle: title,
      /* 页面显示的规则名：classTitle 是 miao 的中文原文，rubricLabel 按当前语言重拼（角色名+规则名） */
      rubricLabel: rubricLabel(ch.avatarId ?? 0, title, loc),
      isDefaultWeight: !!result.isDefaultWeight,
      isCustomWeight: !!result.isCustomWeight,
      /* 有效词条当量：权重 > 0 的那些副词条的 eff 之和（网格里金/白那几档）。见上面 effValid 计算。 */
      effValid,
      /* 无效词条当量：权重 = 0 的那些（网格里的灰色 nouse）。
         页面不单独显示它，只用来跟 effValid 相加得出「总词条」那个分母（前端算 有效/总）。 */
      effInvalid
    },
    charWeight: cw,
    sets,
    panel,
    attrTable: attrTableOf(profile, loc, cw, elem),
    allAttr,
    consList,
    /* 每件的有效/总当量要按角色权重切，所以把 cw 传进去 —— 口径与上面 score.effValid 一致 */
    artifacts: [1, 2, 3, 4, 5].map(pos =>
      artifactOf(pos, result.artis?.[pos], artifactsByPos.get(pos), loc, profile.artis?.artis?.[pos], cw))
  }
}

