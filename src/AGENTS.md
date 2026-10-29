# AGENTS.md —— 后端（`src/`）

本文件规定后端代码的分层、接口、数据和上游集成约束，与仓库根目录的 `AGENTS.md` 配合使用。通用代码风格以根目录规则为准；本文件补充后端特有要求。

开始修改前，先检查当前实现和相关测试。本文档中的文件名、目录职责和实现细节是当前架构约定，不应成为拒绝合理演进的理由；如任务需要改变约定，先说明影响并与用户确认。

## TypeScript 与运行约束

- TypeScript 严格模式必须保持开启。不要为了消除少量类型错误而关闭 `strict`。
- 保持 `erasableSyntaxOnly` 和 `allowImportingTsExtensions` 配置。当前运行方式依赖 Node.js 原生剥除 TypeScript 类型，因此避免使用 `enum`、`namespace`、构造器参数属性等需要运行时转译的语法。
- 相对模块导入必须写完整的 `.ts` 后缀，避免运行时出现模块解析错误。
- 业务代码应明确表达类型，优先使用具体类型；无法立即确定的外部数据可先用 `unknown`，验证后再收窄。
- 不要把 `any` 当作常规逃生口。与 `vendor/miao/` 等缺少类型声明的上游 JavaScript 交互时，允许在边界使用局部、可解释的类型断言或 `any`；尽可能把不确定性限制在边界，不要扩散到业务代码。
- 修改编译配置或运行方式前，检查 Node.js 版本、测试命令和部署环境是否仍兼容。

## 分层与依赖方向

当前后端采用五个主要目录层次及若干横向模块。下表描述现有职责，修改前应以代码和 `test/arch.ts` 的实际断言为准。

| 目录 | 当前职责 |
|---|---|
| `server/` | 应用创建与启动、路由表、限流、静态托管及错误处理 |
| `rest/` | HTTP 控制器；控制器按领域平铺，另有 `meta.ts`、`reply.ts` 等通用入口 |
| `service/` | 用例与业务编排；`context.ts` 定义控制器可使用的能力契约；`dto/` 传输类型、`assembler/` 视图组装 |
| `config/` | 数据库连接、表结构定义、默认值及存储门面 |
| `repository/` | 按领域组织的持久化访问；`dbo/` 数据库对象（原 domain，贫血、零依赖孤岛） |
| `gateway/` | 外部系统隔离：`miao/` 引擎适配（materialize / damage / simulate）、`enka/` 数据源（抓取与原始响应 → dbo） |
| `common/` | i18n 门面、文案表和通用纯函数 |
| `cli/` | 命令行入口及参数处理 |

基本约束：

- 依赖方向应保持清晰，避免低层模块反向依赖高层应用或 HTTP 层。
- 当前控制器通过 `service/context.ts` 提供的能力访问业务用例，原则上不直接导入 repository 或具体 service 实现。若要改变此边界，先检查 `test/arch.ts` 并说明理由。
- `repository/dbo/` 只描述「是什么」，不依赖任何外层（server / rest / service / gateway / config / repository 行读写 / 三方包）；只引同目录与 `common/util.ts`、`common/stat.ts`（词条词汇表）。
- `common/util.ts` 当前约定为零依赖纯函数模块；修改其依赖关系前，先确认是否会造成领域层依赖倒置。
- 不要只为匹配目录表而移动文件或增加抽象。新代码应放在最符合其变化原因和依赖方向的位置。

## 新增或修改接口

- 新增接口时，检查 `server/routes.ts` 的路由注册和相应 `rest/<领域>.rest.ts` 控制器；如需要新的业务能力，再通过 service 层接入。
- 路由参数应尽可能使用明确的格式约束。例如 UID 路径参数使用数字正则。不要只为追求统一而对合法输入施加不必要限制。
- 当前接口主要通过路径和 query 传递参数；模拟比对等结构化输入可以使用请求体。是否使用请求体应由数据结构、长度、语义和 HTTP 约定决定，不要把“目前大多数接口不用请求体”理解成永远禁止。
- 成功响应使用 `{ ok: true, data [, meta] }`；失败响应使用 `{ ok: false, error: { code, message } }`。新增接口应沿用现有响应工具，避免自行创造第三种格式。
- 跨域处理应先于限流等依赖请求来源信息的中间件。修改中间件顺序时，运行 `test/server.ts` 验证实际响应头和错误行为。
- 限流当前分为 `fetch`、`fetchAll`、`read` 三档；修改限流策略时，检查各路由归类、429 响应和 `Retry-After`。
- 若服务部署在反向代理之后，需正确配置 `--trust-proxy`。不要在不验证部署拓扑的情况下默认信任代理头。

## 数据层

- 当前 `config/schema.ts` 是数据库表结构定义的权威来源；不要另外维护一份容易漂移的 `schema.sql`。
- 修改表结构时，检查 `config/db.ts` 中的 `SCHEMA_VERSION`、`config/store.ts` 的映射，以及对应模型和测试。当前版本策略会拒绝旧结构并提示重新抓取数据；修改该策略前，先评估数据丢失影响并取得用户确认。
- 新增或修改列时，确保 schema、模型、存储映射和测试保持一致。
- 保持现有表名、主键和关联键约定；若确需更名或改变关联关系，应同步更新所有读写路径和测试，不能只改一个文件。
- 不要用 `Number()` 把可能为空的值直接转成数字；例如 `Number(null)` 会得到 `0`，从而混淆“缺失”和“值为零”。根据数据语义选择显式校验和转换。
- 圣遗物副属性 ID 列表 `append_prop_ids` 的顺序和重复项具有意义，不能擅自排序或去重。
- 当前不把权重表落库，且存储数字 ID 而非显示名称。若业务需求改变，应先说明数据模型和迁移影响。
- 避免在持久化与计算之间加入没有明确用途的中间模型。确需增加时，应说明它解决的边界问题，而不是仅为分层而分层。

## 多语言与显示口径

- `vendor/i18n/names.json` 是生成的官方名称数据；`src/common/ui.ts` 是手写的界面文案。两者用途不同，不要互相替代。
- 当前依赖方向为 `common/i18n` 读取 `names` 和 `ui`；`names` 与 `ui` 不应互相依赖。修改该结构时，检查 `test/arch.ts` 的依赖断言。
- `repository/dbo/` 不应依赖官方文案表 `common/names.ts`（它要读 vendor 文案表，会把 IO 拽进数据库对象层）；词条词汇表在 `common/stat.ts`，dbo 可引它。
- 词条数值显示统一走 `service/artifact.service.ts` 中现有的 `attrValueText(...)` 逻辑（圣遗物与词条的「显示口径」已抽到该叶子模块，`character.service.ts` 单向引它），以保持不同数据源之间的显示口径。不要绕过它直接使用 `Format.pct`，除非已确认新场景的语义不同并补充测试。
- 前端静态文案通过 `/api/meta` 提供。需要增加或修改界面文案时，检查 `src/common/ui.ts` 和接口返回，不要在前端重复硬编码。

## 上游数据与评分内核

- `SOURCES` 当前包含 microgg 与 Enka，抓取应并行执行。若调整并发策略，需说明原因并测试错误传播和超时行为。
- 两个数据源对 424 等状态码的含义可能不同；处理结果时应按各来源语义判断，不能仅凭状态码统一判错。当前策略是任一来源成功即可使用，全部失败后再返回错误。
- miao 内核位于 `vendor/miao/`，由同步流程生成。不要在同步后直接修改生成物；确需修补时，先检查 `tools/sync_miao.py` 的 `PATCHES` 和同步流程。
- 伤害计算的现有出口为 `gateway/miao/damage.ts` 的 `calcDamage(profile)`（异步，返回 `MiaoDamage | null`）。修改时检查缺失天赋等级的默认处理，并运行伤害相关测试。
- 同步上游数据时，注意旅行者等角色数据可能存在于较深目录；不要只根据浅层文件列表判断素材是否完整。
- 上游数据和评分内核的改动必须以测试结果验证，不要凭主观判断改写数据或计算逻辑。

## 禁止事项与可调整约定

- 不在 `rest/` 中启动服务、托管静态文件或直接引入 `@hono/node-server`；这些职责属于 `server/`。
- 不让控制器绕过 `service/context.ts` 直接访问 repository 或具体 service 实现，除非用户明确批准调整该架构边界。
- 不随意恢复已废弃的目录（例如 `adapter/`、`i18n/`、`shared/`、`view/`、`dao/`）。`dbo/` 现在已正式作为数据库对象目录落在 `repository/dbo/`，不是废弃目录。若确有新需求需要类似模块，应先解释其职责及与现有目录的区别。
- `config/constants.ts` 保持为默认值层，不依赖其他业务模块。
- 不用 `drizzle-kit` 替代运行时的 `config/schema.ts`。若需要引入新的 schema 工具或迁移机制，先说明对部署、旧库和运行时依赖的影响。
- 未经用户同意，不向 `package.json` 添加依赖或脚本。若任务明确需要新增依赖或脚本，先给出必要性、维护成本和替代方案。
- 不手工修改 `vendor/` 中的同步生成文件。
- 不擅自执行数据库删除、批量清理或其他可能丢失数据的操作。

## 测试与验收

后端代码修改后，运行：

```bash
npm test
```

该命令首先执行 TypeScript 类型检查；类型检查失败时，后续测试不会运行。

修改评分内核、数据通路或显示口径时，额外运行：

```bash
node test/verify.ts
```

其标准输出用于与修改前的评分基线比较。需要对拍时，保留原始基线，不要将调试信息写入基线输出。

| 测试文件 | 覆盖内容 |
|---|---|
| `smoke.ts` | 内核能否脱离云崽环境独立加载 |
| `args.ts` | 命令行参数解析 |
| `arch.ts` | 分层、依赖边界和生成物边界 |
| `enka.ts` | 上游抓取 |
| `pipeline.ts` | 原始响应到本地库、miao profile 和评分的完整链路 |
| `i18n.ts` | ID/hash 到多语言文案的映射 |
| `server.ts` | 实际 HTTP 服务与响应 |
| `cli.ts` | CLI 子进程行为 |
| `regression.ts` | 上游更新后的回归检查 |
| `damage.ts` | 伤害计算端到端测试 |
| `verify.ts` | 评分基线 |
| `panel-check.ts` | 面板对拍；由 `pipeline.ts` 调用 |
| `fixtures.ts` | 测试数据，不是独立测试 |

若环境限制导致测试无法执行，明确列出未运行的检查及原因，不要声称通过。测试失败时，区分新增问题、既有问题和环境问题；不要为了让测试变绿而删除有效断言或降低检查强度。

## 排查入口

- 类型或模块加载问题：检查 `tsconfig.json`、导入后缀和 Node.js 版本。
- 分层或依赖问题：检查 `test/arch.ts` 和相关目录的现有实现。
- 接口、中间件或跨域问题：检查 `server/routes.ts`、`server/index.ts` 与 `test/server.ts`。
- 数据结构问题：检查 `config/schema.ts`、`config/db.ts`、`config/store.ts` 和 `test/pipeline.ts`。
- 评分差异：检查 `gateway/miao/`、`vendor/miao/` 的同步补丁和 `test/verify.ts`。
- 多语言问题：检查 `src/common/ui.ts`、`vendor/i18n/names.json` 和 `test/i18n.ts`。
