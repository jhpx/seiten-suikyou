/*
 * shape —— 「库里的一行 + miao 评分结果」→ 给页面/接口用的视图对象
 *
 * 整条链路前面几步只碰数字 id，到了这儿才出中文名（内核的硬要求），而**给人看的这一份**
 * 要按用户选的语言渲染。所以这里是「id → 文本」的第二条出口，语言由 locale 决定。
 *
 * 三条底线：
 *   1. 名字优先查 i18n 表，查不到才退回 miao 的中文名 —— 中文至少是对的，不是乱码。
 *   2. 圣遗物名字用库里存的 hash 查（enka 白给的官方文案主键，见 docs/DESIGN-DATA-MODEL.md），
 *      比拿中文名对字符串稳，也不受 miao 改名影响。
 *   3. 词条数值一律用 miao 格式化好的字符串（`main.value` / `attrs[].value`）——
 *      自己重算就可能和内核不一致，那条「逐字一致」的底线不能破。只有面板（attr）是裸数字。
 *      唯一的例外是整数词条（精通 / 小攻击 / 小生命 / 小防御）：miao 给 1 位小数，游戏显整数，
 *      到出口按 attrValueText 收整 —— 为什么不算「重算」，看那个函数的注释。
 */
import { ArtisMark, Artifact, Format, i18n, Weapon } from '../index.js'
import { toMiaoProfile, deriveTalent } from '../adapter/materialize.js'

/* miao 单条词条「分」公式：46.6 * _mark / 600（与 artis-mark.html 右栏数字逐字一致） */
function statPoint (_mark) {
  return _mark != null ? (Number(_mark) * 46.6 / 600).toFixed(1) : null
}

/* miao 自己的词条中文标题。i18n 表查不到时的兜底，也用来对照。 */
const KEY_TITLE = ArtisMark.getKeyTitleMap('gs')

/*
 * 圣遗物卡片上用的**另一套**标题：miao 模板取的是 Artifact.getArtisKeyTitle()，
 * 它区分大小词条（atk→大攻击、hpPlus→小生命），而 i18n 表里 hpPlus 只有「生命值」，
 * 直接沿用就丢了「大/小」。卡片要跟 miao 长得一样，所以中文下优先用这张表。
 */
let ARTI_TITLE = {}
try { ARTI_TITLE = Artifact.getArtisKeyTitle('gs') || {} } catch { ARTI_TITLE = {} }

/* 「有效词条汇总」里 miao 会把标题再缩短一档：大生命/小生命 → 生命，暴击率 → 暴击 */
const SHORT_TITLE = {
  暴击率: '暴击', 暴击伤害: '爆伤', 充能效率: '充能', 元素精通: '精通',
  效果命中: '命中', 效果抵抗: '抵抗', 击破特攻: '击破',
  大生命: '生命', 大攻击: '攻击', 大防御: '防御',
  小生命: '生命', 小攻击: '攻击', 小防御: '防御'
}

/* 中文按 miao 的卡片来（区分大/小词条）；其它语言走 i18n 表 ——
   miao 那张表只有中文，硬套会把英文界面打回中文。 */
function artiLabel (key, locale) {
  if (locale !== 'chs' && locale !== 'cht') return statLabel(key, locale)
  return ARTI_TITLE[key] || KEY_TITLE[key] || statLabel(key, locale)
}

/* 汇总区的短标题：先取词条标题，再按 SHORT_TITLE 缩一档（非中文时缩不动，原样返回） */
function shortLabel (key, locale) {
  const t = artiLabel(key, locale)
  return SHORT_TITLE[t] || t
}

/* 词条 key → 本地化标题。查不到退回 miao 中文标题，再退回 key 本身。 */
export function statLabel (key, locale) {
  return i18n.statName(key, locale) || KEY_TITLE[key] || key
}

/*
 * 词条数值 → 给人看的串。
 *
 * miao 的 ArtisMark.formatArti 对每条词条一律 `Format.comma(val, 1)`，于是元素精通 /
 * 小攻击 / 小生命 / 小防御（含生之花、死之羽那两个固定值主词条）到了页面就成了
 * 「209.1」「16.3」「13.6」这种**游戏里根本不存在的值** —— 游戏这四类一律显整数，
 * 它的强化档位本来就是整数累加出来的。
 *
 * 所以到出口把它们收回整数：数值还是 miao 给的那个数，这里只改「怎么显示」，
 * 没重算、没碰内核，评分（mark）链路一个字没动。
 * ⚠️ 别把带千分位的串直接喂给 Format.comma —— 它内部是 `(num * 1).toFixed(fix)`，
 *    Number('1,015.8') 是 NaN，会原样吐出 'NaN'。先剥逗号再进。
 */
const INT_ATTR_KEYS = new Set(['mastery', 'atkPlus', 'defPlus', 'hpPlus'])

export function attrValueText (key, value) {
  if (value == null || value === '') return value
  if (!INT_ATTR_KEYS.has(key)) return value      /* 百分比词条原样透传 */
  return Format.comma(Number(String(value).replace(/,/g, '')), 0)
}

/* 圣遗物位置：1 花 2 羽 3 沙 4 杯 5 冠 */
export function slotLabel (pos, locale) {
  return i18n.slotName(pos, locale) || ['', '生之花', '死之羽', '时之沙', '空之杯', '理之冠'][pos] || `#${pos}`
}

/* 面板要显示哪几项、怎么格式化。顺序就是展示顺序。 */
const PANEL_ROWS = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'],
  ['mastery', 'int'], ['recharge', 'pct'],
  ['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']
]

/* 面板：attr 是裸数字，按 kind 格式化（生命/攻击/防御是整数，其余是百分比） */
function panelOf (attr, locale) {
  const out = []
  for (const [key, kind] of PANEL_ROWS) {
    const v = attr?.[key]
    if (!v) continue
    out.push({
      key,
      label: statLabel(key, locale),
      value: v,
      text: kind === 'int' ? Format.comma(v, 0) : Format.pct(v, 1),
      kind
    })
  }
  return out
}

/* 同一份面板的一行文本（命令行用；页面要的是结构化数据，走 panelOf） */
export function panelText (attr, locale) {
  return panelOf(attr, locale).map(p => `${p.label} ${p.text}`).join('  ')
}

/* 词条按权重分三档，页面靠这个类名上色（miao 卡片的「有效/无效词条」规则） */
function weightClass (w) {
  return w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
}

/* 安全的 URL 路径段：中文/空格都 encode，但保留斜杠给目录层级。 */
function assetSeg (s) {
  return s ? encodeURIComponent(s) : ''
}

/*
 * 角色图像资源 —— 照抄 miao 的 CharImg.getImgs（models/character/CharImg.js:87）。
 * vendor 里那个 CharImg 被 sync 脚本整体置空了（它要读磁盘、依赖 image-size），
 * 而这里要的只是拼路径，上游本来就是纯字符串拼接，抄下来十几行、不引新依赖。
 *
 * 三条规则一个字都不能改：
 *   1. 天赋 A 的图标按**武器类型**取公共图（common/item/atk-{sword|bow|…}.webp），
 *      不是角色专属 —— 普攻图标本来就是武器图标。
 *   2. 天赋 E/Q 的图标**就是提升它的那个命座图标**（talentCons 里写的 3 / 5），
 *      角色目录里根本没有 talent-e.webp。
 *   3. 立绘用 imgs/splash.webp，不是 character-img/ 那套（后者是别的功能的同人插画）。
 */
function charImgs (char) {
  const nPath = `/assets/meta-gs/character/${assetSeg(char.name)}/`
  const tc = char.talentCons || {}
  const imgs = {
    splash: `${nPath}imgs/splash.webp`,
    face: `${nPath}imgs/face.webp`,
    card: `${nPath}imgs/card.webp`,
    banner: `${nPath}imgs/banner.webp`
  }
  for (let i = 1; i <= 6; i++) imgs[`cons${i}`] = `${nPath}icons/cons-${i}.webp`
  imgs.a = `/assets/common/item/atk-${char.weaponType || 'sword'}.webp`
  for (const t of ['e', 'q']) {
    imgs[t] = tc[t] > 0 ? imgs[`cons${tc[t]}`] : `${nPath}icons/talent-${t}.webp`
  }
  return imgs
}

/* 画布底图 / 元素图标按元素分文件：common/bg/bg-{元素}.webp、common/elem/{元素}.png。
   角色元数据里的 elem 本来就叫 pyro/cryo/…，直接当文件名用。只有旅行者是 multi，
   没有对应图，按上游兜底取 hydro。 */
const ELEM_BG = new Set(['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo'])
const elemOf = (elem) => (ELEM_BG.has(elem) ? elem : 'hydro')

/* 面板属性表 —— 顺序和键照抄 miao 模板的 attrMap（profile-detail.html:46）：
   每一项三列（总值 / 基础值 / 绿字），权重另起一列高亮，base 来自 Attr 的 isBase 累计值。 */
const ATTR_TABLE = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'], ['mastery', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'], ['recharge', 'pct']
]

/*
 * 三种加成单列：元素伤害 / 物伤加成 / 治疗加成。**按角色挑，不是三个都出。**
 *
 * 为什么它们要分开：三者互斥，且在游戏里各占一个位置 ——
 *   dmg  是 4 号杯主词条之一、phy 只能当副词条（`extra.js` 的 mainAttr：4 号含 dmg/phy，
 *   5 号含 heal/cpct/cdmg，subAttr 干脆不含 phy）、heal 是 5 号杯主词条之一。
 *   一个人身上不会同时堆三种，面板出三行有两行永远是 0.0%（实测七七那页）。
 *
 * 挑哪几行**只看权重表**：权重 > 0 的才出。**面板上的实际值不参与判断。**
 * ⚠️ 别把「面板值 > 0」也加进判据（我第一版就错了）：迪奥娜权重表 heal=100、dmg=0，
 *   她身上碰巧带了个元素增伤圣遗物（面板 18.0%），按「或」的判据会多出一行元素伤害 ——
 *   可权重表明确说了她只吃治疗加成。多出来那行不是「她的面板」，是「圣遗物的面板」：
 *   面板这个模块存在的意义是回答「这个角色该关注什么」，混进无关的加成反而看不清主次。
 *
 * ⚠️ 也别改成「只挑一个」：权重表实测 121 个角色里，8 个**真的两项都要** ——
 *   物理主 C 兼顾元素伤（优菈 phy100/dmg40、雷泽 dmg100/phy100、辛焱、菲米尼）、
 *   奶妈兼顾治疗（珊瑚宫心海 dmg100/heal100、芙宁娜、希格雯、爱可菲）。
 *   雷泽那两项权重还是**完全相等**的（100/100），根本没有「谁更大」可依；
 *   硬压成一行等于藏掉他真正需要的词条。
 */
const DMG_ATTRS = [['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']]

/* 面板属性名 —— 中文下跟 miao 出图用字对齐。
   ⚠️ 别改用 KEY_TITLE / artiLabel 那两张表：它们给的是「大生命 / 大攻击 / 充能效率」
     （圣遗物卡片要区分大小词条，所以带「大」字；面板是属性总值，不需要区分）。
     上游模板 profile-detail.html:45 也是自己写死的一张：`hp:'生命值' … recharge:'元素充能', dmg:'伤害加成'`。
   ⚠️ 但**不能照抄上游那张表**：它只有 dmg、没有 phy/heal。我们补齐了三项加成，
     若沿用 `dmg:'伤害加成'` 这个名字，元素/物理/治疗三种加成就被合并成同一个名字 ——
     治疗角色的治疗加成在面板上会显示成「伤害加成」（实测芭芭拉 65.9% 显示成「伤害增加」）。
     miao 自己的 KEY_TITLE 三个名字本来分得开：元素伤害 / 物伤加成 / 治疗加成，取用它的用字。 */
const ATTR_TITLE_ZH = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能',
  dmg: '元素伤害', phy: '物伤加成', heal: '治疗加成'
}

/* 导出供测试断言用：属性名的三套用字（面板 / 圣遗物卡 / 汇总短标题）很容易改串，
   钉在测试里比钉在页面截图里靠谱。 */
export function attrTableOf (profile, locale, charWeight = {}) {
  const a = profile.attr || {}
  const b = profile.base || {}
  const zh = locale === 'chs' || locale === 'cht'
  /* 属性名：中文用上面那张表（miao 出图用字），其它语言走 i18n 表 */
  const labelOf = (key) => (zh && ATTR_TITLE_ZH[key]) || statLabel(key, locale)
  const makeRow = ([key, kind]) => {
    const total = a[key] ?? 0
    const base = b[key] ?? 0
    const fmt = (v) => (kind === 'int' ? Format.comma(v, 0) : Format.pct(v, 1))
    return {
      key,
      label: labelOf(key),
      value: fmt(total),
      /* 基础值那一列为 0 时 miao 会把它置灰（CSS .base.zero） */
      base: fmt(base),
      baseZero: !base,
      plus: fmt(total - base),
      weight: charWeight[key] || 0
    }
  }
  /* 前七项恒为满行：miao 的模板是死循环那张表，缺项的属性（比如没有元素充能的）
     也照样出一行 0.0%，行高和对齐才稳定。别在这里 continue。 */
  const rows = ATTR_TABLE.map(makeRow)
  /* 末尾三种加成**只按权重表出行**（理由见 DMG_ATTRS 的注释）：权重 > 0 才出这一行。
     面板实际值**不参与**判断 —— 迪奥娜权重 heal=100/dmg=0，她身上带元素增伤圣遗物
     （面板 18.0%）也不该多出元素伤害那行：面板是回答「这个角色该关注什么」，
     混进无关加成反而看不清主次。 */
  const dmgRows = DMG_ATTRS.filter(([key]) => (charWeight[key] || 0) > 0)
  return [...rows, ...dmgRows.map(makeRow)]
}

/* 一件圣遗物：miao 的评分结果 + 库里那行（拿 hash 查名字） */
function artifactOf (pos, marked, dbRow, locale) {
  const posName = slotLabel(pos, locale)
  if (!marked || !marked.name) return { pos, posName, empty: true }

  const setNameZh = marked.set || ''
  const subs = (marked.attrs || [])
    .filter(x => x.key)
    .map(x => ({
      key: x.key,
      label: artiLabel(x.key, locale),
      value: attrValueText(x.key, x.value),
      upNum: x.upNum || 0,
      /* 词条有效率：miao 算好的百分比串，'-' 表示没算（非有效词条） */
      eff: x.eff ?? '-',
      /* 单条词条的原始 miao 分（未缩放），前端按 46.6/600*_mark 显示成「分」 */
      _mark: x._mark ?? null,
      point: statPoint(x._mark)
    }))

  return {
    pos,
    posName,
    empty: false,
    name: (dbRow?.name_hash && i18n.name(dbRow.name_hash, locale)) || marked.name,
    nameZh: marked.name,
    setName: (dbRow?.set_hash && i18n.setNameByHash(dbRow.set_hash, locale)) || setNameZh,
    setNameZh,
    level: marked.level,
    star: dbRow?.star ?? 5,
    /* mark 是给眼睛看的串（1 位小数），markValue 给进度环用（0..70 的原始分） */
    mark: marked.mark,
    markValue: marked._mark || 0,
    markClass: marked.markClass,
    /* 图标从 miao-plugin 仓库按中文套装名拉取，404 时前端用占位图 */
    icon: setNameZh ? `/assets/meta-gs/artifact/imgs/${assetSeg(setNameZh)}/${pos}.webp` : null,
    main: marked.main?.key
      ? {
          key: marked.main.key,
          label: artiLabel(marked.main.key, locale),
          value: attrValueText(marked.main.key, marked.main.value),
          _mark: marked.main._mark ?? null,
          point: statPoint(marked.main._mark)
        }
      : null,
    subs
  }
}

/**
 * 一个角色 → 视图对象
 * @param {object} row      repo.loadAvatar 出来的一行（含 artifacts）
 * @param {object} profile  toMiaoProfile 出来的 miao profile
 * @param {object} result   ArtisMark.getMarkDetail(profile, true) 的结果
 * @param {string} locale   语言代码（认不出会退回默认语言）
 */
/*
 * 场景名（classTitle）里那个「角色缩写-」前缀怎么写。
 *
 * miao 那边固定拼 `${char.abbr}-${title}`（ArtisMarkCfg.js:93），abbr 取自角色表，
 * 于是「沃雅妮莎」这种**上游权重表里还没有的角色**会显示成「妮莎-通用」——
 * 看着像上游真给沃雅妮莎定过一套「通用」权重，实际上那张表根本没这一行，
 * 内核是拿 `defaultAttrWeight`（atk75/cpct100/cdmg100/dmg100/phy100）凑的。
 *
 * 兜底时把前缀换成「默认」：默认-通用。语义是「这是通用模板，不是这个角色的专属权重」。
 * 只换前缀、保留后半段（通用 / 绝缘4 / 西风 / 护摩 这些场景词照旧），
 * 这样「用的是哪套权重」和「命中了哪个场景」两件事仍然分得开。
 *
 * 上游表里有这个角色、或者角色自带 artis.js 专属规则时，一律原样透传内核的标题。
 */
const DEFAULT_WEIGHT_LABEL = '默认'
const CUSTOM_WEIGHT_LABEL = '自定义'

/*
 * 场景名（classTitle）里那个「角色缩写-」前缀怎么写。三种权重来源要分得开：
 *
 *   权重来源                          内核给的标记         页面上显示
 *   ───────────────────────────────  ──────────────────  ──────────────
 *   权重表那一行（artis-mark.js）      无                  角色缩写-通用
 *   专属规则**特判分支**              无                  角色缩写-纯火 / -精通 …
 *   专属规则**默认分支、权重与表一致**  无                  角色缩写-通用（与第一行同形，正确）
 *   专属规则**默认分支、手写了权重**    isCustomWeight    角色缩写-自定义
 *   权重表里没这个角色（内核兜底）      isDefaultWeight   默认-通用
 *
 * 为什么要把第四行单独标出来：miao 只在「命中特判分支」时给自定义名字，
 * 于是迪希雅那种 `def({hp:75,…,recharge:75})` 手写一整套、却也叫「迪希雅-通用」的情况，
 * 看着像查表来的 —— 实际 recharge 是 55→75、mastery 被整个去掉。
 * 实测 69 个有专属规则的角色里只有他一个（见 .tmp/calc-custom-weight.mjs 的算法）。
 *
 * 语义分工：「通用」回答**命中哪个场景**，前缀回答**用的哪套权重**。
 * 所以只换前缀、保留后半段（通用/绝缘4/西风/护摩 这些场景词照旧）——
 * 「用哪套权重」和「命中哪个场景」是���件事，不能混成一个词。
 */
export function classTitleOf (result) {
  const title = result?.classTitle || ''
  if (!title) return title
  const i = title.indexOf('-')
  /* isDefaultWeight：无论标题带什么场景词都要改前缀 —— 兜底角色带绝缘4/西风时
     内核标题是「xxx-绝缘4」，那说的是「命中了哪个场景」，而权重是兜底的这件事
     同样得说出来 → 「默认-绝缘4」。两个标记回答的是不同问题，不能因为其中一个
     已有信息就把另一个也吞掉。 */
  if (result?.isDefaultWeight) {
    return i < 0 ? DEFAULT_WEIGHT_LABEL : DEFAULT_WEIGHT_LABEL + title.slice(i)
  }
  /* isCustomWeight：只在标题就是「通用」时改。标题已自带场景名（「可莉-纯火」）
     再改前缀是重复信息 —— 内核侧已保证不会这么传，这里再挡一道脏数据。 */
  if (result?.isCustomWeight && title.slice(i + 1) === '通用') {
    return CUSTOM_WEIGHT_LABEL + title.slice(i)
  }
  return title
}
export function shapeCharacter (row, profile, result, locale = i18n.DEFAULT_LOCALE) {
  const loc = i18n.resolveLocale(locale)
  const char = profile.char
  const dbArtis = new Map((row.artifacts || []).map(a => [a.pos, a]))
  const talent = deriveTalent(char, row.skill_level_map || {})
  /* 生效权重：ArtisMark.getMarkDetail(profile, **true**) 的 charWeight。
     ⚠️ 第二个参数必须是 true —— charWeight 只在 withDetail 分支里挂上
     （vendor ArtisMark.js:231 `if (withDetail) ret.charWeight = …`），
     传 false 会静默少一个键，面板权重整列 0、词条全被判成「无效」。
     里面的值是**算完之后的最终权重**，含武器特判（护摩/绝缘4/西风）与角色专属规则的修正，
     不是权重表的原始值 —— 面板要的就是这个。 */
  const cw = result.charWeight || {}

  /* 套装：miao 的 sets 键是**官方中文全名**（不是 hash），只能拿中文名反查 */
  const sets = Object.entries(result.sets || {}).map(([name, count]) => ({
    name: i18n.fromZh(name, loc) || name,
    nameZh: name,
    count
  }))

  /* 面板属性 + 该属性的评分权重（>=80 前端高亮成金色，和 miao 一致） */
  const panel = panelOf(profile.attr, loc).map(p => ({ ...p, weight: cw[p.key] || 0 }))

  /* 有效词条汇总：miao 的 allAttr（全队圣遗物里所有有效副词条），补到 9 格 */
  const allAttrRaw = profile.artis?.getAllAttr?.() || []
  const allAttr = Array.from({ length: 9 }, (_, i) => {
    const a = allAttrRaw[i]
    if (!a || !a.key) return {}
    return {
      key: a.key,
      label: shortLabel(a.key, loc),
      value: attrValueText(a.key, a.value),
      upNum: a.upNum || 0,
      eff: a.eff ?? '-',
      cls: weightClass(cw[a.key] || 0)
    }
  })

  /* 命座：6 格，已点亮到 cons 为止 */
  const consList = [1, 2, 3, 4, 5, 6].map(i => i <= (profile.cons ?? 0))

  /* 天赋交给 miao 自己的 CharTalent 算（别自己加命座加成）：它给 level（含命座加成）
     和 original（原始等级），前端靠这两个数判断「被命座提升过」和「满级戴皇冠」。 */
  const talentRaw = char.getAvatarTalent(talent, profile.cons ?? 0, 'original') || {}
  const talentView = Object.fromEntries(['a', 'e', 'q'].map(k => {
    const t = talentRaw[k]
    const level = t?.level ?? talent[k] ?? 0
    const original = t?.original ?? level
    return [k, { level, original, plus: level > original, crown: original >= 10 }]
  }))

  /* 武器：图标 + 主/副属性 + 精炼描述，全来自 miao 的 Weapon 元数据。
     上游是 Avatar.getWeaponDetail()（models/Avatar.js:225），我们没搬 Avatar，照它的逻辑重算。 */
  const wObj = row.weapon_item_id ? Weapon.get(row.weapon_item_id) : null
  const weaponAttrs = {}
  let weaponDesc = ''
  if (wObj) {
    const wCalc = wObj.calcAttr?.(profile.weapon.level, profile.weapon.promote) || {}
    if (wCalc.atkBase) weaponAttrs.atkBase = Format.comma(wCalc.atkBase, 1)
    if (wCalc.attr?.key) {
      /* 精通显整数（和游戏、和上面 attrValueText 一个口径），其余是百分比 */
      weaponAttrs[wCalc.attr.key] = wCalc.attr.key === 'mastery'
        ? Format.comma(wCalc.attr.value, 0)
        : Format.pct(wCalc.attr.value, 1)
    }
    weaponDesc = wObj.getAffixDesc?.(profile.weapon.affix)?.desc || ''
  }

  /* 武器名有两条来源：i18n 表（官方 TextMap，按 itemId）→ miao 元数据。
     两条都查不到 ≠ 角色没装备武器，而是「这把武器比我们的元数据新」——
     例：奥黛塔的 11438。enka 照样给了 level/promote/affix，说明是装备着的。
     两种情况在界面上必须分开说，前端靠下面的 state 选文案。 */
  const wName = (row.weapon_item_id ? i18n.weaponName(row.weapon_item_id, loc) : null) ||
    profile.weapon.name || ''

  const imgs = charImgs(char)
  const elem = profile.elem || char.elem || ''

  return {
    uid: profile.uid,
    avatarId: profile.id,
    name: i18n.avatarName(profile.id, loc) || char.name,
    nameZh: char.name,
    star: char.star || 5,
    level: profile.level,
    cons: profile.cons ?? 0,
    fetter: profile.fetter ?? null,
    elem,
    /* 元素名暂时只有 miao 的中文单字（i18n 表里没收录元素，不想为它多同步一轮） */
    elemText: Format.elemName(elem),
    elemBg: `/assets/common/bg/bg-${elemOf(elem)}.webp`,
    /* 首页角色卡的两张图（明细页用不到）：星级底色、左上角元素图标。
       两个 URL 都由后端给，前端不自己拼路径 —— 和 elemBg 一个规矩。 */
    rarityBg: `/assets/common/item/bg${char.star === 4 ? 4 : 5}.png`,
    elemIcon: `/assets/common/elem/${elemOf(elem)}.png`,
    splash: imgs.splash,
    /* 整张 imgs 表（立绘 + 命座 6 图 + 天赋 a/e/q 图）一起下发，前端直接照模板拼 */
    imgs,
    talent: talentView,
    weapon: {
      /* 三态，前端按它选文案，别再靠「name 是不是空串」猜：
         'none'    角色压根没装备武器（enka 里 weapon_item_id 就是空）
         'unknown' 装备了，但 i18n 表和 miao 元数据都不认识这把（新版本武器）
         'ok'      查到名字了 */
      state: !row.weapon_item_id ? 'none' : (wName ? 'ok' : 'unknown'),
      name: wName,
      nameZh: profile.weapon.name || '',
      /* 卡片里显示的是缩写名（上游 weapon.sName || weapon.name） */
      sName: wObj?.sName || profile.weapon.name || '',
      level: profile.weapon.level,
      affix: profile.weapon.affix,
      promote: profile.weapon.promote,
      star: wObj?.star ?? 0,
      /* 图标：meta-gs/weapon/{类型}/{名}/icon.webp。中文名要逐段 encode ——
         直接拼 wObj.img 会拿到未编码的中文。
         元数据不认识这把时退回**武器类型通用图**（common/item/atk-{type}.webp，
         五张图都按类型分好了）：类型能从角色身上拿（char.weaponType），
         卡片上就不至于空着一个格子。 */
      icon: wObj
        ? `/assets/meta-gs/weapon/${assetSeg(wObj.type)}/${assetSeg(wObj.name)}/icon.webp`
        : (row.weapon_item_id ? `/assets/common/item/atk-${char.weaponType || 'sword'}.webp` : null),
      attrs: weaponAttrs,
      desc: weaponDesc
    },
    score: {
      mark: result.mark,
      markValue: result._mark,
      markClass: result.markClass || 'D',
      classTitle: classTitleOf(result),
      /* 权重来源的两个标记，表现层靠它们区分「用的哪套权重」：
         isDefaultWeight —— 上游表里没这个角色、拿内核通用表凑的，前缀显示「默认」；
         isCustomWeight  —— 专属规则的默认分支手写了权重（≠ 表里那一行），前缀显示「自定义」。
         两者都为 false 时前缀就是角色缩写（权重表那一行，或专属规则的默认分支且与表一致）。 */
      isDefaultWeight: !!result.isDefaultWeight,
      isCustomWeight: !!result.isCustomWeight
    },
    charWeight: cw,
    sets,
    panel,
    attrTable: attrTableOf(profile, loc, cw),
    allAttr,
    consList,
    artifacts: [1, 2, 3, 4, 5].map(pos => artifactOf(pos, result.artis?.[pos], dbArtis.get(pos), loc))
  }
}

/**
 * 抓取时间「ISO UTC → 本地时区的可读文本」。
 *
 * 库里存的是 `toISOString()`（如 `2026-09-13T07:09:14.296Z`）—— 那是存储要的无歧义格式，
 * 直接端上页面就又丑又不符合本地时间。所以只在出口格式化，存储层一个字都不动。
 * 换算靠 `getHours()` 这类**本地**取值器：换台机器看也对，不写死 +8。
 *
 * 空值 / 脏值一律回 null（不返回 '—'）：调用方本来就拿 `|| '—'` 兜底。
 */
export function fmtTime (iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 一整包 → 视图对象（页面/接口的最终形状）。内部把 materialize + 打分 + 本地化串起来。
 *
 * 不认识的角色（miao 元数据里没有该 avatarId）收进 `skipped` 而不是整包失败 ——
 * 新角色先于 miao 更新是常态。
 *
 * @param {object} opts.fetchedAt  最后一次抓取的原始 ISO UTC，出口转成本地时区文本
 */
export function buildAccountView ({ account, rows, locale = i18n.DEFAULT_LOCALE, fetchedAt = null }) {
  const loc = i18n.resolveLocale(locale)
  const avatars = []
  const skipped = []
  for (const row of rows) {
    const profile = toMiaoProfile(row)
    if (!profile) { skipped.push(row.avatar_id); continue }
    profile._raw = row
    avatars.push(shapeCharacter(row, profile, ArtisMark.getMarkDetail(profile, true), loc))
  }
  return {
    locale: loc,
    fetchedAt: fmtTime(fetchedAt),
    account: account
      ? {
          uid: account.uid,
          nickname: account.nickname,
          level: account.level,
          worldLevel: account.world_level,
          signature: account.signature
        }
      : null,
    count: avatars.length,
    skipped,
    avatars
  }
}
