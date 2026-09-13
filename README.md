# 星天水镜 / seiten-suikyou

原神角色养成评估器。**评分算法不做二次实现，直接内嵌 miao-plugin 的计算内核**，上游更新可一键对齐。

名字取自莫娜的称号「星天水镜」（日文 `星天水鏡`，读作 せいてん すいきょう / Seiten Suikyō）。
莫娜的水占术是「以水为镜映照星象，从幻象里读出真实」——面板数字是表象，评分才是那个自会显现的真实。

## 核心设计：内嵌 + 定点处理

miao-plugin 是为云崽（Yunzai + oicq）写的插件，不是库。它假设了一堆只有云崽才提供的运行时：
全局 `redis`、注入的 `Bot`、`e.runtime.render`（puppeteer 截图）、米游社 Cookie，以及
`#miao` 这类 package.json imports 别名。

本项目的做法是**把用得到的源码搬进 `vendor/miao/`，只对「确认本项目用不到」的云崽依赖做定点处理**：

```bash
npm run sync   # 从 miao-plugin 重新搬运 + 打补丁 + 校验 + 出对比报告
npm test       # 全量测试：内核能加载、架构边界没烂、管线没搞坏数据、分数没变
```

三条原则：

1. **能原样搬就原样搬** —— 不为了「干净」而重写上游代码。505 个文件里 498 个是逐字节复制，
   只有 7 个定点改写 + 2 个本地生成。
2. **别名交给 package.json** —— `#miao` / `#miao.models` / `#miao.path` 原样保留在源码里，
   由本项目 `package.json` 的 `imports` 字段映射到 `vendor/miao` 下的真实文件。
   **没有任何 import 语句被改写**，IDE 跳转和静态分析照常可用。
3. **只处理云崽专属** —— 公共依赖用真的，云崽独有的才处理。

### 云崽依赖的处理清单

| 云崽的东西 | 出现在 | 处理方式 |
|---|---|---|
| 全局 `redis` | `components/Data.js` 的 4 个缓存方法 | 退化为空实现（评分链路不走缓存） |
| 全局 `logger` | `components/Data.js` 的 `delFile` | 改 `console.error` |
| `Common`（渲染）/ `App`（应用） | `components/index.js` | 从入口摘掉（本项目无人引用） |
| 云崽模型 `User` / `MysApi` / `Player` / `Abyss` … | `models/index.js` | 从入口摘掉，连同顶层副作用 |
| `Cfg`（用户配置） | 依赖 `cfg/CfgData.js` → 217 行 `cfg_system.js` schema | `components/_local/Cfg.js` 最小实现 |
| `Version`（宿主版本检测） | 读 `package.json` / `CHANGELOG.md`、辨别 Yunzai V2/V3 | `components/_local/Version.js` 最小实现 |
| `CharImg`（渲染层） | 写死云崽路径 + 依赖 `image-size` | 整体置空 |
| `lodash` | 全仓库 46 种方法 | **直接用真依赖**，不替换 |
| `image-size` | 只有 `CharImg` 用 | CharImg 已置空，故不引入 |

`components/_local/` 下两个文件是本项目手写的（不是上游内容），同步时自动生成。

### 搬运范围（为什么是 505 个文件 / 3.5MB）

除了评分算法与角色元数据，还搬了两样「容易漏掉、漏了就出不了正确分」的东西：

| 搬什么 | 为什么必须要 |
|---|---|
| `models/attr/`（`Attr.js` + `AttrData.js`） | 76 个角色规则里 **55 个要读 `attr.xxx`**（如胡桃的核爆判定 `attr.cpct < 15 && attr.cdmg > 280`），而 `attr` 不是数据源给的 —— 是 miao 自己按「基础值 + 武器 + 圣遗物」算的（`models/Avatar.js:320`）。 |
| `resources/meta-gs/weapon/`（**只搬数据，不搬图片**） | 上面那个 `Attr.calc()` 要用 `Weapon.calcAttr()` 和 `weaponBuffs`。同目录下的 `icon/gacha/awaken.webp` 占 21MB，评分用不到，全不搬。 |

另外 `src/index.js` 里的元数据注册是「谁 import 谁登记」：漏 import 一个 `resources/meta-gs/*/index.js`，
对应模型就会静默返回 `false`（我们踩过一次 —— `Weapon.get()` 全返回 null，界面上武器显示「未识别」）。

### 同步产出

| 产物 | 内容 |
|---|---|
| `vendor/miao/VENDOR.md` | 来源、上游版本、文件数、处置方式、相对上一版的增量 |
| `docs/sync-report.md` | **同步了哪些数据 / 相对上一版差在哪 / 改了什么 / 什么没动**。改动用凝练语言说清，不贴 diff —— 要逐行核对走 `git log -p` |

增量不用自己维护一份「文件清单 + 哈希」——`vendor/miao` 本来就是 git 跟踪的，
git 里逐字存着上一版的内容，「相对上一版多了什么、改了什么」直接问它就行。
基准取「最后一个动过 `vendor/miao` 的提交」，也就是上一版同步的产物：

```bash
git diff --name-status <基准提交> -- vendor/miao   # 只看增删改的文件名
git log -p -- vendor/miao                          # 逐行看改了什么
```

脚本内部同样走这条路，并且 `git diff`（已跟踪文件的变化）和 `git status`
（未跟踪的新文件，新搬进来的目录在 `git diff` 里是看不见的）两个来源都取，缺一不可。

```bash
MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_miao.py
```

### 相比早期方案

早期用 Node 的 ESM loader hook 在运行时劫持 import 指向外部 miao-plugin 目录。已废弃，因为：
项目依赖一个外部目录才能跑、边界模糊、IDE 跳转和静态分析全部失效、必须用 `--import` 启动。
现在**仓库自包含**：`node test/verify.mjs` 直接跑。

## 数据通路：三层，中间模型建在「存储」不在「计算」

完整设计见 **`docs/data-model.md`**。一句话：**存储层存 id，不存名字。**

```
enka 原始响应
   │  ① ingest：挑字段、原始 prop id 原样保留、记来源、带走官方文案 key
   ▼
② canonical store（本地库，本地化无关）
   主键全是稳定的数字：uid / avatarId / itemId / propId / TextMapHash
   │
   ├─ ③ materialize → miao profile（id → miao 的中文名与真实对象）→ ArtisMark → 分数
   ├─ ④ localize    → 多语言文案（id → 目标语言）→ 前端
   └─ ⑤ panel-check → 拿游戏给的面板对拍 ③ 的结果，验证翻对了没有
```

**为什么不设「enka → 自有数据模型 → 再拼回 miao」的中间层**（三条实证）：

1. **会丢信息** —— 内核的「词条数」是按 `appendPropIdList` 里**同一 key 出现几次**数出来的
   （`ArtisAttr.js:41` 的 `tmp[key].upNum++`）。**原样保留每一次 roll** 是硬要求：
   去重、或改存 enka 聚合好的 `reliquarySubstats`，这个信息就没了。
2. **数值口径会打架** —— 内核完全不信外部给的属性值，主词条按
   `attrCfg.value × (1.2 + 0.34 × level) × posEff × starEff` 自己算，副词条按自己的
   `attrIdMap` 每 roll 值累加。外面先解析一遍不但白做，还可能算歪。
3. **上游行为就是这样** —— miao 自己的 `models/serv/api/EnkaData.js`（106 行）
   也只做「挑字段 + 位置映射 + level 减一」，属性解析一律留给内核。
   这条边界随内核维护，另起一套就丢了同步性。

**为什么要建这层库**（两条）：

1. **enka 一次只给展柜里的角色**（约 8–12 个），玩家有 20–40+ 角色 → 必须跨多次抓取累积。
   上游自己也这么干：`EnkaApi.updatePlayer` 是 `forEach(avatarInfoList, setAvatar)` + `player._update.push(id)`，
   并且用响应里的 `ttl` 当缓存时长。
2. **多语言** —— miao **零 i18n 能力**：`resources/` 全是中文，角色目录名就是中文（`character/胡桃/`），
   权重表 / 套装缩写 / 武器特判全用中文名当键，全仓库零 `TextMapHash` 使用。
   所以任何「显示英文/日文名」的需求都必须自建文案表，而文案表的主键只能是 id。

   好消息是**文案主键不用自己造**：enka 的 `flat` 里直接带着官方的 `nameTextMapHash` /
   `setNameTextMapHash`（实测 uid 101242308 的响应里有 132 处），那就是官方全语言文案表的主键
   —— 存下 hash，将来接上官方 `TextMap` 就一次性拿到全部语言，不需要我们自己翻译。
   所以这三个 hash 列（`artifact.name_hash` / `artifact.set_hash` / `avatar.weapon_name_hash`）
   在 ingest 阶段就存下来：enka 白给的东西，丢了要补只能重抓。
   唯一例外是**角色名**：`avatarInfo` 里只有 `avatarId`，没有 hash，得另配一份静态映射。

## 目录结构

```
seiten-suikyou/
├── src/
│   ├── index.js              # 内核出口：注册元数据 + 原样导出评分模块
│   ├── store/                # 本地库（SQLite）
│   │   ├── schema.sql        #   表结构（权威定义）
│   │   ├── db.js             #   连接 / 结构版本迁移（用 Node 自带的 node:sqlite）
│   │   └── repo.js           #   读写：合并式 upsert、按 uid 取、文案 key 清单
│   ├── adapter/              # enka ↔ 本项目 的转换
│   │   ├── enka.js           #   按 uid 取原始响应（含各类错误的解释）
│   │   ├── ingest.js         #   原始响应 → 库行（挑字段、位置映射、带文案 key，不解析属性）
│   │   ├── materialize.js    #   库行 → miao profile（id → 中文名/对象 + 算面板）
│   │   └── panel-check.js    #   拿游戏给的面板对拍，验证数据没翻错
│   └── cli/score.js          # 命令行评分入口
├── vendor/miao/              # 从 miao-plugin 搬运的源码（sync 生成，勿手工编辑）
│   ├── components/index.js   #   `#miao`        入口（已摘掉 Common / App）
│   ├── models/index.js       #   `#miao.models` 入口（已摘掉云崽模型）
│   ├── tools/path.js         #   `#miao.path`   路径工具（零云崽依赖）
│   └── components/_local/    #   本项目手写的最小实现：Cfg / Version
├── tools/
│   └── sync_miao.py          # 同步脚本（搬运 + 补丁 + 校验 + 报告；增量交给 git 算）
├── docs/
│   ├── data-model.md         # 数据模型设计（三层结构、为什么不设计算中间层）
│   ├── sample-output.txt     # 真实运行的完整输出存档（含面板对拍）
│   └── sync-report.md        # 每次同步生成：同步了什么 / 改了什么 / 增量多少
└── test/
    ├── fixtures.mjs          测试用的合成数据（手写）
    ├── data/enka-real.json   一份真实 enka 响应（换过 uid，数值没动）
    ├── smoke.mjs             冒烟：内核能否脱离云崽独立加载
    ├── arch.mjs              架构契约：别名解析 / 依赖策略 / vendor 自包含
    ├── pipeline.mjs          管线：ingest / 库往返 / 迁移 / 真实数据对拍 / materialize 不丢数据
    ├── regression.mjs        回归断言：算法常量（上游更新后的安全网）
    └── verify.mjs            端到端评分验证（输出即基线，可 diff）
```

## 运行

```bash
npm install     # 只需 lodash
npm test        # 全量：smoke → arch → pipeline → regression → verify
npm run smoke   # 只跑冒烟
npm run arch    # 只跑架构契约
npm run pipeline# 只跑管线测试
npm run verify  # 只跑评分验证
npm run sync    # 从 miao-plugin 重新同步（需先设 MIAO_PLUGIN_PATH）
```

`verify` 的 stdout 就是「基线」——改完内核后可以
`npm run verify > .tmp/after.txt && diff .tmp/baseline.txt .tmp/after.txt`，
逐字为空才算没跑偏。所以它的断言只在失败时打印，通过时静默。

同步时 miao-plugin 默认在同级目录 `../miao-plugin`，可用环境变量覆盖：

```bash
MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_miao.py
```

**为什么同步脚本用 Python**：它是开发期工具，不参与运行时。Python 标准库
（`shutil` / `re` / `subprocess`）写这类「复制 + 文本改写 + 校验 + 出报告」的脚本更顺手，
也不会让工具代码混进 Node 的模块图。

## 命令行评分

```bash
npm run score -- --uid 101242308            # 抓 enka → 入库 → 打分
npm run score -- --uid 101242308 --offline  # 不联网，直接读库打分
npm run score -- --uid 101242308 --char 胡桃 # 只看一个角色
npm run score -- --uid 101242308 --check    # 顺手对拍游戏面板，验证数据没翻错
npm run score -- --file sample.json         # 从本地原始响应入库（不联网）
npm run score -- --list                     # 库里存了哪些 uid
npm run score -- --keys                     # 库里用到过哪些官方文案 key（做多语言时照着要）
npm run score -- --uid 101242308 --json      # 额外输出结构化结果（给以后的前端/接口）
```

输出长这样（真实数据）：

```
账号  阿空（uid:101242308）  Lv.60  世界等级 9
数据  enka 本次取得 12 个角色　|　最新抓取 2026-09-13T06:57:12.981Z　|　库里共 12 个角色
────────────────────────────────────────────────────────────
迪卢克 ★5 Lv.79 命2 好感10 pyro  A8 E8 Q8
  武器  狼的末路 Lv.90 精2
  套装  炽烈的炎之魔女×4
  1 生之花  魔女的炎之花   ★5 Lv.20     35.3  SS
       主  小生命 4778.6
       副  暴击率 6.6%×2  充能效率 5.2%  元素精通 32.6×2  大攻击 14.0%×3
  ...
  面板  生命 17395  攻击 2450  防御 728  暴击率 56.7%  暴击伤害 158.0%  元素精通 161  元素充能 178.4%  元素伤害 15.0%
  场景  迪卢克-通用
  总分  184.7  SS
```

`×N` 是「同一词条出了几次」（就是内核数出来的 `upNum`）。

两个刻意的设计：

- **打完分一定是从库里读回来再算**，而不是拿刚落库的内存数据直接算。多走一趟数据库，
  才能证明「存进去」和「读出来」是同一个东西。
- **原始响应可以另存一份**（`--save-raw <dir>`），方便复现问题和以后换解析逻辑时回放。

### `--check`：拿游戏自己的面板当标准答案

数据喂错这件事很难从分数上看出来 —— 一个副词条权重看错，总分可能只差 2 分。
所以 `--check` 干一件事：enka 的 `avatarInfo.fightPropMap` 是**游戏客户端自己算出来的最终面板**，
把它和 miao 算出来的 `attr` 逐项比。角色等级/突破、武器、圣遗物主副词条，整条链路一次全验证。

```
面板对拍：游戏 fightPropMap（标准答案） vs miao 计算面板
容差 绝对值 ≤0.05 或 相对 ≤0.1%
  一致  迪卢克        7 项  最大偏差 0.0253%（cdmg）
  一致  砂糖         7 项  最大偏差 0.0306%（cpct）
  ...
  全局最大偏差 0.0402%（cpct）→ 链路正常
```

实测 12 个角色 / 84 项对比全部通过。两个已知的口径差异（都不是我们的锅，写进容差里了）：
百分比类 enka 给小数（`0.5673`）而 miao 给百分数（`56.73`）；源头百分比只有两位小数，
且 miao 元数据里的基础生命/攻击/防御取了整，被百分比加成放大。
真翻错了偏差是百分之几，这个容差挡不住 —— 所以它是有效的。

## 评分调用方式

用 miao 的官方入口，不自己拼：

```js
import { ArtisMark } from './src/index.js'

const ret = ArtisMark.getMarkDetail(profile, withDetail)
// ret: { classTitle, mark, markClass, artis: {1..5}, sets, names, charWeight }
```

`profile` 需提供：`isProfile`、`game`、`id`、`elem`、`char`、`weapon`、`attr`、`cons`、`artis`。
其中：

- `char` 必须是**真 `Character` 对象**（规则里读 `char.name` / `char.isGs`）
- `artis` 必须是**真 `Artis` 实例**（规则里调 `artis.is('绝缘4')`、读 `artis.sets`）
- `attr` 是面板属性，由 `Attr.create(profile).calc()` 算出来（`src/adapter/materialize.js` 里就是这么做的）
- `weapon` 只要 `{ name, level, promote, affix }`，**`name` 必须是中文**（内核拿中文名查 `weaponCfg`）

从 enka 数据出发的话，不用自己拼：`ingest` 负责入库、`materialize` 负责组装。

## 已知约束

1. **圣遗物只喂部件名 + 原始 prop id**（`name` / `level` / `star` / `mainId` / `attrIds`），
   主副属性值一律由内核自解。手工构造 profile 时也别自己算属性值。
2. `vendor/miao/` 是生成物，手工改动会被下次 `npm run sync` 覆盖。要改行为，改 `tools/sync_miao.py` 的清单或补丁。
3. `Cfg` 恒为空配置（网页版没有配置交互层）。评分链路只用到 `Cfg.get('notReleasedData')` 和
   `Cfg.get('qFace')` 两个布尔开关，`_local/Cfg.js` 复刻了「上游读不到配置文件」的行为。
4. **目录层级是硬约束**：`tools/path.js` 靠自身位置推算 miao 根，`Data.getRoot('miao')` 依赖它。
   所以 `vendor/miao/` 这一层不能拍平，`_local/` 也必须留在 `components/` 下（`Format.js` 通过 `#miao` 取 `Cfg`）。
5. **圣遗物 level 的基数**：内核要 0 基（5★ 满级 = 20）。enka 给的是 1 基（实测满级 = 21），
   所以 `src/adapter/materialize.js` 的 `normalizeLevel()` 对 enka 减 1。
   库里存的是原始值 + 来源，万一推断错了改一个函数就能全量重算，不用重新抓。
6. **`test/fixtures.mjs` 的词条 key 与 miao 规范不一致**：它把大/小词条写反了
   （花的主词条写成 `hp`，按 miao 的 `mainIdMap` 应该是 `hpPlus`）。
   因为 1/2 号位的主词条不参与评分、且胡桃的大小生命权重相同，所以基线数字没受影响，
   但它不是一份「规范数据」。要扩测试的话建议先把它改规范并重生成基线。
7. 当前 miao-plugin 是 zip 下载（无 `.git`），同步靠目录复制，无法锁定 commit。
   若想版本化，建议单独 `git clone` 一份作为上游源。
8. **改库结构必须同时加迁移**：`schema.sql` 全是 `CREATE TABLE IF NOT EXISTS`，
   对**已存在**的表一列也不会加。改完要 +1 `SCHEMA_VERSION` 并在 `db.js` 的 `MIGRATIONS`
   里补一版 `ALTER`，否则老库会静默不升级、跑起来报「no such column」。
   缺某一版迁移函数时 `openDb` 会直接抛错拒绝启动（降级处理会静默丢数据）。
9. **不改 `.gitignore` 里的 `data/` 前缀**：它是 `/data/`（锚定仓库根）。
   写成不带斜杠的 `data/` 会连带忽略 `test/data/`（Git 的目录模式不限层级）。
10. **`--check` 只能对着原始响应做**，不能对着库做 —— 因为我们**故意不存面板属性**
    （理由见 `docs/data-model.md` §3）。离库打分时 `--offline --check` 会提示做不了。
11. **同步完记得提交**：报告里「相对上一版」的基准是**最后一个动过 `vendor/miao` 的 git 提交**。
    不提交的话，它只能告诉你「自上次提交以来没变」，看不出这一轮到底搬了什么。

## 下一步

1. `src/i18n/` —— 多语言文案表：接官方 `TextMap`（用 §多语言 里存的 hash 当主键），
   角色名另配 `avatarId → 文案 key` 静态映射
2. `server/` —— Fastify 起 API（复用 store + materialize）
3. `web/` —— H5 前端
