/*
 * 本地库读写 —— 上层只管拿/放，不碰 SQL 细节
 *
 * 抓取策略是「合并」不是「替换」：enka 一次只给展柜里的那几个角色，
 * 所以每次抓到的角色覆盖，没抓到的原样留着（fetched_at 自然落后，用来判断陈旧）。
 */
import { tx } from './db.js'

const j = (v) => (v === undefined ? null : JSON.stringify(v))
const pj = (v) => (v ? JSON.parse(v) : null)

/* ---------------- 写 ---------------- */

export function saveAccount (db, acc, stamp) {
  db.prepare(`
    INSERT INTO account (uid, nickname, level, world_level, signature, avatar_icon, name_card, fetched_at, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (uid) DO UPDATE SET
      nickname     = COALESCE(excluded.nickname, account.nickname),
      level        = COALESCE(excluded.level, account.level),
      world_level  = COALESCE(excluded.world_level, account.world_level),
      signature    = COALESCE(excluded.signature, account.signature),
      avatar_icon  = COALESCE(excluded.avatar_icon, account.avatar_icon),
      name_card    = COALESCE(excluded.name_card, account.name_card),
      fetched_at   = excluded.fetched_at,
      payload_hash = excluded.payload_hash
  `).run(
    acc.uid, acc.nickname ?? null, acc.level ?? null, acc.world_level ?? null,
    acc.signature ?? null, acc.avatar_icon ?? null, acc.name_card ?? null,
    stamp, acc.payload_hash ?? null
  )
}

/* 存一个角色的数据：先写角色行，再整体换掉它的 5 件圣遗物 */
export function saveAvatar (db, uid, av, stamp) {
  db.prepare(`
    INSERT INTO avatar (uid, avatar_id, level, promote, cons, fetter, costume, skill_level_map,
                        weapon_item_id, weapon_name_hash, weapon_level, weapon_promote,
                        weapon_affix, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (uid, avatar_id) DO UPDATE SET
      level            = excluded.level,
      promote          = excluded.promote,
      cons             = excluded.cons,
      fetter           = excluded.fetter,
      costume          = excluded.costume,
      skill_level_map  = excluded.skill_level_map,
      weapon_item_id   = excluded.weapon_item_id,
      weapon_name_hash = excluded.weapon_name_hash,
      weapon_level     = excluded.weapon_level,
      weapon_promote   = excluded.weapon_promote,
      weapon_affix     = excluded.weapon_affix,
      source           = excluded.source,
      fetched_at       = excluded.fetched_at
  `).run(
    uid, av.avatar_id, av.level ?? null, av.promote ?? null, av.cons ?? null,
    av.fetter ?? null, av.costume ?? null, j(av.skill_level_map),
    av.weapon_item_id ?? null, av.weapon_name_hash ?? null, av.weapon_level ?? null,
    av.weapon_promote ?? null, av.weapon_affix ?? null, av.source, stamp
  )

  db.prepare('DELETE FROM artifact WHERE uid = ? AND avatar_id = ?').run(uid, av.avatar_id)
  const ins = db.prepare(`
    INSERT INTO artifact (uid, avatar_id, pos, item_id, level_raw, star, main_prop_id,
                          append_prop_ids, name_hash, set_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const a of av.artifacts || []) {
    ins.run(uid, av.avatar_id, a.pos, a.item_id, a.level_raw, a.star, a.main_prop_id,
      j(a.append_prop_ids), a.name_hash ?? null, a.set_hash ?? null)
  }
}

/* 一次抓取落库：账号 + 角色们 + 流水，包在一个事务里 */
export function saveFetch (db, { uid, account, avatars, source = 'enka', stamp = new Date().toISOString(), ttl = null, note = '' }) {
  return tx(db, () => {
    if (account) saveAccount(db, { ...account, uid }, stamp)
    for (const av of avatars) saveAvatar(db, uid, av, stamp)
    db.prepare(`
      INSERT INTO fetch_log (uid, source, fetched_at, avatar_ids, ttl, ok, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uid, source, stamp, j(avatars.map(a => a.avatar_id)), ttl, 1, note || null)
    return avatars.length
  })
}

export function logFailure (db, { uid, source = 'enka', note = '', stamp = new Date().toISOString() }) {
  db.prepare(`
    INSERT INTO fetch_log (uid, source, fetched_at, avatar_ids, ttl, ok, note)
    VALUES (?, ?, ?, NULL, NULL, 0, ?)
  `).run(uid, source, stamp, note)
}

/* ---------------- 读 ---------------- */

export function getAccount (db, uid) {
  const row = db.prepare('SELECT * FROM account WHERE uid = ?').get(uid)
  return row || null
}

export function listAvatarIds (db, uid) {
  return db.prepare('SELECT avatar_id FROM avatar WHERE uid = ? ORDER BY avatar_id').all(uid).map(r => r.avatar_id)
}

/* 读一个角色，带上它的圣遗物。返回的结构就是 ingest 的入参形状，方便对拍。*/
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

/* 最近一次抓取流水，用来看数据新不新、哪些角色还没拿到 */
export function lastFetch (db, uid) {
  return db.prepare('SELECT * FROM fetch_log WHERE uid = ? ORDER BY id DESC LIMIT 1').get(uid) || null
}

/*
 * 库里实际用到过哪些「官方文案 key」。
 *
 * 用途：将来接多语言文案表时，不用把几十万条官方文案全导进来 ——
 * 拿这张清单去找那几百条就够了。avatar 那组是没 hash 的（enka 不给），
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
