# 多语言文案同步报告

- 同步时间：2026-11-03T00:29:31
- 名字主源：`EnkaNetwork/API-docs store/gi/{locs,avatars,weapons,relics}.json`（原样复制）
- 部件名来源：`gitlab.com/Dimbreath/AnimeGameData（TextMap，只取部件名）`（enka 不收录部件名）
- 语言：简体中文、繁體中文、English、日本語、한국어

## 一、产物

| 文件 | 大小 | 来源 | 处理方式 |
|---|---|---|---|
| `locs.json` | 257 KB | enka | **原样** |
| `avatars.json` | 352 KB | enka | **原样** |
| `weapons.json` | 158 KB | enka | **原样** |
| `relics.json` | 696 KB | enka | **原样** |
| `slots.json` | 1 KB | 手写 | 5 个部位名 |
| `textmap/chs.json` | 127 KB | Dimbreath TextMap | 提取 |
| `textmap/cht.json` | 127 KB | Dimbreath TextMap | 提取 |
| `textmap/en.json` | 151 KB | Dimbreath TextMap | 提取 |
| `textmap/ja.json` | 137 KB | Dimbreath TextMap | 提取 |
| `textmap/ko.json` | 150 KB | Dimbreath TextMap | 提取 |
| **合计** | **2154 KB** | | |

条数：套装 65、角色 156、武器 256、部件归属 4245、部件名 hash 4185。

源文件里 TextMap 是单语言 43 MB / 54 万条，这里只挑出部件名那几条 ——其余是任务对白和道具描述，用不上。

## 二、覆盖审计（每种语言命中率）

| 语言 | 角色 | 武器 | 套装 | 部件名 |
|---|---|---|---|---|
| 简体中文（chs） | 156/156 | 256/256 | 65/65 | 4185/4185 |
| 繁體中文（cht） | 156/156 | 256/256 | 65/65 | 4185/4185 |
| English（en） | 156/156 | 256/256 | 65/65 | 4185/4185 |
| 日本語（ja） | 156/156 | 256/256 | 65/65 | 4185/4185 |
| 한국어（ko） | 156/156 | 256/256 | 65/65 | 4185/4185 |

## 三、上游滞后预警

下面这些套装 enka 已经有，但 TextMap 里凑不齐部件名（这些部件会退回中文名）：

- setId `15047`：0/30 个部件有名字
- setId `15048`：0/30 个部件有名字

上游进度：TextMap（Dimbreath `master`）最大 setId 是 **15046**，enka 已经到 **15048**。等 dump 追上来重跑本脚本即可，不用改代码。

## 四、缓存状态

- 全部为本轮新下载或 7 天内的新鲜缓存。
- 想强制重下（怀疑上游更新了）：`python tools/sync_i18n.py --refresh`。

## 五、怎么复现

```bash
# 原始大文件缓存在 .tmp/i18n-src/（已被 git 忽略），只有产物进仓库
python tools/sync_i18n.py
# 国内直连不通时（enka 在 raw.githubusercontent、TextMap 在 gitlab）
I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py
```

> enka 那 4 个文件是**字节级原样复制**；TextMap 那份是提取件，提取逻辑见脚本。
