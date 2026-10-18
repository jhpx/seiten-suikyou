/*
 * 库结构 —— drizzle 表定义，也是**唯一的结构来源**（没有 schema.sql，没有迁移目录）。
 *
 * 进程启动时按这份定义现算 CREATE TABLE 并执行（见 ddl.ts）：空库自动建表，内存库（测试）同一个路径。
 * 老库缺列时按 db.ts 的 SCHEMA_VERSION 报错要求删库重抓。
 *
 * 三条不变量（改错了分就变）：
 *   ① 只存数字 id，不存名字 —— 名字是多语言的渲染结果。
 *   ② append_prop_ids 保序保重复 —— 内核靠「同一个 id 出现几次」算词条数。
 *   ③ level 存 enka 原值（1 基），出口组装 profile 时才减 1。
 *
 * 表名 = 领域类名（account/character/weapon/artifact），列名跟游戏/上游叫法
 * （avatar_id 就是角色 id：enka 与官方都把角色叫 Avatar）。
 */
import { sqliteTable, integer, text, real, primaryKey, index, foreignKey } from 'drizzle-orm/sqlite-core'

/* 账号信息是分批变的（有时只抓到角色列表、没抓到详情），写入时这些列要「本次没值就留旧值」 */
export const account = sqliteTable('account', {
  uid: integer('uid').primaryKey(),
  nickname: text('nickname'),
  level: integer('level'),
  worldLevel: integer('world_level'),
  signature: text('signature'),
  avatarIcon: integer('avatar_icon'),   // profilePicture.avatarID，存 id 不存图名
  nameCard: integer('name_card'),
  fetchedAt: text('fetched_at').notNull(),
  payloadHash: text('payload_hash')     // 原始响应指纹，用来判断「内容有没有变」
})

/* 一个 uid 多行。fetched_at 落后 = 这个角色的数据陈旧（展柜是子集，得慢慢攒） */
export const character = sqliteTable('character', {
  uid: integer('uid').notNull(),
  avatarId: integer('avatar_id').notNull(),
  level: integer('level'),
  promote: integer('promote'),          // 突破等级 0~6（不是等级！它决定上限 20/40/…/90）
  cons: integer('cons'),
  fetter: integer('fetter'),
  costume: integer('costume'),          // 0 = 无皮肤
  skillLevelMap: text('skill_level_map', { mode: 'json' }).$type<Record<string, number>>(),
  source: text('source').notNull(),     // 'enka' | 'mys' | …（多数据源预留）
  fetchedAt: text('fetched_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.uid, t.avatarId] }),
  index('idx_character_uid').on(t.uid)
])

/* 一个角色一行（1:1）。没装备也是**一行全 NULL**，不是没有行 —— 否则卸了武器会留下上一把的旧行 */
export const weapon = sqliteTable('weapon', {
  uid: integer('uid').notNull(),
  avatarId: integer('avatar_id').notNull(),
  itemId: integer('item_id'),
  nameHash: integer('name_hash'),       // 武器名的官方文案 key（一个 key 覆盖全部语言）
  level: integer('level'),
  promote: integer('promote'),
  affix: integer('affix')               // 精炼等级 1~5
}, (t) => [
  primaryKey({ columns: [t.uid, t.avatarId] }),
  foreignKey({ columns: [t.uid, t.avatarId], foreignColumns: [character.uid, character.avatarId] })
    .onDelete('cascade')
])

/* 每个角色固定 5 行，pos：1花 2羽 3沙 4杯 5头 */
export const artifact = sqliteTable('artifact', {
  uid: integer('uid').notNull(),
  avatarId: integer('avatar_id').notNull(),
  pos: integer('pos').notNull(),
  itemId: integer('item_id').notNull(),
  levelRaw: integer('level_raw').notNull(),   // enka 原值（1 基）；内核要 0 基，出口处减 1
  star: integer('star').notNull(),
  mainPropId: integer('main_prop_id').notNull(),
  appendPropIds: text('append_prop_ids', { mode: 'json' }).$type<number[]>().notNull(),
  /* 下面两列是 enka 的**原始数值**，只给显示：内核的基准表有 float 误差
     （满级花主词条算成 4,778.6，真值 4,780）。算分仍走上面两个 id 列。 */
  mainStatValue: real('main_stat_value'),
  subStats: text('sub_stats', { mode: 'json' }).$type<Array<{ prop: string, value: number | null }>>(),
  nameHash: integer('name_hash'),
  setHash: integer('set_hash')
}, (t) => [
  primaryKey({ columns: [t.uid, t.avatarId, t.pos] }),
  foreignKey({ columns: [t.uid, t.avatarId], foreignColumns: [character.uid, character.avatarId] })
    .onDelete('cascade'),
  index('idx_artifact_uid').on(t.uid, t.avatarId)
])

/* 抓取流水：不成、败都记。不属于领域模型（没有对应类），只按时间查、只增不改。
   前端据此说「还有哪些角色没数据、去展柜放一下」。 */
export const fetchLog = sqliteTable('fetch_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uid: integer('uid').notNull(),
  source: text('source').notNull(),
  fetchedAt: text('fetched_at').notNull(),
  avatarIds: text('avatar_ids', { mode: 'json' }).$type<number[]>(),
  ttl: integer('ttl'),
  ok: integer('ok').notNull(),          // 1 成功 / 0 失败（失败行 note 带错误原文）
  note: text('note')
})
