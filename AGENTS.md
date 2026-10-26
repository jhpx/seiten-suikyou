# AGENTS.md

本文件供 AI 编程助手使用，规定在本仓库中工作的通用约束，不替代 `README.md` 中的项目说明。

## 规则范围与优先级

按以下顺序确定适用规则；越具体、越靠近工作目录的规则优先级越高：

1. 当前任务中的明确要求
2. 工作目录及其父目录中的 `AGENTS.md`
3. `src/AGENTS.md`：后端专属规则
4. `web/AGENTS.md`：前端专属规则。`web/` 是独立 Git 子仓库，该文件由前端子仓库维护
5. 本文件中的通用规则

不要假定某份规则文件一定存在；开始工作前检查与任务相关的规则文件。

## 项目结构

这是一个原神角色养成评估器，内嵌 [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) 的评分内核，包含后端服务和纯静态前端。

| 路径 | 职责 |
|---|---|
| `src/` | 后端 TypeScript 代码 |
| `web/` | 原生 ES 模块前端；独立 Git 子仓库 `seiten-suikyou-web` |
| `vendor/miao/`、`vendor/i18n/` | 由 `tools/sync.py` 生成的上游同步产物 |
| `tools/` | 开发工具：同步上游、测量 DOM、截图、生成评分总表等 |
| `test/` | 测试用例和测试数据；由 `npm test` 统一执行 |
| `docs/` | 设计、接口和部署文档 |

上游 miao-plugin 源码在开发工作区中通常位于 `../miao-plugin/`。本仓库不能依赖该目录存在；需要同步上游时才使用它。

## 运行环境与生效方式

- Node.js **≥ 22.18**。项目直接运行 TypeScript，不生成 `dist/`。
- 依赖由 `package.json` 管理，主要框架为 Hono 和 Drizzle。
- 数据库使用 Node.js 内置的 `node:sqlite`，不需要独立数据库服务。
- 修改 `src/**` 后必须重启服务，已导入内存的模块不会自动更新。
- 修改 `web/` 中的 JavaScript 或 CSS 后，刷新浏览器即可验证。

## 常用命令

```bash
npm test                       # 全套测试
npm run typecheck              # TypeScript 类型检查，不生成文件
npm run server                 # 启动 HTTP 服务，默认监听 0.0.0.0:8787
npm run score -- --uid 101242308  # 命令行评分；完整参数使用 --help 查看
npm run sync                   # 同步上游：miao → i18n → assets
npm run sync:check             # 检查上游同步差异
```

`npm test` 当前执行顺序为：`typecheck → smoke → args → arch → enka → pipeline → i18n → server → cli → regression → damage → verify`。修改测试脚本或测试编排时，以仓库当前配置为准。

单独运行测试：

```bash
node test/<测试文件名>.ts
```

涉及 `node:sqlite` 的测试运行时会出现一条 `ExperimentalWarning`，可加标志抑制：

```bash
node --disable-warning=ExperimentalWarning test/pipeline.ts
```

`package.json` 的 `test` 脚本已经对 `pipeline.ts`、`server.ts`、`cli.ts` 加了该标志。

服务启动参数：`--host`、`--port`、`--db`、`--trust-proxy`、`--no-rate-limit`、`--cors-origin`。

命令行评分参数：`--uid`、`--file`、`--offline`、`--char`、`--db`、`--save-raw`、`--locale`、`--json`、`--keys`、`--list`。具体行为以命令行帮助和实现为准。

## 通用开发规则

1. **评分结果必须与 miao-plugin 保持一致。** 修改评分内核或数据通路后，必须运行 `npm test`，并将 `node test/verify.ts` 的标准输出与修改前基线逐字比较。不要在基线输出中加入调试信息。评分错误是本项目的高优先级缺陷。
2. **未经明确要求，不执行 `git commit` 或 `git push`。** 完成后说明改动和验证结果，由用户决定是否提交、推送。
3. **重命名先提出候选方案。** 涉及类型、函数、变量、文件、接口路径或目录的重命名，先提供至少 3 个候选，并说明各自语义、优点和缺点；获得用户选择后再实施。
4. **文档按职责维护。** `README.md` 说明安装和运行；`docs/DESIGN.md` 记录整体设计；`docs/DESIGN-DATA-MODEL.md` 记录数据层设计；`docs/API.md` 记录接口；`docs/DEPLOY.md` 记录部署。
5. **使用清楚、直接的中文。** 避免“下发”等不必要的行话，优先使用“接口返回”“服务端给前端”等明确说法。注释应通俗、简短，不使用空泛的架构黑话。
6. **控制改动范围。** 优先解决当前任务，不顺手重构无关代码，不擅自引入新的依赖、脚本或架构层次。
7. **验证结果如实报告。** 说明实际执行了哪些检查、哪些通过、哪些未执行及原因；不能把未运行的测试描述为通过。

## 代码风格（前后端通用）

前后端共用以下风格约定；若 `src/AGENTS.md` 或 `web/AGENTS.md` 有更具体的要求，以更具体的规则为准。

- 使用单引号。字符串内容本身需要双引号的场景（例如 SQL 标识符、内嵌 SVG）除外。
- 不写语句结束分号，依靠 ASI 断句。注意避免自动分号插入导致的歧义。
- 使用 2 个空格缩进，不使用 Tab。
- 优先使用 `const`；需要重新赋值时使用 `let`；不使用 `var`。
- 合理使用可选链 `?.`、空值合并 `??` 和展开语法 `...`。
- 一行能表达清楚的短工具函数可使用箭头函数，例如 `export const num = (v) => …`。
- 有多步逻辑的函数使用 `function` 声明，例如 `export function attrValueText (…) { … }`。这也便于利用函数声明提升；不要仅为追求语法统一而牺牲可读性。
- 文件末尾保留一个换行。

## 禁止事项

- 不手工修改 `vendor/**`。这些目录是同步生成物；如需修补上游逻辑，修改 `tools/sync_miao.py` 中的 `PATCHES`，再通过同步流程生成。
- 不制作并搬运手工拼装的“离线依赖包”。依赖应在目标环境通过 `npm install` 安装。
- 不向 `package.json` 添加新的 `scripts`。现有脚本为 `server`、`score`、`typecheck`、`test`、`sync`、`sync:check`；一次性工具直接放在 `tools/` 并通过 `node tools/<工具名>.ts` 运行。若任务明确要求调整脚本，先说明原因并征得用户同意。
- 不改名 `package-lock.json`，也不引入 npm shrinkwrap 文件。
- 不在 `src/` 或 `web/` 中加入与业务无关的临时代码、调试输出或 `console.log`。
- 不在个人目录（桌面、下载、文档等）执行批量删除或批量改写。
- 不覆盖或丢弃用户已有的未提交修改。执行可能造成数据丢失的操作前，先检查 Git 状态并取得用户明确同意。

## 验收清单

根据改动范围执行检查，不要只凭代码阅读判断通过。

1. **所有代码改动：** 运行 `npm test`，确认全套测试通过。
2. **评分内核或数据通路改动：** 额外运行 `node test/verify.ts`，将标准输出与改动前基线逐字比较。
3. **前端改动：** 使用 `node tools/probe.ts <url> <表达式文件>` 测量 DOM 并与预期结果做逐字节 diff；确认后再使用 `node tools/shot.ts <url> <png> [宽,高]` 截图检查。
4. **文档改动：** 运行 `python tools/check_docs.py`，检查相对链接。
5. 如果环境限制导致某项检查无法执行，明确说明，不要声称该项已通过。

## 问题排查入口

| 问题 | 优先查看 |
|---|---|
| 不确定代码分层 | `src/AGENTS.md`、`test/arch.ts` |
| 前端样式异常或类名被隐藏 | `web/AGENTS.md` |
| 部署、跨域或限流 | `docs/DEPLOY.md`、`docs/API.md` |
| 历史问题和工具环境 | 工作区 `../.workbuddy/memory/` 下的 `MEMORY.md`、`WEB-NOTES.md`、`TOOLING-NOTES.md`、`TS-NOTES.md`、`PAGE-NOTES.md` |
