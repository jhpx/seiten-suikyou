# miao 内核同步报告

- 同步时间：2026-10-31 00:39:05
- 上游来源：`E:/Workspace-Private/workspace-javascript/miao-plugin`（miao-plugin v2.3.3）
- 搬运文件：658 个 / 4102.4 KB
- 处置方式：**原样搬运 649 个**　|　定点改写 9 个　|　本地生成 2 个
- 增量基准：最后一个动过 `vendor/miao` 的 git 提交
- 相对上一版（提交 `91d1018`）：新增 0 个　|　移除 0 个　|　内容变化 0 个　|　未动 660 个

搬运范围：components（6）、models（26）、resources（625）、tools（1）

---

## 一、同步了哪些数据

**结论先行：658 个文件里 649 个是逐字节原样搬运的，一行没改。**
被改写的只有 9 个「和云崽机器人运行时绑定」的代码文件（第三节），
另有 2 个文件是本项目手写的（第四节）。

### 1.1 清单（按类别）

| 类别 | 数量 | 内容 |
|---|---|---|
| miao 入口与组件 | 6 | `#miao` 入口、`Data`（路径与 JSON 读取）、`Meta`（元数据注册）、`Format`（数值格式化）、`MiaoError`、`common/Elem`（元素表） |
| 评分算法 | 5 | `Artis` / `ArtisAttr` / `ArtisMark` / `ArtisMarkCfg` / `ArtisSet` —— 评分内核本体 |
| 面板属性计算 | 2 | `Attr`（面板计算）＋ `AttrData`（属性基准表）—— 角色评分规则要读 `profile.attr` |
| 伤害计算引擎 | 6 | `DmgCalc`（各区乘算的伤害公式）＋ `DmgAttr`（属性计算与 buff 施加）＋ `DmgBuffs`（武器/圣遗物/角色 buff 汇总）＋ `DmgMastery`（元素反应系数）＋ `DmgCalcMeta`（等级与反应基础表）＋ `AttrItem` |
| 伤害计算编排 | 1 | `ProfileDmg` —— 加载角色 `calc.js`、组装属性与 buff、逐条算伤害的入口（只取它的 `calcData`，云崽那套模板渲染不要） |
| 角色元数据 | 5 | `CharCfg`（读角色评分规则）、`CharId`、`CharImg`、`CharMeta`、`CharTalent` |
| 领域模型 | 7 | `Base`、`Character`、`Weapon`、`Artifact`、`ArtifactSet`、`Material` ＋ `models/index.js` 入口 |
| 路径工具 | 1 | `path.js` —— `#miao.path` 别名的目标 |
| 角色数据 | 344 | 每个角色一个目录：`data.json`（等级/突破/天赋等基础数据）＋ `artis.js`（该角色的评分规则）＋ `calc.js`（该角色的伤害计算脚本，旅行者按元素分开放 `旅行者/<元素>/`）；另有 4 个索引文件（`index` / `alias` / `extra` / `data.json`） |
| 武器数据 | 271 | 每把武器一个目录的详情 `data.json`（按单手剑/弓/法器/双手剑/长柄武器 5 类分目录）＋ 每类的 `calc.js`（武器特效数值换算）＋ 4 个索引文件 |
| 圣遗物数据 | 6 | 部位与套装数据、副词条基准、评分权重表（`artis-mark.js`） |
| 素材数据 | 4 | 突破素材（`CharMeta` 引用了 `Material` 模型）、素材缩写、每日材料 |

### 1.2 资源数据的构成

- **角色数据 344 个** = 127 个角色的 `data.json`（等级 / 突破 / 天赋等基础数据）＋ 76 个角色的 `artis.js`（该角色专属的评分规则，并非每个角色都有）＋ 129 个角色的 `calc.js`（该角色专属的伤害计算脚本，并非每个角色都有；旅行者按元素分 7 份）＋ 4 个索引文件（`index` / `alias` / `extra` / `data.json`）
- **武器数据 271 个** = 257 把武器的详情 `data.json`（单手剑 60、法器 57、弓 51、双手剑 46、长柄武器 43）＋ 5 类各 1 个 `calc.js`（武器特效数值换算）与 1 个类型级 `data.json` ＋ 4 个索引文件（`index` / `alias` / `desc` / `extra`）
- **圣遗物数据 6 个** = 部位与套装数据（`data.json`）、副词条基准（`calc.js`）、评分权重表（`artis-mark.js`）、别名、`extra`、`index`
- **素材数据 4 个** = 突破素材（角色元数据引用了 `Material` 模型）、素材缩写（`abbr.js`）、每日材料（`daily.js`）、`index`

只搬原神（`meta-gs`）。星穹铁道（`meta-sr`）不搬；图片资源（`icon` / `gacha` / `awaken.webp`，约 21 MB）也不搬 ——
评分是纯计算，用不到图。

### 1.3 生成物

上游没有这 2 个文件，是同步脚本写的；另有一份来源记录 `VENDOR.md` 一并写出（不计入「生成文件」数）。

| 文件 | 说明 |
|---|---|
| `components/_local/Cfg.js` | 云崽用户配置的最小替代（详见第四节） |
| `components/_local/Version.js` | 云崽版本检测的最小替代（详见第四节） |
| `VENDOR.md` | 来源记录：上游路径 / 版本 / 同步时间 / 文件数 / 别名映射 |

---

## 二、相对上一版差在哪

基准是提交 `91d1018`（2026-10-31 00:38:55 +0800）—— 也就是上一版同步的产物。

差异由 git 给出：`git diff` 负责已跟踪文件的变化，`git status` 补上未跟踪的新文件
（同步新搬进来的目录在 `git diff` 里是看不见的）。`VENDOR.md` 每次重写，一律排除。

- 新增 **0** 个　- 移除 **0** 个　- 内容变化 **0** 个　- 未动 **660** 个

### 新增（0 个）

（无）

### 移除（0 个）

（无）

### 内容变化（0 个）

（无）

---

## 三、定点改写：9 个

改写原则：**评分算法与资源数据一律不动**。被处理的只有和「云崽机器人运行时」绑定的部分 ——
云崽注入的全局变量（`redis` / `logger`）、渲染组件、云崽专属模型。
别名 `#miao` / `#miao.models` / `#miao.path` 一概不改写，由 `package.json` 的 `imports`
字段映射到 `vendor/miao` 下的真实文件；所以 import 层面的变化只出现在下面这些入口文件里。

### `components/index.js`

摘掉云崽专属组件（Common 渲染 / App 应用）；Cfg 与 Version 指向本地最小实现

- import：移除 `./Common.js`、`./Cfg.js`、`./Version.js`、`./App.js`；新增 `./_local/Cfg.js`、`./_local/Version.js`

### `components/Data.js`

getRoot 的 miao 分支改为直接指 miao 根；4 个 redis 缓存方法退化为空实现；logger 改 console

- import：改写 `import { rootPath } from '#miao.path'` → `import { rootPath, miaoPath } from '#miao.path'`

### `models/index.js`

摘掉云崽专属模型（User / MysApi / Player / Avatar / Abyss…）与其导致的顶层副作用

- import：移除 `node:fs`、`./Abyss.js`、`./RoleCombat.js`、`./HardChallenge.js`、`./Player.js`、`./Avatar.js`、`./ProfileDmg.js`、`./ProfileRank.js`、`./User.js`、`./MysApi.js`、`./Button.js`、`#miao.path`

### `tools/path.js`

rootPath 由「miao 的上两级」改为 miao 根（本项目没有云崽宿主）

### `models/character/CharCfg.js`

移除星穹铁道（sr）初始化与分支

### `models/artis/ArtisMarkCfg.js`

def/getCfg 透出 isDefaultWeight（表里没这个角色、走通用兜底）与 isCustomWeight（专属规则默认分支手写了权重）

### `models/character/CharImg.js`

整体替换为置空实现（渲染层，写死云崽路径且依赖 image-size）

- import：移除 `node:fs`、`node:path`、`node:url`、`lodash`、`image-size`、`#miao`、`#miao.path`

### `models/Base.js`

缓存定时器加 unref（原版 10 分钟 setTimeout 会把一次性脚本拖住）

### `models/ProfileDmg.js`

摘掉云崽专属依赖 Common（组团伤害的 teamCalc 配置项，云崽聊天层才有）；calc_auto 分支随之一并移除

- import：改写 `import { MiaoError, Meta, Common } from '#miao'` → `import { MiaoError, Meta } from '#miao'`

> 这里只讲「改了什么」，不贴 diff。要逐行核对：`git log -p -- vendor/miao/<文件>`。
> 资源数据（625 个）在本节没有任何条目 —— 因为它们一个字都没改。

---

## 四、本地生成：2 个

这两个文件不是上游内容，由同步脚本生成（内容写死在 `tools/sync_miao.py` 里，要改得改脚本）。

### `components/_local/Cfg.js`

**云崽用户配置的最小替代**

上游 `Cfg` 的依赖链是 `Cfg → cfg/CfgData → config/system/cfg_system.js`（217 行 schema），整条链是为「云崽用户在聊天里改插件配置」服务的，本项目没有这层交互。评分链路只用到它的两个布尔开关（`notReleasedData` / `qFace`），所以这里复刻上游「读不到配置文件」的行为（配置恒为空对象）。⚠️ 但 `get` 查不到时必须返回调用点给的 `def`，不能返回 `undefined`：上游的 `cfg` 是 schema 合并出来的、永远不为 undefined，那句 `isUndefined(cfg) ? def : ret` 是死代码，实际生效的就是 schema 默认值 —— 我们手上没有 schema，只能用调用点自带的默认值还原它。最要紧的一处是 `components/Format.js` 的 `Cfg.get('commaGroup', 3)`：schema 里 commaGroup 的 def 也是 3，返回 undefined 会让全站数字丢掉千分位（`+4778.6` 而非 `+4,778.6`）。

### `components/_local/Version.js`

**云崽版本检测的最小替代**

上游 `Version` 读 `package.json` / `CHANGELOG.md`，并检测宿主是 Yunzai V2 / V3 还是 AlemonJS，这些概念在本项目里都不存在。评分链路只用到 `Version.isMiao`（上游在云崽下为 true，这里恒 false）。

---

## 五、没有改动的部分：649 个

除上面「改写的 + 生成的」以外，其余文件全部逐字节复制，同步脚本对它们零编辑：

| 目录 | 总数 | 未改动 | 改过的（见第三节） |
|---|---|---|---|
| `components/` | 6 | 4 | `Data.js`、`index.js` |
| `models/` | 26 | 20 | `Base.js`、`ProfileDmg.js`、`artis/ArtisMarkCfg.js`、`character/CharCfg.js`、`character/CharImg.js`、`index.js` |
| `resources/` | 625 | 625 | —— 全部原样 |
| `tools/` | 1 | 0 | `path.js` |

资源数据是最能说明问题的一块：角色基础数据、角色评分规则、武器数据、圣遗物权重表、素材数据
全部属于「数据」而非「逻辑」，本项目一个字节都不碰。想确认有没有被悄悄改过，
`git log -p -- vendor/miao/resources` 一卷就到底了。

---

## 六、校验

每次同步都跑这四道守卫，任何一道不过就整体报错退出（报告照样生成，下面如实记录本次结果）：

- ✓ 通过 —— 相对 import 全部指向已搬运的文件
- ✓ 通过 —— `#miao*` 别名全部能在 `package.json` 的 `imports` 中解析
- ✓ 通过 —— 无云崽注入的全局变量残留（redis / logger / Bot / segment / Renderer / Yunzai）
- ✓ 通过 —— 无未知外部依赖（只允许 `lodash` 与 Node 内置模块）

## 附：怎么自己核对

搬运落地的每个文件都在 `vendor/miao/` 下、由 git 跟踪，所以核对不需要额外的清单文件：

```bash
git log -p -- vendor/miao                     # 逐行看改了什么
git diff --name-status <基准提交> -- vendor/miao   # 只看增删改的文件名
```

哪个文件属于「原样搬运」还是「定点改写」，第五节的表已经列全。
