/*
 * 角色行的读写 —— character / weapon / artifact 三张表。
 *
 * 为什么三张表放一个文件：它们同键 (uid, avatar_id)、同寿命、总是一起读写
 * （一个角色 = 一行 character + 一行 weapon + 五行 artifact），拆成三个文件只会让人来回跳。
 * 但它们**各拼各的查询条件** —— 三张表列名一样，复用同一份条件会拼出 `character.avatar_id`
 * 去查 weapon 表（SQLite 会直接报 no such column）。
 *
 * 写入是「整块替换」：数据是 enka 整包给的，先删这个角色名下的子行再写回，
 * 比逐列 diff 简单且不会残留上一次的圣遗物。
 */
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Conn } from '../db.ts'
import { artifact, character, weapon } from '../schema.ts'

export type CharacterRow = typeof character.$inferSelect
export type NewCharacterRow = typeof character.$inferInsert
export type WeaponRow = typeof weapon.$inferSelect
export type NewWeaponRow = typeof weapon.$inferInsert
export type ArtifactRow = typeof artifact.$inferSelect
export type NewArtifactRow = typeof artifact.$inferInsert

/** 删掉一个角色名下的三张表行（外键是 cascade，但显式删更明确、也不依赖 PRAGMA） */
export function deleteOne (db: Conn, uid: number, avatarId: number): void {
  db.delete(artifact).where(and(eq(artifact.uid, uid), eq(artifact.avatarId, avatarId))).run()
  db.delete(weapon).where(and(eq(weapon.uid, uid), eq(weapon.avatarId, avatarId))).run()
  db.delete(character).where(and(eq(character.uid, uid), eq(character.avatarId, avatarId))).run()
}

export function insertCharacter (db: Conn, row: NewCharacterRow): void {
  db.insert(character).values(row).run()
}

/** 武器总有一行 —— 没装备就是全 NULL 那行，卸了武器才不会留下上一把 */
export function insertWeapon (db: Conn, row: NewWeaponRow): void {
  db.insert(weapon).values(row).run()
}

export function insertArtifact (db: Conn, row: NewArtifactRow): void {
  db.insert(artifact).values(row).run()
}

export function selectIds (db: Conn, uid: number): number[] {
  return db.select({ avatarId: character.avatarId }).from(character)
    .where(eq(character.uid, uid)).orderBy(asc(character.avatarId)).all().map(r => r.avatarId)
}

export function selectRows (db: Conn, uid: number, avatarIds: number[]): CharacterRow[] {
  if (!avatarIds.length) return []
  return db.select().from(character)
    .where(and(eq(character.uid, uid), inArray(character.avatarId, avatarIds))).all()
}

export function selectWeapons (db: Conn, uid: number, avatarIds: number[]): WeaponRow[] {
  if (!avatarIds.length) return []
  return db.select().from(weapon)
    .where(and(eq(weapon.uid, uid), inArray(weapon.avatarId, avatarIds))).all()
}

/** 按部位升序 —— 圣遗物在视图里要按 1~5 号排 */
export function selectArtifacts (db: Conn, uid: number, avatarIds: number[]): ArtifactRow[] {
  if (!avatarIds.length) return []
  return db.select().from(artifact)
    .where(and(eq(artifact.uid, uid), inArray(artifact.avatarId, avatarIds)))
    .orderBy(asc(artifact.pos)).all()
}
