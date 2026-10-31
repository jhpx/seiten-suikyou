/*
 * 角色用例 —— 「一个请求要办成什么事」都写在这里。
 *
 * 本文件只管「伤害」这一个用例（characterDamage）；模拟比对的两个用例
 * （characterSim / simCatalogOf）在 simulator.service.ts。两者共用的「读角色 + 判别不存在」
 * （loadOneCharacter / notFound）在这里导出，供 simulator.service.ts 复用。
 *
 * 与 assembler/character.assembler.ts 对照：那边管「把算好的东西拼成页面形状」，这里管编排流程。
 * 这里**不出现状态码** —— 「账号没数据」「没这个角色」用判别联合表达，由 rest 层决定回 404 还是别的。
 */
import type { CharacterDbo } from '../repository/dbo/character.ts'
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { statLabel } from './artifact.service.ts'
import { damageOf } from './assembler/damage.assembler.ts'
import type { DamageResult } from './dto/damage.dto.ts'
import { getRubrics, rubricLabel } from '../gateway/miao/rubric.ts'

/** 伤害用例：一个角色 → 伤害表 */
export async function characterDamage (db: Db, uid: number, avatarId: number): Promise<DamageResult> {
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return notFound(db, uid, avatarId)
  return { kind: 'ok', view: await damageOf(character) }
}

/*
 * 首页「按属性权重筛选」的选项：命中判据是**这一项权重不为 0**。
 * 收哪些键：只用 miao 权重表里真的会出现的键。顺序按「面板里从上往下的读法」排。
 */
export function weightFilterOptions (locale: string): Array<{ key: string; label: string }> {
  return ['hp', 'atk', 'def', 'mastery', 'cpct', 'cdmg', 'recharge', 'dmg', 'phy', 'heal']
    .map(key => ({ key, label: statLabel(key, locale) }))
}

/* ───────────────────────── 共享辅助（供 simulator.service.ts 复用） ───────────────────────── */

/** 读一个角色（实体粒度，不走整包 account 后内存 find） */
export function loadOneCharacter (db: Db, uid: number, avatarId: number): CharacterDbo | null {
  return repo.loadCharacter(db, uid, avatarId)
}

/** 角色不存在时的判别结果：区分「账号没数据」和「没这个角色」。
 *  `no_data`/`no_character` 两个分支同时是 DamageResult 和 SimResult 的成员，TS 会自动适配。 */
export function notFound (db: Db, uid: number, avatarId: number): { kind: 'no_data' } | { kind: 'no_character' } {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  return { kind: 'no_character' }
}

/* ───────────────────────── 评分规则（用户可选 miao 内置规则） ───────────────────────── */

export interface RubricOption {
  /** 规则名（与 src/gateway/miao/rubrics.json 对齐；选它时用这个名字回写库） */
  name: string
  /** 展示用全名（「角色名-规则名」，与 classTitle 同形）；下拉显示这个，提交仍用 name */
  label: string
  /** 触发条件的人类可读描述（「纯火」「血牛」「无 artis.js，固定取默认表权重」…） */
  cond: string
  /** 是不是角色唯一/兜底的那套（基础表） */
  isBase: boolean
}

export type RubricList =
  | { kind: 'ok'; rubrics: RubricOption[]; current: string | null }
  | { kind: 'no_data' }
  | { kind: 'no_character' }

/** 列这个角色能用的全部 miao 评分规则 + 当前选中的那个；判别「账号没数据 / 没这个角色」 */
export function listRubrics (db: Db, uid: number, avatarId: number, locale: string): RubricList {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return { kind: 'no_character' }
  const list = getRubrics(avatarId) || []
  return {
    kind: 'ok',
    /* label 由 rubricLabel 现拼：角色名走官方文案表、规则名走意译表，跟着 locale 变 */
    rubrics: list.map(s => ({ name: s.name, label: rubricLabel(avatarId, s.name, locale), cond: s.cond, isBase: s.isBase })),
    current: repo.getRubric(db, uid, avatarId)
  }
}

export type SelectRubricResult =
  | { kind: 'ok' }
  | { kind: 'no_data' }
  | { kind: 'no_character' }
  | { kind: 'bad_rubric' }

/**
 * 选 / 清一个评分规则。rubric 为 null = 退回 miao 自动选（删偏好行）。
 * 名字必须在角色可用规则里，否则回 bad_rubric（防止写进一个不存在的规则名）。
 */
export function selectRubric (db: Db, uid: number, avatarId: number, rubric: string | null): SelectRubricResult {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return { kind: 'no_data' }
  const character = loadOneCharacter(db, uid, avatarId)
  if (!character) return { kind: 'no_character' }
  if (rubric === null) {
    repo.setRubric(db, uid, avatarId, null)
    return { kind: 'ok' }
  }
  const list = getRubrics(avatarId) || []
  if (!list.some(s => s.name === rubric)) return { kind: 'bad_rubric' }
  repo.setRubric(db, uid, avatarId, rubric)
  return { kind: 'ok' }
}
