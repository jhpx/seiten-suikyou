# tools —— 开发期工具

运行时一个都不用它们：发布时 `npm pack` 只带 `src/` `vendor/` 和 `package.json`（见 `docs/DEPLOY.md` 第三节），
`tools/` 不在其中。日常只用记住一个入口：`npm run sync`。

## 为什么 .py 和 .ts 混着放

判断标准只有一条 —— **要不要 import `src/` 里的 TS 才能干活**：

- 要（读库、复用 `service/` 的视图拼装）→ `.ts`，Node 直接跑，不多一个入口
- 不要（搬文件、比路径、压 tar）→ `.py`，和同步脚本一路，省得为纯文件操作再起一个 Node 脚本

所以混不是懒，是两个运行时各干自己顺手的活。

## 同步上游（一个动作，四个文件）

| 文件 | 一行简介 | 怎么跑 |
|---|---|---|
| `sync.py` | ★ 唯一入口，按 miao → i18n → assets 的顺序跑完三步 | `npm run sync`；单步 `python tools/sync.py miao`；只检查 `npm run sync:check` |
| `sync_miao.py` | 把 miao-plugin 的评分源码搬进 `vendor/miao/` 并打定点补丁 | `python tools/sync_miao.py`（用 `MIAO_PLUGIN_PATH` 换源目录） |
| `sync_i18n.py` | 搬名字数据到 `vendor/i18n/`：enka 的 4 个文件原样复制 + 部件名提取件 | `python tools/sync_i18n.py`（`I18N_LOCALES=chs,en` 限定语种；`--refresh` 强制重下） |
| `sync_assets.py` | 复制 miao 素材到 `web/assets/`（角色只拷 `imgs/splash.webp` + `icons/`），并用页面清单对账 | `python tools/sync_assets.py` |

## 素材预处理（按需，不是同步步骤）

| 文件 | 一行简介 | 怎么跑 |
|---|---|---|
| `gen_flower.py` | 一次产出三类小图：圣遗物 `artifact/thumbs/<setId>/1~5.webp`（96px，**裁边**，`1.webp` 兼作套装代表图）、武器 `weapon/thumbs/<itemId>.webp`（96px，**只缩不裁**，原图几乎满格）、头像 `character/thumbs/<avatarId>/face.webp`（**196px**，只缩不裁，目录形状照圣遗物：id 当文件夹、文件名说清是哪张） | `python tools/gen_flower.py` 补缺图；`--force` 全部重生成；`--edge` 改图标边长、`--char-edge` 改头像边长 |

「缩略图」= 缩到**显示尺寸**，不是一律 96：圣遗物图标显示 17~28px、武器 28×38px → 96 够；
头像首页画到 107px、2 倍屏要 214 设备像素 → 得 196（1.09 倍放大，看不出来），照抄 96 就是拿小图撑大。

上游新增套装 / 武器时先 `python tools/sync.py assets`，再跑一次它补图；**头像不用 sync** ——
脚本直接从 `../miao-plugin` 的原件缩（`MIAO_PLUGIN_PATH` 可改），web/assets 里那份 face 副本
2026-11-09 已删。`npm run sync:check` 会分别报三类缺图。
产物都在前端子仓库的**独立 `thumbs/` 目录**里，不混进上游原图目录。
标识一律用数字 id：圣遗物是 enka 的 setId（脚本从 `vendor/i18n/` 现算中文名 → id），
武器是 miao 五份 `data.json` 的 itemId、不分类型目录，头像用 `character/data.json` 的 avatarId
（127 个 id ↔ 127 个上游目录，正好 1:1）—— id 唯一，也不随官方译名变。
原图目录仍按上游的中文名摆，两层命名不同是有意的。
`imgs/` 圣遗物原图（明细页 100px）、`weapon/<类型>/<中文名>/icon.webp` 武器原图（明细页 100px 武器卡）
都留给明细页，96px 小图在那儿会糊；头像没有这个问题 —— 明细页立绘走 `splash.webp`（1400px 宽），
整站只有首页和模拟器圆框用 face，最大 107px，所以它干脆只出小图。
角色素材现在**只同步 `imgs/splash.webp` + `icons/`**：`imgs/face.webp`（127 张 5.8MB）已被 thumbs 顶替，
`imgs/card.webp` / `imgs/banner.webp`（131×2 张 12.5MB）前端从未引用，三类合计 18.3MB 已删；
`sync_assets.py` 的 `CHAR_IMGS` 别再把这几个名字加回去。
`thumbs/` 随子仓库提交（母仓库只更新子模块指针）。

## 验收（改完前端 / 文档后自查）

| 文件 | 一行简介 | 怎么跑 |
|---|---|---|
| `probe.ts` | 在真实页面里跑一段 JS 量 DOM（尺寸、折行、计算样式），可顺带截一张 | `node tools/probe.ts <url> <表达式文件> [截图png]` |
| `shot.ts` | headless chrome 截一张图，肉眼看版式对不对 | `node tools/shot.ts <url> <png> [宽,高]` |
| `list_assets.ts` | 问应用本人「页面会请求哪些图」，落 `.tmp/asset-list.json` 给 `sync_assets` 对账 | `node tools/list_assets.ts` |
| `check_docs.py` | 校验文档里的相对链接有没有写歪（搬过家就查一遍） | `python tools/check_docs.py` |

`probe.ts` 只量不改：它拉一个开 `--remote-debugging-port` 的 chrome 走 CDP，不碰产品代码；
chrome 本体（`chrome-headless-shell`，约 120MB）落在 `.tmp/`，准备方法写在 `shot.ts` 头部。

## 文档与图表

| 文件 | 一行简介 | 怎么跑 |
|---|---|---|
| `gen_artis_table.ts` | 从 `vendor/miao` 的规则实测出评分总表，写进 `docs/`（规则总表 csv + html） | `node tools/gen_artis_table.ts` |
| `link_arch.py` | 给两份架构图互插一个跳转按钮 | `python tools/link_arch.py` |

`link_arch.py` 的时序是固定的：**先 archify deliver，再跑它**。deliver 会整份重写 HTML
把按钮冲掉；脚本自己幂等（先删上次插的样式和按钮再插），图本身一个字不动。

## 谁调谁

```
sync.py ─┬─► sync_miao.py  ──► vendor/miao/          （内核 + 资源清单）
         ├─► sync_i18n.py  ──► vendor/i18n/           （enka 4 个原样 + textmap/ 提取件）
         └─► sync_assets.py ──► web/assets/           （miao 的 resources/ 按清单复制，不再全量）
                            ◄── .tmp/asset-list.json ◄── list_assets.ts（可选，对账用）
```

顺序不能反：后两步都按 miao 的资源清单干活，miao 必须先到位。

## 不在这里的东西

- `test/*.ts` 是测试，`npm test` 统一跑，不归 tools 管
- `.tmp/` 是开发残留（chrome、截图、表达式文件、`asset-list.json`），已 gitignore
