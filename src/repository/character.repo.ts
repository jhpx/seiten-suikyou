/*
 * 角色域的行读写 —— character / weapon / artifact 三张表，外加跨这三表收文案 key。
 *
 * 为什么三张表放一个文件：它们同键 (uid, avatar_id)、同寿命、总是一起读写
 * （一个角色 = 一行 character + 一行 weapon + 五行 artifact），拆成三个文件只会让人来回跳。
 * 但它们**各拼各的查询条件** —— 三张表列名一样，复用同一份条件会拼出 `character.avatar_id`
 * 去查 weapon 表（SQLite 会直接报 no such column）。
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'

import type { Conn } from '../config/db.ts'
import { artifact, character, characterRubric, weapon } from '../config/schema.ts'

export type CharacterRow = typeof character.$inferSelect
export type NewCharacterRow = typeof character.$inferInsert
export type WeaponRow = typeof weapon.$inferSelect
export type NewWeaponRow = typeof weapon.$inferInsert
export type ArtifactRow = typeof artifact.$inferSelect
export type NewArtifactRow = typeof artifact.$inferInsert

/** 一个角色在三张表里的全部行 —— replaceCharacter 的入参 */
export interface CharacterDocs {
  character: NewCharacterRow
  /** 武器总有一行 —— 没装备就是全 NULL 那行，卸了武器才不会留下上一把 */
  weapon: NewWeaponRow
  /** 五件圣遗物的行；几件就几件，本事没戴满也照写 */
  artifacts: NewArtifactRow[]
}

/* 删掉一个角色名下的三张表行（外键是 cascade，但显式删更明确、也不依赖 PRAGMA） */
function dropRows (db: Conn, uid: number, avatarId: number): void {
  db.delete(artifact).where(and(eq(artifact.uid, uid), eq(artifact.avatarId, avatarId))).run()
  db.delete(weapon).where(and(eq(weapon.uid, uid), eq(weapon.avatarId, avatarId))).run()
  db.delete(character).where(and(eq(character.uid, uid), eq(character.avatarId, avatarId))).run()
}

/**
 * 这个角色的所有行整块重写：先删子行再写回。数据是 enka 整包给的，
 * 比逐列 diff 简单且不会残留上一次的圣遗物。
 */
export function replaceCharacter (db: Conn, docs: CharacterDocs): void {
  const { uid, avatarId } = docs.character
  dropRows(db, uid, avatarId)
  db.insert(character).values(docs.character).run()
  db.insert(weapon).values(docs.weapon).run()
  if (docs.artifacts.length) db.insert(artifact).values(docs.artifacts).run()
}

/** 这个 uid 名下的角色 id，升序 */
export function listCharacterIds (db: Conn, uid: number): number[] {
  return db.select({ avatarId: character.avatarId }).from(character)
    .where(eq(character.uid, uid)).orderBy(asc(character.avatarId)).all().map(r => r.avatarId)
}

/** 批量拿角色行 —— 上层按 avatarId 在内存里分组，避免一个角色一轮查询 */
export function findCharacters (db: Conn, uid: number, avatarIds: number[]): CharacterRow[] {
  if (!avatarIds.length) return []
  return db.select().from(character)
    .where(and(eq(character.uid, uid), inArray(character.avatarId, avatarIds))).all()
}

/** 批量拿武器行（同键同条件，按 avatarId 自己拼） */
export function findWeapons (db: Conn, uid: number, avatarIds: number[]): WeaponRow[] {
  if (!avatarIds.length) return []
  return db.select().from(weapon)
    .where(and(eq(weapon.uid, uid), inArray(weapon.avatarId, avatarIds))).all()
}

/** 批量拿圣遗物行，按部位升序 —— 视图里要按 1~5 号排 */
export function findArtifacts (db: Conn, uid: number, avatarIds: number[]): ArtifactRow[] {
  if (!avatarIds.length) return []
  return db.select().from(artifact)
    .where(and(eq(artifact.uid, uid), inArray(artifact.avatarId, avatarIds)))
    .orderBy(asc(artifact.pos)).all()
}

/* ---------------- 文案 key 清单 ---------------- */

export interface TextKeys {
  hash: number[]
  avatars: number[]
}

/**
 * 「库里实际用到过哪些官方文案 key」—— 跨这三张表去重。
 *
 * 接多语言翻译表时不用把几十万条全导进来，拿这张清单去找那几百条就够了
 * （角色没有 hash —— enka 不给角色名 hash，只能按 avatarId 列）。
 */
export function collectTextKeys (db: Conn): TextKeys {
  const hash = new Set<number>()
  const add = (rows: Array<{ h: number | null }>): void => { for (const r of rows) if (r.h !== null) hash.add(r.h) }

  add(db.selectDistinct({ h: artifact.nameHash }).from(artifact).where(isNotNull(artifact.nameHash)).all())
  add(db.selectDistinct({ h: artifact.setHash }).from(artifact).where(isNotNull(artifact.setHash)).all())
  add(db.selectDistinct({ h: weapon.nameHash }).from(weapon).where(isNotNull(weapon.nameHash)).all())

  const avatars = db.selectDistinct({ avatarId: character.avatarId }).from(character)
    .orderBy(asc(character.avatarId)).all().map(r => r.avatarId)

  return { hash: [...hash], avatars }
}

/* ─────────────── 评分规则偏好（用户为每个角色选的 miao 规则） ─────────────── */

/** 读这个角色当前选中的规则名；没选过 → null（= 用 miao 自动选） */
export function getRubric (db: Conn, uid: number, avatarId: number): string | null {
  const rows = db.select({ rubric: characterRubric.rubric })
    .from(characterRubric)
    .where(and(eq(characterRubric.uid, uid), eq(characterRubric.avatarId, avatarId))).all()
  return rows[0]?.rubric ?? null
}

/**
 * 设 / 清选中规则。rubric 为 null = 退回 miao 自动选（把偏好行删掉，不留空串行）。
 * 用「先删后插」而不是 upsert：清选项时直接删行，语义更干净。
 */
export function setRubric (db: Conn, uid: number, avatarId: number, rubric: string | null): void {
  db.delete(characterRubric)
    .where(and(eq(characterRubric.uid, uid), eq(characterRubric.avatarId, avatarId))).run()
  if (rubric) {
    db.insert(characterRubric).values({ uid, avatarId, rubric }).run()
  }
}
