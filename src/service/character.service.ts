/*
 * 角色用例 —— 「一个请求要办成什么事」都写在这里（伤害 / 模拟比对 / 装备目录）。
 *
 * 与 assembler/character.assembler.ts 对照：那边管「把算好的东西拼成页面形状」（shapeCharacter /
 * damageToView / simCatalogToDto），这里管「编排流程」（load → 找角色 → materialize → 算分 → 组装 → return）。
 *
 * 与 account.service.ts 对照：那边管账号层（列表 / 详情 / 抓取 / 账号整包视图）。
 * 这里**不出现状态码** —— 「账号没数据」「没这个角色」用判别联合表达，由 rest 层决定回 404 还是别的。
 */
import { ArtisMark, i18n } from '../index.ts'
import { toMiaoProfile } from '../gateway/miao/materialize.ts'
import { buildSimProfile } from '../gateway/miao/simulate.ts'
import { calcDamage } from '../gateway/miao/damage.ts'
import type { CharacterDbo } from '../dbo/character.ts'
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { statLabel } from './artifact.service.ts'
import { damageOf, damageToView, simCatalogToDto, simViewOf } from './assembler/character.assembler.ts'
import type { DamageResult, MarkDetail, SimCatalog, SimRequest, SimResult } from './dto/character.dto.ts'

export type { DamageResult, SimCatalog, SimRequest, SimResult }

/** 伤害用例：一个角色 → 伤害表 */
export async function characterDamage (db: Db, uid: number, avatarId: number): Promise<DamageResult> {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return notFound(db, uid, avatarId)
  return { kind: 'ok', view: await damageOf(character) }
}

/** 模拟用例：按改后的配装重算面板与伤害 */
export async function characterSim (db: Db, uid: number, avatarId: number, req: SimRequest, locale: string): Promise<SimResult> {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return notFound(db, uid, avatarId)
  const base = toMiaoProfile(character)
  if (!base) return { kind: 'ok', view: null }

  const draft = {
    weapon: req.weapon ? { ...req.weapon } : null,
    artifacts: (req.artifacts || []).map(a => ({ ...a, subs: a.subs.map(s => ({ ...s })) }))
  }
  const profile = buildSimProfile(base, draft, base.elem || '')

  /* 评分：与真实件同一入口，右栏的评分因此和左栏同口径 */
  const result = ArtisMark.getMarkDetail(profile, true) as MarkDetail

  const damage = await calcDamage(profile)
  const view = simViewOf(character, profile, result, draft, locale, damage ? damageToView(damage) : null)
  return { kind: 'ok', view }
}

/** 装备目录用例：这个角色能换什么 */
export function simCatalogOf (db: Db, uid: number, avatarId: number, locale: string): SimCatalog | null {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return null
  return simCatalogToDto(character, locale)
}

/*
 * 首页「按属性权重筛选」的选项：命中判据是**这一项权重不为 0**。
 * 收哪些键：只用 miao 权重表里真的会出现的键。顺序按「面板里从上往下的读法」排。
 */
export function weightFilterOptions (locale: string): Array<{ key: string; label: string }> {
  return ['hp', 'atk', 'def', 'mastery', 'cpct', 'cdmg', 'recharge', 'dmg', 'phy', 'heal']
    .map(key => ({ key, label: statLabel(key, locale) }))
}

/* ───────────────────────── 内部辅助 ───────────────────────── */

/** 读一个角色（实体粒度，不走整包 account 后内存 find） */
function loadOneCharacter (db: Db, uid: number, avatarId: number): CharacterDbo | null {
  return repo.loadCharacter(db, uid, avatarId)
}

/** 角色不存在时的判别结果：区分「账号没数据」和「没这个角色」。
 *  `no_data`/`no_character` 两个分支同时是 DamageResult 和 SimResult 的成员，TS 会自动适配。 */
function notFound (db: Db, uid: number, avatarId: number): { kind: 'no_data' } | { kind: 'no_character' } {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  return { kind: 'no_character' }
}
