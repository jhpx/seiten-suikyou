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
  ['cpct', 'pct'], ['cdmg', 'pct'], ['recharge', 'pct'], ['dmg', 'pct']
]

/* miao 模板里写死的属性名，跟 i18n 表的用字不完全一样（「元素充能」vs「元素充能效率」），
   中文下按 miao 来才谈得上 1:1；其它语言仍走 i18n。 */
const ATTR_TITLE_ZH = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能', dmg: '伤害加成'
}

function attrTableOf (profile, locale, charWeight = {}) {
  const a = profile.attr || {}
  const b = profile.base || {}
  const zh = locale === 'chs' || locale === 'cht'
  /* 恒为 8 行：miao 的模板是死循环那张表，缺项的属性（比如没有伤害加成的角色）
     也照样出一行 0.0%，行高和对齐才稳定。别在这里 continue。 */
  return ATTR_TABLE.map(([key, kind]) => {
    const total = a[key] ?? 0
    const base = b[key] ?? 0
    const fmt = (v) => (kind === 'int' ? Format.comma(v, 0) : Format.pct(v, 1))
    return {
      key,
      label: (zh && ATTR_TITLE_ZH[key]) || statLabel(key, locale),
      value: fmt(total),
      /* 基础值那一列为 0 时 miao 会把它置灰（CSS .base.zero） */
      base: fmt(base),
      baseZero: !base,
      plus: fmt(total - base),
      weight: charWeight[key] || 0
    }
  })
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

export function classTitleOf (result) {
  const title = result?.classTitle || ''
  if (!result?.isDefaultWeight || !title) return title
  const i = title.indexOf('-')
  return i < 0 ? DEFAULT_WEIGHT_LABEL : DEFAULT_WEIGHT_LABEL + title.slice(i)
}

export function shapeCharacter (row, profile, result, locale = i18n.DEFAULT_LOCALE) {
  const loc = i18n.resolveLocale(locale)
  const char = profile.char
  const dbArtis = new Map((row.artifacts || []).map(a => [a.pos, a]))
  const talent = deriveTalent(char, row.skill_level_map || {})
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
      /* 权重是不是「上游表里没有该角色、拿通用表兜底」来的。
         表现层要靠它区分「上游真写了这套权重」和「我们拿通用模板凑的」——
         前者可信，后者只是没有任何针对性数据。true 时 classTitle 已经是「默认-通用」。 */
      isDefaultWeight: !!result.isDefaultWeight
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
