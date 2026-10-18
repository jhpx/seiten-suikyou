/*
 * 仓储 —— 按「聚合」读写，进出都是领域对象（Account / Character / Weapon / Artifact）。
 *
 * 这一层只做三件事，SQL 全在 repository/ 里：
 *   ① 行 ↔ 对象映射（下面那几对小函数）
 *   ② 聚合组装（一个 Account = 账号行 + 角色行 + 各自的武器与五件圣遗物）
 *   ③ 事务边界（一次抓取落库 = 账号 + 角色们 + 流水，要么全成要么全不成）
 *
 * 抓取是**合并式**写入：enka 一次只给展柜里那几个角色，所以每次都只碰这次抓到的，
 * 没抓到的原样留着（它们的 fetched_at 自然落后，用来判断陈旧）。
 */
import type { Conn, Db } from './db.ts'
import * as accountBo from '../repository/account.repo.ts'
import * as characterBo from '../repository/character.repo.ts'
import type { AccountRow } from '../repository/account.repo.ts'
import type { ArtifactRow, CharacterRow, WeaponRow } from '../repository/character.repo.ts'
import { account as accountT, artifact as artifactT, character as characterT, weapon as weaponT } from './schema.ts'
import { Account } from '../domain/account.ts'
import { Character } from '../domain/character.ts'
import { Weapon } from '../domain/weapon.ts'
import { Artifact } from '../domain/artifact.ts'

/* ---------------- 行 ↔ 对象 ---------------- */

function accountRow (a: Account, stamp?: string): typeof accountT.$inferInsert {
  return {
    uid: a.uid!,
    nickname: a.nickname,
    level: a.level,
    worldLevel: a.worldLevel,
    signature: a.signature,
    avatarIcon: a.avatarIcon,
    nameCard: a.nameCard,
    fetchedAt: stamp ?? a.fetchedAt!,
    payloadHash: a.payloadHash
  }
}

const accountOf = (row: AccountRow): Account => new Account(row)

function characterRow (c: Character, stamp?: string): typeof characterT.$inferInsert {
  return {
    uid: c.uid!,
    avatarId: c.avatarId!,
    level: c.level,
    promote: c.promote,
    cons: c.cons,
    fetter: c.fetter,
    costume: c.costume,
    skillLevelMap: c.skillLevelMap,
    source: c.source,
    fetchedAt: stamp ?? c.fetchedAt!
  }
}

const characterOf = (row: CharacterRow, weapon: Weapon, artifacts: Artifact[]): Character =>
  new Character({ ...row, weapon, artifacts })

function weaponRow (c: Character): typeof weaponT.$inferInsert {
  return {
    uid: c.uid!,
    avatarId: c.avatarId!,
    itemId: c.weapon.itemId,
    nameHash: c.weapon.nameHash,
    level: c.weapon.level,
    promote: c.weapon.promote,
    affix: c.weapon.affix
  }
}

const weaponOf = (row: WeaponRow | undefined): Weapon => new Weapon(row ?? {})

function artifactRow (a: Artifact, uid: number, avatarId: number): typeof artifactT.$inferInsert {
  return {
    uid,
    avatarId,
    pos: a.pos!,
    itemId: a.itemId!,
    levelRaw: a.levelRaw!,
    star: a.star!,
    mainPropId: a.mainPropId!,
    appendPropIds: a.appendPropIds,
    mainStatValue: a.mainStatValue,
    subStats: a.subStats,
    nameHash: a.nameHash,
    setHash: a.setHash
  }
}

/* JSON 列读回来是普通对象，交给 constructor 换成 Stat（那里顺带把字符串数值归一成 number） */
const artifactOf = (row: ArtifactRow): Artifact =>
  new Artifact({ ...row, subStats: row.subStats ?? [] })

/* ---------------- 写 ---------------- */

/** 账号那一行。合并式：本次没值的列保留库里旧值（语义在 repository/account.repo.ts 的 mergeAccount） */
export function saveAccount (db: Conn, a: Account, stamp?: string): void {
  accountBo.mergeAccount(db, accountRow(a, stamp))
}

/** 一个角色 = 三张表的行整块重写（数据是整包来的，见 repository/character.repo.ts 的 replaceCharacter） */
export function saveCharacter (db: Conn, c: Character, stamp?: string): void {
  const uid = c.uid!
  const avatarId = c.avatarId!

  characterBo.replaceCharacter(db, {
    character: characterRow(c, stamp),
    weapon: weaponRow(c),
    artifacts: (c.artifacts || []).map(a => artifactRow(a, uid, avatarId))
  })
}

export interface SaveFetchArgs {
  account: Account
  source?: string
  stamp?: string
  ttl?: number | null
  note?: string
}

/** 一次抓取落库：账号 + 角色们 + 流水，包在一个事务里。返回落库的角色数 */
export function saveFetch (db: Db, {
  account, source = 'enka', stamp = new Date().toISOString(), ttl = null, note = ''
}: SaveFetchArgs): number {
  return db.transaction(tx => {
    if (account) saveAccount(tx, account, stamp)
    const characters = account?.characters || []
    for (const c of characters) saveCharacter(tx, c, stamp)
    accountBo.appendFetchLog(tx, {
      uid: account.uid!,
      source,
      fetchedAt: stamp,
      avatarIds: characters.map(c => c.avatarId!),
      ttl,
      ok: 1,
      note: note || null
    })
    return characters.length
  })
}

export interface LogFailureArgs {
  uid: number | null
  source?: string
  note?: string
  stamp?: string
}

/** 抓取失败也记一行（ok=0）—— 上游抖过多少次，只留痕在这里 */
export function logFailure (db: Conn, { uid, source = 'enka', note = '', stamp = new Date().toISOString() }: LogFailureArgs): void {
  accountBo.appendFetchLog(db, { uid: uid!, source, fetchedAt: stamp, avatarIds: null, ttl: null, ok: 0, note: note || null })
}

/* ---------------- 读 ---------------- */

/** 只读账号那一行（不带角色）。列表页 / 页脚只要昵称等级时用它 */
export function loadAccount (db: Conn, uid: number): Account | null {
  const row = accountBo.findAccount(db, uid)
  return row ? accountOf(row) : null
}

export function listUids (db: Conn): number[] {
  return accountBo.listAccountUids(db)
}

export function listCharacterIds (db: Conn, uid: number): number[] {
  return characterBo.listCharacterIds(db, uid)
}

/* 一批角色连武器带圣遗物 —— 固定三条查询（不按角色数 N+1），子行在内存里按 avatarId 分组 */
function loadCharacters (db: Conn, uid: number, avatarIds: number[]): Character[] {
  if (!avatarIds.length) return []

  const rows = new Map(characterBo.findCharacters(db, uid, avatarIds).map(r => [r.avatarId, r]))
  const weapons = new Map(characterBo.findWeapons(db, uid, avatarIds).map(r => [r.avatarId, r]))

  const artifacts = new Map<number, Artifact[]>()
  for (const row of characterBo.findArtifacts(db, uid, avatarIds)) {
    const list = artifacts.get(row.avatarId) || []
    list.push(artifactOf(row))
    artifacts.set(row.avatarId, list)
  }

  /* 按调用方给的顺序（页面按需加载时就是页面上的顺序），库里没有的跳过 */
  return avatarIds.flatMap(id => {
    const row = rows.get(id)
    return row ? [characterOf(row, weaponOf(weapons.get(id)), artifacts.get(id) || [])] : []
  })
}

/** 读一个角色（带武器与圣遗物） */
export function loadCharacter (db: Conn, uid: number, avatarId: number): Character | null {
  return loadCharacters(db, uid, [avatarId])[0] ?? null
}

/*
 * 读整个账号：账号行 + 名下的角色们（Account 是聚合根）。库里连账号带角色都没有 → null，上层据此回 404。
 * avatarIds 给了就只读那几个（页面按需加载），不给读全部。
 */
export function loadAccountWithCharacters (db: Conn, uid: number, avatarIds: number[] | null = null): Account | null {
  const ids = avatarIds && avatarIds.length ? avatarIds : listCharacterIds(db, uid)
  const characters = loadCharacters(db, uid, ids)
  const account = loadAccount(db, uid)
  if (!account && !characters.length) return null
  const merged = account || new Account({ uid })
  merged.characters = characters
  return merged
}

/** fetch_log 表的一行（`lastFetch` 的返回形状） */
export type FetchLogRow = accountBo.FetchLogRow

/** 最后一次成功抓取（列表页页脚 / 明细页 / CLI 的「最后抓取」都读它） */
export function lastFetch (db: Conn, uid: number): FetchLogRow | null {
  return accountBo.lastOkFetch(db, uid)
}

/** 库里用到的官方文案 key 清单（跨三张表去重，见 repository/character.repo.ts） */
export function listTextKeys (db: Conn): characterBo.TextKeys {
  return characterBo.collectTextKeys(db)
}
