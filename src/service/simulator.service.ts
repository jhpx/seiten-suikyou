/*
 * 模拟比对用例 —— 换一套配装重算面板与伤害（characterSim）+ 可选装备目录（simCatalogOf）。
 *
 * 与 character.service.ts 对照：那边管「伤害」这一个用例（characterDamage），这边管「模拟比对」
 * 两个用例。两者共用的「读角色 + 判别不存在」在 character.service.ts 导出。
 *
 * 与 assembler/character.assembler.ts 对照：那边管「把算好的东西拼成页面形状」，这里管编排流程。
 */
import { ArtisMark } from '../index.ts'
import { toMiaoProfile } from '../gateway/miao/materialize.ts'
import { buildSimProfile } from '../gateway/miao/simulate.ts'
import { calcDamage } from '../gateway/miao/damage.ts'
import type { Db } from '../config/db.ts'
import { damageToView } from './assembler/damage.assembler.ts'
import { simCatalogToDto, simViewOf } from './assembler/sim.assembler.ts'
import { loadOneCharacter, notFound } from './character.service.ts'
import type { MarkDetail } from './dto/character.dto.ts'
import type { SimCatalog, SimRequest, SimResult } from './dto/sim.dto.ts'

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
