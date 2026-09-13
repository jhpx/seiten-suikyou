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
import { ArtisMark, Format, i18n } from '../index.js'
import { toMiaoProfile, deriveTalent } from '../adapter/materialize.js'

/* miao 自己的词条中文标题。i18n 表查不到时的兜底，也用来对照。 */
const KEY_TITLE = ArtisMark.getKeyTitleMap('gs')

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

/* 一件圣遗物：miao 的评分结果 + 库里那行（拿 hash 查名字） */
function artifactOf (pos, marked, dbRow, locale) {
  const posName = slotLabel(pos, locale)
  if (!marked || !marked.name) {
    return { pos, posName, empty: true }
  }
  const hashed = dbRow?.name_hash ? i18n.name(dbRow.name_hash, locale) : null
  const setHashed = dbRow?.set_hash ? i18n.setNameByHash(dbRow.set_hash, locale) : null
  const e = marked // 简写
  const main = e.main?.key
    ? { key: e.main.key, label: statLabel(e.main.key, locale), value: e.main.value }
    : null
  const subs = (e.attrs || [])
    .filter(x => x.key)
    .map(x => ({
      key: x.key,
      label: statLabel(x.key, locale),
      value: x.value,
      upNum: x.upNum || 0,
      /* 词条有效率：miao 算好的百分比串，'-' 表示没算（非有效词条） */
      eff: x.eff ?? '-'
    }))

  return {
    pos,
    posName,
    empty: false,
    name: hashed || e.name,
    nameZh: e.name,
    setName: setHashed || e.set,
    setNameZh: e.set,
    level: e.level,
    star: dbRow?.star ?? 5,
    /* mark 是给眼睛看的串（1 位小数），markValue 给进度环用（0..70 的原始分） */
    mark: e.mark,
    markValue: e._mark || 0,
    markClass: e.markClass,
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

  return {
    uid: profile.uid,
    avatarId: profile.id,
    name: i18n.avatarName(profile.id, loc) || char.name,
    nameZh: char.name,
    star: char.star || 5,
    level: profile.level,
    cons: profile.cons ?? 0,
    fetter: profile.fetter ?? null,
    elem: profile.elem || char.elem || '',
    /* 元素名暂时只有 miao 的中文单字（i18n 表里没收录元素，是不想为它多同步一轮） */
    elemText: Format.elemName(profile.elem || char.elem || ''),
    talent: { a: talent.a || 0, e: talent.e || 0, q: talent.q || 0 },
    weapon: {
      name: (row.weapon_item_id ? i18n.weaponName(row.weapon_item_id, loc) : null) || profile.weapon.name || '',
      nameZh: profile.weapon.name || '',
      level: profile.weapon.level,
      affix: profile.weapon.affix,
      promote: profile.weapon.promote
    },
    score: {
      mark: result.mark,
      markValue: result._mark,
      markClass: result.markClass || 'D',
      classTitle: result.classTitle
    },
    sets,
    panel: panelOf(profile.attr, loc),
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
