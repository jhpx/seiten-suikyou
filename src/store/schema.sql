-- 星天水镜 本地库结构（SQLite）
--
-- 设计要点（详见 docs/DESIGN-DATA-MODEL.md）：
--   1. 只存「稳定的数字 id」，不存中文名。名字是渲染结果，中文只是 miao 的一种语言，
--      存进去就把多语言的门焊死了。
--   2. 圣遗物只存原始 prop id（main_prop_id / append_prop_ids），
--      绝不存解析后的属性值 —— 解析是 miao 内核的活，我们跟着它走。
--   3. level 存原始值，读的时候按 source 归一化。各数据源对 level 基数的假设不一样
--      （enka 是 1 基），万一将来发现推断错了，改一行代码就能全量重算，不用重新抓。
--   4. append_prop_ids 必须保序、保重复：内核就是靠「同一个 id 出现几次」算
--      「词条数 / 副词条有效率」的，去重就废了。
--   5. 除了「id」，还额外存「官方文案 key」（*_hash 三列）。它不是名字，是名字的 id ——
--      游戏文案表里 nameTextMapHash → 各语言文本，一个 key 覆盖全部语言。
--      enka 白送这个字段，我们存下来，将来做多语言就不用再抓一遍（也没有额外翻译工作）。
--      注意：角色名 enka **不给** hash（avatarInfo 里只有 avatarId），角色的多语言得另配映射。

CREATE TABLE IF NOT EXISTS account (
  uid          INTEGER PRIMARY KEY,   -- 游戏 UID，本来就是数字
  nickname     TEXT,
  level        INTEGER,
  world_level  INTEGER,
  signature    TEXT,
  avatar_icon  INTEGER,               -- profilePicture.avatarID，用 id 不用图名
  name_card    INTEGER,
  fetched_at   TEXT    NOT NULL,
  payload_hash TEXT                   -- 原始响应指纹，用来判断「内容有没有变」
);

-- 一个 uid 多行。fetched_at 落后 = 这个角色的数据陈旧（展柜是子集，得慢慢攒）
CREATE TABLE IF NOT EXISTS avatar (
  uid             INTEGER NOT NULL,
  avatar_id       INTEGER NOT NULL,   -- avatarId，角色的稳定数字 id
  level           INTEGER,
  promote         INTEGER,
  cons            INTEGER,            -- 命座数
  fetter          INTEGER,            -- 好感等级
  costume         INTEGER,            -- 0 = 无皮肤
  skill_level_map TEXT,               -- JSON {天赋id: 等级}，不是名字，是 id
  weapon_item_id  INTEGER,            -- 存 itemId，不存武器名
  weapon_name_hash INTEGER,           -- 武器名的官方文案 key（= enka 的 flat.nameTextMapHash）
  weapon_level    INTEGER,
  weapon_promote  INTEGER,
  weapon_affix    INTEGER,            -- 精炼等级，1 = 精1
  source          TEXT    NOT NULL,   -- 'enka' | 'mys' | ...（多数据源预留）
  fetched_at      TEXT    NOT NULL,
  PRIMARY KEY (uid, avatar_id)
);

-- 每个角色固定 5 行。pos：1花 2羽 3沙 4杯 5头
CREATE TABLE IF NOT EXISTS artifact (
  uid             INTEGER NOT NULL,
  avatar_id       INTEGER NOT NULL,
  pos             INTEGER NOT NULL,
  item_id         INTEGER NOT NULL,   -- 部位物品 id（5 位数，前两位定套装）
  level_raw       INTEGER NOT NULL,   -- 原样存，读时按 source 归一化
  star            INTEGER NOT NULL,   -- 星级
  main_prop_id    INTEGER NOT NULL,   -- 主词条 prop id
  append_prop_ids TEXT    NOT NULL,   -- JSON 数组，保序保重复
  name_hash       INTEGER,            -- 这一件圣遗物名字的官方文案 key
  set_hash        INTEGER,            -- 套装名字的官方文案 key（同套装 5 件都一样）
  PRIMARY KEY (uid, avatar_id, pos),
  FOREIGN KEY (uid, avatar_id) REFERENCES avatar (uid, avatar_id) ON DELETE CASCADE
);

-- 抓取流水。enka 只给展柜子集，所以「哪次拿到了哪些角色」得留痕，
-- 前端才能告诉用户「还有哪些角色没数据、去展柜放一下」
CREATE TABLE IF NOT EXISTS fetch_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        INTEGER NOT NULL,
  source     TEXT    NOT NULL,
  fetched_at TEXT    NOT NULL,
  avatar_ids TEXT,                    -- JSON 数组：本次拿到的角色
  ttl        INTEGER,                 -- 数据源给的缓存秒数
  ok         INTEGER NOT NULL,
  note       TEXT
);

-- 多语言文案。中文可以直接吃 miao 现成的，非中文往这里塞。
-- id 用哪个 id 由 kind 决定：
--   'text'            → id = 官方文案 key（*_hash），一个 key 覆盖全部语言，首选
--   'avatar'          → id = avatarId（enka 不给角色名的 hash，只能自己按 avatarId 映射）
--   'stat'            → id = prop id
CREATE TABLE IF NOT EXISTS i18n_text (
  kind   TEXT    NOT NULL,            -- 'text' | 'avatar' | 'stat'
  id     INTEGER NOT NULL,
  locale TEXT    NOT NULL,            -- 'zh-CN' | 'en' | 'ja' | ...
  text   TEXT    NOT NULL,
  PRIMARY KEY (kind, id, locale)
);

CREATE INDEX IF NOT EXISTS idx_avatar_uid   ON avatar (uid);
CREATE INDEX IF NOT EXISTS idx_artifact_uid ON artifact (uid, avatar_id);
