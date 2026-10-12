# vendor/i18n 来源记录

本目录由 `python tools/sync_i18n.py` 生成，**请勿手工编辑**。

- 上游：`gitlab.com/Dimbreath/AnimeGameData`（`master（最近提交 2026-06-29，游戏 6.6.0）`）
- 词条上游：`cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/loc.json`
- 同步时间：2026-10-12T20:02:42
- 语言：简体中文, 繁體中文, English, 日本語, 한국어
- 内容：767 个名字组 / 11931 个 hash 索引 / 63 个套装

## 为什么不直接放原始 TextMap

单语言完整表 43 MB / 54 万条，九成九是对白，我们一条都不要。
这里存的是**离线提取后的子集**（几百 KB）。要核对提取对不对，重跑脚本并对比
`docs/reports/i18n-report.md` —— 报告里有每种类别的条目数、每语言的命中率、以及撞名切分哨兵。
