/*
 * 角色用例 + 角色视图成型 —— 「角色」这一层的请求（伤害）与角色页面要的整包形状
 * （面板 / 圣遗物卡 / 词条汇总 / 天赋 / 命座 / 武器）都在这。
 *
 * 与 account.service.ts 对照：那边管账号层（列表 / 详情 / 抓取 / 账号整包视图）。
 * 词条标题、百分比舍入、面板文本这些「怎么显示」的规则，以及单件圣遗物卡片
 * （statLabel / attrValueText / artiLabel / artifactOf …），已经抽到
 * artifact.service.ts —— 那是个只引 gateway / domain / common 的叶子，本文件单向引它，
 * 避免 character → artifact → character 的环。
 * 账号域只借用 common/util.ts 的 fmtTime。
 *
 * 这里**不出现状态码** —— 「账号没数据」「没这个角色」用判别联合表达，
 * 由 rest 层决定回 404 还是别的。
 */
import { ArtisMark, Format, i18n, Weapon as MiaoWeapon } from '../index.ts'
import { toMiaoProfile, deriveTalent } from '../gateway/miao/materialize.ts'
import type { MiaoProfile } from '../gateway/miao/materialize.ts'
import { buildSimProfile, mainKeysOf, promoteOf, simCatalog, subAttrKeys, artifactNameOf, artifactMaxLevel } from '../gateway/miao/simulate.ts'
import type { SimDraft } from '../gateway/miao/simulate.ts'
import { calcDamage } from '../gateway/miao/damage.ts'
import { ArtifactDbo, setMaxStar } from '../dbo/artifact.ts'
import { WeaponDbo } from '../dbo/weapon.ts'
import { isIntegerStatKey } from '../dbo/stat.ts'
import { CharacterDbo } from '../dbo/character.ts'
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { fmtTime } from '../common/util.ts'
/* 显示口径 + 圣遗物卡片：叶子模块，单向引用，不成环 */
import {
  statLabel, pctText, attrValueText, KEY_TITLE,
  artifactOf, artifactIcon, assetSeg, artiLabel, shortLabel
} from './artifact.service.ts'
import type { MarkedArtifact } from './artifact.service.ts'

/* ───────────────────────── 用例 ───────────────────────── */

/**
 * 伤害请求的三种结果 —— 用判别联合而不是抛错：
 * 「账号没抓过」和「账号有但没这个角色」对调用方是两种提示，控制器要分别回不同 code。
 */
export type DamageResult =
  | { kind: 'ok', view: DamageView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

export async function characterDamage (db: Db, uid: number, avatarId: number): Promise<DamageResult> {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  const character = (account.characters || []).find(ch => ch.avatarId === avatarId)
  if (!character) return { kind: 'no_character' }
  /* 算不出（没有伤害脚本 / 新角色先于 miao 更新）返回 null —— 接口照旧 200 + data:null，
     不当作错误：这是「暂时算不了」，不是「你请求错了」。 */
  return { kind: 'ok', view: await damageOf(character) }
}

/* ───────────────────────── 显示口径（面板 / 武器 / 词条数值） ───────────────────────── */

/*
 * 武器副属性的 key 归一 → **标准词条 key**（domain/stat.ts 那一套）。
 *
 * miao 的 Weapon.calcAttr() 给的是 `atkPct` / `hpPct` / `defPct`，而标准 key 是
 * `atk` / `hp` / `def`（不带 Pct 才是百分比，带 `Plus` 才是固定值 —— 反着记会把
 * 大生命指到小生命上）。不归一的话 statLabel 查不到、只能退回裸 key 或硬编码短名
 * （前端原来那张 W_ATTR_TITLE 就写成「攻击 / 生命 / 精通 / 爆伤」，不是官方叫法）。
 */
const WEAPON_KEY_FIX: Record<string, string> = {
  atkPct: 'atk', hpPct: 'hp', defPct: 'def'
}

/*
 * 首页「按属性权重筛选」的选项：命中判据是**这一项权重不为 0** ——
 * 权重表里给 0 的，就是这个角色不吃这条属性。
 *
 * 收哪些键：只用 miao 权重表里**真的会出现**的键。
 * ⚠️ 大/小词条（atk / atkPlus、hp / hpPlus、def / defPlus）**成对出现、权重相等**，
 *   所以一条只挂一个键 —— 挂两个就是两颗筛出来一模一样的 chip。
 * ⚠️ dmg / phy / heal 是三种加成，各占游戏里一个位置：**按角色挑**，不用三个都出。
 * 顺序按「面板里从上往下的读法」排。
 */
export function weightFilterOptions (locale: string): Array<{ key: string; label: string }> {
  return ['hp', 'atk', 'def', 'mastery', 'cpct', 'cdmg', 'recharge', 'dmg', 'phy', 'heal']
    .map(key => ({ key, label: statLabel(key, locale) }))
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

/* ───────────────────────── 视图成型（角色面板 / 圣遗物卡 / 词条汇总） ───────────────────────── */

/** 面板属性表的一行。给名字是因为调用方（页面之外还有测试）要按下标找行、比 key 与名字，
 *  用 Record<string, unknown> 的每处都得断言一次。 */
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

/* 角色图像资源 —— 照抄 miao 的 CharImg.getImgs（models/character/CharImg.js:87）。
 * vendor 里那个被 sync 脚本整体置空了（要读磁盘、依赖 image-size），而这里要的只是拼路径。
 *
 * 三条规则一个字都不能改：① 天赋 A 的图标按**武器类型**取公共图（普攻图标本来就是武器图标）；
 * ② 天赋 E/Q 的图标**就是提升它的那个命座图标**（talentCons 里写的 3 / 5），角色目录里没有 talent-e.webp；
 * ③ 立绘用 imgs/splash.webp，不是 character-img/ 那套（后者是别的功能的同人插画）。 */
function charImgs (char: any): Record<string, string> {
  const base = `assets/meta-gs/character/${assetSeg(char.name)}/`
  const talentCons = char.talentCons || {}
  /* 键是动态拼的（cons1..cons6 / a / e / q），所以标成「字符串字典」而不是字面量对象 */
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

/* 画布底图 / 元素图标按元素分文件（common/bg/bg-{元素}.webp、common/elem/{元素}.png）。角色元数据里的
   elem 本来就叫 pyro/cryo/…，直接当文件名用。只有旅行者是 multi、没有对应图，按上游兜底取 hydro。 */
const ELEM_BG = new Set(['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo'])
const elemOf = (elem: string): string => (ELEM_BG.has(elem) ? elem : 'hydro')
/* 元素名按 locale 走 ui 表（七元素全收）；key 不在表里的未知元素回落到 miao 的中文单字 */
const ELEM_UI: Record<string, string> = {
  pyro: 'elemPyro', hydro: 'elemHydro', cryo: 'elemCryo', electro: 'elemElectro',
  anemo: 'elemAnemo', geo: 'elemGeo', dendro: 'elemDendro'
}
const elemNameLocalized = (elem: string, loc: string): string =>
  (ELEM_UI[elem] ? i18n.uiText(ELEM_UI[elem], loc) : '') || Format.elemName(elem)

/* 面板属性表 —— 顺序和键照抄 miao 模板的 attrMap（profile-detail.html:46）：每项三列（总值 / 基础值 / 绿字） */
const ATTR_TABLE: Array<[string, string]> = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'], ['mastery', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'], ['recharge', 'pct']
]

/*
 * 三种加成单列：元素伤害 / 物伤加成 / 治疗加成 —— **按角色挑，不是三个都出**。
 * 它们互斥且各占游戏里一个位置（dmg 是 4 号杯主词条之一、phy 只能当副词条、heal 是 5 号杯主词条之一），
 * 一个人不会同时堆三种，出三行有两行永远是 0.0%。
 *
 * 挑哪几行**只看权重表**：权重 > 0 才出，**面板实际值不参与判断**。
 * ⚠️ 别把「面板值 > 0」也加进判据：角色可能碰巧带了不符合权重表的圣遗物，
 *    多出来那行不是「她的面板」而是「圣遗物的面板」。
 * ⚠️ 也别改成「只挑一个」：有角色**真的两项都要**（优菈 phy100/dmg40、雷泽 dmg100/phy100），
 *    硬压成一行等于藏掉他真正需要的词条。
 */
const DMG_ATTRS: Array<[string, string]> = [['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']]

/* 面板属性名 —— 中文下跟 miao 出图用字对齐。
 * ⚠️ 别改用 KEY_TITLE / artiLabel 那两张表：它们给的是「大生命 / 大攻击 / 充能效率」（圣遗物卡片要区分
 *   大小词条），而面板是属性总值、不区分。
 * ⚠️ 也不能照抄上游模板那张（`hp:'生命值' … dmg:'伤害加成'`）：它只有 dmg、没有 phy/heal，
 *   沿用 `dmg:'伤害加成'` 会把元素/物理/治疗三个名字合并成一个（实测芭芭拉 65.9% 显成「伤害加成」）。 */
const ATTR_TITLE_ZH: Record<string, string> = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能',
  dmg: '元素伤加成', phy: '物伤加成', heal: '治疗加成'
}

/*
 * 面板属性表：三列（总值 / 基础值 / 绿字） + 生效权重。
 *
 * 导出供测试断言用：属性名的三套用字（面板 / 圣遗物卡 / 汇总短标题）很容易改串，钉在测试里比钉截图靠谱。
 * ⚠️ 入参只要 `attr` / `base` 两栏（Pick 出来的）—— 写成整个 MiaoProfile 会害得
 * 「只想验排版」的调用方凭空造一个假 profile。
 */
export function attrTableOf (profile: Pick<MiaoProfile, 'attr' | 'base'>, locale: string, charWeight: Record<string, number> = {}, elem = ''): AttrRow[] {
  const attr = profile.attr || {}
  const base = profile.base || {}
  const zh = locale === 'chs' || locale === 'cht'
  /* dmg 行换成具体元素的图标；拿不到元素就留 'dmg'（CSS 里不画） */
  const dmgIcon = ELEM_BG.has(elem) ? elem : 'dmg'
  /* 属性名：中文用上面那张表，其它语言走 i18n 表。元素伤那一行带具体元素 —— 用字跟杯子（4 号位）对齐，
     名字就在 KEY_TITLE 里（`pyro → 火伤加成`，miao 自己按同一句式生成的）；拿不到元素时退回同句式的通名，
     别掉到 statLabel 去 —— 那边给的是官方全称「元素伤害加成」（6 字），跟物伤/治疗两项对不齐。 */
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
      baseZero: !baseValue,          // 基础值为 0 时 miao 会置灰（CSS .base.zero）
      plus: fmt(total - baseValue),
      weight: charWeight[key] || 0
    }
  }
  /* 前七项恒为满行：miao 模板是死循环那张表，缺项的属性也照样出一行 0.0%，行高和对齐才稳定（别 continue）。
     末尾三种加成**只按权重表出行**（理由见 DMG_ATTRS 的注释）。 */
  return [...ATTR_TABLE.map(makeRow), ...DMG_ATTRS.filter(([key]) => (charWeight[key] || 0) > 0).map(makeRow)]
}

/* 词条按权重分三档，页面靠这个类名上色（miao 卡片的「有效/无效词条」规则） */
function weightClass (weight: number): string {
  return weight > 79.9 ? 'great' : (weight > 0 ? 'useful' : 'nouse')
}

const DEFAULT_WEIGHT_LABEL = '默认'
const CUSTOM_WEIGHT_LABEL = '自定义'

/*
 * 场景名（classTitle）里「角色缩写-」前缀怎么写 —— 三种权重来源要分得开。miao 固定拼 `${char.abbr}-${title}`，
 * 于是「沃雅妮莎」这种上游权重表里还没有的角色会显示成「妮莎-通用」，看着像上游真给它定过一套「通用」权重，
 * 实际内核是拿 defaultAttrWeight 凑的。兜底时把前缀换成「默认」：默认-通用。
 *
 *   权重来源                          内核给的标记        页面显示
 *   权重表那一行 / 专属规则特判分支    无                 角色缩写-通用
 *   专属规则默认分支、权重与表一致     无                 角色缩写-通用（与上一行同形，正确）
 *   专属规则默认分支、手写了权重       isCustomWeight     角色缩写-自定义
 *   权重表里没这个角色（内核兜底）     isDefaultWeight    默认-通用
 *
 * 第四行为什么单标：miao 只在「命中特判分支」时给自定义名字，于是迪希雅那种手写一整套、却也叫
 * 「迪希雅-通用」的情况看着像查表来的（实际 recharge 55→75、mastery 整个去掉）；实测 69 个专属规则角色里只有他一个。
 *
 * 语义分工：「通用」回答**命中哪个场景**，前缀回答**用的哪套权重** —— 所以只换前缀、保留后半段。
 */
export function classTitleOf (result: MarkDetail | null | undefined): string {
  const title = result?.classTitle || ''
  if (!title) return title
  const i = title.indexOf('-')
  /* isDefaultWeight：无论标题带什么场景词都要改前缀 —— 兜底角色带绝缘4/西风时内核标题是「xxx-绝缘4」，
     那说的是「命中了哪个场景」，而权重是兜底的这件事同样得说出来。两个标记回答不同问题，不能互相吞掉。 */
  if (result?.isDefaultWeight) {
    return i < 0 ? DEFAULT_WEIGHT_LABEL : DEFAULT_WEIGHT_LABEL + title.slice(i)
  }
  /* isCustomWeight：只在标题就是「通用」时改。标题已自带场景名（「可莉-纯火」）再改是重复信息 ——
     内核侧已保证不会这么传，这里再挡一道脏数据。 */
  if (result?.isCustomWeight && title.slice(i + 1) === '通用') {
    return CUSTOM_WEIGHT_LABEL + title.slice(i)
  }
  return title
}

/** 一个角色 → 视图对象：`ch` 是领域模型（含武器与圣遗物），`profile` 来自 toMiaoProfile，
 *  `result` 是 ArtisMark.getMarkDetail(profile, true) 的结果，`locale` 认不出会退回默认语言 */
export function shapeCharacter (ch: CharacterDbo, profile: MiaoProfile, result: MarkDetail, locale: string = i18n.DEFAULT_LOCALE) {
  const loc = i18n.resolveLocale(locale)
  const char = profile.char
  const artifactsByPos = new Map((ch.artifacts || []).map(a => [a.pos, a] as const))
  const talent = deriveTalent(char, ch.skillLevelMap || {})
  /* 生效权重：getMarkDetail(profile, **true**) 的 charWeight。
     ⚠️ 第二个参数必须是 true —— charWeight 只在 withDetail 分支里挂上（ArtisMark.js:231），传 false 会
     静默少一个键，面板权重整列 0、词条全被判成「无效」。里面的值是**算完之后的最终权重**（含武器特判
     护摩/绝缘4/西风与角色专属规则的修正），不是权重表的原始值 —— 面板要的就是这个。 */
  const cw = result.charWeight || {}

  /* 套装：miao 的 sets 键是**官方中文全名**（不是 hash），只能拿中文名反查。
     icon 固定取「花」（部位 1）那张 —— 五件的部位图里花的轮廓差别最大，一眼能分套，
     而且每套都出全五件，不存在缺图。名字用 key（中文全名）拼，不跟显示名走：
     素材目录是官方中文，切英文时 setNameZh 还是中文，不能拿英文去拼路径。 */
  const sets = Object.entries(result.sets || {}).map(([name, count]) => ({
    name: i18n.fromZh(name, loc) || name,
    nameZh: name,
    count,
    icon: artifactIcon(name, 1)
  }))

  /* 面板属性 + 该属性的评分权重（>=80 前端高亮成金色，和 miao 一致） */
  const panel = panelOf(profile.attr, loc).map(p => ({ ...p, weight: cw[p.key] || 0 }))

  /* 有效词条汇总：miao 的 allAttr（全队圣遗物里所有有效副词条），补到 9 格。
     汇总的裸数字拿不回来（getAllAttr 只给格式化串），但每一件的裸数字都在 artis 模型里 ——
     照它同一套加法加一遍（只加 attrs 的 value、不含主词条）就够，也只为显示时舍一次。 */
  const allAttrRaw = profile.artis?.getAllAttr?.() || []
  const rawAll: Record<string, number> = {}
  /* 内核 artis 模型是 vendored JS（MiaoProfile.artis 只是 any）—— 按我们真正读的字段给它安个名字 */
  const coreArtis: Record<string, { attrs?: Array<{ key: string; value: number }> }> = profile.artis?.artis || {}
  for (const arti of Object.values(coreArtis)) {
    for (const at of arti.attrs || []) rawAll[at.key] = (rawAll[at.key] || 0) + at.value
  }
  /* enka 侧的同一套加法在模型上做（Artifact.subStatTotals），显示优先用它（与游戏同口径） */
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

  /* 命座：6 格，已点亮到 cons 为止 */
  const consList = [1, 2, 3, 4, 5, 6].map(i => i <= (profile.cons ?? 0))

  /* 天赋交给 miao 自己的 CharTalent 算（别自己加命座加成）：它给 level（含命座加成）与 original（原始等级），
     前端靠这两个数判断「被命座提升过」和「满级戴皇冠」。 */
  const talentRaw = char.getAvatarTalent(talent, profile.cons ?? 0, 'original') || {}
  const talentView = Object.fromEntries(['a', 'e', 'q'].map(k => {
    const t = talentRaw[k]
    const level = t?.level ?? talent[k] ?? 0
    const original = t?.original ?? level
    return [k, { level, original, plus: level > original, crown: original >= 10 }]
  }))

  /* 武器：图标 + 主/副属性 + 精炼描述，全来自 miao 的 Weapon 元数据（上游是 Avatar.getWeaponDetail()，
     我们没搬 Avatar，照它的逻辑重算）。`WeaponDbo.get()` 认不出时返回 `false`（不是 null/undefined）——
     先归一到 `WeaponDbo | null`，后面 `wObj?.xxx` 才不会在 `false` 上报错。 */
  const wObj = ch.weapon.equipped ? (MiaoWeapon.get(ch.weapon.itemId) || null) : null
  /* 数组而不是 Record：**名字必须由后端按 locale 给**（statLabel），前端不该再存一张
     硬编码中文表 —— 那张表既不全（没有基础攻击力）、叫法也不标准（「爆伤」「精通」）。 */
  const weaponAttrs: Array<{ key: string; label: string; value: string }> = []
  let weaponDesc = ''
  if (wObj) {
    /* 内核 Weapon 的这个方法没有类型声明 —— 按我们真正读的字段断言 */
    const wCalc = (wObj.calcAttr?.(profile.weapon.level, profile.weapon.promote) || {}) as {
      atkBase?: number
      attr?: { key: string; value: number }
    }
    /* 主属性攻击力：游戏里武器面板**只有整数**（608、454、741），没有小数点。
       calcAttr 是按等级两端线性插值出来的浮点（401.31…），直接 comma(_,1) 会给出
       「401.3」这种游戏里不存在、也跟面板数值对不上的串 —— 一律收整到 0 位。 */
    if (wCalc.atkBase) {
      weaponAttrs.push({
        key: 'atkBase',
        label: statLabel('atkBase', loc),
        value: Format.comma(wCalc.atkBase, 0)
      })
    }
    if (wCalc.attr?.key) {
      /* 副属性：整数口径（精通）显整数，其余百分比 —— 判据用 isIntegerStatKey，
         跟圣遗物词条、面板属性表同一套，别在这儿另写「key === 'mastery'」的特判 */
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

  /* 武器名两条来源：i18n 表（官方 TextMap，按 itemId）→ miao 元数据。两条都查不到 ≠ 没装备武器，
     而是「这把武器比我们的元数据新」（例：奥黛塔的 11438）—— enka 照样给了 level/promote/affix，
     说明是装备着的。两种情况界面上必须分开说，前端靠下面的 state 选文案。 */
  const wName = (ch.weapon.equipped ? i18n.weaponName(ch.weapon.itemId, loc) : null) ||
    profile.weapon.name || ''

  const imgs = charImgs(char)
  const elem = profile.elem || char.elem || ''

  return {
    uid: profile.uid,
    avatarId: profile.id,
    /* 这个角色**自己**上一次被同步的时刻（character 表那行），不是整个 UID 的最后一次抓取 —— 展柜是子集、
       每次只覆盖展柜里那几个，所以角色之间能差好几天。列表页页脚报的是 UID 级时间
       （见 buildAccountView 的 fetchedAt），两处语义不同，别混。 */
    fetchedAt: fmtTime(ch.fetchedAt),
    name: i18n.avatarName(profile.id, loc) || char.name,
    nameZh: char.name,
    star: char.star || 5,
    level: profile.level,
    cons: profile.cons ?? 0,
    fetter: profile.fetter ?? null,
    elem,
    elemText: elemNameLocalized(elem, loc),    // 元素名按 locale 走 ui 表（七元素全收），未知元素回落 miao 中文单字
    elemBg: `assets/common/bg/bg-${elemOf(elem)}.webp`,
    /* 首页角色卡的两张图（明细页用不到）：星级底色、左上角元素图标。两个 URL 都在此拼好、前端不自己拼路径 */
    rarityBg: `assets/common/item/bg${char.star === 4 ? 4 : 5}.png`,
    elemIcon: `assets/common/elem/${elemOf(elem)}.png`,
    splash: imgs.splash,
    imgs,                                     // 整张表（立绘 + 命座 6 图 + 天赋 a/e/q 图）一起返回，前端照模板拼
    talent: talentView,
    weapon: {
      /* 三态，前端按它选文案，别再靠「name 是不是空串」猜：
         'none' 没装备武器 | 'unknown' 装备了但 i18n 表和 miao 元数据都不认识（新版本武器）| 'ok' 查到名字了 */
      state: !ch.weapon.equipped ? 'none' : (wName ? 'ok' : 'unknown'),
      /* 模拟比对页要把「当前这把」在下拉里选中，只能靠 id 认（按名字认会栽在本地化上） */
      itemId: ch.weapon.itemId ?? 0,
      name: wName,
      nameZh: profile.weapon.name || '',
      sName: wObj?.sName || profile.weapon.name || '',       // 卡片里显示的是缩写名（上游 weapon.sName || weapon.name）
      level: profile.weapon.level,
      affix: profile.weapon.affix,
      promote: profile.weapon.promote,
      star: wObj?.star ?? 0,
      /* 图标：meta-gs/weapon/{类型}/{名}/icon.webp。中文名要逐段 encode（直接拼 wObj.img 会拿到未编码的中文）。
         元数据不认识这把时退回**武器类型通用图**（五张图按类型分好了，类型能从 char.weaponType 拿到），
         卡片上就不至于空着一个格子。 */
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
      /* 权重来源的两个标记，表现层靠它们区分「用的哪套权重」（含义见 classTitleOf） */
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

/* ───────────────────────── 伤害计算（明细页下侧的「伤害计算」表） ───────────────────────── */

/** 伤害表的一行。dmg 为 null = 这条不吃暴击（反应类伤害），页面上期望值独占整行 */
export interface DamageRow {
  title: string
  dmg: string | null
  avg: string
  /** 单位，拼在数值后面（目前只有坎蒂丝的「Q提升普攻伤害」是 '%'） */
  unit: string
}

export interface DamageView {
  rows: DamageRow[]
  /** buff 列表：「来源：描述」按冒号拆开（内核 msg 原样是拼好的串） */
  buffs: Array<{ title: string; desc: string }>
  /** 角色 calc.js 的署名（miao 社区贡献者，比如「冰翼」） */
  createdBy: string
  enemyName: string
  enemyLv: number
}

/*
 * 一个角色 → 伤害表视图对象。内部就是 materialize 桥 + calcDamage（见 gateway/miao/damage.ts），
 * 本函数只做「给页面用的整形」：数值按 miao 出图的口径格式化（Format.comma(v, 0)）、
 * buff 串按冒号拆成两列。
 *
 * 返回 null 的三种情况对页面来说是同一件事（不出这一块）：角色没配 calc.js、
 * 脚本算崩了（calcDamage 内部已打日志）、或 materialize 搭不出 profile（元数据不认识的角色）。
 * 语义区别由调用方在调本函数前自己查（server 路由分 404 / 200+null）。
 *
 * ⚠️ 敌人名（enemyName）只有 miao 的中文（'小宝'），和 elemText 一个情况：内核没给别的语言。
 */
export async function damageOf (ch: CharacterDbo): Promise<DamageView | null> {
  const profile = toMiaoProfile(ch)
  if (!profile) return null
  const dmg = await calcDamage(profile)
  if (!dmg) return null
  return {
    rows: dmg.entries.map(e => ({
      title: e.title,
      dmg: e.dmg === null ? null : Format.comma(e.dmg, 0),
      avg: e.avg === null ? '' : Format.comma(e.avg, 0),
      unit: e.unit
    })),
    buffs: dmg.buffs.map(msg => {
      /* buff 串形如「蝶引来生：开E获得2,858.0点攻击力加成」—— 冒号前是来源、后面是描述。
         照 miao 模板的 split('：') 取 [0]/[1]；没有冒号时整串当来源、描述留空。 */
      const i = msg.indexOf('：')
      return i < 0 ? { title: msg, desc: '' } : { title: msg.slice(0, i), desc: msg.slice(i + 1) }
    }),
    createdBy: dmg.createdBy,
    enemyName: dmg.enemyName,
    enemyLv: dmg.enemyLv
  }
}

/* ───────────────────────── 模拟比对（改一套配装 → 重算） ───────────────────────── */

/**
 * 模拟请求：用户改过的那几件（没改的不用传）。
 *
 * ⚠️ 形状是**领域语义**（套装名 + 部位 + 词条数值），不是内核 id：
 *   内核那套 append_prop_ids 编码（一个 roll 一段）是 enka 的抓取格式，
 *   人手填的「暴击率 20%」没有对应的编码 —— 直接给数值更贴近人话，
 *   数值由内核按 attrMap 的基准值自己算（见 gateway/miao/simulate.ts）。
 */
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

/**
 * 模拟结果的三种情况 —— 与 DamageResult 同一个套路（用判别联合，不抛错）。
 *
 * `view` 为 null：内核算不出来（角色没被 miao 认识 / 没配 calc.js）——
 * 对页面是「算不出」，不是「请求错了」。
 */
export type SimResult =
  | { kind: 'ok'; view: SimView | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

/** 模拟的产物：与 shapeCharacter 同构的角色视图 + 伤害表 */
export interface SimView {
  /** 角色视图（面板 / 圣遗物卡 / 武器卡 …）—— 与明细页那份同构 */
  avatar: ReturnType<typeof shapeCharacter>
  /** 伤害表（与 damageOf 同构）；算不出时是 null */
  damage: DamageView | null
}

/**
 * 模拟一个角色：拿角色当前配装当底，按用户改过的部分重算面板与伤害。
 *
 * 走的是**和真实件完全同一条内核链路**（materialize → Attr.calc → ArtisMark → ProfileDmg），
 * 所以左右两栏的数值口径必然一致 —— 这不是「页面自己算一遍」，是「同一内核算两遍」。
 */
export async function characterSim (db: Db, uid: number, avatarId: number, req: SimRequest, locale: string): Promise<SimResult> {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  const character = (account.characters || []).find(ch => ch.avatarId === avatarId)
  if (!character) return { kind: 'no_character' }

  const base = toMiaoProfile(character)
  if (!base) return { kind: 'ok', view: null }

  const draft: SimDraft = {
    weapon: req.weapon ? { ...req.weapon } : null,
    artifacts: (req.artifacts || []).map(a => ({ ...a, subs: a.subs.map(s => ({ ...s })) }))
  }
  const profile = buildSimProfile(base, draft, base.elem || '')

  /* 评分：与真实件同一入口（ArtisMark.getMarkDetail），右栏的评分因此和左栏同口径 */
  const result = ArtisMark.getMarkDetail(profile, true) as MarkDetail

  /* 视图：把「人工件」翻译成领域模型，好让 shapeCharacter 走同一条成型路径。
     人工件没有 enka 的 nameHash / setHash（那是抓取时才有的东西），
     所以用 hashOfZh 从中文名反查 —— 查不到就退回中文名（i18n 出口本来就这个口径）。 */
  const view = shapeCharacter(
    simCharacterOf(character, profile, draft),
    profile,
    result,
    locale
  )
  const dmg = await calcDamage(profile)
  return {
    kind: 'ok',
    view: {
      avatar: view,
      damage: dmg
        ? {
            rows: dmg.entries.map(e => ({
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
        : null
    }
  }
}

/**
 * 把「人工配装」翻成领域模型（Character / Weapon / Artifact），
 * 让 shapeCharacter 能用同一条路径成型 —— 显示口径（词条标题、套装名、图标）全复用。
 *
 * ⚠️ 这里只喂**显示需要**的字段：Artifact 的 enka 数值（mainStatValue / subStats）
 *   人工件没有（用户给的是最终值，内核那边已经算好了），所以留空 ——
 *   shapeCharacter 显示副词条时优先用 enka 值，没有就退回内核值，正好是人工件要的。
 */
function simCharacterOf (ch: CharacterDbo, profile: MiaoProfile, draft: SimDraft): CharacterDbo {
  const artifacts = (ch.artifacts || []).map(a => {
    const spec = (draft.artifacts || []).find(s => s.pos === a.pos)
    if (!spec) return a
    const name = artifactNameOf(spec.set, spec.pos)
    if (!name) return a
    /* 套装名 → 官方文案 hash（本地化用）；查不到就 null，显示层会退回中文名 */
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
        /* 武器中文名从 miao 元数据反查（草稿里只带 id —— 名字是显示层的事，不该由前端传）。
           `MiaoWeapon.get` 认不出时返回 false（不是 null），先归一再用。 */
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

/**
 * 可选装备目录：这个角色能换什么。
 *
 * 武器按**角色武器类型**过滤（迪奥娜只能拿弓）—— 目录层就滤掉，页面与接口都不用再判一次。
 */
/**
 * miao 的文案里夹着 `<nobr>` 这类排版标记（游戏原文用它防折行）。
 * 我们的显示层一律 textContent，标记带出去就原样露出来 —— 在出口统一洗掉。
 */
const plainText = (text: string): string => String(text || '').replace(/<[^>]*>/g, '')

/**
 * 「等级档位 → 数值」翻成「等级档位 → 显示文本」。
 * 键必须转成字符串 —— JSON 的键没有数字这回事，前端拿到的永远是 `"20"`，
 * 与其让每个调用方自己 String() 一遍，不如在出口统一。
 */
function levelValues (vals: Record<number, number>, fmt: (v: number) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [lv, v] of Object.entries(vals)) out[lv] = fmt(v)
  return out
}

export function simCatalogOf (db: Db, uid: number, avatarId: number, locale: string): SimCatalog | null {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return null
  const character = (account.characters || []).find(ch => ch.avatarId === avatarId)
  if (!character) return null
  const profile = toMiaoProfile(character)
  if (!profile) return null

  const char = profile.char
  const weaponType = char.weaponType || ''
  const raw = simCatalog(weaponType)
  const loc = i18n.resolveLocale(locale)
  return {
    /* 武器：名字走 i18n（官方文案），查不到退回 miao 元数据里的中文名。
       affixText + affixVals 是精炼效果的「模板 + 数值表」（见 gateway/miao 里那段的说明）；
       main / sub 是主副属性按等级档位各给一份，弹窗右侧那栏显示用。 */
    weapons: raw.weapons.map(w => {
      /* 副属性 key 走武器那张修正表：miao 给 atkPct，标准叫法是 atk（攻击力%） */
      const subKey = w.sub ? (WEAPON_KEY_FIX[w.sub.key] || w.sub.key) : ''
      return {
        itemId: w.itemId,
        name: i18n.weaponName(w.itemId, loc) || w.name,
        star: w.star,
        affixText: plainText(w.affixText),
        affixVals: w.affixVals,
        /* 主属性一律整数（游戏里武器面板没有小数点）；副属性百分比还是整数，
           跟明细页同一套判据（isIntegerStatKey），别在这儿另写特判 */
        main: { label: statLabel('atkBase', loc), values: levelValues(w.atks, v => Format.comma(v, 0)) },
        sub: subKey
          ? {
            label: statLabel(subKey, loc),
            values: levelValues(w.sub!.values, v => isIntegerStatKey(subKey) ? Format.comma(v, 0) : pctText(v))
          }
          : null
      }
    }),
    /* 套装：miao 按中文名索引，所以中文名是**主键**，显示名另给一份。
       positions 是这套在游戏里有哪些部位 —— 前端按部位过滤下拉，别让人选「祭雷之人的花」：
       那种组合 `artifactRefOf` 认不出，后端会整件草稿静默跳过（值一点不变，只被染了模拟色）。
       star 是这套**最高几星**（下拉里标 5★/4★/3★，并决定等级上限）。 */
    sets: raw.sets.map(s => ({
      key: s.set,
      name: i18n.fromZh(s.set, loc) || s.set,
      positions: s.positions,
      star: setMaxStar(s.set)
    })),
    /* 各部位的主词条候选（key → 显示名）
       主词条是**大词条**（生命值/攻击力百分比…），用面板那套用字（ATTR_TITLE_ZH 口径） */
    mains: [1, 2, 3, 4, 5].map(pos => ({
      pos,
      options: mainKeysOf(pos).map(key => ({
        key,
        name: mainStatName(key, loc),
        /* 主词条都是百分比形态；元素伤害那项按角色元素显示 */
        elem: key === 'dmg'
      }))
    })),
    /* 星级 → 满级（enka 1 基口径：4★ 满级是 +16 → 17）。改圣遗物弹窗按它生成等级档位，
       前端不自己存一张「几星到几级」的表 —— 那是游戏规则，只有这一份 */
    starLevels: [5, 4, 3, 2, 1].map(star => ({ star, maxLevel: artifactMaxLevel(star) })),
    /* 副词条候选：大小词条同名（都是「攻击力」），必须标出是哪个，
       否则用户分不清填的是百分比还是固定值。int = 整数口径（显示时不带小数）。 */
    subs: subAttrKeys().map(key => ({
      key,
      name: artiLabel(key, loc),
      int: isIntegerStatKey(key)
    }))
  }
}

/** 主词条的显示名：直接走面板那套标签（statLabel），**必须带 locale** ——
    以前这里硬编码中文（ATTR_TITLE_ZH），英文/日文界面下主词条下拉仍是中文。 */
function mainStatName (key: string, locale: string): string {
  return statLabel(key, locale)
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
