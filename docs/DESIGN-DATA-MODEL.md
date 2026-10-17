# 数据模型设计：enka → 缓存 → miao 内核

> 结论先行：**中间模型要建，但位置要从「计算路径」挪到「存储契约」和「展示出口」。**
>
> | 位置 | 要不要模型 | 为什么 |
> |---|---|---|
> | 计算路径（喂给内核算分的那份 profile） | ❌ 不要，必须就是 miao 的形状 | 见 §3，插一层会丢信息、改数值口径 |
> | 存储层（DB 缓存） | ✅ 必须有 | enka 只给展柜子集、要跨多次抓取累积、要支持多用户 |
> | 展示层（i18n） | ✅ 必须有 | miao 零多语言能力（§1.2） |
>
> 实现落在 `src/adapter/`（ingest / materialize / panel-check）、`src/store/`（schema / db / repo）、
> `src/cli/score.ts`（端到端命令行）。本文记录的是**为什么这么设计**，代码结构看 README。

---

## 1. 三条硬约束（都是实测/源码证据，不是推测）

### 1.1 enka 只给「展柜子集」，且自带 TTL

**enka 一次不给全角色**，只返回玩家放进游戏内角色展柜的那些（数量由展柜决定，实测约 8–12 位）。
一个正常玩家有 20–40+ 角色，所以**必须多次抓取、累积存储**。

上游 miao 自己就是这么做的，两处证据：

```js
// models/serv/api/EnkaApi.js
updatePlayer (player, data) {
  player.setBasicData(Data.getData(data.playerInfo, 'name:nickname,face:profilePicture.avatarID,...'))
  lodash.forEach(data.avatarInfoList, (ds) => {      // ← 逐个合并，不是一次性拿全
    let ret = EnkaData.setAvatar(player, ds)
    if (ret) player._update.push(ret.id)             // ← 记录本次增量
  })
},

// 获取冷却时间
cdTime (data) {
  return data.ttl || 60                              // ← enka 明确告诉你这份数据能缓存多久
}
```

`cdTime` 用 `data.ttl` 说明 enka 有官方缓存语义：**到期前别硬刷**。

### 1.2 miao 没有多语言能力

- `resources/` 下只有 `meta-gs` / `meta-sr`，**全部是中文资源**；角色目录名本身就是中文（`character/胡桃/`）。
- 权重表、套装缩写表、武器特判表**全部用中文名当键**：`usefulAttr[char.name]`、`setAbbr['炽烈的炎之魔女']`、`weaponCfg['护摩之杖']`。
- `resources/meta-gs/character/alias.js` 里确实有 `琴: 'Jean,团长,代理团长...'`、`丽莎: 'Lisa,...'` 这类英文，
  但**只用于输入匹配**（用户打英文名能查到角色），且不完整——`空`、`旅行者` 就没有对应英文。
- 整个 miao-plugin **零 `TextMapHash` 使用**。

结论：任何「显示英文/日文名」的需求 miao 都提供不了，展示层必须自建多语言表。

### 1.3 面板属性 `attr` 得我们自己算（内核要读，但数据源不给）

这是实现阶段才暴露出来的一条：

- miao 的 enka 适配器 `EnkaData.js` **不填 `attr`** —— 它只组装圣遗物的**原始 prop id**，不解析属性。
- 但 miao 的角色规则里**有 56/76 个文件读 `profile.attr`**（例：`resources/meta-gs/character/胡桃/artis.js`
  里 `attr.cpct < 15 && attr.cdmg > 280` 判断核爆面板）。
- 所以 `attr` 不能指望数据源，必须调内核自己的算法：`Attr.create(profile).calc()`（`models/attr/Attr.js`）。
  它需要角色元数据 + 武器元数据 → 这也是 sync 清单里必须带上 `resources/meta-gs/weapon/` 和 `models/attr/` 的原因。

**反过来这给了一个近乎完美的验收手段**：enka 的 `avatarInfo.fightPropMap` 是游戏客户端自己算出来的最终面板，
是「标准答案」。拿它和 `Attr.create().calc()` 的结果一比，整条链路（角色等级/突破 + 武器 + 圣遗物主副词条）
有没有翻错一眼就看出来。这就是 `src/adapter/panel-check.ts`（§6）。

---

## 2. 三层结构

```
enka 原始响应 (JSON)
      │
      │  ① ingest：把响应组装成领域模型（见 §2.1），挑字段与映射交给模型的 ofEnka；
      │            原始 id 原样保留、记 source、带走官方文案 key
      ▼
┌─────────────────────────────────────────────────────────┐
│  ② canonical store（DB，与语言无关）                     │
│     主键全部是稳定数字 id：                                │
│     uid / avatarId / itemId / propId / *TextMapHash      │
└─────────────────────────────────────────────────────────┘
      │
      ├─ ③ materialize → miao profile（id → miao 的中文名与对象）→ ArtisMark → 分数
      ├─ ④ localize    → display DTO（id → 目标语言文本 + 图标）→ 前端
      └─ ⑤ panel-check → 拿游戏面板对拍 ③ 的结果，验证翻对了没有
```

**核心原则：存储层存 id，不存名字。**

理由很直接：`avatarId` / `itemId` / `propId` / `setId` / `TextMapHash` 都是游戏内的**稳定数字标识**，
且**天然与语言无关**；而「胡桃」「护摩之杖」只是 miao 这一种语言的渲染结果。把中文名写进存储，等于把 i18n 的门焊死。

名字在两条出口各自解析，方向都是 **id → 文本**：

| 出口 | 解析成什么 | 数据来自 |
|---|---|---|
| ③ 计算 | miao 的中文名（**必须**，内核拿中文名查表） | miao 自己的 meta |
| ④ 展示 | 用户语言的名字 | 官方文案表 / 我们自建的 i18n 表（§5） |

### 2.1 领域模型（`src/domain/`）

「存储契约」不是一堆列名，而是四个模型：

| 模型 | 对应 | 说明 |
|---|---|---|
| `Account` | account 行 + 它名下的角色 | 聚合根；账号信息分批变，写库时对「本次没给值」的列用 COALESCE 保留旧值 |
| `Character` | character 行 + 武器 + 5 件圣遗物 | 玩家实例（练成什么样），与 miao 的同名「图鉴 + 内核」模型不是一回事 |
| `Weapon` | weapon 行 | 1:1 独立落表，键同 artifact 的 `(uid, avatar_id)` —— 列名因此不用带 `weapon_` 前缀，`Character` 也不必把列拆成三段拼 |
| `Artifact` | artifact 行 | 保证 `appendPropIds` 保序保重复（内核靠它算词条数） |

每个模型只声明**一张**「列名 ↔ 领域字段」对照表（`FIELDS`，工具在 `src/domain/fields.ts`）：
`COLS`（拼 SQL 的列名清单）/ `toValues`（写库取值）/ `fromRow`（读行入参）全由它派生。
加一列因此只动两处 —— 模型的 `FIELDS` + `schema.sql`（DDL 省不掉）。以前这三份是分开写的、
顺序一致只靠注释约束；`test/pipeline.ts` 现在把「空库的列 == 模型 COLS」断言了，写歪即红。
`ingest` 只做编排，「enka 长什么样 → 模型」的映射交给各模型的 `ofEnka`。

⚠️ 模型**不许引外层**（`test/arch.ts` 第 7 节）—— 只许两种 import：同目录的 `./xxx.ts`，
以及更底一层的共用件 `../shared/util.ts`。不许 import store / adapter / view / miao / 三方包。
一旦它反过来依赖存储或数据源，就退化成「跟着 DB 列名走的数据袋」，那正是它要解决的问题。
为此 `payload_hash` 的算法（要 `node:crypto`）留在适配层，模型只负责把它存下来。

`src/shared/util.ts` 是**跨层的小工具**（`num` 脏值收敛、库里 JSON 文本列的编解码、
`parseArgs`）：不属于任何一层，所以谁都能引它；反过来它谁也不引（连 `node:` 都不用），
否则会把运行环境顺着它带进领域层。只服务单层的工具不进这儿（`decRound` 只在展示层用，
就留在 `view/shape.ts`）。

**字段类型不变量（「获取数据时转一次」）**：每个模型的 constructor 是**类型归一的唯一入口** ——
数字语义的标量字段进对象时一律 `num()` 收敛成 `number | null`。于是 `ofEnka`（外部响应）与
`fromRow`（库行）**都只做字段名映射、不再各自转换**；下游（materialize / view / cli）**信任**这个
类型、不再重复 `num`。`num` 全项目只有两处合法用法：① 模型 constructor；② 出口解析**内核给的
字符串数字**（`Format` 出的 "4,778.6"，那是另一条来源）。守卫在 `test/pipeline.ts` §2b ——
⚠️ 写这类测试别拿数值列（REAL/INTEGER）塞字符串：SQLite 的**类型亲和性**会自己转成数字，
测出来的是 SQLite 不是我们；要用 TEXT 列里的 JSON（`sub_stats`）或直接造 row 对象。

---

## 3. 为什么不违反「计算路径不要中间模型」的结论

上一轮反对的是**在计算路径上插一层「解析后的属性」模型**。这个反对依然完全成立，三条理由：

1. **信息会丢**：miao 的「副词条条数 `upNum`」和「有效率 `eff`」来自 `appendPropIdList` 里
   同一条目**重复出现的次数**（`ArtisAttr.getAttr` 里 `tmp[key].upNum++`）。
   任何「聚合去重」的模型都会把它抹掉——实测走聚合值那条路，详情里这两项会变成 `0` 和 `-`。
   注意：多次 roll 的 prop id **可能并不相同**（id 里编了数值档位），所以按 key 分组计数才对，
   按 id 去重数个数是错的——`test/pipeline.ts` 专门有一条断言守这个。
2. **数值口径会打架**：miao 完全不信外部给的数值，主词条按 `attrCfg.value × (1.2 + 0.34×level) × posEff × starEff` 自己算，
   副词条按自己 `attrIdMap` 的每 roll 值累加。外面先解析一遍只是白做，还可能因为浮点/Decimal 口径不同算出不同的分。
3. **要逐字一致**：项目的验收标准是输出与 miao 逐字一致，那推导就必须让 miao 自己做完。

现在这层「canonical store」是**存储契约**，不是转换 hop：它保留原始 id、不重复任何数值推导。
所以 ③ 那一步仍然是「id 原样交给 miao、miao 自己解析」，**分数不受影响**。

一句话区分：

- ❌ 上一次被否掉的：`enka → 解析成属性值 → 再拼回 miao profile`（纯浪费 + 有损）
- ✅ 现在建成的：`enka → 归一化的原始 id（存起来）→ 按需原样交给 miao`

---

## 4. Schema

权威定义在 `src/store/schema.sql`（本文不再复制一份，避免两处漂移）。设计上值得说的几点：

- **`level_raw` + `source`，而不是归一化后的 level。**
  四个上游对 level 基数的假设不一致：`EnkaData` 做 `-1`，`MysPanelData` / `EnkaHSRApi` / `HomoApi` 都不做。
  而 `EnkaData` 里的 `Math.min(20, (re.level ?? 0) - 1)` —— 那个 **20 的上限只在「1 基」假设下才有意义**
  （0 基的话根本不会超 20），所以 enka 给的是 1 基（满级 = 21）。
  存原始值 + 记基数，将来若推断错了，改 `materialize` 里那一行减 1 就能全量重算，**不用重新抓 enka**。
  实测锚点：迪卢克满级 5★ 暴击伤害冠解析出 `62.2%`（若基数错会得 59.5%）。
- **`append_prop_ids` 保序保重复**：这是「词条数 / 副词条有效率」的唯一来源，不能去重。
- **技能等级存 `skill_level_map` 原始 JSON**（`{天赋id: 等级}`），不在 ingest 阶段拆成 `elem` / `talent_a/e/q`。
  为什么：`天赋id → 是普攻还是战技` 这个对应关系在 **miao 的元数据**里（`char.meta.talentId`），
  我们在这儿拆就等于自己维护一份游戏数据 —— 拆解放在 materialize（§附），只在算分那一刻做。
- **不存面板属性**（`fightPropMap` / 解析后的 attr 值）。理由见 §3；代价是 `--check` 只能对着原始响应做，
  没法对着库做——这是有意换来的。
- **分数不默认落库**。miao 每次 sync 权重都可能变，缓存的分立刻过期。
  要缓存就缓存成 `(uid, avatar_id, miao_version)` 三元组，sync 后自动失效。

### 4.1 结构保证（不做增量迁移）

`db.ts` 的 `openDb` 打开库时直接把 `schema.sql` 跑一遍——`CREATE TABLE IF NOT EXISTS`：空库建表就位，
已存在的库表在就不碰，不破坏旧数据。`SCHEMA_VERSION` 只作当前结构代次的戳记（每次打开写进
`PRAGMA user_version`），用来比对「库是不是比代码旧」。

不做「增量迁移表」：数据全部可从 enka 重新抓取，老库没必要逐版本 `ALTER` 升级。因此改了 `schema.sql`
后，老库不会自动长出新列——这种库删掉 db 文件、重启后重新抓取即可。打开到一个比当前代次旧的库时
（说明 `schema.sql` 改过而库没重建），直接抛错提示删库重抓，而不是静默带着缺列的库跑（插入/读取
新列时才崩，更难查）。

`schema.sql` 与模型的 `FIELDS` 两份列定义必须一致——`test/pipeline.ts` 用「空库的列 == 模型 COLS」
守住这一条，写歪即红。加一列只动两处：模型的 `FIELDS` + `schema.sql`。

---

## 5. i18n 的落地要点

### 5.1 主键首选：官方文案 key（TextMapHash）—— 已确认真实响应里就有

**上一版这里还是「待确认」，现在已经拿真实响应确认了**：enka 的 `avatarInfoList[].equipList[].flat` 里带着

```
flat.nameTextMapHash       // 这件圣遗物 / 这把武器的名字
flat.setNameTextMapHash    // 套装名（同套装 5 件共用同一个值）
```

（实测：uid 101242308 的响应里共 132 处 `TextMapHash` 字段。）

这是**官方全语言文案表的主键**——游戏本体的 `TextMap` 资源就是 `hash → 各语言文本`。
所以对圣遗物/武器名，我们**不需要自己翻译、也不需要自己维护 id→名字映射**：
存下 hash，将来挂上官方文案表就一次性拿到全部语言。

因此 `artifact.name_hash` / `artifact.set_hash` / `weapon.name_hash` 三列是**现在就必须存的**：
enka 正好白给，丢了以后要补只能重抓（我们做缓存的全部意义就是不重抓）。它仍然符合「存 id 不存名字」——
hash 是名字的 id。

`--keys` 把库里实际用到过的 key 列出来：将来接文案表时只要那几百条，不必把几十万条官方文案全导进来。

### 5.2 角色名是个例外：enka 不给

`avatarInfo` 里**只有 `avatarId`，没有 `nameTextMapHash`**（实测确认）。所以角色名的多语言必须另配一份
`avatarId → 文案 key` 映射（这份映射从官方数据表里来，是静态的，一次配好即可）。

文案**不落库**：`tools/sync_i18n.py` 把官方 TextMap 提取成 `vendor/i18n/names.json`
（hash / avatarId / itemId / setId → 各语言文本），进程启动时读进内存查表 —— 多语言是展示层的事，
数据层只存 id。schema 里曾经挂过一张 `i18n_text` 占位表，v4 迁移删掉了（零引用、零数据）。

### 5.3 计算时方向反过来

miao 拿中文名查表（`usefulAttr[char.name]`、`weaponCfg[wn]`），
所以 materialize 那一步必须 `itemId → miao 中文名`。仍然是 id 驱动，只是查的是 miao 的表。
中文因此可以继续吃 miao 现成的（`Meta.getMeta(...)`），只对非中文建表。

---

## 6. 抓取、失效、对拍

- **merge upsert**：每次抓取，抓到的角色覆盖，没抓到的**保留**并让 `fetched_at` 自然落后。
  `fetch_log` 记录每次拿到了哪些角色，前端才能提示「还有哪些角色没数据、去展柜放一下」——
  这是展柜数据源的固有体验，绕不开。
  抓取**失败也记一行**（`ok=0`，错误原文进 `note`）：上游抖动只在服务端终端飘一眼，
  记下来才能事后查「哪段时间在抖、抖在超时还是 424」。
  「最后抓取」时间只认 `ok=1` —— 失败是「尝试过」，数据并没变新。
- 读取时按 `ttl` 判断新鲜度，到期前只读 DB，不打 enka。
- `source` 字段为将来接第二个数据源（米游社面板）预留。
- **panel-check（`--check`）**：拿 `fightPropMap` 当标准答案对拍。
  实测 12 个角色 / 84 项对比，**最大偏差 0.0402%**，全部通过。
  两个口径差异（都不是我们的锅）：
  1. 百分比类：enka 给小数（`0.5673`），miao 给百分数（`56.73`）→ 乘 100
  2. 双方精度都有限：源头百分比只有两位小数（`1.5805` = `158.05%`）；miao 元数据里的基础生命/攻击/防御是取了整的
     （迪卢克基础生命 `11362.007`，游戏给 `11361.5996`），再被百分比加成放大
  容差因此定成「绝对值 ≤ 0.05 或 相对值 ≤ 0.1%」。真翻错了（词条权重看错、套装效果漏算）偏差是百分之几，
  绝不可能混过去——这是它的价值所在。

---

## 7. 待决项

| # | 问题 | 影响 | 现状 |
|---|---|---|---|
| 1 | 面板 `attr` 从哪来 | 「核爆」类场景规则是否触发 | ✅ 已定：调 `Attr.create().calc()` 自己算，并用 `fightPropMap` 对拍验证（§1.3、§6） |
| 2 | enka 的 level 基数 | 主词条数值整体差一档 | ✅ 已定：1 基（满级 21），真实数据锚点 62.2% 通过 |
| 3 | DB 选型 | 部署形态 | ✅ 已定：SQLite（`node:sqlite`，零原生模块）。schema 两边通用，将来换 Postgres 不用改模型 |
| 4 | 响应里有没有 TextMapHash | i18n 主键选型 | ✅ 已确认有，见 §5.1 |
| 5 | 文案表从哪来（官方 TextMap 资源怎么取、要不要落库） | 多语言能否真正上线 | ⬜ **未决**——下一步的入口 |
| 6 | 角色名 `avatarId → 文案 key` 映射的来源 | 角色名多语言 | ⬜ **未决**，与 #5 一起解 |
| 7 | 米游社面板做第二数据源 | 拿不到展柜之外的角色 | ⬜ 未决；`MyPanelData` 得**逆推** mainId/attrIds（上游注释直言这是"难点"），成本高 |

---

## 附：materialize 的契约（③ 那一步要产出什么）

内核 `ArtisMark.getMarkDetail(profile)` 需要的最小形状（从 `ArtisMarkCfg.getCharArtisCfg` 反推）：

```js
profile = {
  isProfile: true, isGs: true, game: 'gs',
  id: <avatarId>,                       // 数字
  elem: <'pyro'|...>,                   // 由 char.meta.talentElem 推
  char: <miao Character 对象>,           // 必须是真对象：内核读 char.name / char.isGs
  cons: <命座数>,
  attr: <Attr.create(profile).calc() 的结果>,   // ⚠️ 必须自己算，见 §1.3
  weapon: { name: <中文名>, level, promote, affix },   // name 必须中文，weaponCfg 查中文键
  artis: <Artis 实例>                    // 由 artis.setArtis(pos, {name, level, star, mainId, attrIds}) 逐件喂
}
```

注意 `artis` 必须是**真 `Artis` 实例**（内核调 `artis.is('绝缘4')`、读 `artis.sets`），
`char` 必须是**真 `Character` 对象**（内核读 `char.name`、`char.isGs`）——
所以 materialize 是「id → miao 对象」的薄组装，不是数据搬运。

顺带一个坑：`src/index.ts` 必须 import 全部 `resources/meta-gs/*/index.js`，
否则 `Meta.getData` / `Weapon.get` 会**静默返回 false**（不是抛错），表现为武器名变成「（未识别）」。
这个坑实际踩过一次。
