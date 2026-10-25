/*
 * simulate —— 「人工配装 → miao profile」+ 可选装备目录
 *
 * 与 materialize 的分工：materialize 走**真实抓取**的领域模型（enka 的 append_prop_ids 编码）；
 * 本模块走**用户手填**的配置（词条直接给最终数值，不经过 id 编码）。
 * 两者产出的都是同一个 MiaoProfile，下游（Attr 面板 / ArtisMark 评分 / ProfileDmg 伤害）完全共用
 * —— 所以左右两栏的数值口径必然一致。
 *
 * ⚠️ 词条数值的口径差异（用户已知并选择）：
 *   真实装备的副词条值 = 若干次 roll 的增量之和，由内核 attrIdMap 决定；
 *   人工配装是用户直接给的**最终值**。单位相同（暴击 10 = 10%），
 *   但「有效率 / 强化命中次数」这类 roll 过程的衍生信息在人工件上没有意义，
 *   故 upNum 固定 1、eff 固定 0（页面显示为 '-'）。
 */
import { Artifact as MiaoArtifact, ArtifactSet, Artis, ArtisAttr, Attr, Meta, Weapon as MiaoWeapon } from '../index.ts'
import type { MiaoProfile } from './materialize.ts'

/* ───────────────────────── 草稿形状 ───────────────────────── */

/** 武器：型号 + 等级 + 精炼。突破等级由等级推出（见 promoteOf） */
export interface SimWeapon {
  /** 武器 id（与 enka / miao 同一 id 空间） */
  itemId: number
  /** 等级（enka 1 基） */
  level: number
  /** 精炼 1–5 */
  affix: number
}

/** 一条副词条：词条 key + 最终数值 */
export interface SimSub {
  /** miao 短 key：cpct / cdmg / hp / hpPlus / mastery … */
  key: string
  value: number
}

/** 一件圣遗物：套装 + 部位 + 星级 + 等级 + 主词条 + 副词条 */
export interface SimArtifact {
  /** 套装名（miao 内部就是按套装名索引的，这里用它的中文名） */
  set: string
  /** 部位 1花 2羽 3沙 4杯 5冠 */
  pos: number
  /** 星级 4 / 5 */
  star: number
  /** 等级（enka 1 基；内部减 1） */
  level: number
  /**
   * 主词条的 miao key：hp / atk / cpct / cdmg / mastery / dmg（元素伤害）/ phy（物理伤害）…
   * 「元素伤害」在内部要换成角色元素的具体 key（cryo / pyro …），见 resolveMainKey。
   */
  mainKey: string
  subs: SimSub[]
}

/** 一整套「改后」的配装 */
export interface SimDraft {
  /** null = 沿用角色当前武器 */
  weapon: SimWeapon | null
  /** 只列出被改过的部位；没列的沿用角色现有的 */
  artifacts: SimArtifact[]
}

/* ───────────────────────── 元数据查询 ───────────────────────── */

function artiMeta (): any {
  return Meta.getMeta('gs', 'arti') as any
}

/**
 * 主词条 id 的「位置家族」—— 上游 id 的**前三位**。
 *
 * 真实 enka 数据实测吻合：花=140 羽=120 沙=100 杯=150 冠=130。
 * ⚠️ 别按前两位匹配 —— 前两位相同但家族不同的还有 109 / 309 / 508 / 509，
 *   混进来会让「杯」多出「沙」的主词条。
 */
const POS_FAMILY: Record<number, string> = { 1: '140', 2: '120', 3: '100', 4: '150', 5: '130' }

/**
 * 主词条 key → 该位置可用的 id。
 *
 * ⚠️ **只在该位置的家族里找，找不到就是 null** —— 不许退回别的家族。
 *   理由：主词条是「位置 + 词条」一起定的（花=小生命、羽=小攻击固定不变；
 *   沙只有大攻击/大防御/大生命/精通/充能，冠才有暴击率…）。跨家族兜底会让
 *   「把花的主词条改成暴击率」这种非法组合悄悄算出一个数来。
 *
 * ⚠️ 数值只由 key 决定（`AttrGS.getMain` 先查 `mainIdMap[id]` 得 key，
 *   再用 attrMap[key] 的基准值算），与 id 属于哪个家族无关 —— 但**归属**要靠家族管。
 */
export function mainIdOf (pos: number, key: string): number | null {
  const map = artiMeta().mainIdMap as Record<string, string>
  const family = POS_FAMILY[pos]
  if (!family) return null
  for (const [id, k] of Object.entries(map)) {
    if (k === key && id.startsWith(family)) return Number(id)
  }
  return null
}

/**
 * 元素伤害（主词条）：显示层统一叫 'dmg'，内核里却是**具体元素**的 key（cryo / pyro …）。
 * 这里做双向翻译 —— 元素伤害杯的 id 是按元素分的（15010=冰、15008=火…）。
 */
export function resolveMainKey (displayKey: string, elem: string): string {
  return displayKey === 'dmg' ? elem : displayKey
}

/** 把内核 key 翻回显示用的 key（元素 → 'dmg'） */
export function displayMainKey (kernelKey: string, elem: string): string {
  return kernelKey === elem ? 'dmg' : kernelKey
}

/**
 * 每个位置的主词条可选 key（上游 mainAttr）。
 *
 * ⚠️ pos 1（花）与 pos 2（羽）的主词条是**固定的**（花恒为小生命、羽恒为小攻击），
 *   上游 mainAttr 里根本没有这两项 —— 上游给的是「按权重挑最优主词条」的候选，
 *   不是「这个位置能选哪些」。所以这两处硬编码，别的位置照抄上游。
 */
export function mainKeysOf (pos: number): string[] {
  if (pos === 1) return ['hpPlus']
  if (pos === 2) return ['atkPlus']
  const mainAttr = artiMeta().mainAttr as Record<string, string[]>
  return mainAttr[pos] || []
}

/** 副词条可选 key（上游 subAttr） */
export function subAttrKeys (): string[] {
  return (artiMeta().subAttr as string[]) || []
}

/** 套装名 → 套装对象（miao 按套装名索引） */
export function setOf (set: string): any {
  try { return (ArtifactSet as any).get(set) } catch { return null }
}

/** 套装 + 部位 → 部件中文名 */
export function artifactNameOf (set: string, pos: number): string | null {
  const s = setOf(set)
  if (!s) return null
  return s.getArtiName(pos) || null
}

/** 套装 + 部位 → { name: 部件名, set: 套装名 }；换不成（套装没这个部位）就是 null */
export function artifactRefOf (set: string, pos: number): { name: string; set: string } | null {
  const name = artifactNameOf(set, pos)
  if (!name) return null
  const meta = MiaoArtifact.get(name)
  if (!meta) return null
  return { name, set: meta.set || set }
}

/* ───────────────────────── 装配 ───────────────────────── */

/**
 * 突破等级：与内核 Attr.calcPromote 同一张等级表（[1,20,40,50,60,70,80,90]），
 * 落在第几段就是几。真实武器的 promote 由 enka 直接给，人工换武器时没有 enka 值，只能按等级推
 * —— 这张表对 1–5 星武器都成立（差别只在各星上限）。
 */
export function promoteOf (level: number): number {
  const steps = [1, 20, 40, 50, 60, 70, 80, 90]
  for (let i = 0; i < steps.length - 1; i++) {
    if (level >= steps[i] && level <= steps[i + 1]) return i
  }
  return level >= 90 ? 6 : 0
}

/**
 * 基线 profile + 草稿 → 改后的 profile（面板属性已重算）。
 *
 * 草稿里没提到的部位 / 武器沿用基线 —— 前端只要发「改了哪几件」，不必回传全量。
 */
export function buildSimProfile (base: MiaoProfile, draft: SimDraft, elem: string): MiaoProfile {
  const profile: MiaoProfile = { ...base, artis: new Artis('gs', true) as any }
  const core = (base.artis as any)?.artis || {}

  /* 武器 */
  if (draft.weapon) {
    const w = MiaoWeapon.get(draft.weapon.itemId)
    if (w) {
      profile.weapon = {
        name: w.name,
        level: draft.weapon.level,
        promote: promoteOf(draft.weapon.level),
        affix: draft.weapon.affix
      }
    }
  }

  /* 圣遗物：只改草稿里点名的部位 */
  for (const spec of draft.artifacts || []) {
    if (!core[spec.pos]) continue
    const ref = artifactRefOf(spec.set, spec.pos)
    if (!ref) continue
    const level = Math.max(0, (spec.level || 1) - 1)
    const kernelKey = resolveMainKey(spec.mainKey, elem)
    const mainId = mainIdOf(spec.pos, kernelKey)
    if (mainId === null) continue
    const main = ArtisAttr.getData({ mainId, attrIds: [], level, star: spec.star } as any, 1, 'gs') as any
    if (!main?.main) continue
    ;(profile.artis as any).artis[spec.pos] = {
      name: ref.name,
      set: ref.set,
      level,
      star: spec.star,
      main: { key: main.main.key, value: main.main.value },
      /* ⚠️ 值为 0（或被填成 NaN）的词条**别喂给内核**：miao 的 `ArtisMark.formatArti` 里写的是
         `val = ds.value || ds[1]` —— 0 是 falsy，会被当成「压根没这个字段」，
         接着 `Format.comma(undefined)` 出来就是页面上那个「NaN.0」。
         顺带这也符合语义：0 值词条加不加都不影响任何数值，等于用户把它删了。 */
      attrs: (spec.subs || []).filter(s => s.value).map(s => ({ key: s.key, value: s.value, upNum: 1, eff: 0 }))
    }
  }

  /* 没被草稿碰到的位置，沿用基线 */
  for (const [pos, arti] of Object.entries(core)) {
    if (!(profile.artis as any).artis[pos]) (profile.artis as any).artis[pos] = arti
  }

  /* 面板属性重算（改动的主副词条值就是这里生效的地方） */
  const attrCalc = Attr.create(profile as any)
  profile.attr = attrCalc.calc()
  profile.base = attrCalc.getBase() || {}
  return profile
}

/* ───────────────────────── 可选装备目录 ───────────────────────── */

/** 一把可选武器 */
export interface SimWeaponOption {
  itemId: number
  name: string
  type: string
  star: number
}

/** 一套可选圣遗物套装 */
export interface SimSetOption {
  /** miao 索引用的套装名（中文） */
  set: string
  /**
   * 这套在游戏里**有哪些部位**（1 花 2 羽 3 沙 4 杯 5 冠）。
   *
   * ⚠️ 不是每套都五个部位：祭X之人那批 4★ 套只有理之冠。前端必须按它过滤下拉 ——
   *   选一个不存在的组合（祭雷之人的花）时，`artifactRefOf` 返回 null，
   *   `buildSimProfile` 会**整件草稿跳过**（主词条、副词条一起吞掉），
   *   页面上只看到「值被染成模拟色、但一点没变」，怎么查都像前端没刷新。
   */
  positions: number[]
}

/** 一套圣遗物有哪些部位可换（顺序恒为 1..5，空数组 = 一套都不认） */
export function setPositionsOf (set: string): number[] {
  const obj = setOf(set)
  if (!obj) return []
  return [1, 2, 3, 4, 5].filter(pos => obj.getArtiName(pos))
}

/**
 * 角色能用的武器（按武器类型过滤）+ 全部套装。
 *
 * 武器类型是角色的**硬约束**（迪奥娜只能拿弓）—— 目录按类型过滤，页面就不用自己判，
 * 服务端也不接受类型不符的武器。套装同理按「有没有这个部位」过滤，见 SimSetOption.positions。
 */
export function simCatalog (weaponType: string): { weapons: SimWeaponOption[]; sets: SimSetOption[] } {
  const weapons: SimWeaponOption[] = []
  Meta.forEach('gs', 'weapon', (ds: any) => {
    if (ds.type !== weaponType) return
    weapons.push({ itemId: ds.id, name: ds.name, type: ds.type, star: ds.star || 1 })
  })
  weapons.sort((a, b) => b.star - a.star || a.itemId - b.itemId)

  const sets: SimSetOption[] = []
  Meta.forEach('gs', 'artiSet', (ds: any) => { sets.push({ set: ds.name, positions: setPositionsOf(ds.name) }) })
  return { weapons, sets }
}
