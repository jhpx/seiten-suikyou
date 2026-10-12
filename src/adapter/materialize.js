/*
 * materialize —— 把领域模型（一个 Character）组装成 miao 内核能吃的 profile
 *
 * 这是「计算出口」，方向是 id → 中文名：库里存的是与语言无关的数字 id，
 * 而内核拿中文名当键查表（usefulAttr[char.name]、weaponCfg['护摩之杖']）。
 *
 * 内核要求（缺了会炸）：char 必须是真 Character 对象、artis 必须是真 Artis 实例、
 * attr 得自己算好（76 个角色规则里 56 个要读它）、weapon 的 name 必须是中文。
 *
 * ⚠️ 入参是我们自己的领域模型 Character（domain/character.js），不是 miao 的同名模型 ——
 *    所以这里把 miao 的两个同名类显式改名成 Miao* 以示区分。
 */
import { Artis, Artifact as MiaoArtifact, Attr, Character as MiaoCharacter, Weapon as MiaoWeapon } from '../index.js'

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
 * 一个角色（领域模型）→ miao profile
 * @param {import('../domain/character.js').Character} ch
 * @returns {object|null} 角色不被 miao 认识时返回 null
 */
export function toMiaoProfile (ch) {
  const char = MiaoCharacter.get(ch.avatarId)
  if (!char) return null

  /* 圣遗物仍然只喂「部件名 + 原始 prop id」，属性让内核自己解析。
     ch.artifacts 是领域模型对象（domain/artifact.js 的 Artifact），字段名跟它走。 */
  const artis = new Artis('gs', true)
  for (const a of ch.artifacts || []) {
    const obj = MiaoArtifact.get(a.itemId)
    if (!obj) continue
    /* 等级基数：库里存的是 enka 的原值（1 基，5★ 满级 21），内核要 0 基（满级 20）——
       两边刚好差 1，在这儿减掉。全项目只此一处需要「猜」上游语义，不另立模块。
       将来若接了米游社那类 0 基的源，这儿要按 ch.source 分叉。 */
    const level = Math.max(0, (Number(a.levelRaw) || 1) - 1)
    artis.setArtis(a.pos, {
      name: obj.name,
      level,
      star: a.star,
      mainId: a.mainPropId,
      attrIds: a.appendPropIds
    })
  }

  const profile = {
    isProfile: true,
    isGs: true,
    game: 'gs',
    uid: ch.uid,
    id: char.id,
    char,
    elem: deriveElem(char, ch.skillLevelMap) || char.elem,
    level: ch.level,
    promote: ch.promote,
    cons: ch.cons ?? 0,
    fetter: ch.fetter,
    costume: ch.costume,
    weapon: {
      /* 名字必须是中文（内核拿它查 weaponCfg）：没有武器就是空串 */
      name: ch.weapon.equipped ? (MiaoWeapon.get(ch.weapon.itemId)?.name || '') : '',
      level: ch.weapon.level ?? 1,
      promote: ch.weapon.promote ?? 0,
      affix: ch.weapon.affix ?? 1
    },
    artis
  }

  /* 面板属性不是数据源给的，是 miao 按「基础值 + 武器 + 圣遗物」算的（上游 Avatar.js:320）。
     base 也一并留下 —— Attr 算完 final 后内部还记着哪些是基础值，页面要拿它渲染「基础值 +绿字」。 */
  const attrCalc = Attr.create(profile)
  profile.attr = attrCalc.calc()
  profile.base = attrCalc.getBase() || {}

  return profile
}

/** 批量：一批角色（领域模型）→ 一批 profile，顺手把不认识的角色挑出来 */
export function toMiaoProfiles (chars) {
  const profiles = []
  const skipped = []
  for (const ch of chars) {
    const p = toMiaoProfile(ch)
    if (p) profiles.push(p)
    else skipped.push(ch.avatarId)
  }
  return { profiles, skipped }
}
