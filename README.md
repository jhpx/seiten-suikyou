# 星天水镜 / seiten-suikyou

> 「只要百川奔流，雨露不休，水就不会消失。」
> ——纯水精灵·洛蒂娅（《原神》）

原神角色养成评估器。评分算法不做二次实现，直接内嵌 [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) 的计算内核，分数与上游逐字一致。

名字取自莫娜的称号「星天水镜」：以水为镜映照星象，从幻象里读出真实。

## 能力

| 能力 | 入口 |
|---|---|
| 按 UID 抓展柜 → 存本地库 → 用 miao 规则打分 | `npm run score -- --uid <uid>` |
| 网页：角色网格 + 角色明细页 | `npm run server` |
| 多语言：简 / 繁 / EN / JA / KO | 页面右上角，或 `--locale` |
| JSON 接口 | `GET /api/accounts/:uid?locale=en` |

## 快速开始

```bash
git clone --recursive <仓库地址>   # 前端是 submodule，漏了 --recursive 页面会 404
npm install                       # 五个运行时依赖，全部纯 JS
npm run score -- --uid 101242308  # 先抓数据并打分
npm run server                    # http://127.0.0.1:8787
```

- Node ≥ 22.18，`.ts` 直接跑，无构建。
- 本地库用 Node 自带 `node:sqlite`，首次启动按 `src/config/schema.ts` 自动建表。
- Python 3 只在跑 `tools/*.py` 同步脚本时需要，不参与运行时。

## 常用命令

```bash
npm run server        # 默认监听 0.0.0.0:8787
npm run score -- --help
npm run typecheck
npm test              # 类型检查 + 全套测试
npm run sync          # 同步上游：miao 内核 / 多语言表 / 图片素材
npm run sync:check    # 只体检不落盘
```

## 命令行评分

```bash
npm run score -- --uid 101242308              # 抓 enka → 入库 → 打分
npm run score -- --uid 101242308 --offline    # 不联网，读库打分
npm run score -- --uid 101242308 --char 胡桃   # 只看一个角色
npm run score -- --file sample.json           # 从本地原始响应入库
npm run score -- --list                       # 库里有哪些 uid
npm run score -- --json                       # 结构化输出
npm run score -- --locale en                  # 换语言
```

完整参数见 `npm run score -- --help`，输出样例见 [`docs/sample/cli-output.txt`](docs/sample/cli-output.txt)。

## 网页服务

```bash
npm run server                        # 0.0.0.0:8787
npm run server -- --port 9000 --db data/other.db
npm run server -- --host 127.0.0.1    # 只给本机
```

⚠️ 默认绑 `0.0.0.0` 且无登录鉴权，只在可信网络里开；要关起来用 `--host 127.0.0.1`。

接口清单、错误形状、限流与跨域约定见 [`docs/API.md`](docs/API.md)。

## 目录

```text
seiten-suikyou/
├── src/
│   ├── index.ts              # 内核出口
│   ├── config/               # 数据库 / 表结构 / 全局默认值
│   ├── repository/           # 一张表一行
│   ├── service/              # 用例编排 + 视图组装
│   ├── rest/                 # 控制器，只做 HTTP 关切
│   ├── gateway/              # miao 内核 / enka 适配
│   ├── common/               # 字典与纯函数
│   ├── cli/                  # 命令行入口
│   └── server/               # HTTP 进程入口
├── web/                      # 前端子仓库（submodule）
├── vendor/                   # miao 内核与多语言表（sync 生成，勿手改）
├── tools/                    # 同步 / 测量 / 截图工具
├── test/                     # 测试
├── docs/                     # 设计、接口、部署与专题文档
│   ├── architecture/         # 可交互架构图（html + 数据源 json）
│   ├── reports/              # 上游同步报告
│   └── wireframe/            # 界面原型（按分节拆分的静态页）
└── data/                     # 本地库（gitignore）
```

## 部署

本地运行 / 前后端分离 / 后端上线（`npm pack` → `scp` → systemd + nginx）见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 相关文档

| 想了解 | 看哪 |
|---|---|
| 接口请求 / 响应、错误码、限流与跨域 | [`docs/API.md`](docs/API.md) |
| 部署 | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| 为什么内嵌 miao 内核、页面与多语言怎么还原 | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 数据层设计 | [`docs/DESIGN-DATA-MODEL.md`](docs/DESIGN-DATA-MODEL.md) |
| 界面原型：视觉与交互规范，开发按它对照 | [`docs/wireframe/index.html`](docs/wireframe/index.html) |
| 架构全貌（可交互） | [`docs/architecture/seiten-suikyou-architecture.html`](docs/architecture/seiten-suikyou-architecture.html) |
| 前端架构（可交互） | [`docs/architecture/seiten-suikyou-web-architecture.html`](docs/architecture/seiten-suikyou-web-architecture.html) |

## 许可

本项目代码采用 [MIT License](LICENSE)。

评分内核、角色 / 武器元数据与前端图片素材来自 [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)（MIT，Copyright (c) 2023 Yoimiya）；完整许可文本与素材声明见 [`NOTICE`](NOTICE)。原神相关素材版权归米哈游（miHoYo / HoYoverse）所有，本项目不用于任何盈利目的。
