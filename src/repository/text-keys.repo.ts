/*
 * 「库里实际用到过哪些官方文案 key」—— 跨 artifact / weapon / character 三张表的去重查询。
 *
 * 单独一个文件是因为它既不按表、也不成聚合：接多语言翻译表时不用把几十万条全导进来，
 * 拿这张清单去找那几百条就够了（角色没有 hash —— enka 不给角色名 hash，只能按 avatarId 列）。
 */
import { asc, isNotNull } from 'drizzle-orm'

import type { Conn } from '../config/db.ts'
import { artifact, character, weapon } from '../config/schema.ts'

export interface TextKeys {
  hash: number[]
  avatars: number[]
}

/** 三张表扫一遍，把用到的文案 hash 与角色 id 去重收拢 */
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
