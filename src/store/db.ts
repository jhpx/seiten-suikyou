/*
 * 本地库连接 —— 用 Node 自带的 node:sqlite，不引第三方驱动
 *
 * 为什么不用 better-sqlite3：那是个原生模块，装的时候要编译（Windows 上还要 MSVC），
 * 而本项目现在是「只有一个运行时依赖 lodash」的干净状态，测试里也有断言盯着。
 * Node 22 内置的 node:sqlite 够用了，代价是会打一条 experimental 警告 ——
 * package.json 的脚本里用 --disable-warning=ExperimentalWarning 关掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = path.join(HERE, 'schema.sql')

/*
 * ── 「库里 ↔ 程序」的**类型边界** ──────────────────────────────
 * SQLite 取出来的东西没有类型（`Record<string, SQLOutputValue>`，还带 bigint/Uint8Array）。所以凡是查库
 * 都走这三个函数：断言只发生在这一处，不散到 repo 每个查询上。默认行形状就是「一行原始值」，
 * 由模型的 fromRow 自己按列名取值；要别的形状（比如只需一两个列）就显式传类型参数。
 */
export type { DatabaseSync }

/** 取一行 → 调用方声明的行形状；没有 → undefined */
export function getRow<T = Record<string, unknown>> (db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined
}

/** 取多行 → 调用方声明的行形状数组 */
export function allRows<T = Record<string, unknown>> (db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[]
}

/*
 * 写一行。值常常来自模型的 `toValues(): unknown[]`，所以收数组、在这儿断言一次
 * （SQLite 自己不校验类型，真塞了非法值它会在运行时报错，跟以前一样）。
 */
export function runSql (db: DatabaseSync, sql: string, values: unknown[] = []): void {
  db.prepare(sql).run(...(values as SQLInputValue[]))
}

/* 结构版本。改了 schema.sql 就 +1，migrate 会把老库升上来。 */
export const SCHEMA_VERSION = 5

/*
 * 增量迁移表：MIGRATIONS[v] 把「版本 v」的库升到「版本 v+1」。
 *
 * 为什么需要这张表：schema.sql 全是 CREATE TABLE IF NOT EXISTS，对空库没问题，
 * 但表已经存在时它一列也不会加。所以老库只能靠 ALTER 逐版本补。
 * 新库不走这里 —— 空库直接跑 schema.sql 就已经是最新结构。
 *
 * ⚠️ 迁移里的 DDL 与列名是**冻结快照**：故意不读 schema.sql、也不引模型的 COLS。
 *    迁移是历史记录，写的是什么就永远做什么；跟着现码走，下次改结构时会重复加同一列。
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  /* v1 → v2：补上数据源自带的「官方文案 key」（多语言用） */
  1: (db) => {
    db.exec('ALTER TABLE artifact ADD COLUMN name_hash INTEGER')
    db.exec('ALTER TABLE artifact ADD COLUMN set_hash INTEGER')
    db.exec('ALTER TABLE avatar ADD COLUMN weapon_name_hash INTEGER')
  },
  /* v2 → v3：补上 enka 的**原始数值**（页面显示直接用它，不走 miao 的基准表重算）。
     老库这两列是 NULL —— 显示层拿不到 enka 值时会退回内核值（不炸，只是数字还是内核口径），
     重新抓一次 / 重新 ingest 就填上了。 */
  2: (db) => {
    db.exec('ALTER TABLE artifact ADD COLUMN main_stat_value REAL')
    db.exec('ALTER TABLE artifact ADD COLUMN sub_stats TEXT')
  },
  /*
   * v3 → v4：表名与领域类对齐（avatar → character），顺带删掉从没被用过的 i18n_text 死表。
   *
   * 为什么整表重建而不是 `ALTER ... RENAME`：老库的列顺序是历年 ALTER 追加出来的
   * （name_hash / set_hash / main_stat_value / sub_stats 全吊在 artifact 尾巴上、
   * weapon_name_hash 吊在 character 尾巴上），RENAME 改不了顺序。重建之后**老库与新库结构逐字一致**，
   * 那次「列顺序漂移」也就一并消掉。数据一条不丢：建新表 → 按显式列名搬 → 丢旧表。
   *
   * 关 foreign_keys 是为了让 RENAME 不去改写 artifact 的 REFERENCES 子句（两张表反正都要丢掉重建）。
   */
  3: (db) => {
    db.exec('PRAGMA foreign_keys = OFF')
    tx(db, () => db.exec(`
      ALTER TABLE artifact RENAME TO _old_artifact;
      ALTER TABLE avatar   RENAME TO _old_avatar;

      CREATE TABLE character (
        uid              INTEGER NOT NULL,
        avatar_id        INTEGER NOT NULL,
        level            INTEGER,
        promote          INTEGER,
        cons             INTEGER,
        fetter           INTEGER,
        costume          INTEGER,
        skill_level_map  TEXT,
        weapon_item_id   INTEGER,
        weapon_name_hash INTEGER,
        weapon_level     INTEGER,
        weapon_promote   INTEGER,
        weapon_affix     INTEGER,
        source           TEXT    NOT NULL,
        fetched_at       TEXT    NOT NULL,
        PRIMARY KEY (uid, avatar_id)
      );

      CREATE TABLE artifact (
        uid             INTEGER NOT NULL,
        avatar_id       INTEGER NOT NULL,
        pos             INTEGER NOT NULL,
        item_id         INTEGER NOT NULL,
        level_raw       INTEGER NOT NULL,
        star            INTEGER NOT NULL,
        main_prop_id    INTEGER NOT NULL,
        append_prop_ids TEXT    NOT NULL,
        main_stat_value REAL,
        sub_stats       TEXT,
        name_hash       INTEGER,
        set_hash        INTEGER,
        PRIMARY KEY (uid, avatar_id, pos),
        FOREIGN KEY (uid, avatar_id) REFERENCES character (uid, avatar_id) ON DELETE CASCADE
      );

      INSERT INTO character (uid, avatar_id, level, promote, cons, fetter, costume, skill_level_map,
        weapon_item_id, weapon_name_hash, weapon_level, weapon_promote, weapon_affix, source, fetched_at)
        SELECT uid, avatar_id, level, promote, cons, fetter, costume, skill_level_map,
          weapon_item_id, weapon_name_hash, weapon_level, weapon_promote, weapon_affix, source, fetched_at
        FROM _old_avatar;

      INSERT INTO artifact (uid, avatar_id, pos, item_id, level_raw, star, main_prop_id, append_prop_ids,
        main_stat_value, sub_stats, name_hash, set_hash)
        SELECT uid, avatar_id, pos, item_id, level_raw, star, main_prop_id, append_prop_ids,
          main_stat_value, sub_stats, name_hash, set_hash
        FROM _old_artifact;

      DROP TABLE _old_artifact;
      DROP TABLE _old_avatar;
      DROP TABLE IF EXISTS i18n_text;

      CREATE INDEX IF NOT EXISTS idx_character_uid ON character (uid);
      CREATE INDEX IF NOT EXISTS idx_artifact_uid  ON artifact (uid, avatar_id);
    `))
    db.exec('PRAGMA foreign_keys = ON')
  },
  /*
   * v4 → v5：武器从 character 里拆出来，独立成 weapon 表（模型层同步：Weapon 的字段回归、Character 不再拼三段）。
   *
   * 这里不用整表重建 —— 只是「挪走 5 列 + 建一张表」，列的顺序本来就不关心（两边都按显式列名读写），
   * 所以 `DROP COLUMN` 就够了。武器行**每个角色都写**（没装备就是全 NULL），所以这里直接对着 character 全量搬。
   */
  4: (db) => {
    tx(db, () => db.exec(`
      CREATE TABLE weapon (
        uid        INTEGER NOT NULL,
        avatar_id  INTEGER NOT NULL,
        item_id    INTEGER,
        name_hash  INTEGER,
        level      INTEGER,
        promote    INTEGER,
        affix      INTEGER,
        PRIMARY KEY (uid, avatar_id),
        FOREIGN KEY (uid, avatar_id) REFERENCES character (uid, avatar_id) ON DELETE CASCADE
      );

      INSERT INTO weapon (uid, avatar_id, item_id, name_hash, level, promote, affix)
        SELECT uid, avatar_id, weapon_item_id, weapon_name_hash, weapon_level, weapon_promote, weapon_affix
        FROM character;

      ALTER TABLE character DROP COLUMN weapon_item_id;
      ALTER TABLE character DROP COLUMN weapon_name_hash;
      ALTER TABLE character DROP COLUMN weapon_level;
      ALTER TABLE character DROP COLUMN weapon_promote;
      ALTER TABLE character DROP COLUMN weapon_affix;
    `))
  }
}

export function openDb (file = ':memory:'): DatabaseSync {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate (db: DatabaseSync): boolean {
  const cur = getRow<{ user_version?: number }>(db, 'PRAGMA user_version')?.user_version ?? 0
  if (cur >= SCHEMA_VERSION) return false

  if (cur === 0) {
    /* 空库：schema.sql 就是最新结构，一次到位，不用再逐版本 ALTER */
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
  } else {
    for (let v = cur; v < SCHEMA_VERSION; v++) {
      if (!MIGRATIONS[v]) throw new Error(`缺 v${v} → v${v + 1} 的迁移，降级处理会丢数据，拒绝启动`)
      MIGRATIONS[v](db)
    }
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return true
}

/* 一个小工具：把一组写操作包在事务里。出错回滚，不留半截数据。 */
export function tx<T> (db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const ret = fn()
    db.exec('COMMIT')
    return ret
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
