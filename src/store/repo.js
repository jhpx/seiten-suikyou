/*
 * 本地库读写 —— 上层只管拿/放，不碰 SQL 细节
 *
 * 写入是「合并式 upsert」而不是覆盖：enka 一次只给展柜里那几个角色，
 * 所以每次抓到的角色覆盖，没抓到的原样留着（fetched_at 自然落后，用来判断陈旧）。
 *
 * 进出都走领域模型（src/domain/）：列名、JSON 编解码、扁列 ↔ 字段名的对应全在模型里
 * （`Player.COLS` / `Character.COLS` / `Artifact.COLS` + 各自的 `toValues` / `fromRow`）。
 * 这里只做两件事：拿模型出的值拼 SQL，把查到的行交回模型解 —— 不再维护「哪列是 JSON」的清单。
 */
import { tx } from './db.js'
import { Player } from '../domain/player.js'
import { Character } from '../domain/character.js'
import { Artifact } from '../domain/artifact.js'

/* 列名只写一遍（表结构改动只需动模型），ON CONFLICT 那份由这里生成。
   keep 里的列写 COALESCE：本次没给值的就保留库里旧值 —— 账号信息会分批变。 */
const upsertModel = (db, table, cols, key, values, keep = []) => {
  const set = cols
    .filter(c => !key.includes(c))
    .map(c => (keep.includes(c) ? `${c} = COALESCE(excluded.${c}, ${table}.${c})` : `${c} = excluded.${c}`))
    .join(',\n      ')
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT (${key.join(', ')}) DO UPDATE SET
      ${set}`).run(...values)
}

/* ---------------- 写 ---------------- */

/* 账号一行。模型自己把 camelCase 摊回列名，JSON 列（如果有）也自己编码 */
export function savePlayer (db, player, stamp) {
  upsertModel(db, 'account', Player.COLS, ['uid'], player.toValues(stamp), Player.KEEP)
}

/* 一个角色：先写角色行（武器那几列由 Character.toValues 一并给出），再整体换掉它的 5 件圣遗物 */
export function saveCharacter (db, ch, stamp) {
  upsertModel(db, 'avatar', Character.COLS, ['uid', 'avatar_id'], ch.toValues(stamp))

  db.prepare('DELETE FROM artifact WHERE uid = ? AND avatar_id = ?').run(ch.uid, ch.avatarId)
  /* 列名与各列的值都由 Artifact 自己给（COLS 与 toValues 一一对应） */
  const ins = db.prepare(`INSERT INTO artifact (${Artifact.COLS.join(', ')})
    VALUES (${Artifact.COLS.map(() => '?').join(', ')})`)
  for (const a of ch.artifacts || []) ins.run(...a.toValues(ch.uid, ch.avatarId))
}

/* 抓取流水：成了记一笔拿到了哪些角色，失败了也记（前端据此提示「还有哪些没拿到」） */
function logFetch (db, { uid, source, stamp, ok, avatarIds = null, ttl = null, note = '' }) {
  db.prepare(`INSERT INTO fetch_log (uid, source, fetched_at, avatar_ids, ttl, ok, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, source, stamp, avatarIds === null ? null : JSON.stringify(avatarIds), ttl, ok, note || null)
}

/* 一次抓取落库：账号 + 角色们 + 流水，包在一个事务里 */
export function saveFetch (db, { player, source = 'enka', stamp = new Date().toISOString(), ttl = null, note = '' }) {
  return tx(db, () => {
    if (player) savePlayer(db, player, stamp)
    const chars = player?.characters || []
    for (const ch of chars) saveCharacter(db, ch, stamp)
    logFetch(db, { uid: player.uid, source, stamp, ok: 1, avatarIds: chars.map(c => c.avatarId), ttl, note })
    return chars.length
  })
}

export function logFailure (db, { uid, source = 'enka', note = '', stamp = new Date().toISOString() }) {
  logFetch(db, { uid, source, stamp, ok: 0, note })
}

/* ---------------- 读 ---------------- */

export function loadAccount (db, uid) {
  return Player.fromRow(db.prepare('SELECT * FROM account WHERE uid = ?').get(uid)) || null
}

export function listCharacterIds (db, uid) {
  return db.prepare('SELECT avatar_id FROM avatar WHERE uid = ? ORDER BY avatar_id').all(uid).map(r => r.avatar_id)
}

/* 读一个角色，带上它的圣遗物。圣遗物行交回 Artifact 自己解（JSON 列在模型里解码）。 */
export function loadCharacter (db, uid, avatarId) {
  const row = db.prepare('SELECT * FROM avatar WHERE uid = ? AND avatar_id = ?').get(uid, avatarId)
  if (!row) return null
  const artis = db.prepare('SELECT * FROM artifact WHERE uid = ? AND avatar_id = ? ORDER BY pos').all(uid, avatarId)
  return Character.fromRow(row, artis.map(r => Artifact.fromRow(r)))
}

/*
 * 读整个玩家：账号 + 角色们（Player 是聚合根）。
 * 库里连账号带角色都没有 → null，上层据此回 404。
 * avatarIds 给了就只读那几个（页面按需加载），不给读全部。
 */
export function loadPlayer (db, uid, avatarIds = null) {
  const account = loadAccount(db, uid)
  const ids = avatarIds && avatarIds.length ? avatarIds : listCharacterIds(db, uid)
  const characters = ids.map(id => loadCharacter(db, uid, id)).filter(Boolean)
  if (!account && !characters.length) return null
  const player = account || new Player({ uid })
  player.characters = characters
  return player
}

export function listUids (db) {
  return db.prepare('SELECT uid FROM account ORDER BY uid').all().map(r => r.uid)
}

/* 最近一次抓取流水，用来看数据新不新 */
export function lastFetch (db, uid) {
  return db.prepare('SELECT * FROM fetch_log WHERE uid = ? ORDER BY id DESC LIMIT 1').get(uid) || null
}

/*
 * 库里实际用到过哪些「官方文案 key」—— 接多语言文案表时，不用把几十万条全导进来，
 * 拿这张清单去找那几百条就够了。avatar 那组是没 hash 的（enka 不给角色名 hash），
 * 单独按 avatarId 列出来，好知道还得另外配映射。
 */
export function listTextKeys (db) {
  const hash = db.prepare(`
    SELECT DISTINCT name_hash AS h FROM artifact WHERE name_hash IS NOT NULL
    UNION
    SELECT DISTINCT set_hash  FROM artifact WHERE set_hash  IS NOT NULL
    UNION
    SELECT DISTINCT weapon_name_hash FROM avatar WHERE weapon_name_hash IS NOT NULL
  `).all().map(r => r.h)
  const avatars = db.prepare('SELECT DISTINCT avatar_id FROM avatar ORDER BY avatar_id').all().map(r => r.avatar_id)
  return { hash, avatars }
}
