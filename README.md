# 星天水镜 / seiten-suikyou

原神角色养成评估器。**评分算法不做二次实现，直接内嵌 miao-plugin 的计算内核**，分数与上游逐字一致。

名字取自莫娜的称号「星天水镜」（日文 `星天水鏡`，读作 せいてん すいきょう / Seiten Suikyō）。
莫娜的水占术是「以水为镜映照星象，从幻象里读出真实」——面板数字是表象，评分才是那个自会显现的真实。

> 这篇是**使用文档**。为什么这么设计（内嵌内核的取舍、数据通路三层、页面与多语言的还原思路、
> 改动前的工程约束）在 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 它能做什么

| 能力 | 入口 |
|---|---|
| 按 UID 抓展柜 → 存本地库 → 用 miao 规则打分 | `npm run score -- --uid <uid>` |
| 网页：首页角色网格 + 角色明细页（复刻 miao 的评分结果图） | `npm run server` |
| 拿游戏客户端算的最终面板**对拍**我们自己算的面板 | `npm run score -- --check` |
| 多语言：简体 / 繁體 / English / 日本語 / 한국어 | 页面右上角，或 `--locale` |
| 本地缓存：enka 只给展柜那 8–12 个角色，跨多次抓取累积 | 自动 |
| JSON 接口 | `GET /api/uid/:uid?locale=en` |

## 快速开始

```bash
npm install                        # 两个运行时依赖：lodash + limiter
npm run score -- --uid 101242308   # 抓一次 enka 并打分（先有数据，页面才有东西看）
npm run sync:assets                # 从 miao-plugin 全量复制图片素材（可选，不跑则用 CSS 色块占位）
npm run server                     # 打开 http://127.0.0.1:8787
```

- **运行时要求**：Node ≥ 22.5。本地库走 Node 自带的 `node:sqlite`，不引原生模块
  （装 better-sqlite3 在 Windows 上要 MSVC，为一个个人工具不值得）。
- **Python 3 只在跑同步脚本时需要**（`tools/*.py`），不参与运行时。
- **不跑 `sync:assets` 也能用**，只是角色立绘、圣遗物图标会退化成 CSS 色块。
- `sync:assets` 从 miao-plugin 的 `resources/` 整目录复制，**全程离线**：不联网、不按需、不猜名字
  （素材源：`MIAO_PLUGIN_PATH`，默认 `../miao-plugin`，跟 `npm run sync` 一个约定）。
  全量约 100 MB、1800+ 个文件，一次跑完以后随便加角色都不用再管。
  miao 仓库里唯一没有的 7 张元素符号，作为种子放在 `tools/assets-seed/` 里随仓库走。
- 想对账「页面要的图是不是都落盘了」：`npm run list:assets && npm run sync:assets`。
  清单由页面自己的 `buildAccountView` 吐出来，缺哪个会列出来并以失败退出。

## 运行

```bash
npm install          # 只需 lodash + limiter

# 跑起来
npm run server       # http://127.0.0.1:8787
npm run score -- --help

# 测试
npm test             # 全量：smoke → arch → pipeline → i18n → server → cli → regression → verify
npm run smoke        # 只跑冒烟
npm run arch         # 只跑架构契约
npm run pipeline     # 只跑管线
npm run i18n         # 只跑多语言
npm run server:test  # 只跑服务测试
npm run cli:test     # 只跑命令行测试
npm run regression   # 只跑回归断言
npm run verify       # 只跑评分验证

# 同步（只在要更新数据时跑）
npm run sync          # ★ 同步上游的唯一入口：内核+权重表+多语言表+图片素材，一条命令全跑
npm run sync:check    # 只体检不落盘：先看跟上游差多少，再决定要不要跑
npm run sync:miao     # 只同步内核 / 权重表 / 角色武器数据（tools/sync_miao.py）
npm run sync:i18n     # 只重新提取多语言表
npm run sync:assets   # 只全量复制页面图片素材

# 文档
npm run check:docs   # 校验 README / docs 里的相对链接没写歪（搬过家就跑一遍）
```

## 命令行评分

```bash
npm run score -- --uid 101242308             # 抓 enka → 入库 → 打分
npm run score -- --uid 101242308 --offline   # 不联网，直接读库打分
npm run score -- --uid 101242308 --char 胡桃  # 只看一个角色
npm run score -- --uid 101242308 --check     # 顺手对拍游戏面板，验证数据没翻错
npm run score -- --file sample.json          # 从本地原始响应入库（不联网）
npm run score -- --save-raw .tmp/raw         # 原始响应另存一份，方便复现
npm run score -- --list                      # 库里存了哪些 uid
npm run score -- --keys                      # 库里用到过哪些官方文案 key（做多语言时照着要）
npm run score -- --uid 101242308 --json      # 额外输出结构化结果
npm run score -- --locale en                 # 换语言输出
```

输出长这样（真实数据，完整存档见 [`docs/sample/cli-output.txt`](docs/sample/cli-output.txt)）：

```
账号  阿空（uid:101242308）  Lv.60  世界等级 9
数据  enka 本次取得 12 个角色　|　最后抓取 2026-09-19 21:59:09　|　12 个角色
────────────────────────────────────────────────────────────
迪卢克 ★5 Lv.79 命之座2 好感10 pyro  A8 E8 Q8
  武器  狼的末路 Lv.90 精2
  套装  炽烈的炎之魔女×4
  1 生之花  魔女的炎之花   ★5 Lv.20     35.3  SS
       主词条  生命值 4778.6
       副  暴击率 6.6%×2  元素充能效率 5.2%  元素精通 32.6×2  攻击力 14.0%×3
  ...
  面板属性  生命值 17395  攻击力 2450  防御力 728  暴击率 56.7%  暴击伤害 158.0%  元素精通 161  元素充能效率 178.4%  伤害增加 15.0%
  场景  迪卢克-通用
  总分  184.7  SS
────────────────────────────────────────────────────────────
汇总（按总分降序，共 12 个角色）
   214.4  SSS  夏沃蕾        夏沃蕾-通用
   ...
────────────────────────────────────────────────────────────
```

`×N` 是「同一词条出了几次」（就是内核数出来的 `upNum`）。

数据时间统一按**本机时区**输出（库里的 ISO 是 UTC，展示时才本地化）。

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

**注意**：`--check` 必须对着原始响应做，所以 `--offline --check` 会提示做不了
（库里故意不存面板属性，理由见 [`docs/DESIGN-DATA-MODEL.md`](docs/DESIGN-DATA-MODEL.md) §3）。

## 网页服务

```bash
npm run server                                        # 监听 0.0.0.0:8787，本机开 http://127.0.0.1:8787
npm run server -- --port 9000 --db data/other.db
npm run server -- --host 127.0.0.1                     # 只给本机用，不对外
```

**默认绑 `0.0.0.0`（局域网可达）**，启动日志会把各网卡地址逐个列出来，手机连同一个 Wi-Fi 直接打开那个地址即可。
⚠️ **本服务没有登录鉴权** —— 绑 `0.0.0.0` 意味着同网段任何人都能看到库里的角色数据，只在可信网络里开；
要关起来就用 `--host 127.0.0.1`。

（局域网另一台设备连不上时，先查 Windows 防火墙的 `node.exe` 入站规则：规则按**可执行文件完整路径**放行，
换 Node 版本/路径后规则就失效了，需要重新放行。）

| 接口 | 说明 |
|---|---|
| `GET /api/meta` | 有哪些语言、多语言表在不在、以及当前语言的**界面文字表** |
| `GET /api/health` | 库里有几个 uid |
| `GET /api/uids` | uid 列表（昵称、等级、角色数、最后抓取时间） |
| `GET /api/uid/:uid?locale=en` | 整包视图：账号 + 全部角色（面板/套装/圣遗物主副词条） |
| `GET /api/uid/:uid/character/:avatarId/damage` | 单个角色的伤害计算（明细页下侧那张表）。`data` 为 `null` = 这个角色算不出伤害（没配 calc.js 等） |
| `POST /api/fetch` | `{uid, locale}` 从 enka 现抓一份并入库，直接回视图 |
| `GET /assets/<路径>` | 图片素材（扩展名白名单 + 目录穿越防护 + 一天缓存） |
| `GET /` | H5 页面 |

静态页走**通用静态服务**：整个 `public/` 目录按扩展名白名单 + 目录穿越防护托管（`/` 与 `/index.html` 给首页，`/bootstrap.js` 等 ES 模块逐个加载，`/style.css`、`/miao.css` 给样式），`/api/*` 一律交给接口、不会被静态分支抢走。
失败一律同一个形状：`{ ok:false, error:{ code, message } }`。

### 限流

公网一开放，`POST /api/fetch` 就是个「拿你的服务去打 enka」的口子 —— 上游一限流就是全站 502，
所以自带三档闸：

| 档位 | 默认 | 挡的是 |
|---|---|---|
| 抓取 · 每 IP | 20 次/分 | 单个访客连着刷 |
| 抓取 · 全局 | 30 次/分 | 换 IP 也绕不过去，这一档是替 enka 上游挡的 |
| 读接口 · 每 IP | 300 次/分 | 脚本把 uid 扫一遍 |

超了回 `429` + `rate_limited`，并带 `Retry-After` 头。
`/api/health`、静态页、图片素材**故意不限** —— 探活被拦会误报故障。

```bash
RATE_FETCH=5 RATE_FETCH_ALL=10 npm run server     # 调档（填每分钟几次）
npm run server -- --no-rate-limit                  # 本地调试时整个关掉
```

⚠️ **挂在反向代理后面必须加 `--trust-proxy`**（Cloudflare Tunnel、nginx 都算）：
那种拓扑下 TCP 对端永远是代理自己（走 Tunnel 时全是 `127.0.0.1`），不认转发头的话
限流会把所有访客当成同一个 IP。开了才按 `CF-Connecting-IP` / `X-Forwarded-For` 分桶。
反过来，**直接暴露时不要开**：那只是个请求头，谁都能伪造，认了等于没限。

用 `node:http` 手写，不引框架 —— 这里要的东西很薄（几个 JSON 接口 + 几个静态文件），
不值得为省一张路由表把依赖撑大。运行时依赖只有两个：`lodash`（miao 内核本来就要）和
`limiter`（限流的令牌桶，零传递依赖）。`test/arch.ts` 盯着这个清单 —— 加依赖前先算账：
省下的行数配不配得上它的体积。

## 多语言

页面右上角切换，命令行用 `--locale`：

```bash
npm run score -- --uid 101242308 --locale ja   # chs / cht / en / ja / ko
npm run sync:i18n                              # 重新提取官方文案表（默认 chs,cht,en,ja,ko）
I18N_LOCALES=chs,en npm run sync:i18n          # 只提两种语言（编排器不转发子命令参数，用环境变量）
I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py   # 国内直连 gitlab 不通
```

> `npm run sync:i18n` 走的是统一入口，**不转发子命令参数**（编排器已经解析过一遍了，
> 再传一遍会让子脚本的 argparse 报「未知参数」）。要带参数就调子脚本本身，或用 `I18N_LOCALES`。

文案分**游戏内文案**（`vendor/i18n/names.json`，从官方 `TextMap` 提取）和**界面文字**
（`src/i18n/ui.ts`，手写 69 条 × 5 种语言）两张表 —— 官方表里没有「刷新」「圣遗物」这类
我们自己页面的说法。两张表为什么这么分、提取时踩过哪三个坑，见 [`docs/DESIGN.md`](docs/DESIGN.md) §四。

表不在时**静默降级**成只有中文（页面会给出提示），不会崩。

## 当库用：评分调用方式

用 miao 的官方入口，不自己拼：

```js
import { ArtisMark } from './src/index.ts'

const ret = ArtisMark.getMarkDetail(profile, withDetail)
// ret: { classTitle, mark, markClass, artis: {1..5}, sets, names, charWeight }
```

`profile` 需提供：`isProfile`、`game`、`id`、`elem`、`char`、`weapon`、`attr`、`cons`、`artis`。
其中：

- `char` 必须是**真 `Character` 对象**（规则里读 `char.name` / `char.isGs`）
- `artis` 必须是**真 `Artis` 实例**（规则里调 `artis.is('绝缘4')`、读 `artis.sets`）
- `attr` 是面板属性，由 `Attr.create(profile).calc()` 算出来（`src/adapter/materialize.ts` 里就是这么做的）
- `weapon` 只要 `{ name, level, promote, affix }`，**`name` 必须是中文**（内核拿中文名查 `weaponCfg`）

**圣遗物只喂部件名 + 原始 prop id**（`name` / `level` / `star` / `mainId` / `attrIds`），
主副属性值一律由内核自解 —— 手工构造 profile 时也别自己算属性值。

从 enka 数据出发的话不用自己拼：`ingest` 负责入库、`materialize` 负责组装。

## 测试

```bash
npm test
```

八套，分工不重叠：

| 套 | 项数 | 管什么 |
|---|---|---|
| `smoke` | — | 内核能不能脱离云崽独立加载：模块加载、元数据注册（attrMap 13 项 / 暴击率标准值 / 胡桃权重）、角色 ID 表 |
| `arch` | 21 | 架构契约：别名可解析、依赖清单（lodash + limiter）、vendor 自包含、云崽全局零残留 |
| `pipeline` | 58 | **我们自己写的代码有没有搞坏数据**：level 基数归一化、ingest、库往返、迁移、合并抓取、真实数据 + 面板对拍 |
| `i18n` | 27 | 各类名字中英两路都对、大小写与别名归一、表缺失时能跳过 |
| `server` | 58 | 真起监听打真 HTTP：路由、静态与素材、错误形状、多语言出口、POST 抓取（用假 enka，不联网） |
| `cli` | 51 | **命令行入口**：把 CLI 当黑盒跑子进程，看该打印的段落在不在（汇总 / 面板对拍 / `--json` 形状 / 出错退出码非 0）、离库重跑分数不变、`--locale` 真透传 |
| `regression` | — | 算法常量（上游更新后的安全网）：硬断言常量、软校验角色数/权重 |
| `verify` | — | 端到端评分（输出即基线，可 diff） |

几条约定：

- **测试只 import `src/index.ts` 的出口 API，不碰内部路径**。这样 vendor 内部怎么搬、别名怎么解析，
  对测试都透明 —— 内部重构不必改测试。
  （`cli` 那套是例外：它跑子进程，测的就是进程边界本身。）
- **`verify.ts` 的 stdout 就是基线**，断言只在失败时打印、通过时静默：

  ```bash
  npm run verify > .tmp/after.txt && diff .tmp/baseline.txt .tmp/after.txt   # 逐字为空才算没跑偏
  ```

- `test/data/enka-real.json` 是**一份带数值的真实 enka 响应**（只换过 uid/昵称、只留 3 个不同元素的角色，
  数值一个没动）。合成数据只能测「逻辑对不对」，真实数据才能测「翻没翻错」——
  面板对拍那条断言就靠它。

- `cli` 那套**只看输出、不看退出码**是不行的，反过来只看退出码也不行：CLI 挂过一次 ——
  汇总段用了未定义的变量，异常被外层 `catch` 吞掉后提前返回，**后面的面板对拍整段不执行**，
  而进程退出码当时还是 0。所以它断言的是「汇总段 / 面板对拍段在不在」。
  单独跑：`npm run cli:test`。

改动前端样式后想验收，用 `tools/probe.ts` 直读真实 DOM（尺寸 / 折行 / 计算样式），
别去数截图像素 —— 截到立绘的深色衣服会以为是背景色，会得出错的结论（实测踩过两次）。

## 目录结构

```
seiten-suikyou/
├── src/
│   ├── index.ts              # 内核出口：注册元数据 + 原样导出评分模块
│   ├── store/                # 本地库（SQLite）
│   │   ├── schema.sql        #   表结构（权威定义）
│   │   ├── db.ts             #   连接 / 结构保证（node:sqlite，打开即跑最新 schema.sql）
│   │   └── repo.ts           #   读写：合并式 upsert、按 uid 取、文案 key 清单
│   ├── adapter/              # enka ↔ 本项目 的转换
│   │   ├── enka.ts           #   按 uid 取原始响应（把 HTTP 码翻译成人话）
│   │   ├── ingest.ts         #   原始响应 → 库行（挑字段、带文案 key，不解析属性）
│   │   ├── materialize.ts    #   库行 → miao profile（id → 中文名/对象 + 算面板）
│   │   └── panel-check.ts    #   拿游戏给的面板对拍，验证数据没翻错
│   ├── view/shape.ts         # 视图成型：库行 + 评分结果 → 页面/接口/CLI 共用的对象
│   ├── i18n/
│   │   ├── index.ts          #   多语言：hash/id → 游戏文案（读 vendor/i18n/names.json）
│   │   └── ui.ts             #   界面文字手写表（按钮/标题/提示，官方表里没有）
│   ├── cli/score.ts          # 命令行评分入口
│   └── server/
│       ├── index.ts          #   node:http 路由（API + 通用静态页），零新依赖
│       └── public/           #   页面：原生 ES 模块，无框架无 CDN（type="module"，零构建）
│           ├── index.html    #     外壳（顶栏 / 视图容器 / 页脚），引 /bootstrap.js
│           ├── bootstrap.js  #     入口：引齐 feature 模块（副作用注册渲染器）+ 控制器 + 启动
│           ├── core.js       #     基座：state / 工具 / 编排（经 reg 注册表反向调 feature，无环依赖）
│           ├── roster.js     #     feature：账号头 + 角色网格 + 卡片
│           ├── filter.js     #     feature：筛选条（元素 / 评分 / 权重）
│           ├── sort.js       #     feature：多条件排序（至多 3 字段的排序链）
│           ├── detail.js     #     feature：角色明细画布 + 缩放
│           ├── i18n.js       #     feature：loadMeta / 切语言 / 静态文案
│           ├── history.js    #     feature：UID 历史（localStorage）
│           ├── style.css     #     外壳样式
│           ├── miao.css      #     评分卡样式（miao 的 profile-detail.css 移植版）
│           └── assets/       #     图片素材（sync:assets 从 miao-plugin 复制，约 100MB，随仓库提交）
├── vendor/
│   ├── miao/                 # 从 miao-plugin 搬运的源码（sync 生成，勿手工编辑）
│   └── i18n/names.json       # 官方文案表（sync_i18n 生成，勿手工编辑）
├── tools/                    # 同步 / 验收工具（开发期用，不参与运行时）
│   ├── sync.py               # ★ 同步上游的唯一入口（编排下面三个，按依赖顺序跑）
│   ├── sync_miao.py          # 内核同步（搬运 + 补丁 + 校验 + 报告；增量交给 git 算）
│   ├── sync_i18n.py          # 多语言表提取（官方 TextMap + enka loc.json）
│   ├── sync_assets.py        # 图片素材全量复制（源：miao-plugin/resources，全程离线）
│   ├── list_assets.ts        # 问应用本人「页面会请求哪些图」，供 sync_assets 对账
│   └── assets-seed/          # 种子素材：miao 那边没有的图（元素符号 7 张），进 git
│   ├── probe.ts              # 在真实页面跑 JS 量布局（改样式后的验收工具）
│   ├── shot.ts               # headless chrome 截图
│   └── check_docs.py         # 校验文档里的相对链接没写歪（搬过家就查一遍）
├── test/                     # 见「测试」一节
├── docs/                     # 设计文档 + 参考稿
│   ├── DESIGN.md             #   总设计（为什么内嵌内核 / 页面与多语言怎么还原 / 工程约束）
│   ├── DESIGN-DATA-MODEL.md  #   数据层专项：enka → 缓存 → 内核，为什么不设计算中间层
│   ├── 角色列表页.jpg         #   首页网格的版式参考（原魔工具箱「角色展柜」）
│   ├── miao结果图参考.jpeg    #   明细页对拍基准（奥黛塔 248.0 / ACE）
│   ├── sample/               #   样例数据：一次真实运行的完整命令行输出存档
│   └── reports/              #   同步脚本每次生成的报告（sync-report / i18n-report）
└── data/                     # 本地库（/data/ 已 gitignore）
```

## 相关文档

| 想了解 | 看哪 |
|---|---|
| 怎么装、怎么跑、接口有哪些 | 本文件 |
| 为什么内嵌 miao 内核、页面与多语言怎么还原、改动前的硬约束 | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 数据层设计（存储存 id 不存名字、为什么不设计算中间层） | [`docs/DESIGN-DATA-MODEL.md`](docs/DESIGN-DATA-MODEL.md) |
| 命令行输出长什么样 | [`docs/sample/cli-output.txt`](docs/sample/cli-output.txt) |
| 上一次同步搬了什么、多语言覆盖率如何 | [`docs/reports/`](docs/reports/) |
