/*
 * 本地库读写 —— 上层只管拿/放，不碰 SQL 细节
 *
 * 写入是「合并式 upsert」而不是覆盖：enka 一次只给展柜里那几个角色，
 * 所以每次抓到的角色覆盖，没抓到的原样留着（fetched_at 自然落后，用来判断陈旧）。
 */
import { tx } from './db.js'

const JSON_COLS = new Set(['skill_level_map', 'append_prop_ids', 'avatar_ids'])

const j = (v) => (v === undefined ? null : JSON.stringify(v))
const pj = (v) => (v ? JSON.parse(v) : null)

/* 按列名从对象里取值，JSON 列序列化 */
const rowValues = (cols, obj) => cols.map(c => (JSON_COLS.has(c) ? j(obj[c]) : obj[c] ?? null))

/* 列名只写一遍（表结构改动只需动这两张常量），ON CONFLICT 那份由这里生成。
   keepOnNull 里的列写 COALESCE：本次没给值的就保留库里旧值 —— 账号信息会分批变。 */
const upsertSql = (table, cols, key, keepOnNull = []) => {
  const set = cols
    .filter(c => !key.includes(c))
    .map(c => (keepOnNull.includes(c) ? `${c} = COALESCE(excluded.${c}, ${table}.${c})` : `${c} = excluded.${c}`))
    .join(',\n      ')
  return `INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT (${key.join(', ')}) DO UPDATE SET
      ${set}`
}

const upsert = (db, table, cols, key, row, keepOnNull) =>
  db.prepare(upsertSql(table, cols, key, keepOnNull)).run(...rowValues(cols, row))

/* ---------------- 写 ---------------- */

const ACCOUNT_COLS = ['uid', 'nickname', 'level', 'world_level', 'signature',
  'avatar_icon', 'name_card', 'fetched_at', 'payload_hash']
/* 这几项这次没给（比如只抓到角色列表）时保留旧值，剩下的直接盖 */
const ACCOUNT_KEEP = ['nickname', 'level', 'world_level', 'signature', 'avatar_icon', 'name_card']

export function saveAccount (db, acc, stamp) {
  upsert(db, 'account', ACCOUNT_COLS, ['uid'], { ...acc, fetched_at: stamp }, ACCOUNT_KEEP)
}

const AVATAR_COLS = ['uid', 'avatar_id', 'level', 'promote', 'cons', 'fetter', 'costume', 'skill_level_map',
  'weapon_item_id', 'weapon_name_hash', 'weapon_level', 'weapon_promote', 'weapon_affix', 'source', 'fetched_at']

const ARTIFACT_COLS = ['uid', 'avatar_id', 'pos', 'item_id', 'level_raw', 'star',
  'main_prop_id', 'append_prop_ids', 'name_hash', 'set_hash']

/* 存一个角色：先写角色行，再整体换掉它的 5 件圣遗物 */
export function saveAvatar (db, uid, av, stamp) {
  upsert(db, 'avatar', AVATAR_COLS, ['uid', 'avatar_id'], { ...av, uid, fetched_at: stamp })

  db.prepare('DELETE FROM artifact WHERE uid = ? AND avatar_id = ?').run(uid, av.avatar_id)
  const ins = db.prepare(`INSERT INTO artifact (${ARTIFACT_COLS.join(', ')})
    VALUES (${ARTIFACT_COLS.map(() => '?').join(', ')})`)
  for (const a of av.artifacts || []) ins.run(...rowValues(ARTIFACT_COLS, { ...a, uid, avatar_id: av.avatar_id }))
}

/* 抓取流水：成了记一笔拿到了哪些角色，失败了也记（前端据此提示「还有哪些没拿到」） */
function logFetch (db, { uid, source, stamp, ok, avatarIds = null, ttl = null, note = '' }) {
  db.prepare(`INSERT INTO fetch_log (uid, source, fetched_at, avatar_ids, ttl, ok, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, source, stamp, avatarIds === null ? null : JSON.stringify(avatarIds), ttl, ok, note || null)
}

/* 一次抓取落库：账号 + 角色们 + 流水，包在一个事务里 */
export function saveFetch (db, { uid, account, avatars, source = 'enka', stamp = new Date().toISOString(), ttl = null, note = '' }) {
  return tx(db, () => {
    if (account) saveAccount(db, { ...account, uid }, stamp)
    for (const av of avatars) saveAvatar(db, uid, av, stamp)
    logFetch(db, { uid, source, stamp, ok: 1, avatarIds: avatars.map(a => a.avatar_id), ttl, note })
    return avatars.length
  })
}

export function logFailure (db, { uid, source = 'enka', note = '', stamp = new Date().toISOString() }) {
  logFetch(db, { uid, source, stamp, ok: 0, note })
}

/* ---------------- 读 ---------------- */

export function getAccount (db, uid) {
  return db.prepare('SELECT * FROM account WHERE uid = ?').get(uid) || null
}

export function listAvatarIds (db, uid) {
  return db.prepare('SELECT avatar_id FROM avatar WHERE uid = ? ORDER BY avatar_id').all(uid).map(r => r.avatar_id)
}

/* 读一个角色，带上它的圣遗物。返回的结构就是 ingest 的入参形状，方便对拍。 */
export function loadAvatar (db, uid, avatarId) {
  const av = db.prepare('SELECT * FROM avatar WHERE uid = ? AND avatar_id = ?').get(uid, avatarId)
  if (!av) return null
  const artis = db.prepare('SELECT * FROM artifact WHERE uid = ? AND avatar_id = ? ORDER BY pos').all(uid, avatarId)
  return {
    ...av,
    skill_level_map: pj(av.skill_level_map),
    artifacts: artis.map(a => ({ ...a, append_prop_ids: pj(a.append_prop_ids) }))
  }
}

export function loadUid (db, uid, avatarIds = null) {
  const account = getAccount(db, uid)
  const ids = avatarIds && avatarIds.length ? avatarIds : listAvatarIds(db, uid)
  return { uid, account, avatars: ids.map(id => loadAvatar(db, uid, id)).filter(Boolean) }
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
