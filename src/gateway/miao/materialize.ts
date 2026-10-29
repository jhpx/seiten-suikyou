/*
 * materialize —— 把领域模型（一个 Character）组装成 miao 内核能吃的 profile
 *
 * 这是「计算出口」，方向是 id → 中文名：库里存的是与语言无关的数字 id，而内核拿**中文名当键**查表
 * （`usefulAttr[char.name]` / `weaponCfg['护摩之杖']`）。
 *
 * ⚠️ 入参是我们自己的领域模型 Character，不是 miao 的同名类 —— 所以这里把 miao 的两个同名类
 *    显式改名成 `Miao*` 以示区分。
 */
import { Artis, Artifact as MiaoArtifact, Attr, Character as MiaoCharacter, Weapon as MiaoWeapon } from '../../index.ts'
import type { CharacterDbo } from '../../dbo/character.ts'

/*
 * miao 内核的 profile —— **计算出口的形状**，我方与 miao 之间唯一的约定：
 * 内核要真 Character / Artis 实例、attr 得先算好、weapon.name 必须是中文名。
 * `char` / `artis` 是 miao 的对象（vendored JS，没有类型声明），到这儿只当「内核能认的东西」用，
 * 不穿透去描述内核内部。
 */
export interface MiaoProfile {
  isProfile: boolean
  isGs: boolean
  game: string
  uid: number | null
  /** miao 角色的 id（= avatarId）；本工程的视图出口拿它当角色主键 */
  id: number
  char: any
  elem: string
  level: number | null
  promote: number | null
  cons: number
  fetter: number | null
  costume: number
  weapon: { name: string; level: number; promote: number; affix: number }
  artis: any
  /** miao 自己算的属性（Attr.create().calc()），角色规则要读它 */
  attr?: Record<string, number>
  /** 同上，哪些是「基础值」（页面渲染「基础 + 绿字」用） */
  base?: Record<string, number>
  /** 天赋等级 { a/e/q: 等级 } —— 伤害计算的技能倍率查表要用（ProfileDmg.talent 读它）；
      不给的话内核按 1 级算，伤害会凭空低一大截 */
  talent?: Record<string, number>
}

/* 旅行者这类角色的元素要看天赋表；普通角色直接用 char.elem */
export function deriveElem (char: any, skillLevelMap: Record<string, number> | null = {}): string {
  const talentElem = char.meta?.talentElem || {}
  for (const id of Object.keys(skillLevelMap || {})) {
    if (talentElem[id]) return talentElem[id]
  }
  return ''
}

/* 天赋 id → a/e/q。照抄上游 EnkaData.getTalent 的兜底顺序 */
export function deriveTalent (char: any, skillLevelMap: Record<string, number> | null = {}): Record<string, number> {
  const talentId = char.meta?.talentId || {}
  const letters = ['a', 'e', 'q']
  const out: Record<string, number> = {}
  let idx = 0
  for (const [id, level] of Object.entries(skillLevelMap || {})) {
    const key = talentId[id] || letters[idx++]
    if (key && out[key] === undefined) out[key] = level
  }
  return out
}

/** 一个角色（领域模型）→ miao profile；角色不被 miao 认识时返回 null */
export function toMiaoProfile (character: CharacterDbo): MiaoProfile | null {
  const char = MiaoCharacter.get(character.avatarId)
  if (!char) return null

  /* 圣遗物仍然只喂「部件名 + 原始 prop id」，属性让内核自己解析 */
  const artis = new Artis('gs', true)
  for (const artifact of character.artifacts || []) {
    const meta = MiaoArtifact.get(artifact.itemId)   // 元数据里没有这个部件（`!meta` 把 miao 的 `false` 一并收掉）
    if (!meta) continue
    /* 等级基数：库里存的是 enka 原值（1 基，5★ 满级 21），内核要 0 基（满级 20），两边刚好差 1 */
    artis.setArtis(artifact.pos as number, {
      name: meta.name,
      level: Math.max(0, (Number(artifact.levelRaw) || 1) - 1),
      star: artifact.star,
      mainId: artifact.mainPropId,
      attrIds: artifact.appendPropIds
    })
  }

  /* 武器元数据（miao 那边的对象）：认不认识这把。装备了但元数据没有它 → weaponMeta 为空 */
  const weaponMeta = MiaoWeapon.get(character.weapon.itemId)

  const profile: MiaoProfile = {
    isProfile: true,
    isGs: true,
    game: 'gs',
    uid: character.uid,
    id: char.id,
    char,
    elem: deriveElem(char, character.skillLevelMap) || char.elem,
    level: character.level,
    promote: character.promote,
    cons: character.cons ?? 0,
    fetter: character.fetter,
    costume: character.costume,
    weapon: {
      /* 名字必须是中文（内核拿它查 weaponCfg）；没装备 / 元数据不认识这把 → 空串。
         `weaponMeta` 为空即「不认识」，跟 equipped 为假（没装）是两回事。 */
      name: character.weapon.equipped && weaponMeta ? (weaponMeta.name || '') : '',
      level: character.weapon.level ?? 1,
      promote: character.weapon.promote ?? 0,
      affix: character.weapon.affix ?? 1
    },
    artis
  }

  /* 天赋等级：域模型存的是 {天赋id: 等级}（enka 的 skillLevelMap），换算成内核要的 {a/e/q: 等级} */
  profile.talent = deriveTalent(char, character.skillLevelMap)

  /* 面板属性不是数据源给的，是 miao 按「基础值 + 武器 + 圣遗物」算的。
     base 也一并留下 —— Attr 算完 final 后内部还记着哪些是基础值，页面要拿它渲染「基础值 + 绿字」。 */
  const attrCalc = Attr.create(profile)
  profile.attr = attrCalc.calc()
  profile.base = attrCalc.getBase() || {}

  return profile
}

/** 批量：一批角色 → 一批 profile，顺手把不认识的角色挑出来（skipped） */
export function toMiaoProfiles (characters: CharacterDbo[]): { profiles: MiaoProfile[]; skipped: Array<number | null> } {
  const profiles: MiaoProfile[] = []
  const skipped: Array<number | null> = []
  for (const character of characters) {
    const profile = toMiaoProfile(character)
    if (profile) profiles.push(profile)
    else skipped.push(character.avatarId)
  }
  return { profiles, skipped }
}
