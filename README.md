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
npm test       # 全量测试：内核能加载、架构边界没烂、分数没变
```

三条原则：

1. **能原样搬就原样搬** —— 不为了「干净」而重写上游代码。239 个文件里 232 个是逐字节复制。
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

### 同步产出

- `vendor/miao/VENDOR.md` —— 来源、上游版本、文件数
- `docs/sync-report.md` —— **逐文件 unified diff**：哪个文件改了什么、为什么改、import 怎么变的

### 相比早期方案

早期用 Node 的 ESM loader hook 在运行时劫持 import 指向外部 miao-plugin 目录。已废弃，因为：
项目依赖一个外部目录才能跑、边界模糊、IDE 跳转和静态分析全部失效、必须用 `--import` 启动。
现在**仓库自包含**：`node test/verify.mjs` 直接跑。

## 目录结构

```
seiten-suikyou/
├── src/index.js              # 本项目自己的代码：注册元数据 + 原样导出评分模块
├── vendor/miao/              # 从 miao-plugin 搬运的源码（sync 生成，勿手工编辑）
│   ├── components/index.js   #   `#miao`        入口（已摘掉 Common / App）
│   ├── models/index.js       #   `#miao.models` 入口（已摘掉云崽模型）
│   ├── tools/path.js         #   `#miao.path`   路径工具（零云崽依赖）
│   └── components/_local/    #   本项目手写的最小实现：Cfg / Version
├── tools/sync_miao.py        # 同步脚本（搬运 + 补丁 + 校验 + 报告）
├── docs/sync-report.md       # 每次同步生成的对比文档
└── test/
    ├── fixtures.mjs          测试用角色/圣遗物数据
    ├── smoke.mjs             冒烟：内核能否脱离云崽独立加载
    ├── arch.mjs              架构契约：别名解析 / 依赖策略 / vendor 自包含
    ├── regression.mjs        回归断言：算法常量（上游更新后的安全网）
    └── verify.mjs            端到端评分验证（输出即基线，可 diff）
```

## 运行

```bash
npm install     # 只需 lodash
npm test        # 全量：smoke → arch → regression → verify
npm run smoke   # 只跑冒烟
npm run arch    # 只跑架构契约
npm run verify  # 只跑评分验证
npm run sync    # 从 miao-plugin 重新同步（需先设 MIAO_PLUGIN_PATH）
```

`verify` 的 stdout 就是「基线」——改完内核后可以
`npm run verify > .tmp/after.txt && diff .tmp/baseline.txt .tmp/after.txt`，
逐字为空才算没跑偏。所以它的断言只在失败时打印，通过时保持静默。

同步时 miao-plugin 默认在同级目录 `../miao-plugin`，可用环境变量覆盖：

```bash
MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_miao.py
```

**为什么同步脚本用 Python**：它是开发期工具，不参与运行时。Python 标准库
（`shutil` / `re` / `difflib`）写这类「复制 + 文本改写 + 出 diff 报告」的脚本更顺手，
也不会让工具代码混进 Node 的模块图。

## 依赖策略

唯一运行时依赖是 **lodash**。

它是稳定的公共库，miao 全仓库用了 46 种方法（评分内核 8 种，加载链路更多）。
早期版本自己写了 `_lodash.js` 替代 + Proxy 兜底，实测**两次因未实现的方法报错**（`isObject`、`repeat`）——
上游一旦引入新模块就得跟着补。既然它本来就是公共依赖，直接用真的。

`image-size` 不引入：唯一的使用者 `CharImg`（渲染层）已被整体置空。

## 评分调用方式

用 miao 的官方入口，不自己拼：

```js
import { ArtisMark } from './src/index.js'

const ret = ArtisMark.getMarkDetail(profile, withDetail)
// ret: { classTitle, mark, markClass, artis: {1..5}, sets, names, charWeight }
```

`profile` 需提供：`isProfile`、`game`、`id`、`elem`、`char`、`weapon`、`attr`、`cons`、`artis`。
其中 `artis` 是 `Artis` 实例（1 花 2 羽 3 沙 4 杯 5 头）。

## 已知约束

1. **圣遗物名必须是 miao meta 里的真实部件名**（如 `魔女的炎之花`），否则 `Artifact.get()` 查不到，详情模式会报错。
2. `vendor/miao/` 是生成物，手工改动会被下次 `npm run sync` 覆盖。要改行为，改 `tools/sync_miao.py` 的清单或补丁。
3. `Cfg` 恒为空配置（网页版没有配置交互层）。评分链路只用到 `Cfg.get('notReleasedData')` 和
   `Cfg.get('qFace')` 两个布尔开关，`_local/Cfg.js` 复刻了「上游读不到配置文件」的行为。
4. **目录层级是硬约束**：`tools/path.js` 靠自身位置推算 miao 根，`Data.getRoot('miao')` 依赖它。
   所以 `vendor/miao/` 这一层不能拍平，`_local/` 也必须留在 `components/` 下（`Format.js` 通过 `#miao` 取 `Cfg`）。
5. 当前 miao-plugin 是 zip 下载（无 `.git`），同步靠目录复制，无法锁定 commit。
   若想版本化，建议单独 `git clone` 一份作为上游源。

## 下一步

1. `adapter/` —— enka 数据 → miao profile 转换（唯一需要认真对齐字段的地方，配单元测试）
2. `server/` —— Fastify 起 API
3. `web/` —— H5 前端
