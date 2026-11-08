/*
 * 圣遗物与词条「显示口径」叶子 —— 角色面板与圣遗物卡共用的显示原语 + 单件圣遗物卡片。
 *
 * 为什么单独成一个叶子（只引 gateway / dbo / common，不回头引任何 service）：
 * 圣遗物卡（artifactOf）依赖 statLabel / KEY_TITLE 这套「显示脊柱」，而 character.service.ts
 * 的 shapeCharacter 又反过来依赖 artifactOf —— 若把圣遗物卡搬走、却把显示脊柱留在
 * character.service.ts，就会形成 character → artifact → character 的环。
 * 所以显示脊柱和圣遗物卡**一起**收口在这里，让 character.service.ts 单向引它，环就破了。
 *
 * 这里**不出现状态码**，也不碰任何业务编排；纯「给定一个数据库对象（DBO）/ miao 结果，怎么显示」。
 */
import { ArtisMark, Format, i18n, Artifact as MiaoArtifact } from '../index.ts'
import { ArtifactDbo } from '../repository/dbo/artifact.ts'
import { isIntegerStatKey } from '../common/stat.ts'
import { num } from '../common/util.ts'

/* miao 自己的词条中文标题（含 `pyro → 火伤加成` 这类元素名，由 Format.eachElem 生成）。
   i18n 表查不到时的兜底；圣遗物卡片标题（artiLabel）也用它。
   内核是 vendored JS，返回值 TS 只能推成 `{}`，断言成字典、形状由上游保证。 */
export const KEY_TITLE = ArtisMark.getKeyTitleMap('gs') as Record<string, string>

/*
 * 标题覆盖表 —— 两类条目，都只在这里写、不进 vendor/i18n/（那是同步脚本的生成物，
 * 改了会被覆盖）：
 *
 *   ① 跟游戏官方叫法不一致的：`dmg` 在 miao 的 i18n 表里是「伤害增加」/“DMG Bonus”（它自己
 *      出图时的简称），但游戏里这条就叫**元素伤害加成**。面板上物伤/治疗/元素伤三行连着读，
 *      写成「伤害增加」看不出是哪个加成。
 *   ② miao 词条表里根本没有的武器专属词条：`atkBase`（基础攻击力）。它不是「词条」，
 *      是武器面板上的第一行，官方中文叫「基础攻击力」，英文 Base ATK。
 */
const STAT_TITLE_FIX: Record<string, Record<string, string>> = {
  dmg: {
    chs: '元素伤害加成', cht: '元素傷害加成',
    en: 'Elemental DMG Bonus', ja: '元素ダメージ加成', kr: '원소 피해 보너스'
  },
  atkBase: {
    chs: '基础攻击力', cht: '基礎攻擊力',
    en: 'Base ATK', ja: '基礎攻撃力', kr: '기초 공격력'
  }
}

/** 词条 key → 本地化标题。修正表 → i18n 表 → miao 中文标题 → key 本身 */
export function statLabel (key: string, locale: string): string {
  /* 先归一语言码：修正表是按 chs/en 这种小写码写的，外面传进来的可能带大写或别名 */
  const loc = i18n.resolveLocale(locale)
  return STAT_TITLE_FIX[key]?.[loc] || i18n.statName(key, loc) || KEY_TITLE[key] || key
}

/*
 * 词条数值 → 给人看的串。**数值来源**：优先 enka 的原始 `statValue`，拿不到才退回内核算的值。
 * 因为 miao 的基准表是 float32 —— 5★ 生之花满级主词条它算 4,778.6 而游戏真值 4,780（enka 给的就是 4780），
 * 精通真值 33 它算 32.6。enka 是官方算好的，直接用它才和游戏一模一样。
 * 内核只剩两个用途：给评分（不碰显示）、以及没存 enka 值时兜底。
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
 *    先剥逗号再进。（「哪些词条是整数口径」的判据在 common/stat.ts 的 isIntegerStatKey）
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
export const pctText = (v: unknown): string => decRound(v) + '%'

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
export function enkaNumsOf (artifact: ArtifactDbo | null | undefined): { main: number | null; sub: Map<string, number> } {
  const sub = new Map<string, number>()
  for (const stat of artifact?.subStats || []) {
    if (stat.key && stat.value !== null) sub.set(stat.key, stat.value)
  }
  return { main: artifact?.mainStatValue ?? null, sub }
}

/* 内核给的一件圣遗物的评分结果（= `result.artis[pos]`） */
export interface MarkedArtifact {
  name?: string
  set?: string
  level?: number
  mark?: string
  _mark?: number
  markClass?: string
  main?: { key: string; value: string; _mark?: number }
  attrs?: Array<{ key: string; value: string; upNum?: number; eff?: string; _mark?: number }>
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
export function artiLabel (key: string, locale: string): string {
  if (locale !== 'chs' && locale !== 'cht') return statLabel(key, locale)
  return ARTI_TITLE[key] || KEY_TITLE[key] || statLabel(key, locale)
}

/* 汇总区的短标题：先取词条标题，再按 SHORT_TITLE 缩一档（非中文缩不动，原样返回） */
export function shortLabel (key: string, locale: string): string {
  const title = artiLabel(key, locale)
  return SHORT_TITLE[title] || title
}

/* 安全的 URL 路径段：中文/空格都 encode，但保留斜杠给目录层级 */
export function assetSeg (s: string | null | undefined): string {
  return s ? encodeURIComponent(s) : ''
}

/** 圣遗物位置：1 花 2 羽 3 沙 4 杯 5 冠 */
export function slotLabel (pos: number, locale: string): string {
  return i18n.slotName(pos, locale) || ['', '生之花', '死之羽', '时之沙', '空之杯', '理之冠'][pos] || `#${pos}`
}

/* 圣遗物素材图：`imgs/<套装官方中文名>/<部位>.webp`。部位 1=花 2=羽 3=沙 4=杯 5=头（见 Artifact.pos）。 */
export function artifactIcon (setNameZh: string | null | undefined, pos: number): string | null {
  return setNameZh ? `assets/meta-gs/artifact/imgs/${assetSeg(setNameZh)}/${pos}.webp` : null
}

/* **整套的代表图** = 1 号位（花）裁掉透明边、等比缩到 96px 的预处理件。
   卡片、筛选框、刷取建议的套装图标全用它 —— 原图有 150~380px，而这几处最多只显示
   31px（高分屏 94px），直接给原图是白下十倍像素；裁边顺手把「老素材满格、
   新素材主体偏小」的参差抹平，三处拿到同一张图，主体大小天然一致。
   ⚠️ 目录名用 **setId**（enka 的稳定数字身份），不用中文套装名：中文名来自文案表，
      官方改一次译名、或 setName 查不到（i18n-report 里 15047/15048 那类），
      拼出来的路径就 404 没图；前端筛选／排序本来也拿 setId 当套装身份，口径统一。
   ⚠️ 单独放 thumbs/，不塞进 imgs/：imgs 是上游素材的**原样复制**
      （tools/sync_assets.py 全量同步），按上游的中文套装名摆；两层命名不同是有意的。
   ⚠️ 花就是 1 号位，代表图直接用 1.webp；同目录 2~5.webp 是另外四个部位的小图
      （tools/gen_flower.py 产出）。advice.js 把 1.webp 的末段换成部位号去推，
      pos=1 时换出来还是自己。
   ⚠️ 明细页那些单件部位图仍走 artifactIcon() 的 imgs/ 原图：那边显示 100px，
      96px 的小图会糊。 */
export function artifactSetIcon (setId: number | null | undefined): string | null {
  return setId == null ? null : `assets/meta-gs/artifact/thumbs/${setId}/1.webp`
}

/** 一件圣遗物的**套装身份** = enka 的 setId（千岩 15017）。
 *
 *  为什么不是 enka 玩家接口给的 `setHash`：那个 `setNameTextMapHash`（千岩 1337665995）
 *  在 enka 的 locs.json 里**查不到名字**，怎么都翻不出「千岩牢固」。setId 才能
 *  （setId → Sets[setId].Name → locs → 名称）。所以名字认 setId，hash 只留档。
 *
 *  两个来源：真实件用 itemId 推（enka `relics.json` 的 itemId → SetId，全表 4245 条）；
 *  人工/模拟件换过套装、itemId 还是原件那一个，构造时就把 setId 直接写好了。 */
export function setIdOf (artifact: ArtifactDbo | null | undefined): number | null {
  if (!artifact) return null
  return artifact.setId ?? i18n.setIdOfItem(artifact.itemId)
}

/** 一件圣遗物：miao 的评分结果 + 数据库对象（DBO，拿 set 身份查名字、拿 enka 的原始数值做显示）。
 *  raw 是内核解析出的裸数字（`profile.artis.artis[pos]`）—— 只在没有 enka 值时兜底，见 enkaNumsOf
 *  cw 是角色的词条权重表（key → 权重），只用来判「这条词条算不算有效」：权重 > 0 即有效。
 *     传了它就按该角色的口径算 effValid；不传（默认空表）effValid 恒为 0 —— 明细页必须传。 */
export function artifactOf (pos: number, marked: MarkedArtifact | undefined, artifact: ArtifactDbo | undefined, locale: string, raw: unknown, cw: Record<string, number> = {}) {
  const posName = slotLabel(pos, locale)
  if (!marked || !marked.name) return { pos, posName, empty: true, initSubs: null, effValid: 0, effTotal: 0 }

  // 套装名只认 setId→官方名，绝不退回 miao 显示名：官方真缺名（本地 vendor/i18n 落后游戏版本）就显示「未知套装」。
  // 明细页部位原图的目录按官方中文名摆（imgs/<套装名>/<部位>.webp，上游原样复制）；
  // 套装代表图不走这里，它按 setId 排，见 artifactSetIcon。
  const setId = setIdOf(artifact)
  const setNameZh = (setId === null ? null : i18n.setName(setId, 'zh')) || ''
  /* 初始副词条条数：3 = 初始三词条、4 = 初始四词条（见 Artifact.quality）。
     只认这两个值 —— 别的一律当「不知道」：夹具里 roll 条数与等级不自洽会算出负数/2，
     老数据缺 appendPropIds 会算出 0。页面就不画角标，建议层也不算它。 */
  const initRaw = artifact?.quality()
  const initSubs = initRaw === 3 || initRaw === 4 ? initRaw : null
  const enka = enkaNumsOf(artifact)                 // 显示数值：优先 enka 原始 statValue，内核重算的只兜底
  const { main: rawMain, sub: rawSub } = rawNumsOf(raw)
  /* 这一件的有效 / 总词条当量：跟 character.assembler.ts 里 score.effValid 是同一套原始 eff，
     只是按「件」求和而不是按「角色」求和，两边加起来能对上。
     ⚠️ 千万别改用 marked.attrs[].eff 累加：那是 miao 已 ÷0.85 又四舍五入成一位小数的
        展示串，一件 4 条、五件 20 条加起来会漂 0.1~0.5，跟总分对不上账。 */
  let effValid = 0
  let effTotal = 0
  const rawAttrs = (raw as { attrs?: Array<{ key: string; eff?: number }> } | undefined)?.attrs || []
  for (const at of rawAttrs) {
    const e = (at.eff || 0) / 0.85
    effTotal += e
    if ((cw[at.key] || 0) > 0) effValid += e
  }
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
    setName: (setId === null ? null : i18n.setName(setId, locale)) || i18n.uiText('unknownSet', locale),
    setNameZh,
    setId,
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
    subs,
    /* 全精度、未舍入；前端 detail.js 显示时才 toFixed(1) */
    effValid,
    effTotal
  }
}
