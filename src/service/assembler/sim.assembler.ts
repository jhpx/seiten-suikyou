/*
 * 模拟比对组装器 —— 把人工配装 + miao 计算结果拼成 SimView / SimCatalog（给前端的模拟形状）。
 */
import { Format, i18n, Weapon as MiaoWeapon } from '../../index.ts'
import { toMiaoProfile } from '../../gateway/miao/materialize.ts'
import type { MiaoProfile } from '../../gateway/miao/materialize.ts'
import { mainKeysOf, promoteOf, simCatalog, subAttrKeys, artifactNameOf, artifactMaxLevel } from '../../gateway/miao/simulate.ts'
import type { SimDraft } from '../../gateway/miao/simulate.ts'
import { ArtifactDbo, setMaxStar } from '../../repository/dbo/artifact.ts'
import { WeaponDbo } from '../../repository/dbo/weapon.ts'
import { isIntegerStatKey } from '../../common/stat.ts'
import { CharacterDbo } from '../../repository/dbo/character.ts'
import { statLabel, pctText, artiLabel } from '../artifact.service.ts'
import { shapeCharacter, WEAPON_KEY_FIX } from './character.assembler.ts'
import type { MarkDetail } from '../dto/character.dto.ts'
import type { SimCatalog, SimView } from '../dto/sim.dto.ts'
import type { DamageView } from '../dto/damage.dto.ts'

/* miao 的文案里夹着 <nobr> 这类排版标记，出口统一洗掉 */
const plainText = (text: string): string => String(text || '').replace(/<[^>]*>/g, '')

/* 「等级档位 → 数值」翻成「等级档位 → 显示文本」；键转字符串（JSON 键没有数字） */
function levelValues (vals: Record<number, number>, fmt: (v: number) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [lv, v] of Object.entries(vals)) out[lv] = fmt(v)
  return out
}

/** 主词条的显示名：直接走面板那套标签（statLabel），必须带 locale */
function mainStatName (key: string, locale: string): string {
  return statLabel(key, locale)
}

/** 把「人工配装」翻成领域模型，让 shapeCharacter 走同一条成型路径 */
function simCharacterOf (ch: CharacterDbo, profile: MiaoProfile, draft: SimDraft): CharacterDbo {
  const artifacts = (ch.artifacts || []).map(a => {
    const spec = (draft.artifacts || []).find(s => s.pos === a.pos)
    if (!spec) return a
    const name = artifactNameOf(spec.set, spec.pos)
    if (!name) return a
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

/** 可选装备目录 → SimCatalog DTO */
export function simCatalogToDto (character: CharacterDbo, locale: string): SimCatalog | null {
  const profile = toMiaoProfile(character)
  if (!profile) return null
  const char = profile.char
  const weaponType = char.weaponType || ''
  const raw = simCatalog(weaponType)
  const loc = i18n.resolveLocale(locale)
  return {
    weapons: raw.weapons.map(w => {
      const subKey = w.sub ? (WEAPON_KEY_FIX[w.sub.key] || w.sub.key) : ''
      return {
        itemId: w.itemId,
        name: i18n.weaponName(w.itemId, loc) || w.name,
        star: w.star,
        affixText: plainText(w.affixText),
        affixVals: w.affixVals,
        main: { label: statLabel('atkBase', loc), values: levelValues(w.atks, v => Format.comma(v, 0)) },
        sub: subKey
          ? {
            label: statLabel(subKey, loc),
            values: levelValues(w.sub!.values, v => isIntegerStatKey(subKey) ? Format.comma(v, 0) : pctText(v))
          }
          : null
      }
    }),
    sets: raw.sets.map(s => ({
      key: s.set,
      name: i18n.fromZh(s.set, loc) || s.set,
      positions: s.positions,
      star: setMaxStar(s.set)
    })),
    mains: [1, 2, 3, 4, 5].map(pos => ({
      pos,
      options: mainKeysOf(pos).map(key => ({
        key,
        name: mainStatName(key, loc),
        elem: key === 'dmg'
      }))
    })),
    starLevels: [5, 4, 3, 2, 1].map(star => ({ star, maxLevel: artifactMaxLevel(star) })),
    subs: subAttrKeys().map(key => ({
      key,
      name: artiLabel(key, loc),
      int: isIntegerStatKey(key)
    }))
  }
}

/* 组装模拟结果里「改后的角色视图」+「伤害表」，供 character.service 的 characterSim 调用 */
export function simViewOf (character: CharacterDbo, profile: MiaoProfile, result: MarkDetail, draft: SimDraft, locale: string, damage: DamageView | null): SimView {
  const view = shapeCharacter(simCharacterOf(character, profile, draft), profile, result, locale)
  return { avatar: view, damage }
}
