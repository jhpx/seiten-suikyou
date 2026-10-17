/*
 * 本地库读写 —— 上层只管拿/放，不碰 SQL 细节
 *
 * 写入是「合并式 upsert」而不是覆盖：enka 一次只给展柜里那几个角色，所以每次抓到的覆盖、
 * 没抓到的原样留着（fetched_at 自然落后，用来判断陈旧）。
 *
 * 进出都走领域模型：列名、JSON 编解码、扁列 ↔ 字段名的对应全在模型里（`X.COLS` + `toValues` / `fromRow`），
 * 这里只做两件事 —— 拿模型出的值拼 SQL，把查到的行交回模型解。
 *
 * 表名与领域类一一对应：account ↔ Account、character ↔ Character、artifact ↔ Artifact。
 */
import { tx, getRow, allRows, runSql } from './db.ts'
import type { DatabaseSync } from './db.ts'
import { Account } from '../domain/account.ts'
import { Character } from '../domain/character.ts'
import { Weapon } from '../domain/weapon.ts'
import { Artifact } from '../domain/artifact.ts'

/* 列名只写一遍（表结构改动只需动模型），ON CONFLICT 那份由这里生成。
   keep 里的列写 COALESCE：本次没给值的就保留库里旧值 —— 账号信息会分批变。 */
function upsertModel (
  db: DatabaseSync, table: string, cols: string[], key: string[], values: unknown[], keep: string[] = []
): void {
  const set = cols
    .filter(c => !key.includes(c))
    .map(c => (keep.includes(c) ? `${c} = COALESCE(excluded.${c}, ${table}.${c})` : `${c} = excluded.${c}`))
    .join(',\n      ')
  runSql(db, `INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT (${key.join(', ')}) DO UPDATE SET
      ${set}`, values)
}

/* ---------------- 写 ---------------- */

export function saveAccount (db: DatabaseSync, account: Account, stamp?: string): void {
  upsertModel(db, 'account', Account.COLS, ['uid'], account.toValues(stamp), Account.KEEP)
}

/* 一个角色三张表：character 那一行、它的 1 把武器（weapon）、它的 5 件圣遗物（artifact，整体换掉） */
export function saveCharacter (db: DatabaseSync, character: Character, stamp?: string): void {
  upsertModel(db, 'character', Character.COLS, ['uid', 'avatar_id'], character.toValues(stamp), [])

  /* 武器总是写一行 —— 没装备就是 Weapon.none() 那行全 NULL。写成「有装备才写」的话，
     卸了武器就会把上一把的旧行留在库里（upsert 只覆盖、不删行）。 */
  upsertModel(db, 'weapon', Weapon.COLS, ['uid', 'avatar_id'],
    character.weapon.toValues(character.uid, character.avatarId))

  runSql(db, 'DELETE FROM artifact WHERE uid = ? AND avatar_id = ?', [character.uid, character.avatarId])
  const insert = `INSERT INTO artifact (${Artifact.COLS.join(', ')})
    VALUES (${Artifact.COLS.map(() => '?').join(', ')})`
  for (const artifact of character.artifacts || []) {
    runSql(db, insert, artifact.toValues(character.uid, character.avatarId))
  }
}

/* 抓取流水：成了记一笔拿到了哪些角色，失败了也记（前端据此提示「还有哪些没拿到」） */
function logFetch (db: DatabaseSync, { uid, source, stamp, ok, avatarIds = null, ttl = null, note = '' }: {
  uid: number | null
  source: string
  stamp: string
  ok: number
  avatarIds?: Array<number | null> | null
  ttl?: number | null
  note?: string
}): void {
  runSql(db, `INSERT INTO fetch_log (uid, source, fetched_at, avatar_ids, ttl, ok, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [uid, source, stamp, avatarIds === null ? null : JSON.stringify(avatarIds), ttl, ok, note || null])
}

export interface SaveFetchArgs {
  account: Account
  source?: string
  stamp?: string
  ttl?: number | null
  note?: string
}

/** 一次抓取落库：账号 + 角色们 + 流水，包在一个事务里。返回落库的角色数 */
export function saveFetch (db: DatabaseSync, {
  account, source = 'enka', stamp = new Date().toISOString(), ttl = null, note = ''
}: SaveFetchArgs): number {
  return tx(db, () => {
    if (account) saveAccount(db, account, stamp)
    const characters = account?.characters || []
    for (const character of characters) saveCharacter(db, character, stamp)
    logFetch(db, { uid: account.uid, source, stamp, ok: 1, avatarIds: characters.map(c => c.avatarId), ttl, note })
    return characters.length
  })
}

export interface LogFailureArgs {
  uid: number | null
  source?: string
  note?: string
  stamp?: string
}

export function logFailure (db: DatabaseSync, { uid, source = 'enka', note = '', stamp = new Date().toISOString() }: LogFailureArgs): void {
  logFetch(db, { uid, source, stamp, ok: 0, note })
}

/* ---------------- 读 ---------------- */

/** 只读账号那一行（不带角色）。视图页脚 / 列表页只要昵称等级时用它 */
export function loadAccount (db: DatabaseSync, uid: number): Account | null {
  return Account.fromRow(getRow(db, 'SELECT * FROM account WHERE uid = ?', uid)) || null
}

export function listCharacterIds (db: DatabaseSync, uid: number): number[] {
  return allRows<{ avatar_id: number }>(db, 'SELECT avatar_id FROM character WHERE uid = ? ORDER BY avatar_id', uid)
    .map(row => row.avatar_id)
}

/** 读一个角色，带上它的武器与圣遗物（子行交回各自的模型解，JSON 列在模型里解码） */
export function loadCharacter (db: DatabaseSync, uid: number, avatarId: number): Character | null {
  const row = getRow(db, 'SELECT * FROM character WHERE uid = ? AND avatar_id = ?', uid, avatarId)
  if (!row) return null
  /* 武器行理论上一定有（saveCharacter 总是写），但手工动过库就别炸了 —— 缺行按「没装备」算 */
  const weapon = getRow(db, 'SELECT * FROM weapon WHERE uid = ? AND avatar_id = ?', uid, avatarId)
  const artifacts = allRows(db, 'SELECT * FROM artifact WHERE uid = ? AND avatar_id = ? ORDER BY pos', uid, avatarId)
  return Character.fromRow(
    row, artifacts.map(row => Artifact.fromRow(row)), weapon ? Weapon.fromRow(weapon) : Weapon.none()
  )
}

/*
 * 读整个账号：账号行 + 名下的角色们（Account 是聚合根）。库里连账号带角色都没有 → null，上层据此回 404。
 * avatarIds 给了就只读那几个（页面按需加载），不给读全部。
 */
export function loadAccountWithCharacters (db: DatabaseSync, uid: number, avatarIds: number[] | null = null): Account | null {
  const account = loadAccount(db, uid)
  const ids = avatarIds && avatarIds.length ? avatarIds : listCharacterIds(db, uid)
  const characters = ids
    .map(id => loadCharacter(db, uid, id))
    .filter((c): c is Character => c !== null)
  if (!account && !characters.length) return null
  const merged = account || new Account({ uid })
  merged.characters = characters
  return merged
}

export function listUids (db: DatabaseSync): number[] {
  return allRows<{ uid: number }>(db, 'SELECT uid FROM account ORDER BY uid').map(row => row.uid)
}

/** fetch_log 表的一行（lastFetch 的返回形状） */
export interface FetchLogRow {
  id?: number
  uid?: number | null
  source?: string
  fetched_at?: string | null
  avatar_ids?: string | null
  ttl?: number | null
  ok?: number
  note?: string | null
}

/** 最近一次抓取流水，用来看数据新不新 */
/** 最后一次**成功**抓取（列表页页脚 / 明细页 / CLI 的「最后抓取」都读它）。
    只认 ok=1：失败流水（ok=0）记的是「尝试过」，数据并没变新 ——
    把失败时刻当数据更新时间，页面会显示一个骗人的新鲜度。 */
export function lastFetch (db: DatabaseSync, uid: number): FetchLogRow | null {
  return getRow<FetchLogRow>(db, 'SELECT * FROM fetch_log WHERE uid = ? AND ok = 1 ORDER BY id DESC LIMIT 1', uid) || null
}

/* 库里实际用到过哪些「官方文案 key」—— 接多语言文案表时不用把几十万条全导进来，
   拿这张清单去找那几百条就够了。角色那种没有 hash（enka 不给角色名 hash），单独按 avatarId 列出来。 */
export function listTextKeys (db: DatabaseSync): { hash: number[]; avatars: number[] } {
  const hash = allRows<{ h: number }>(db, `
    SELECT DISTINCT name_hash AS h FROM artifact WHERE name_hash IS NOT NULL
    UNION
    SELECT DISTINCT set_hash  FROM artifact WHERE set_hash  IS NOT NULL
    UNION
    SELECT DISTINCT name_hash FROM weapon  WHERE name_hash IS NOT NULL
  `).map(row => row.h)
  const avatars = allRows<{ avatar_id: number }>(db, 'SELECT DISTINCT avatar_id FROM character ORDER BY avatar_id')
    .map(row => row.avatar_id)
  return { hash, avatars }
}
