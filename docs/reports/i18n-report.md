# 多语言文案同步报告

- 同步时间：2026-10-12T20:02:42
- 上游来源：`gitlab.com/Dimbreath/AnimeGameData`（`master（最近提交 2026-06-29，游戏 6.6.0）`）
- 词条来源：`cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/loc.json`
- 语言：简体中文、繁體中文、English、日本語、한국어

## 一、同步了什么

| 类别 | 条目数 | 说明 |
|---|---|---|
| 角色 | 156 | ExcelBinOutput/AvatarExcelConfigData |
| 武器 | 265 | ExcelBinOutput/WeaponExcelConfigData |
| 圣遗物部件 | 4185 | 按 ReliquaryExcelConfigData 自己的 setId 归属筛（低星狗粮不入表） |
| 套装 | 63 | setId → equipAffixId → EquipAffixExcelConfigData[level=0] |
| 部位 | 5 | 生之花/死之羽/时之沙/空之杯/理之冠（官方表里唯一，可反查） |
| 词条 | 47 | loc.json 的 FIGHT_PROP_* 区块 |

落库：**767 个名字组**，`nameIndex` 索引了 **11931 个 hash**（平均一个名字对应 15.6 个官方键）。

## 二、为什么要「名字组」，以及为什么不能只按中文名合并

官方把同一段文案复用在几十处：「胡桃」在完整表里有 49 个键、「宗室之花」23 个、「炽烈的炎之魔女」11 个。enka 返回的是其中任意一个 —— 实测套装经 EquipAffix 链出来的是
`1928302715`，而 enka 给的是 `1524173875`，两个都对，只是变体不同。
离线时无法预知 enka 给哪个，所以要把**变体键全部收进来**。

但「同名」不等于「同一个东西」：中文是**不唯一**的键 —— `以理服人` 既是武器
Debate Club，也是任务里的一句 *Time for a debate*；`信使` 在日文下有 3 种写法。
只按中文合并的话，enka 给武器那个 hash 时，可能查出任务那句话的英文，这才是真的串味。

所以合并条件是「**在所有语言下文案都相同**」：先按中文粗合并，再逐语言切分。
真变体（各语言都一致）照旧合并在一起，撞名的被切开、各拿各的翻译。

因撞名而切出来的组：**11** 处（见下）

- 洛恩（en）→ Rowan
- 以理服人（en）→ Peacemonger
- 以理服人（en）→ Time for a debate
- 落霞（en）→ Luoxia
- 少女飘摇的思念（en）→ Maiden's Heart-stricken Infatuation
- 盟誓金爵（en）→ Pledging Vessel
- 成男体型测试（ja）→ 成人男性ボディテスト
- 信使（ja）→ 伝達使
- 信使（ja）→ 使者
- 阿蕾奇诺（ko）→ 「아를레키노」
- 战狂的蔷薇（ko）→ 전광의 장미

## 三、每种语言解析到多少组

| 语言 | 有文案的组 | 占比 |
|---|---|---|
| 简体中文（chs） | 756 / 767 | 98.6% |
| 繁體中文（cht） | 756 / 767 | 98.6% |
| English（en） | 762 / 767 | 99.3% |
| 日本語（ja） | 765 / 767 | 99.7% |
| 한국어（ko） | 767 / 767 | 100.0% |

- 分母是**切分后**的最终组数；越靠后切出来的组，前面的语言还没轮到它，所以数字递增是正常的。

## 四、没解析到的

- 上游 dump 落后于游戏时，比它新的角色/武器/套装会**整体缺席**（不是翻译缺失，是 id 根本没进表）。实测：uid 101242308 展柜里的「熔铸者」套装（比 dump 新），以及角色「奥黛塔」
- 只有中文、其它语言一条都没收录的组：3 个

## 五、怎么复现

```bash
# 默认 chs,cht,en,ja,ko；原始大文件缓存在 .tmp/i18n-src/（已被 git 忽略）
python tools/sync_i18n.py
# 国内直连 gitlab 不通，需要代理时
I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py
```

> `vendor/miao/` 是「原样搬运 + 定点改写」，本目录不同：
> 它是**从 43 MB 原始表里提取出来的子集**，提取逻辑见脚本。
