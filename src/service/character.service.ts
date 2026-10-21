/*
 * 角色用例 + 角色视图成型 —— 「角色」这一层的请求（伤害）与角色页面要的整包形状
 * （面板 / 圣遗物卡 / 词条汇总 / 天赋 / 命座 / 武器）都在这。
 *
 * 与 account.service.ts 对照：那边管账号层（列表 / 详情 / 抓取 / 账号整包视图）。
 * 词条标题、百分比舍入、面板文本这些「怎么显示」的规则也在这 —— 用它们的只有角色面板与圣遗物卡。
 * 账号域只借用 common/util.ts 的 fmtTime。
 *
 * 这里**不出现状态码** —— 「账号没数据」「没这个角色」用判别联合表达，
 * 由 rest 层决定回 404 还是别的。
 */
import { Artifact as MiaoArtifact, ArtisMark, Format, i18n, Weapon } from '../index.ts'
import { toMiaoProfile, deriveTalent } from '../kernel/materialize.ts'
import type { MiaoProfile } from '../kernel/materialize.ts'
import { calcDamage } from '../kernel/damage.ts'
import { Artifact } from '../domain/artifact.ts'
import { isIntegerStatKey } from '../domain/stat.ts'
import type { Character } from '../domain/character.ts'
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { fmtTime, num } from '../common/util.ts'

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

/* ───────────────────────── 显示口径（词条标题 / 数值串 / 面板文本） ───────────────────────── */

/* miao 自己的词条中文标题（含 `pyro → 火伤加成` 这类元素名，由 Format.eachElem 生成）。
   i18n 表查不到时的兜底；圣遗物卡片标题（artiLabel）也用它。
   内核是 vendored JS，返回值 TS 只能推成 `{}`，断言成字典、形状由上游保证。 */
export const KEY_TITLE = ArtisMark.getKeyTitleMap('gs') as Record<string, string>

/*
 * 官方用字修正表 —— 只放「miao 那张表跟游戏官方叫法不一致」的条目，目前只有一条。
 *
 * `dmg` 在 miao 的 i18n 表里是「伤害增加」/ “DMG Bonus”（它自己出图时的简称），
 * 但游戏里这一条就叫**元素伤害加成**。面板上物伤/治疗/元素伤三行连着读，
 * 写成「伤害增加」看不出到底是哪个加成 —— 所以按官方名改。
 * ⚠️ 别改 vendor/i18n/names.json：那是同步脚本的生成物，改了会被覆盖。
 */
const STAT_TITLE_FIX: Record<string, Record<string, string>> = {
  dmg: {
    chs: '元素伤害加成', cht: '元素傷害加成',
    en: 'Elemental DMG Bonus', ja: '元素ダメージ加成', kr: '원소 피해 보너스'
  }
}

/** 词条 key → 本地化标题。修正表 → i18n 表 → miao 中文标题 → key 本身 */
export function statLabel (key: string, locale: string): string {
  /* 先归一语言码：修正表是按 chs/en 这种小写码写的，外面传进来的可能带大写或别名 */
  const loc = i18n.resolveLocale(locale)
  return STAT_TITLE_FIX[key]?.[loc] || i18n.statName(key, loc) || KEY_TITLE[key] || key
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

/*
 * 词条数值 → 给人看的串。**数值来源**：优先 enka 的原始 `statValue`，拿不到才退回内核算的值。
 * 因为 miao 的基准表是 float32 —— 5★ 生之花满级主词条它算 4,778.6 而游戏真值 4,780（enka 给的就是 4780），
 * 精通真值 33 它算 32.6。enka 是官方算好的，直接用它才和游戏一模一样。
 * 内核只剩两个用途：给评分（不碰显示）、以及没存 enka 值时的兜底。
 *
 * ⚠️ 「显示」和「算分」是两条路：改这里的口径不影响任何评分（评分仍 100% 走内核）。
 * 两处「怎么显示」的修正仍然需要：
 *   ① 整数词条（精通 / 小攻击 / 小生命 / 小防御，含花、羽那两个固定值主词条）：miao 一律
 *      `Format.comma(val, 1)`，于是成了「209.1」这种**游戏里不存在**的值 → 收整到 0 位。
 *   ② 百分比：miao 的 `Format.pct` 是 `(v*1).toFixed(1)`，**分不清 5.25 和 5.2499998**。
 *      内核裸数字是 float32 精度的十进制（5★ 大生命第 3 档真值 0.0525，内核表里 0.05249999836087227）→
 *      显成 5.2%，而游戏按十进制四舍五入是 5.3%。enka 的 statValue 是**已乘 100 的十进制**（5.8、46.6），
 *      没有这个噪声 → 有 enka 值时直接 decRound 到 1 位；没有时才回去舍内核的 float32 裸数字。
 * ⚠️ 别把带千分位的串直接喂给 Format.comma —— 它内部是 `(num*1).toFixed(fix)`，Number('1,015.8') 是 NaN。
 *    先剥逗号再进。（「哪些词条是整数口径」的判据在 domain/stat.ts 的 isIntegerStatKey）
 */
/* 十进制四舍五入前「推一把」的量，为什么需要见 decRound */
const ROUND_NUDGE = 1e-9

/*
 * 按十进制四舍五入到 fix 位（half-up，游戏口径）：① 先收敛到 6 位小数，把 1e-8 量级的 float32 噪声吸掉
 * （5.249999836 → 5.25）；② 再加 1e-9 后 toFixed —— double 在 x.x5 上可能落在半分界**下方**
 * （0.0315*100 = 3.1499999999999995），不推这一把会舍成 3.1 而不是 3.2。
 * 收敛到 6 位后 1e-9 只动得了「正好落在半分界上」的值，其余离边界至少 1e-6、推不动。
 */
function decRound (v: unknown, fix = 1): string {
  const n = Number(v)
  return (Number(n.toFixed(6)) + ROUND_NUDGE * Math.sign(n)).toFixed(fix)
}

/* 百分比统一走这里，别用 Format.pct —— 理由见上面 ②。面板行与武器属性都经它 */
const pctText = (v: unknown): string => decRound(v) + '%'

/*
 * 词条数值出口：优先级 enka 值 > 内核裸数字 > 内核串。enka 值能直接用是因为它和游戏同口径
 * （固定值词条本来就是整数，百分比已乘 100）。
 *   key      miao 词条 key（cpct / hpPlus …）
 *   value    内核给好的格式化串（兜底用）
 *   coreRaw  内核的裸数字（百分比词条要用它做十进制舍入）
 *   enkaVal  enka 的原始 statValue（优先用它；混不到时 null / undefined）
 */
export function attrValueText (key: string, value: string, coreRaw?: unknown, enkaVal?: number | null): string {
  /* ⚠️ enkaVal 由调用方从**模型字段**取来，已是 number|null —— 直接 ?? null，不重复 num。
     这儿**绝不能**退化成 Number()：`Number(null) === 0` 会把「没有 enka 值」读成「值 = 0」，
     主词条会显示成 0 / 0.0% 且兜底整条失效。 */
  const enka = enkaVal ?? null
  if (isIntegerStatKey(key)) {                                   // 整数词条（精通/小攻/小生/小防）：一律收整
    const n = enka ?? num(String(value).replace(/,/g, ''))
    return n !== null ? Format.comma(n, 0) : value
  }
  /* 百分比：有 enka 值就直接按十进制舍（它已是 ×100 的十进制）；没有才退回内核裸数字（要先收敛 float32 噪声） */
  if (enka !== null) return pctText(enka)
  const core = num(coreRaw)
  return core !== null ? pctText(core) : value
}

/** 从内核的 artis 模型里取「这一件的裸数字」，交给 attrValueText 兜底用。
 *  副词条按 key 存成 Map：内核已把一个 key 的多次强化合成一条，所以 key 唯一。 */
export function rawNumsOf (artisEntry: any): { main: unknown; sub: Map<string, unknown> } {
  return {
    main: artisEntry?.main?.value,
    sub: new Map((artisEntry?.attrs || []).map((a: any) => [a.key, a.value]))
  }
}

/** 从一件圣遗物（模型）取 enka 的原始数值，按 miao key 归拢 —— 显示数值的第一来源。
 *  主词条只有一个 key、由调用方用 `marked.main.key` 定位，不在这儿再解一遍；副词条的 key 走 Stat.key。 */
export function enkaNumsOf (artifact: Artifact | null | undefined): { main: number | null; sub: Map<string, number> } {
  const sub = new Map<string, number>()
  for (const stat of artifact?.subStats || []) {
    if (stat.key && stat.value !== null) sub.set(stat.key, stat.value)
  }
  return { main: artifact?.mainStatValue ?? null, sub }
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

/** 内核给的一件圣遗物的评分结果（= `result.artis[pos]`） */
interface MarkedArtifact {
  name?: string
  set?: string
  level?: number
  mark?: string
  _mark?: number
  markClass?: string
  main?: { key: string; value: string; _mark?: number }
  attrs?: Array<{ key: string; value: string; upNum?: number; eff?: string; _mark?: number }>
}

/* 面板属性表的一行。给名字是因为调用方（页面之外还有测试）要按下标找行、比 key 与名字，
   用 Record<string, unknown> 的每处都得断言一次。 */
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

/* miao 单条词条「分」公式：46.6 * _mark / 600（与 artis-mark.html 右栏数字逐字一致） */
function statPoint (_mark: number | null | undefined): string | null {
  return _mark != null ? (Number(_mark) * 46.6 / 600).toFixed(1) : null
}

/* 圣遗物卡片上用的**另一套**标题：miao 模板取 Artifact.getArtisKeyTitle()，它区分大小词条
   （atk→大攻击、hpPlus→小生命），而 i18n 表里 hpPlus 只有「生命值」，直接沿用就丢了「大/小」。 */
let ARTI_TITLE: Record<string, string> = {}
try { ARTI_TITLE = (MiaoArtifact.getArtisKeyTitle('gs') as Record<string, string>) || {} } catch { ARTI_TITLE = {} }

/* 「有效词条汇总」里 miao 会把标题再缩短一档：大生命/小生命 → 生命，暴击率 → 暴击 */
const SHORT_TITLE: Record<string, string> = {
  暴击率: '暴击', 暴击伤害: '爆伤', 充能效率: '充能', 元素精通: '精通',
  效果命中: '命中', 效果抵抗: '抵抗', 击破特攻: '击破',
  大生命: '生命', 大攻击: '攻击', 大防御: '防御',
  小生命: '生命', 小攻击: '攻击', 小防御: '防御'
}

/* 中文按 miao 的卡片来（区分大/小词条）；其它语言走 i18n 表 —— miao 那张只有中文，硬套会把英文界面打回中文 */
function artiLabel (key: string, locale: string): string {
  if (locale !== 'chs' && locale !== 'cht') return statLabel(key, locale)
  return ARTI_TITLE[key] || KEY_TITLE[key] || statLabel(key, locale)
}

/* 汇总区的短标题：先取词条标题，再按 SHORT_TITLE 缩一档（非中文缩不动，原样返回） */
function shortLabel (key: string, locale: string): string {
  const title = artiLabel(key, locale)
  return SHORT_TITLE[title] || title
}

/* 安全的 URL 路径段：中文/空格都 encode，但保留斜杠给目录层级 */
function assetSeg (s: string | null | undefined): string {
  return s ? encodeURIComponent(s) : ''
}

/*
 * 角色图像资源 —— 照抄 miao 的 CharImg.getImgs（models/character/CharImg.js:87）。
 * vendor 里那个被 sync 脚本整体置空了（要读磁盘、依赖 image-size），而这里要的只是拼路径。
 *
 * 三条规则一个字都不能改：① 天赋 A 的图标按**武器类型**取公共图（普攻图标本来就是武器图标）；
 * ② 天赋 E/Q 的图标**就是提升它的那个命座图标**（talentCons 里写的 3 / 5），角色目录里没有 talent-e.webp；
 * ③ 立绘用 imgs/splash.webp，不是 character-img/ 那套（后者是别的功能的同人插画）。
 */
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
   ⚠️ 别改用 KEY_TITLE / artiLabel 那两张表：它们给的是「大生命 / 大攻击 / 充能效率」（圣遗物卡片要区分
     大小词条），而面板是属性总值、不区分。
   ⚠️ 也不能照抄上游模板那张（`hp:'生命值' … dmg:'伤害加成'`）：它只有 dmg、没有 phy/heal，
     沿用 `dmg:'伤害加成'` 会把元素/物理/治疗三个名字合并成一个（实测芭芭拉 65.9% 显成「伤害加成」）。 */
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

/** 圣遗物位置：1 花 2 羽 3 沙 4 杯 5 冠 */
export function slotLabel (pos: number, locale: string): string {
  return i18n.slotName(pos, locale) || ['', '生之花', '死之羽', '时之沙', '空之杯', '理之冠'][pos] || `#${pos}`
}

/* 圣遗物素材图：`imgs/<套装官方中文名>/<部位>.webp`。部位 1=花 2=羽 3=沙 4=杯 5=头（见 Artifact.pos）。 */
function artifactIcon (setNameZh: string | null | undefined, pos: number): string | null {
  return setNameZh ? `assets/meta-gs/artifact/imgs/${assetSeg(setNameZh)}/${pos}.webp` : null
}

/** 一件圣遗物：miao 的评分结果 + 领域模型（拿 hash 查名字、拿 enka 的原始数值做显示）。
 *  raw 是内核解析出的裸数字（`profile.artis.artis[pos]`）—— 只在没有 enka 值时兜底，见 enkaNumsOf */
function artifactOf (pos: number, marked: MarkedArtifact | undefined, artifact: Artifact | undefined, locale: string, raw: unknown) {
  const posName = slotLabel(pos, locale)
  if (!marked || !marked.name) return { pos, posName, empty: true, initSubs: null }

  const setNameZh = marked.set || ''
  /* 初始副词条条数：3 = 初始三词条、4 = 初始四词条（见 Artifact.quality）。
     只认这两个值 —— 别的一律当「不知道」：夹具里 roll 条数与等级不自洽会算出负数/2，
     老数据缺 appendPropIds 会算出 0。页面就不画角标，建议层也不算它。 */
  const initRaw = artifact?.quality()
  const initSubs = initRaw === 3 || initRaw === 4 ? initRaw : null
  const enka = enkaNumsOf(artifact)                 // 显示数值：优先 enka 原始 statValue，内核重算的只兜底
  const { main: rawMain, sub: rawSub } = rawNumsOf(raw)
  const subs = (marked.attrs || [])
    .filter(x => x.key)
    .map(x => ({
      key: x.key,
      label: artiLabel(x.key, locale),
      value: attrValueText(x.key, x.value, rawSub.get(x.key), enka.sub.get(x.key)),
      upNum: x.upNum || 0,
      eff: x.eff ?? '-',                             // 词条有效率：miao 算好的百分比串，'-' = 非有效词条
      _mark: x._mark ?? null,
      point: statPoint(x._mark)                      // 单条词条的原始 miao 分（未缩放），前端按 46.6/600*_mark 显示
    }))

  return {
    pos,
    posName,
    empty: false,
    name: (artifact?.nameHash && i18n.name(artifact.nameHash, locale)) || marked.name,
    nameZh: marked.name,
    setName: (artifact?.setHash && i18n.setNameByHash(artifact.setHash, locale)) || setNameZh,
    setNameZh,
    level: marked.level,
    star: artifact?.star ?? 5,
    /* 初始 3 / 4 词条，不知道该件时 null（页面不画角标） */
    initSubs,
    mark: marked.mark,                               // 给眼睛看的串（1 位小数）
    markValue: marked._mark || 0,                    // 给进度环用（0..70 的原始分）
    markClass: marked.markClass,
    icon: artifactIcon(setNameZh, pos),            // 404 时前端用占位图
    main: marked.main?.key
      ? {
          key: marked.main.key,
          label: artiLabel(marked.main.key, locale),
          value: attrValueText(marked.main.key, marked.main.value, rawMain, enka.main),
          _mark: marked.main._mark ?? null,
          point: statPoint(marked.main._mark)
        }
      : null,
    subs
  }
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
export function shapeCharacter (ch: Character, profile: MiaoProfile, result: MarkDetail, locale: string = i18n.DEFAULT_LOCALE) {
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
  const enkaAll = Artifact.subStatTotals(ch.artifacts)
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
     我们没搬 Avatar，照它的逻辑重算）。`Weapon.get()` 认不出时返回 `false`（不是 null/undefined）——
     先归一到 `Weapon | null`，后面 `wObj?.xxx` 才不会在 `false` 上报错。 */
  const wObj = ch.weapon.equipped ? (Weapon.get(ch.weapon.itemId) || null) : null
  const weaponAttrs: Record<string, string> = {}
  let weaponDesc = ''
  if (wObj) {
    /* 内核 Weapon 的这个方法没有类型声明 —— 按我们真正读的字段断言 */
    const wCalc = (wObj.calcAttr?.(profile.weapon.level, profile.weapon.promote) || {}) as {
      atkBase?: number
      attr?: { key: string; value: number }
    }
    if (wCalc.atkBase) weaponAttrs.atkBase = Format.comma(wCalc.atkBase, 1)
    if (wCalc.attr?.key) {
      /* 精通显整数（和游戏、和 attrValueText 一个口径），其余是百分比 */
      weaponAttrs[wCalc.attr.key] = wCalc.attr.key === 'mastery'
        ? Format.comma(wCalc.attr.value, 0)
        : pctText(wCalc.attr.value)
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
    elemText: Format.elemName(elem),          // 元素名暂时只有 miao 的中文单字（i18n 表没收录元素，不想为它多同步一轮）
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
 * 一个角色 → 伤害表视图对象。内部就是 materialize 桥 + calcDamage（见 kernel/damage.ts），
 * 本函数只做「给页面用的整形」：数值按 miao 出图的口径格式化（Format.comma(v, 0)）、
 * buff 串按冒号拆成两列。
 *
 * 返回 null 的三种情况对页面来说是同一件事（不出这一块）：角色没配 calc.js、
 * 脚本算崩了（calcDamage 内部已打日志）、或 materialize 搭不出 profile（元数据不认识的角色）。
 * 语义区别由调用方在调本函数前自己查（server 路由分 404 / 200+null）。
 *
 * ⚠️ 敌人名（enemyName）只有 miao 的中文（'小宝'），和 elemText 一个情况：内核没给别的语言。
 */
export async function damageOf (ch: Character): Promise<DamageView | null> {
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
