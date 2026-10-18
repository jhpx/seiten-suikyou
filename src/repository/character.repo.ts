/*
 * 角色行的读写 —— character / weapon / artifact 三张表。
 *
 * 为什么三张表放一个文件：它们同键 (uid, avatar_id)、同寿命、总是一起读写
 * （一个角色 = 一行 character + 一行 weapon + 五行 artifact），拆成三个文件只会让人来回跳。
 * 但它们**各拼各的查询条件** —— 三张表列名一样，复用同一份条件会拼出 `character.avatar_id`
 * 去查 weapon 表（SQLite 会直接报 no such column）。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Conn } from '../config/db.ts'
import { artifact, character, weapon } from '../config/schema.ts'

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
