# 星天水镜 · 设计文档

**这篇讲「为什么这么设计」。** 怎么装、怎么跑、命令有哪些、接口长什么样 —— 看根目录
[`README.md`](../README.md)。

数据层（enka → 缓存 → 内核）的完整论证单独一篇：[`DESIGN-DATA-MODEL.md`](DESIGN-DATA-MODEL.md)。

---

## 一、内嵌 miao 内核，不重新实现

miao-plugin 是为云崽（Yunzai + oicq）写的插件，不是库。它假设了一堆只有云崽才提供的运行时：
全局 `redis`、注入的 `Bot`、`e.runtime.render`（puppeteer 截图）、米游社 Cookie，以及
`#miao` 这类 package.json imports 别名。

本项目的做法是**把用得到的源码搬进 `vendor/miao/`，只对「确认本项目用不到」的云崽依赖做定点处理**。

三条原则：

1. **能原样搬就原样搬** —— 不为了「干净」而重写上游代码。搬进来的文件绝大多数是逐字节复制，
   只有少数定点改写 + 本地生成，清单在 `tools/sync_miao.py` 里。
2. **别名交给 package.json** —— `#miao` / `#miao.models` / `#miao.path` 原样保留在源码里，
   由本项目 `package.json` 的 `imports` 字段映射到 `vendor/miao` 下的真实文件。
   **没有任何 import 语句被改写**，IDE 跳转和静态分析照常可用。
3. **只处理云崽专属** —— 公共依赖用真的，云崽独有的才处理。

### 云崽依赖的处理清单

| 云崽的东西 | 出现在 | 处理方式 |
|---|---|---|
| 全局 `redis` | `components/Data.js` 的 4 个缓存方法 | 退化为空实现（评分链路不走缓存） |
| 全局 `logger` | `components/Data.js` 的 `delFile` | 改 `console.error` |
| `Common`（渲染）/ `App`（应用） | `components/index.js`；`ProfileDmg` 引它只为 `calc_auto`（组团伤害）分支 | 从入口摘掉（本项目无人引用）；`ProfileDmg` 里那个分支一并移除 |
| 云崽模型 `User` / `MysApi` / `Player` / `Abyss` … | `models/index.js` | 从入口摘掉，连同顶层副作用 |
| `Cfg`（用户配置） | 依赖 `cfg/CfgData.js` → 217 行 `cfg_system.js` schema | **已删除**：唯一活调用点 `Format.js` 的千分位分组数恒为 3，已写死（`vendor/miao` 现不再含 `Cfg`） |
| `Version`（宿主版本检测） | 读 `package.json` / `CHANGELOG.md`、辨别 Yunzai V2/V3 | **已删除**：只被 `Cfg` 内部恒 false 的 `isMiao` 分支引用，纯死代码 |
| `CharImg`（渲染层） | 写死云崽路径 + 依赖 `image-size` | **已彻底移除**：图片 getter 在本项目从不被调用，连同整套图片方法一起删 |
| `lodash` | 全仓库 46 种方法 | **直接用真依赖**，不替换 |
| `image-size` | 只有 `CharImg` 用 | CharImg 已移除，故不引入 |

`components/_local/` 下的 Cfg / Version 替身文件已于 2026-11-03 全部移除（`vendor/miao` 现不再含 `_local/` 下的任何替身）；详见 `VENDOR-REPLACEMENTS.md`。
（上表说的是**内核**的依赖怎么处置。**本项目自己**的依赖另有一套口径：
`test/arch.ts` 盯着 `dependencies` 清单，当前两项 —— `lodash`（内核要的）与
`limiter`（限流的令牌桶，零传递依赖）。原则是**代码最精简 + 依赖量最小**，
允许加轻量第三方库，但加之前先算账：省下的行数配不配得上它的体积。）

### 搬运范围（为什么要搬几 MB 的代码）

除了评分算法与角色元数据，还搬了三样「容易漏掉、漏了就出不了正确分」的东西：

| 搬什么 | 为什么必须要 |
|---|---|
| `models/attr/`（`Attr.js` + `AttrData.js`） | 76 个角色规则文件里 **55 个要读 `attr.xxx`**（如胡桃的核爆判定 `attr.cpct < 15 && attr.cdmg > 280`），而 `attr` 不是数据源给的 —— 是 miao 自己按「基础值 + 武器 + 圣遗物」算的（`models/Avatar.js:320`）。 |
| `resources/meta-gs/weapon/`（**只搬数据，不搬图片**） | 上面那个 `Attr.calc()` 要用 `Weapon.calcAttr()` 和 `weaponBuffs`。同目录下的 `icon/gacha/awaken.webp` 占 21 MB，评分用不到，全不搬。 |
| `models/dmg/` + `models/ProfileDmg.js` + 每个角色的 `calc.js`（一个角色一个） | 伤害计算（详见下节）。引擎 6 个文件约 1250 行纯计算；角色脚本按目录动态读取，闭包扫不出来，只能按 GLOBS 规则搬。 |

另外 `src/index.ts` 里的元数据注册是「谁 import 谁登记」：漏 import 一个 `resources/meta-gs/*/index.js`，
对应模型就会静默返回 `false`（我们踩过一次 —— `Weapon.get()` 全返回 null，界面上武器显示「未识别」）。

### 伤害计算：ProfileDmg + 每角色一个 calc.js

miao 面板下方的「伤害计算」是它**自研**的，没有基于外部库。常被提到的「冰翼」不是库、
是人 —— miao-plugin 的核心贡献者，129 个角色脚本里绝大多数署名是他（`calc.js` 里的
`export const createdBy = '冰翼'`），CHANGELOG 里也能看到他的提交。

构成分两层：

- **引擎** `models/dmg/`（6 个文件约 1250 行）：`DmgCalc` 是各区乘算的公式本体（攻击区 ×
  增伤区 × 暴击区 × 防御区 × 抗性区 × 反应区），`DmgAttr` 管属性计算与 buff 施加，
  `DmgBuffs` 汇总武器 / 圣遗物套装 / 角色三方 buff，`DmgCalcMeta` 是等级与反应基础表。
- **角色层** `resources/meta-gs/character/<角色>/calc.js`：每份导出 `details`（伤害条目，
  形如 `dmg(talent.a['重击伤害'], 'a2', 'vaporize')`）和 `buffs`（命座 / 天赋 / 专武交互）。
  旅行者按元素分开放 `旅行者/<元素>/calc.js`。

编排在 `ProfileDmg.calcData()`：加载 calc.js → `DmgAttr.getAttr`（吃 `profile.attr` 打底，
即 `Attr.calc()` 的产出）→ `getBuffs` → `calcAttr` 逐条目施加 → `getDmgFn` 出 `{ dmg, avg }`。
本项目的出口是 `src/gateway/miao/damage.ts` 的 `calcDamage()`（归一化 + 单角色炸了不拖垮整页），
数据库对象到它的桥在 `gateway/miao/materialize.ts` 的 `toMiaoProfile()`（`MiaoProfile.talent` 就是为它补的 —— 缺了天赋等级，
内核按 1 级算，伤害凭空低一大截）。

**对拍方法论**：数值不与「社区攻略」比，只与原版 miao 逐字一致。`.tmp/dmg-parity/run.ts`
拿同一个 profile 过原版 `ProfileDmg`（在 miao-plugin 原地跑）与我方 `calcDamage`，diff 为空
才算搬对；基线固化进 `test/damage.ts` 硬断言。跑对拍要两样临时物（脚本头部有说明）：
miao-plugin 下的 stub `node_modules`（原版链路 import 得到 moment / image-size / node-fetch，
但伤害路径不调用），以及一个目录联接 —— 原版 `Data.getRoot('miao')` 写死云崽布局
`<rootPath>/plugins/miao-plugin/`，而原版 `rootPath` 是 miao-plugin 的上两级。
**跑完即删，不进仓库。**

⚠️ 一个真实的漏搬教训：旅行者的 `data.json` 在 `旅行者/<元素>/` 下（深度 2），
深度 1 的 GLOBS 只搬得到索引级的 `旅行者/data.json`（没有 `talentData`）——
内核 `getDetail()` 却按 `旅行者/<elem>` 取数，少这一层旅行者伤害必炸。
所以 GLOBS 里 `data.json` 有深度 1 和深度 2 两条。

**页面接线**（2026-10-13）：`GET /api/accounts/:uid/characters/:avatarId/damage` 出视图对象
（`character.service.ts` 的 `damageOf`：`Format.comma(v, 0)` 格式化 + buff 串按「：」拆两列），
明细页在圣遗物卡下方异步拉它、画一张 miao 同款表（`detail.js` + `web/css/damage.css` 的 `.dmg-cont`）。
两个 deliberate 的偏差：表格用 **grid 而非上游的 display:table**（上游让不吃暴击的行把
期望值单元格设 `width:200%` 冒充跨列，自动布局下会把暴击列撑到 311px、期望列压到 56px，
「期望伤害」表头折成两行 —— 实测截图后改的）；伤害标题列允许换行（上游出图 nowrap）。
接口走**读档限流**：跑一遍内核比普通读接口贵一个量级，不设限能拿它打满 CPU。

### 同步产出

| 产物 | 内容 |
|---|---|
| `vendor/miao/VENDOR.md` | 来源、上游版本、文件数、处置方式、相对上一版的增量 |
| `docs/reports/sync-report.md` | **同步了哪些数据 / 相对上一版差在哪 / 改了什么 / 什么没动**。改动用凝练语言说清，不贴 diff —— 要逐行核对走 `git log -p` |

增量不用自己维护一份「文件清单 + 哈希」——`vendor/miao` 本来就是 git 跟踪的，
git 里逐字存着上一版的内容，「相对上一版多了什么、改了什么」直接问它就行。
基准取「最后一个动过 `vendor/miao` 的提交」，也就是上一版同步的产物：

```bash
git diff --name-status <基准提交> -- vendor/miao   # 只看增删改的文件名
git log -p -- vendor/miao                          # 逐行看改了什么
```

脚本内部同样走这条路，并且 `git diff`（已跟踪文件的变化）和 `git status --porcelain -uall`
（未跟踪的新文件 —— 新搬进来的目录在 `git diff` 里是看不见的）两个来源都取，缺一不可。

同步脚本自带四道守卫，任一不过就报错退出：

1. 相对 import 是否落地；2. `#miao*` 别名是否可解析；
3. 云崽全局变量是否零残留；4. **未知外部依赖**（只允许 lodash 与 Node 内置模块）。

---

## 二、数据通路三层，模型建在「存储」不在「计算」

完整设计见 [`DESIGN-DATA-MODEL.md`](DESIGN-DATA-MODEL.md)。一句话：**存储层存 id，不存名字。**

```
enka 原始响应
   │  ① ingest：挑字段、原始 prop id 原样保留、记来源、带走官方文案 key
   ▼
② canonical store（本地库，本地化无关）
   主键全是稳定的数字：uid / avatarId / itemId / propId / TextMapHash
   │
   ├─ ③ materialize → miao profile（id → miao 的中文名与真实对象）→ ArtisMark → 分数
   ├─ ④ localize    → 多语言文案（id → 目标语言）→ 前端
   └─ ⑤ panel-check → 拿游戏给的面板对拍 ③ 的结果，验证翻对了没有（测试件，见 test/panel-check.ts）
```

**为什么不设「enka → 自有数据模型 → 再拼回 miao」的中间层**（三条实证）：

1. **会丢信息** —— 内核的「词条数」是按 `appendPropIdList` 里**同一 key 出现几次**数出来的
   （`ArtisAttr.js` 的 `tmp[key].upNum++`）。**原样保留每一次 roll** 是硬要求：
   去重、或改存 enka 聚合好的 `reliquarySubstats`，这个信息就没了。
2. **数值口径会打架** —— 内核完全不信外部给的属性值，主词条按
   `attrCfg.value × (1.2 + 0.34 × level) × posEff × starEff` 自己算，副词条按自己的
   `attrIdMap` 每 roll 值累加。外面先解析一遍不但白做，还可能算歪。
3. **上游行为就是这样** —— miao 自己的 `models/serv/api/EnkaData.js`（106 行）
   也只做「挑字段 + 位置映射 + level 减一」，属性解析一律留给内核。
   这条边界随内核维护，另起一套就丢了同步性。

**为什么要建这层库**（两条）：

1. **enka 一次只给展柜里的角色**（约 8–12 个），玩家有 20–40+ 角色 → 必须跨多次抓取累积。
   上游自己也这么干：`EnkaApi.updatePlayer` 是 `forEach(avatarInfoList, ...)` + `player._update.push(id)`，
   并且用响应里的 `ttl` 当缓存时长。所以库里的 `saveFetch` 是**合并式 upsert**，不是覆盖。
2. **多语言** —— miao **零 i18n 能力**（见 §四），所以任何「显示英文/日文名」的需求都必须自建文案表，
   而文案表的主键只能是 id。

   好消息是**文案主键不用自己造**：enka 的 `flat` 里直接带着官方的 `nameTextMapHash` /
   `setNameTextMapHash`（实测 uid 101242308 的响应里有 132 处），那就是官方全语言文案表的主键
   —— 存下 hash，接上官方 `TextMap` 就一次性拿到全部语言，不需要我们自己翻译。
   所以这三个 hash 列（`artifact.name_hash` / `artifact.set_hash` / `weapon.name_hash`）
   在 ingest 阶段就存下来：enka 白给的东西，丢了要补只能重抓。
   唯一例外是**角色名**：`avatarInfo` 里只有 `avatarId`，没有 hash，得另配一份静态映射。

**故意不存的东西**：面板属性、分数。面板能从库行重算（且对拍只能对着原始响应做），
分数则随同步进来的权重表变化 —— 存了也要绑 `miao_version` 才敢用，不如不存。

### 评分链路上两个刻意的选择

- **打完分一定是从库里读回来再算**，而不是拿刚落库的内存数据直接算。多走一趟数据库，
  才能证明「存进去」和「读出来」是同一个东西。
- **原始响应可以另存一份**（`--save-raw <dir>`），方便复现问题和以后换解析逻辑时回放。

---

## 三、页面

页面在独立的前端子仓库 [seiten-suikyou-web](https://github.com/jhpx/seiten-suikyou-web)，母仓库以 submodule 挂在 `web/`：原生 JS + `<template>` 克隆，无框架、无 CDN。
分两个视图，都在同一个 HTML 里切换。首页与明细页都是**照着 miao 的出图还原**的。

本目录下放着两份还原用的参考稿，改版式前先看它们：

| 参考稿 | 管什么 | 怎么量 |
|---|---|---|
| `角色列表页.jpg` | 首页网格版式（原魔工具箱「角色展柜」中间那块） | 卡片填充色做 mask，行/列投影量卡宽与间距 |
| `miao结果图参考.jpeg` | 明细页对拍基准（奥黛塔 248.0 / ACE） | 用 `tools/shot.ts` 出图后人工对照 |

### 首页（账号头 + 筛选条 + 网格）

按总分降序铺成五列网格。每张卡：

- 底色是 miao 的 `common/item/bg{4,5}.png`（游戏里五星橙 / 四星紫那张底），不是自己调的渐变
- 左上角元素符号、右上角等级胶囊、右下角圣遗物评级（档位配色与 miao 一致）
- 底部白块（两种视图，筛选条中间的循环按钮切换）：
  - **武器**：左边武器图标，右边武器名 + `Lv.x · 精x`
  - **圣遗物**：每行 = 一个套装图标 + 套装名 + `×件数`，两套就是上下两行（4 件一行、2+2 两行）。
    图标是 `thumbs/<setId>/1.webp`（1 号花图裁边缩到 96px 的预处理件），在行内垂直居中，
    和那一行文字天然对齐，不用算偏移。接口的 `sets` 给全量件数（含单件），页面只列
    `count >= 2` 的 —— 1 件不激活效果，所以最多两行；一套都没有时出「无圣遗物」占位。
    白块有高度下限，最矮的卡不比武器视图矮；名字折行就让卡片自己长高。
    用花当套装代表图：每套都出全五件不缺图，且花的轮廓在套与套之间差别最大
    （沙/杯/冠缩到卡片尺寸分不出来）。

筛选条三段：**视图切换**（左）｜**排序 + 漏斗筛选**（右，两颗挨在一起）。
左边是「状态钮」（点一下就换视图，实心金底胶囊），右边两颗是「操作钮」（点开弹窗去选，
深色玻璃方角）—— 两种性质的东西分边站，框子也做成两副面孔。排序和筛选都居右：筛选是末态动作，
排序跟着它走，左边的空间留给最常用的视图切换。

- 视图切换：一颗循环按钮，点一下换下一个视图，只显示「当前是哪个」—— 加第三个视图也不用改版式
- 排序：也是**弹窗**（和筛选共用 `web/features/dialog.js` 的壳）。按钮文案自己说清当前排成什么样：
  单条件「排序：评价等级 ↓」（字段 + 方向），多条件「排序：条件排序」（全铺上去按钮放不下）。
  弹窗里编辑的是草稿（升降序 / 上下移 / 移除 / +），确定才写回
- 筛选：点漏斗弹出居中大框，稀有度 / 元素 / 圣遗物套装 / 评价等级 / 评价权重五个维度都能多选 —— 维度内 OR、维度间 AND
  （选了火+水又选「吃暴击」，出的是「火或水里吃暴击的」）。
  ⚠️ 组名要写全（评价等级 / 评价权重，不是「等级」「权重」）：「等级」会被读成角色等级，
  「权重」两个字单独挂着看不出是「评价用的权重」。弹窗里勾的是草稿，点「确定」才写回并重画网格，
  「取消 / Esc / 点遮罩」丢弃草稿 —— 否则每勾一下整页闪一次，取消也没有意义。
  用 chips 而不是三个独立下拉：「同时看火和水」是常见需求，单值下拉逼着用户来回切。
  **评价权重**那一组的选项 = 「这个角色吃哪条属性」（权重表里该项不为 0），十项：
  生命 / 攻 / 防 / 精通 + 双暴 + 充能 + 三种加成（元素伤 / 物伤 / 治疗）—— 顺序照面板从上往下读，
  加成按用得多寡排（元素伤 >> 物伤 > 治疗），治疗垫底。
  ⚠️ `dmg` 那条显示**官方全称「元素伤害加成」**，不是 miao 表里那句简称「伤害增加」——
  三行加成连着读，简称看不出是哪个加成。改在 `artifact.service.ts` 的 `STAT_TITLE_FIX`（圣遗物与词条的「显示脊柱」已抽到该叶子模块，改上游表会被同步覆盖）。
  只收权重表里**真会出现**的键；大/小词条（atk / atkPlus…）永远成对出现、权重相等，所以一条只挂一个键。
  选中数在漏斗图标上挂角标

所有尺寸用 `cqw`（= 卡片宽度的 1%），配合 `container-type` —— 同一套版式桌面一张卡 90 px、
手机 63 px，字号和内边距都跟着缩。写死 px 不是桌面太小就是手机溢出。

### 明细页（评分卡）

`web/css/detail-base.css`、`score-card.css`、`item-card.css`、`damage.css` 是 miao 的
`resources/character/profile-detail.css` **照抄**后按模块拆开的移植版，不是凭印象画的。

设计前提：miao 的那张结果图是**一张固定 600 px 宽的画布**。要长得像就不能拆成流式响应式布局
—— 这里照搬 600 px 画布，再由前端的 `detail.js`（`fitDetailZoom`）用 `zoom` 把整张画布等比缩到屏幕宽度。
缩下来就是同一张图的缩小版，构图与 miao 出图一致。

结构（照抄上游，不自己发明）：

```
.basic            立绘（1400×500 左溢出、margin-left:-545px）
                  右上角浮信息：角色名 / UID-Lv / 天赋 a e q / 8 行属性表
                  左下角 6 个命座、右下角数据时间
.arti-mark-cont   左：圣遗物总分 + 评级（按档位配色）；右：有效词条汇总 + 评分规则
.artis            武器卡 + 5 件圣遗物卡（185px 宽，一格一个）
```

### 图片素材

`vendor/miao/` 只同步代码与元数据，**不同步二进制图片**（太大）。页面要还原 miao 的评分卡，
需要三类素材：角色立绘、圣遗物/武器图标、UI 小图。它们落在前端子仓库的 `web/assets/`，
**随子仓库提交**（约 100 MB，跟着角色/套装数增长）—— 重建依赖本地 miao-plugin 目录在、且版本对得上，
换了机器素材不能凭空长出来。更新用 `python tools/sync.py assets`（全量复制，命令见 README）。

几个设计点：

- **从本地 miao-plugin 全量复制，不走网络**：素材本来就躺在 miao 仓库的 `resources/` 里，
  再绕网络下一遍只会白继承「国内连不上 + 连不上当 404 静默跳过」两个坑。
- **不猜名字表**：源目录里有什么就拷什么。按 id 反查名字再拼 URL 的办法覆盖不全
  （新角色没进表、圣遗物 id 对不上），结果是零星角色／套装整片缺图。
- **原图是上游原样，`thumbs/` 是本地加工件**：`thumbs/` 是三类小图，
  都按数字 id 定位、独立存放，生成入口 `tools/gen_flower.py`。圣遗物按 enka `setId` 分目录
  （原图透明留白不统一，要**裁边**，96px，`1~5.webp`），武器按 miao `itemId` 平铺、不分类型
  （原图几乎满格，**只缩不裁**，96px），头像按 `avatarId` **分目录放 `face.webp`**（形状照圣遗物：
  id 当文件夹、文件名说清是哪张，以后加圆框版/方卡版就收同一目录；**只缩不裁**，**196px** ——
  首页画到 107px、2 倍屏要 214 设备像素，96px 在那儿是拿小图撑大）。首页卡片和模拟器的小格用小图，
  明细页 100px 的卡仍用原图；头像例外，明细页立绘走 `splash`，face 全站只当小图用。
  角色素材因此**只同步 `imgs/splash.webp` + `icons/`**：`imgs/face.webp`（127 张 5.8MB）有了
  thumbs 就是同一批像素的两份；`imgs/card.webp` / `imgs/banner.webp`（131×2 张 12.5MB）前端
  从未引用。三类合计 18.3MB 已删，头像原件的唯一来源是 miao-plugin 本身
  （`gen_flower.py` 直接读它，不经 `web/assets` 中转）。
  `tools/list_assets.ts` 只用来对账：问页面会请求哪些图，跟实际拷进来的比一遍。
- 元素符号不在 miao 仓库里，已随子仓库提交，不由同步脚本生成。
- 404 / 缺图不报错，页面回退到 CSS 色块占位。

---

## 四、多语言：为什么是两张表

`src/common/` 分两张表，因为它们的**来源和性质完全不同**：

| | `vendor/i18n/` | `src/common/ui.ts` |
|---|---|---|
| 内容 | 游戏内文案：角色 / 武器 / 圣遗物部件 / 套装 / 部位 / 词条名 | 界面文字：刷新、搜索角色、面板属性、命之座… |
| 来源 | enka `store/gi/`（角色/武器/套装/词条，**原样复制**）+ 官方 `TextMap`（**只为部件名**，提取件） | 手写（官方表里没有这些说法） |
| 主键 | hash / avatarId / itemId / setId | 英文 key |

**为什么两个源**：enka 的 `store/gi/{locs,avatars,weapons,relics}.json` 跟着它线上口径走，新角色新套装
一上线就有（旧 TextMap 快照连「奥黛塔」都还没有）；但 enka **不收录圣遗物部件名**
（「魔女的炎之花」这类，它自己的网页也不显示），所以那一类只能继续从 TextMap 取。

两张表由 `src/common/i18n.ts` 统一出口：认语言（`resolveLocale`）、把界面文字包一层再给出去。
**别再把这个包装放回 `names.ts`** —— 那样 `names` 要引 `ui`、`ui` 又要从 `names` 拿默认语言，
两个文件互相 import（`test/arch.ts` 有一条断言钉着这个方向）。

**前端一个词条名都不写死** —— 部位名、词条名、套装名、角色名、武器名全是后端按 `locale` 给好的文本；
连按钮和分组标题都从 `/api/meta` 的 `ui` 表来。加一门语言不用动前端，
这也是为什么界面文字要单独手写一张表：官方 TextMap 里根本没有「刷新」「圣遗物」这种我们自己页面的说法。

**miao 侧零 i18n 能力**：`resources/` 全是中文，角色目录名就是中文（`character/胡桃/`），
权重表 / 套装缩写 / 武器特判全用中文名当键，全仓库零 `TextMapHash` 使用。
所以翻译只能挂在我们自己的出口上，内核那边一个字都不能动 —— 动了分数就可能变。

**`vendor/i18n/` 的形状就是上游的形状**（用户明确要求：能原样的原样，好对着上游看 diff）：
enka 的 `locs/avatars/weapons/relics.json` 是**字节级复制**，上游一更新 `git diff` 就知道哪条变了；
只有 TextMap 没法原样（单语言 43 MB），才做提取件 `textmap/*.json`（`{hash: 文案}`，只留部件名）。

名字表的三个坑，都在脚本注释里记着：

1. **部件名一个 itemId 对应一个 hash**，直查即可 ——
   库里的 `name_hash` 与 `ReliquaryExcelConfigData` 里同一 itemId 的 `nameTextMapHash` **逐条一致**
   （实测全库 250 件：239 一致、0 不一致、11 件上游还没有）。
2. **词条名不能走 hash** —— 走 enka 的 `FIGHT_PROP_*` 区块，它和 miao 的 `StatType` 一一对应，没有歧义。
3. **套装身份必须是 `setId`** —— enka 玩家接口给的是 `setNameTextMapHash`
   （千岩 1337665995），那个 hash **在 enka 的 locs.json 里查不到名字**：它和 locs 用的 `locHash`
   （千岩 4007101907）是两个空间，拿它查表整套都会变成「未知套装」。
   能查到名字的只有 `itemId → setId（15017）→ Sets[setId].Name → locs`。

表不在时**静默降级**成只有中文（`i18n.available()` 返回 false，页面会提示），不会崩。
每次同步产出 [`reports/i18n-report.md`](reports/i18n-report.md)：各类别条目数、每语言命中率、
上游滞后预警（enka 已有的套装里，哪些的部件名 TextMap 还没收）。

---

## 五、工程约束（改代码前先读，逐条都有过教训）

1. **圣遗物只喂部件名 + 原始 prop id**（`name` / `level` / `star` / `mainId` / `attrIds`），
   主副属性值一律由内核自解。手工构造 profile 时也别自己算属性值。
2. `vendor/miao/` 与 `vendor/i18n/` 是生成物，手工改动会被下次 `npm run sync` 覆盖。
   要改行为，改 `tools/sync_miao.py` 的清单或补丁。
   **「更新上游」是一个动作**：`npm run sync` 一条命令跑完三步
   （内核+权重表 → 多语言表 → 图片素材，顺序有依赖：i18n 要知道现在有哪些角色才能提取名字）。
   上游 miao-plugin 永远比我们新，这是正常的 —— 所以这个命令会反复跑，不该拆成三步让人挑。
   跑之前可以先 `npm run sync:check` 看差异规模；跑完**必须** `npm test`，
   权重表变了评分基线就会变（逐项核对差异是上游修正还是我们回归，别直接改基线了事）。
3. ~~`Cfg` / `Version` 两个云崽替身在 2026-11-03 已删除~~（原：恒为空配置、复刻「读不到配置文件」行为）。
   删除依据：`Cfg` 唯一活调用点 `Format.js` 的千分位分组数在本项目恒为 3，已写死；`Version` 只被
   `Cfg` 内部恒 false 的 `isMiao` 分支引用。详见 `VENDOR-REPLACEMENTS.md`。
4. **目录层级是硬约束**：`tools/path.js` 靠自身位置推算 miao 根，`Data.getRoot('miao')` 依赖它。
   所以 `vendor/miao/` 这一层不能拍平（`Format.js` 通过 `#miao` 取 `Data` / `Meta` 等仍在用的组件）。
5. **圣遗物 level 的基数**：内核要 0 基（5★ 满级 = 20）。enka 给的是 1 基（实测满级 = 21），
   所以 `src/gateway/miao/materialize.ts` 组装 profile 时对 enka 减 1 —— 就这一处，不另立模块。
   库里存的是原始值 + 来源，万一推断错了改这一行就能全量重算，不用重新抓。
6. **`test/fixtures.ts` 的词条 key 与 miao 规范相反**：它把大/小词条写反了
   （花的主词条写成 `hp`，按 miao 的 `mainIdMap` 小生命是 `hpPlus`、大生命才是 `hp`；
   羽毛的主词条同理应是 `atkPlus`）。因为 1/2 号位的主词条不参与评分、且胡桃的大小生命/攻击权重相同，
   所以基线数字没受影响，但它不是一份「规范数据」。要扩测试建议先改规范并重生成基线。
7. 当前 miao-plugin 是 zip 下载（无 `.git`），同步靠目录复制，无法锁定 commit。
   若想版本化，建议单独 `git clone` 一份作为上游源。
8. **改库结构不用加迁移**：`config/schema.ts` 的 drizzle 表定义是单一事实来源，`openDb` 打开时按它
   现算 DDL 跑一遍（空库建表、老库表在就不碰）。数据可从 enka 重抓，所以不记迁移历史——改了表定义
   后老库请删文件重抓（或开发期 `npx drizzle-kit push` 就地 ALTER）；打开到比 `SCHEMA_VERSION` 旧的库会
   直接抛错提示删库。表定义与实际建表必须一致（`test/pipeline.ts` 断言「空库的列 == 表定义的列」）。
9. **不改 `.gitignore` 里的 `data/` 前缀**：它是 `/data/`（锚定仓库根）。
   写成不带斜杠的 `data/` 会连带忽略 `test/data/`（Git 的目录模式不限层级）。
   ⚠️ `web/assets/` 是**相反**的一例：它**故意提交**（约 100 MB / 1886 个文件）——
   前端已拆成独立子仓库 seiten-suikyou-web，素材随那个仓库提交，母仓库这边只存子模块指针。
   理由是重新跑素材同步（`python tools/sync.py assets`）依赖本地那个 miao-plugin 目录在、且版本对得上，换了机器素材就全没了。
10. **面板对拍只能在测试里、对着原始响应做**，不能对着库做 —— 因为我们**故意不存面板属性**
    （理由见 [`DESIGN-DATA-MODEL.md`](DESIGN-DATA-MODEL.md) §3）。所以它是 `test/panel-check.ts`，
    由 `test/pipeline.ts` 硬断言，命令行不提供 `--check` 开关。
11. **同步完记得提交**：报告里「相对上一版」的基准是**最后一个动过 `vendor/miao` 的 git 提交**。
    不提交的话，它只能告诉你「自上次提交以来没变」，看不出这一轮到底搬了什么。
12. **测 CLI 要断言「该打印的段落在不在」，光看退出码不够**。`test/cli.ts` 就是干这个的。
    来历：`src/cli/score.ts` 的汇总段曾用了未定义的 `r`（正确写法 `for (const r of sorted)`），
    异常被外层 `catch` 吞掉后**提前返回**，汇总段及其后的输出整段不执行 —— 而进程退出码当时还是 0，
    `npm test` 全绿，只有真跑一遍命令行才看得见。所以那套测试必须把「汇总」这类
    段落本身钉住，不能只断言 `code === 0`。
13. **评分权重表不是每个角色都有的**。上游 `artis-mark.js` 的 `usefulAttr` 收录不全时，
    内核拿通用表兜底（`ArtisMarkCfg.js:99`：`atk75/cpct100/cdmg100/dmg100/phy100`），
    但标题照旧拼 `${char.abbr}-通用` —— 看着像上游给这个角色定过一套权重。
    所以内核在 `getCfg` 里透出 `isDefaultWeight`，视图成型（`service/character.service.ts` 的 `classTitleOf`）
    据此把前缀换成「默认」：**默认-通用**。只换前缀、保留规则词（通用/护摩/绝缘4），
    「用的哪套权重」和「命中哪个规则」仍然分得开。
    同步上游会自然消掉这件事（沃雅妮莎、薇斯纳就是 2026-10-06 同步时补进来的），
    但下一个新角色还会再走一遍兜底 —— 这个标识就是给那时候准备的。
14. **「通用」不是「权重来自权重表」**（2026-10-06 核实）：`def(attrWeight, title = [])` 的 `title`
    为空才落成 `'通用'`，所以它标记的是**这次没命中任何特判分支**。
    实测 121 个角色：查总表 46 / **专属规则默认分支 69** / 特判分支 5。
    后 69 个的默认分支写的是 `return def(usefulAttr['X'])`（引用总表原值），**68 个与总表逐字一致**；
    唯一例外是 **迪希雅**（`def({hp:75,…,recharge:75})` 手写一整套，recharge 55→75、mastery 整个删掉，
    却也叫「迪希雅-通用」）。→ 我们加了第二个标记 `isCustomWeight`，前缀显示「自定义-通用」；
    内核只在 `title === '通用'` 时为它置真（特判分支标题已自带规则名，再标是重复信息）。

    规则名的两个前缀各回答一个问题，**不能互相吞**：

    | 前缀 | 回答 | 内核标记 |
    |---|---|---|
    | 角色缩写（`七七-通用`） | 用的哪套权重：权重表那一行 | 无 |
    | 自定义（`自定义-通用`） | 用的哪套权重：专属规则手写 | `isCustomWeight` |
    | 默认（`默认-通用`） | 用的哪套权重：表里没这角色，内核兜底 | `isDefaultWeight` |
    | 后半段（`通用`/`纯火`/`绝缘4`） | 命中了哪个规则 | 内核 `title` |

    ⚠️ `isDefaultWeight` 必须**无条件**改前缀：`def()` 内部的绝缘4/西风特判对兜底角色同样生效，
    写成「标题带规则词就不改」会漏掉「默认-绝缘4」。
    ⚠️ 比对权重差异时**「缺失的键」必须与 0 视为等价** —— 直接 `JSON.stringify` 比会把「缺 4 个 0」误判成不一致。

15. **分层方向不许反向**（2026-10-18 定稿，三层半架构）：`rest → service → { repository, gateway }` 只能从上往下引；
    `gateway/enka` 与 `repository/dbo` 是叶子适配层（只认 dbo / common / 三方），`common` / `config` 是底层叶子，不参与竖向流水线。几条硬规矩：
    控制器只认 `service/context.ts` 这一份能力契约（**不给 db**，否则迟早顺手拼个 SELECT）；
    `rest/` 控制器平铺、不许 `rest/controllers/`；`server/` 只装配（URL 表在 `routes.ts`，
    装配顺序 cors → 路由 → 静态 → 兜底）。全部由 `test/arch.ts` 断言钉住，改结构先跑它。

---

## 六、下一步

1. 把多语言覆盖到**剩余的中文字面**：规则名（`classTitle`，miao 自己的中文串）。
   意译表 `src/common/rubric-names.ts` 还缺几条，en 下目前有 6 条退回中文
   （雷神-薙刀、莱依拉-西风、夏洛蒂-西风、希诺宁-西风、伊安珊-西风、雅珂达-西风）。
   角色 / 武器 / 套装 / 部件 / 元素名都已走官方文案表，不用再管。
2. 首页角色卡的进一步还原（排列/密度可调），以及明细页与 miao 出图的逐像素对拍。
3. 圣遗物按「单件分」排序、以及词条有效率的柱状对比 —— 数据都已经在接口里了，只差排版。
4. miao 面板还有一张「换主属性伤害对比」矩阵（`calcData` 的 `dmgRet`），要不要一并展示届时定。
