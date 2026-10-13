-- 星天水镜 本地库结构（SQLite）
--
-- 设计要点（详见 docs/DESIGN-DATA-MODEL.md）：
--   1. 只存「稳定的数字 id」，不存中文名。名字是渲染结果，中文只是 miao 的一种语言，
--      存进去就把多语言的门焊死了。
--   2. 圣遗物只存原始 prop id（main_prop_id / append_prop_ids），
--      绝不存解析后的属性值 —— 解析是 miao 内核的活，我们跟着它走。
--   3. level 存原始值（enka 是 1 基，5★ 满级 21），出口组装 profile 时减 1 换成内核的 0 基。
--      万一将来发现推断错了，改那一行就能全量重算，不用重新抓。
--   4. append_prop_ids 必须保序、保重复：内核就是靠「同一个 id 出现几次」算
--      「词条数 / 副词条有效率」的，去重就废了。
--   5. 除了「id」，还额外存「官方文案 key」（*_hash 三列）。它不是名字，是名字的 id ——
--      游戏文案表里 nameTextMapHash → 各语言文本，一个 key 覆盖全部语言。
--      enka 白送这个字段，我们存下来，将来做多语言就不用再抓一遍（也没有额外翻译工作）。
--      注意：角色名 enka **不给** hash（avatarInfo 里只有 avatarId），角色的多语言得另配映射。
--
-- 表名与 src/domain 的类名一一对应：account ↔ Account、character ↔ Character、
-- weapon ↔ Weapon、artifact ↔ Artifact。
-- 列名保持**上游/游戏**的叫法（avatar_id 就是角色 id、item_id 就是物品 id）——
-- id 是外部世界的标识符，跟着类名改反而会丢掉「这个值从哪来」这条线。
-- ⚠️ 所以 avatar_id 不叫 character_id：enka 的 avatarInfoList[].avatarId 与官方数据
--    AvatarExcelConfigData 都把角色称作 **Avatar**，avatarId 就是它们给的字段名。
--    表名跟我们的类（Character，也是 miao 的叫法），列名跟数据来源（Avatar，enka/官方的叫法）。

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
CREATE TABLE IF NOT EXISTS character (
  uid             INTEGER NOT NULL,
  avatar_id       INTEGER NOT NULL,   -- avatarId，角色的稳定数字 id
  level           INTEGER,            -- 等级（enka 1 基）
  promote         INTEGER,            -- 「突破等级」0~6（不是等级！它决定等级上限 20/40/…/90）
  cons            INTEGER,            -- 命座数
  fetter          INTEGER,            -- 好感等级
  costume         INTEGER,            -- 0 = 无皮肤
  skill_level_map TEXT,               -- JSON {天赋id: 等级}，不是名字，是 id
  source          TEXT    NOT NULL,   -- 'enka' | 'mys' | ...（多数据源预留）
  fetched_at      TEXT    NOT NULL,
  PRIMARY KEY (uid, avatar_id)
);

-- 一个角色一行（1:1）。独立成表是因为它跟圣遗物一样「挂在角色下的一摊数据」，
-- 各表各管自己的列，character 那一行就不用把武器的五列夹在中间（列名也就不用加 weapon_ 前缀）。
-- 没装备武器也是**一行全 NULL**，不是没有行 —— 这样「换了 / 卸了武器」不会留下上一把的旧行。
CREATE TABLE IF NOT EXISTS weapon (
  uid        INTEGER NOT NULL,
  avatar_id  INTEGER NOT NULL,
  item_id    INTEGER,                 -- 武器物品 id；NULL = 没装备
  name_hash  INTEGER,                 -- 武器名的官方文案 key（= enka 的 flat.nameTextMapHash）
  level      INTEGER,
  promote    INTEGER,                 -- 「突破等级」0~6（来自 enka 的 weapon.promoteLevel）
  affix      INTEGER,                 -- 精炼等级，1 = 精1
  PRIMARY KEY (uid, avatar_id),
  FOREIGN KEY (uid, avatar_id) REFERENCES character (uid, avatar_id) ON DELETE CASCADE
);

-- 每个角色固定 5 行。pos：1花 2羽 3沙 4杯 5头
CREATE TABLE IF NOT EXISTS artifact (
  uid             INTEGER NOT NULL,
  avatar_id       INTEGER NOT NULL,
  pos             INTEGER NOT NULL,
  item_id         INTEGER NOT NULL,   -- 部位物品 id（5 位数，前两位定套装）
  level_raw       INTEGER NOT NULL,   -- enka 原值（1 基）；内核要 0 基，出口处减 1
  star            INTEGER NOT NULL,   -- 星级
  main_prop_id    INTEGER NOT NULL,   -- 主词条 prop id（喂内核算分用的数字 id）
  append_prop_ids TEXT    NOT NULL,   -- JSON 数组，保序保重复
  -- 下面两列是 enka 的**原始数值**（页面显示直接用它，不经过 miao 的基准表重算）：
  -- 内核自己的 attrIdMap 基准有 float 误差（满级花主词条 4778.6 而游戏真值 4780），
  -- 而 enka 的 flat 里本来就带着官方算好的 statValue。两处口径各司其职：
  -- 算分走 main_prop_id / append_prop_ids（内核要靠 id 的重复次数算词条数），
  -- 显示走 main_stat_value / sub_stats（要跟游戏一模一样）。
  main_stat_value REAL,               -- 主词条数值（enka flat.reliquaryMainstat.statValue）
  sub_stats       TEXT,               -- JSON [{prop,value}]，enka flat.reliquarySubstats（已合并，保序）
  name_hash       INTEGER,            -- 这一件圣遗物名字的官方文案 key
  set_hash        INTEGER,            -- 套装名字的官方文案 key（同套装 5 件都一样）
  PRIMARY KEY (uid, avatar_id, pos),
  FOREIGN KEY (uid, avatar_id) REFERENCES character (uid, avatar_id) ON DELETE CASCADE
);

-- 抓取流水。enka 只给展柜子集，所以「哪次拿到了哪些角色」得留痕，
-- 前端才能告诉用户「还有哪些角色没数据、去展柜放一下」。
-- 这张表不属于领域模型（没有 Character/Artifact 那样的类）—— 它是审计流水，
-- 由 store/repo.ts 直接读写，只按时间查、只增不改。
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

-- 多语言文案**不落库**：角色 / 武器 / 圣遗物 / 套装 / 词条名走 vendor/i18n/names.json
-- （tools/sync_i18n.py 从官方 TextMap 生成），进程启动时读进内存查表。

CREATE INDEX IF NOT EXISTS idx_character_uid ON character (uid);
CREATE INDEX IF NOT EXISTS idx_artifact_uid  ON artifact (uid, avatar_id);
