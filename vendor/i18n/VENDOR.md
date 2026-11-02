# vendor/i18n 来源记录

本目录由 `python tools/sync_i18n.py` 生成，**请勿手工编辑**。

## 目录里都是什么

| 文件 | 来源 | 处理方式 |
|---|---|---|
| `locs.json` | enka `store/gi/locs.json` | **原样**（字节级复制） |
| `avatars.json` | enka `store/gi/avatars.json` | **原样** |
| `weapons.json` | enka `store/gi/weapons.json` | **原样** |
| `relics.json` | enka `store/gi/relics.json` | **原样** |
| `slots.json` | 无上游，手写 | 5 个部位名 |
| `textmap/*.json` | Dimbreath `TextMap` | **提取件**：43 MB 里只留部件名，`{hash: 文案}` |

同步时间：2026-11-03T00:29:31　语言：简体中文、繁體中文、English、日本語、한국어

体量：65 个套装 / 156 个角色 / 256 把武器 / 4245 个部件归属 / 4185 个部件名 hash。

上游一更新，`git diff` 直接就能看出 `locs.json` 里哪条变了 —— 这是「原样」的唯一理由。
TextMap 做不到原样（单语言 43 MB），所以只留提取件；它的允许清单来自 Dimbreath 的
`ReliquaryExcelConfigData`，只在构建期用，不落在本目录。

## 为什么角色/武器/套装/词条走 enka，只有部件名走 TextMap

enka 的 `store/gi/` 是它自己的线上口径，新角色/新套装一上线就有；而 TextMap dump 是社区周更的，会滞后。
但 enka **不收录圣遗物部件名**（它的网页也不显示这个），所以「魔女的炎之花」这类名字只能从 TextMap 取。

## 两套 hash 空间别混

玩家接口给的是 `setNameTextMapHash`（千岩 = 1337665995），它**不在 locs.json 里**；套装名要经 `itemId → setId → Sets[setId].Name` （千岩 = 15017 → 4007101907）才查得到。所以套装身份一律用 **setId**。
