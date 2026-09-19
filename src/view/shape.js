/*
 * shape —— 「库里的一行 + miao 评分结果」→ 给页面/接口用的视图对象
 *
 * 位置在整条链路的最后一公里：前面几步全程只碰数字 id，输出中文名是 miao 内核的硬要求
 * （见 adapter/materialize.js 的注释），而**给人看的这一份**要按用户选的语言渲染。
 * 所以这里是「id → 文本」的第二条出口，语言由 locale 决定。
 *
 * 三个刻意的决定：
 *
 *   1. 名字优先查 i18n 表，查不到才退回 miao 的中文名（`nameZh`）。
 *      退回不是「凑合」—— 表里没有的 id 只能这么办，而且中文至少是对的、不是乱码。
 *
 *   2. 圣遗物的名字用**库里存的 hash** 查，不用 miao 给的中文名反查。
 *      name_hash / set_hash 是 enka 白给的官方文案主键（见 docs/data-model.md），
 *      直接查比拿中文名对字符串稳得多，也不受 miao 改名影响。
 *
 *   3. 词条数值一律用 miao 已格式化好的字符串（`main.value` / `attrs[].value`）。
 *      那是 ArtisMark.formatArti 按 `attrMap[key].format`（comma / pct）算出来的，
 *      我们重算一遍就有可能和内核不一致 —— 那条「逐字一致」的底线不能破。
 *      只有面板（attr）是裸数字，这里按 kind 自己格式化。
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
 * 圣遗物卡片上用的**另一套**标题：miao 模板渲染主/副词条时取的是
 * Artifact.getArtisKeyTitle()，它区分大小词条（atk→大攻击、hpPlus→小生命），
 * 而 i18n 表里 hpPlus 只有「生命值」，直接沿用就丢了「大/小」这个信息。
 * 卡片要跟 miao 长得一样，所以圣遗物部分优先用这张表。
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

/*
 * 圣遗物词条标题。
 * 中文下按 miao 的卡片来（区分大/小词条）；其它语言走 i18n 表 ——
 * miao 那张表只有中文，硬套会把英文界面打回中文。
 */
function artiLabel (key, locale) {
  if (locale !== 'chs' && locale !== 'cht') return statLabel(key, locale)
  return ARTI_TITLE[key] || KEY_TITLE[key] || statLabel(key, locale)
}

/* 汇总区的短标题：先取词条标题，再按 SHORT_TITLE 缩一档（非中文时自然缩不动，原样返回） */
function shortLabel (key, locale) {
  const t = artiLabel(key, locale)
  return SHORT_TITLE[t] || t
}

/* 面板要显示哪几项、怎么格式化。顺序就是展示顺序。 */
const PANEL_ROWS = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'],
  ['mastery', 'int'], ['recharge', 'pct'],
  ['dmg', 'pct'], ['phy', 'pct'], ['heal', 'pct']
]

/* 词条 key → 本地化标题。查不到退回 miao 中文标题，再退回 key 本身。 */
export function statLabel (key, locale) {
  return i18n.statName(key, locale) || KEY_TITLE[key] || key
}

/* 圣遗物位置：1 花 2 羽 3 沙 4 杯 5 冠 */
export function slotLabel (pos, locale) {
  return i18n.slotName(pos, locale) || ['', '生之花', '死之羽', '时之沙', '空之杯', '理之冠'][pos] || `#${pos}`
}

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

/* 安全的 URL 路径段：中文/空格都 encode，但保留斜杠给目录层级。 */
function assetSeg (s) {
  return s ? encodeURIComponent(s) : ''
}

/*
 * 角色图像资源 —— 原样照抄 miao 的 CharImg.getImgs（models/character/CharImg.js:87）
 *
 * 为什么自己抄一份而不是调 vendor 里那个：vendor 的 CharImg 被 sync 脚本整体置空了
 * （它原本要读磁盘、依赖 image-size，评分用不到）。而这里要的只是**拼路径**，
 * 上游公式是纯字符串拼接，抄下来十几行，不引入任何新依赖。
 *
 * 三条上游规则，抄的时候一个字都不能改：
 *   1. 天赋 A 的图标是**按武器类型**取的公共图（common/item/atk-{sword|bow|...}.webp），
 *      不是角色专属 —— 普攻图标本来就是武器图标。
 *   2. 天赋 E/Q 的图标**就是提升它的那个命座图标**（talentCons 里写的 3 / 5）。
 *      角色目录里根本没有 talent-e.webp，上游 icons/ 下只有 cons-1~6 和 passive-0~2。
 *   3. 立绘用 imgs/splash.webp，不是 character-img/ 那套（后者是别的功能用的同人插画）。
 */
function charImgs (char) {
  const name = assetSeg(char.name)
  const nPath = `/assets/meta-gs/character/${name}/`
  const wt = char.weaponType || 'sword'
  const tc = char.talentCons || {}
  const imgs = {
    splash: `${nPath}imgs/splash.webp`,
    face: `${nPath}imgs/face.webp`,
    card: `${nPath}imgs/card.webp`,
    banner: `${nPath}imgs/banner.webp`
  }
  for (let i = 1; i <= 6; i++) imgs[`cons${i}`] = `${nPath}icons/cons-${i}.webp`
  imgs.a = `/assets/common/item/atk-${wt}.webp`
  for (const t of ['e', 'q']) {
    imgs[t] = tc[t] > 0 ? imgs[`cons${tc[t]}`] : `${nPath}icons/talent-${t}.webp`
  }
  return imgs
}

/*
 * 整张角色页画布的背景按元素分图：common/bg/bg-{元素}.webp
 *
 * miao 的做法（resources/common/layout/elem.html:15）是把 element 映射成英文类名挂在
 * container 上，再由 common.css 的 `.elem-{x} .elem-bg` 选背景图。原神这边角色元数据里
 * 的 elem 本来就叫 pyro/cryo/...，所以直接当类名用，不用翻译。
 * 只有旅行者是 multi，没有对应图，按上游的兜底取 hydro。
 */
const ELEM_BG = new Set(['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo'])

/*
 * 面板属性表 —— 顺序和键都照抄 miao 模板里的 attrMap（profile-detail.html:46）
 *
 * 每一项要三列：总值 / 基础值 / 绿字（基础值之外的加成），权重另起一列高亮。
 * 这正是上游 ProfileDetail.js:153-172 干的事：base 来自 Attr 的 isBase 累计值。
 */
const ATTR_TABLE = [
  ['hp', 'int'], ['atk', 'int'], ['def', 'int'], ['mastery', 'int'],
  ['cpct', 'pct'], ['cdmg', 'pct'], ['recharge', 'pct'], ['dmg', 'pct']
]

/*
 * miao 模板里写死的属性名（profile-detail.html:46）。
 * 跟 i18n 表的用字不完全一样（「元素充能」vs「元素充能效率」、「伤害加成」vs「伤害增加」），
 * 中文下按 miao 来，才谈得上 1:1；其它语言仍走 i18n。
 */
const ATTR_TITLE_ZH = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能', dmg: '伤害加成'
}

function attrTableOf (profile, locale, charWeight = {}) {
  const a = profile.attr || {}
  const b = profile.base || {}
  const zh = locale === 'chs' || locale === 'cht'
  const out = []
  for (const [key, kind] of ATTR_TABLE) {
    /* miao 的模板是死循环那张 8 项表，缺项的属性（比如没有伤害加成的角色）
       也照样出一行 0.0% —— 整张表恒为 8 行，行高和对齐才稳定。别在这里 continue。 */
    const total = a[key] ?? 0
    const base = b[key] ?? 0
    out.push({
      key,
      label: (zh && ATTR_TITLE_ZH[key]) || statLabel(key, locale),
      value: kind === 'int' ? Format.comma(total, 0) : Format.pct(total, 1),
      /* 基础值那一列为 0 时 miao 会把它置灰（CSS .base.zero） */
      base: kind === 'int' ? Format.comma(base, 0) : Format.pct(base, 1),
      baseZero: !base,
      plus: kind === 'int' ? Format.comma(total - base, 0) : Format.pct(total - base, 1),
      weight: charWeight[key] || 0
    })
  }
  return out
}

/* 一件圣遗物：miao 的评分结果 + 库里那行（拿 hash 查名字） */
function artifactOf (pos, marked, dbRow, locale) {
  const posName = slotLabel(pos, locale)
  if (!marked || !marked.name) {
    return { pos, posName, empty: true }
  }
  const hashed = dbRow?.name_hash ? i18n.name(dbRow.name_hash, locale) : null
  const setHashed = dbRow?.set_hash ? i18n.setNameByHash(dbRow.set_hash, locale) : null
  const e = marked // 简写
  const setNameZh = e.set || ''
  const main = e.main?.key
    ? {
        key: e.main.key,
        label: artiLabel(e.main.key, locale),
        value: e.main.value,
        _mark: e.main._mark ?? null,
        point: statPoint(e.main._mark)
      }
    : null
  const subs = (e.attrs || [])
    .filter(x => x.key)
    .map(x => ({
      key: x.key,
      label: artiLabel(x.key, locale),
      value: x.value,
      upNum: x.upNum || 0,
      /* 词条有效率：miao 算好的百分比串，'-' 表示没算（非有效词条） */
      eff: x.eff ?? '-',
      /* 单条词条的原始 miao 分（未缩放）。前端按 miao 的公式 (46.6/600*_mark) 显示成「分」，
         和 miao 评分卡右栏那个数字逐字一致 */
      _mark: x._mark ?? null,
      point: statPoint(x._mark)
    }))

  return {
    pos,
    posName,
    empty: false,
    name: hashed || e.name,
    nameZh: e.name,
    setName: setHashed || setNameZh,
    setNameZh,
    level: e.level,
    star: dbRow?.star ?? 5,
    /* mark 是给眼睛看的串（1 位小数），markValue 给进度环用（0..70 的原始分） */
    mark: e.mark,
    markValue: e._mark || 0,
    markClass: e.markClass,
    /* 图标从 miao-plugin 仓库按中文套装名拉取，404 时前端用占位图 */
    icon: setNameZh ? `/assets/meta-gs/artifact/imgs/${assetSeg(setNameZh)}/${pos}.webp` : null,
    main,
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
export function shapeCharacter (row, profile, result, locale = i18n.DEFAULT_LOCALE) {
  const loc = i18n.resolveLocale(locale)
  const char = profile.char
  const dbArtis = new Map((row.artifacts || []).map(a => [a.pos, a]))
  const talent = deriveTalent(char, row.skill_level_map || {})

  /* 套装：miao 的 sets 键是**官方中文全名**（不是 hash），所以只能拿中文名反查 */
  const sets = Object.entries(result.sets || {}).map(([name, count]) => ({
    name: i18n.fromZh(name, loc) || name,
    nameZh: name,
    count
  }))

  /* 面板属性：label + 数值，外加该属性的评分权重（charWeight，>=80 高亮成金色，和 miao 一致） */
  const panel = panelOf(profile.attr, loc).map(p => ({
    ...p,
    weight: result.charWeight?.[p.key] || 0
  }))

  /* 有效词条汇总：miao 的 allAttr（全队圣遗物里所有有效副词条），补到 9 格，逐条按权重分 great/useful/nouse */
  const allAttrRaw = (profile.artis && typeof profile.artis.getAllAttr === 'function')
    ? (profile.artis.getAllAttr() || [])
    : []
  const allAttr = []
  for (let i = 0; i < 9; i++) {
    const a = allAttrRaw[i]
    if (a && a.key) {
      const w = result.charWeight?.[a.key] || 0
      allAttr.push({
        key: a.key,
        label: shortLabel(a.key, loc),
        value: a.value,
        upNum: a.upNum || 0,
        eff: a.eff ?? '-',
        cls: w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
      })
    } else {
      allAttr.push({})
    }
  }

  /* 命座：6 格，已点亮到 cons 为止 */
  const consList = [1, 2, 3, 4, 5, 6].map(i => i <= (profile.cons ?? 0))

  /*
   * 天赋：交给 miao 自己的 CharTalent 算，别自己加命座加成。
   * 它返回 { level, original }：level 是**含命座加成后**的等级，original 是原始等级。
   * 前端靠这两个数判断「是否被命座提升」和「是否满级戴皇冠」，和上游模板一致。
   */
  const talentRaw = char.getAvatarTalent(talent, profile.cons ?? 0, 'original') || {}
  const talentView = {}
  for (const k of ['a', 'e', 'q']) {
    const t = talentRaw[k]
    const level = t?.level ?? talent[k] ?? 0
    const original = t?.original ?? level
    talentView[k] = { level, original, plus: level > original, crown: original >= 10 }
  }

  /*
   * 武器：图标 + 主/副属性 + 精炼描述，全部来自 miao 的 Weapon 元数据。
   * 上游是 Avatar.getWeaponDetail()（models/Avatar.js:225），我们 vendor 里没搬 Avatar，
   * 所以在这里照它的逻辑重算一遍 —— 用到的 calcAttr / getAffixDesc 都是 vendor 真货。
   */
  const wObj = row.weapon_item_id ? Weapon.get(row.weapon_item_id) : null
  let weaponAttrs = {}
  let weaponDesc = ''
  if (wObj) {
    const wCalc = wObj.calcAttr?.(profile.weapon.level, profile.weapon.promote) || {}
    if (wCalc.atkBase) weaponAttrs.atkBase = Format.comma(wCalc.atkBase, 1)
    if (wCalc.attr?.key) {
      /* 精通是整数，其余是百分比 —— 和上游 keyType 那张表一致 */
      weaponAttrs[wCalc.attr.key] = wCalc.attr.key === 'mastery'
        ? Format.comma(wCalc.attr.value, 1)
        : Format.pct(wCalc.attr.value, 1)
    }
    weaponDesc = wObj.getAffixDesc?.(profile.weapon.affix)?.desc || ''
  }

  const imgs = charImgs(char)
  const elemKey = profile.elem || char.elem || ''

  return {
    uid: profile.uid,
    avatarId: profile.id,
    name: i18n.avatarName(profile.id, loc) || char.name,
    nameZh: char.name,
    star: char.star || 5,
    level: profile.level,
    cons: profile.cons ?? 0,
    fetter: profile.fetter ?? null,
    elem: elemKey,
    /* 元素名暂时只有 miao 的中文单字（i18n 表里没收录元素，是不想为它多同步一轮） */
    elemText: Format.elemName(elemKey),
    /* 画布底图：按元素分的那张 bg-{元素}.webp，前端挂在 container 上（见上面的 ELEM_BG） */
    elemBg: `/assets/common/bg/bg-${ELEM_BG.has(elemKey) ? elemKey : 'hydro'}.webp`,
    /*
     * 立绘：miao 用的是官方 splash（meta-gs/character/{名}/imgs/splash.webp），
     * 不是 character-img/ 那套同人插画 —— 之前选错了，现在按上游 CharImg.getImgs 来。
     * 顺带把整张 imgs 表（命座 6 图 + 天赋 a/e/q 图）一起下发，前端直接照模板拼。
     */
    splash: imgs.splash,
    imgs,
    talent: talentView,
    weapon: {
      name: (row.weapon_item_id ? i18n.weaponName(row.weapon_item_id, loc) : null) || profile.weapon.name || '',
      nameZh: profile.weapon.name || '',
      /* 卡片里显示的是缩写名（上游 weapon.sName || weapon.name） */
      sName: wObj?.sName || profile.weapon.name || '',
      level: profile.weapon.level,
      affix: profile.weapon.affix,
      promote: profile.weapon.promote,
      star: wObj?.star ?? 0,
      /* 武器图标：meta-gs/weapon/{类型}/{名}/icon.webp，类型是 miao 元数据给的。
         注意中文名要逐段 encode，直接拼 wObj.img 会拿到未编码的中文。 */
      icon: wObj
        ? `/assets/meta-gs/weapon/${assetSeg(wObj.type)}/${assetSeg(wObj.name)}/icon.webp`
        : null,
      attrs: weaponAttrs,
      desc: weaponDesc
    },
    score: {
      mark: result.mark,
      markValue: result._mark,
      markClass: result.markClass || 'D',
      classTitle: result.classTitle
    },
    /* 角色的词条权重表（miao charCfg.attrs 的 weight）。前端用它给副词条分 great/useful/nouse 三档，
       和 miao 卡片里「有效/无效词条」的高亮规则完全一致 */
    charWeight: result.charWeight || {},
    sets,
    panel,
    /* 面板属性表（总值 / 基础值 / 绿字 / 权重），照 miao 模板 attrMap 那 8 项 */
    attrTable: attrTableOf(profile, loc, result.charWeight || {}),
    allAttr,
    consList,
    artifacts: [1, 2, 3, 4, 5].map(pos =>
      artifactOf(pos, result.artis?.[pos], dbArtis.get(pos), loc))
  }
}

/**
 * 一整包 → 视图对象（页面/接口的最终形状）。
 * 内部把 materialize + 打分 + 本地化串起来，调用方只要给库里的行就行。
 *
 * 不认识的角色（miao 元数据里没有该 avatarId）会被收集到 `skipped`，
 * 而不是让整包失败 —— 新角色先于 miao 更新是常态。
 *
 * @param {object}  opts
 * @param {object}  opts.account   repo.getAccount 出来的一行（可空）
 * @param {Array}   opts.rows      repo.loadUid 出来的角色行
 * @param {string}  opts.locale
 * @param {string}  opts.fetchedAt 最后一次抓取时间（可空）
 */
export function buildAccountView ({ account, rows, locale = i18n.DEFAULT_LOCALE, fetchedAt = null }) {
  const loc = i18n.resolveLocale(locale)
  const avatars = []
  const skipped = []
  for (const row of rows) {
    const profile = toMiaoProfile(row)
    if (!profile) { skipped.push(row.avatar_id); continue }
    profile._raw = row
    const result = ArtisMark.getMarkDetail(profile, true)
    avatars.push(shapeCharacter(row, profile, result, loc))
  }
  return {
    locale: loc,
    fetchedAt,
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
