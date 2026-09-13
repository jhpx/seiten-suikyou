/*
 * materialize —— 把库里那几行组装成 miao 内核能吃的 profile
 *
 * 这是「计算出口」。方向是 id → 中文名：
 *   库里存的是 avatarId / itemId / propId 这些和语言无关的数字，
 *   而 miao 内核是拿中文名当键查表的（usefulAttr[char.name]、weaponCfg['护摩之杖']），
 *   所以这一层必须把 id 还原成 miao 要的中文名与真实对象。
 *
 * 内核要求（从 ArtisMarkCfg 反推，缺了会炸）：
 *   char   必须是真 Character 对象（规则里读 char.name / char.isGs）
 *   artis  必须是真 Artis 实例（规则里调 artis.is('绝缘4')、读 artis.sets）
 *   attr   角色规则要用它做场景判定（76 个规则里 56 个读 attr）
 *   weapon 只要 { name, level, promote, affix }，name 必须是中文
 */
import { Artis, Artifact, Attr, Character, Weapon } from '../index.js'

/*
 * level 归一化 —— 全项目对数据源语义唯一需要「猜」的地方，所以单独一个函数 + 注释
 *
 * 内核要的是 0 基（5★ 满级 = 20）。enka 的 reliquary.level 是 1 基（满级给 21）：
 * 依据是上游 EnkaData.js 写的是 `Math.min(20, level - 1)` —— 那个 20 的上限
 * 只在「1 基」假设下才有意义（0 基的话根本不会超过 20）。
 * 而 MysPanelData 那边不减，是因为米游社给的就是 0 基。
 *
 * 所以库里存的是 level_raw（原样），基数差异在这里按 source 处理。
 * 万一将来发现推错了，改这一个函数就能全量重算，不用重新抓 enka。
 */
export function normalizeLevel (levelRaw, source = 'enka') {
  const n = Number(levelRaw)
  if (!Number.isFinite(n)) return 0
  const normalized = source === 'enka' ? n - 1 : n
  return Math.max(0, Math.min(20, normalized))
}

/* 旅行者这类角色的元素要看天赋表；普通角色直接用 char.elem */
export function deriveElem (char, skillLevelMap = {}) {
  const talentElem = char.meta?.talentElem || {}
  for (const id of Object.keys(skillLevelMap || {})) {
    if (talentElem[id]) return talentElem[id]
  }
  return ''
}

/* 天赋 id → a/e/q。照抄上游 EnkaData.getTalent 的兜底顺序 */
export function deriveTalent (char, skillLevelMap = {}) {
  const talentId = char.meta?.talentId || {}
  const letters = ['a', 'e', 'q']
  const ret = {}
  let idx = 0
  for (const [id, lv] of Object.entries(skillLevelMap || {})) {
    const key = talentId[id] || letters[idx++]
    if (key && ret[key] === undefined) ret[key] = lv
  }
  return ret
}

/**
 * 库里的一行（含圣遗物）→ miao profile
 * @returns {object|null} 角色不被 miao 认识时返回 null
 */
export function toMiaoProfile (row) {
  const char = Character.get(row.avatar_id)
  if (!char) return null

  /* 圣遗物：仍然只喂「部件名 + 原始 prop id」，让内核自己去解析属性 */
  const artis = new Artis('gs', true)
  for (const a of row.artifacts || []) {
    const obj = Artifact.get(a.item_id)
    if (!obj) continue
    artis.setArtis(a.pos, {
      name: obj.name,
      level: normalizeLevel(a.level_raw, row.source),
      star: a.star,
      mainId: a.main_prop_id,
      attrIds: a.append_prop_ids
    })
  }

  const weaponName = row.weapon_item_id ? (Weapon.get(row.weapon_item_id)?.name || '') : ''

  const profile = {
    isProfile: true,
    isGs: true,
    game: 'gs',
    uid: row.uid,
    id: char.id,
    char,
    elem: deriveElem(char, row.skill_level_map) || char.elem,
    level: row.level,
    promote: row.promote,
    cons: row.cons ?? 0,
    fetter: row.fetter,
    costume: row.costume,
    weapon: {
      name: weaponName,
      level: row.weapon_level ?? 1,
      promote: row.weapon_promote ?? 0,
      affix: row.weapon_affix ?? 1
    },
    artis
  }

  /* 面板属性：不是数据源给的，是 miao 自己按「基础值 + 武器 + 圣遗物」算出来的
     （上游 models/Avatar.js:320 那句 attr.calc()）。角色规则读它。 */
  profile.attr = Attr.create(profile).calc()

  return profile
}

/** 批量：库里一批行 → 一批 profile，顺手把不认识的角色挑出来 */
export function toMiaoProfiles (rows) {
  const profiles = []
  const skipped = []
  for (const row of rows) {
    const p = toMiaoProfile(row)
    if (p) profiles.push(p)
    else skipped.push(row.avatar_id)
  }
  return { profiles, skipped }
}
