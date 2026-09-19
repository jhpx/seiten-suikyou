# 多语言文案同步报告

- 同步时间：2026-09-13T19:18:37
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

落库：**756 个名字组**，`nameIndex` 索引了 **11931 个 hash**（平均一个名字对应 15.8 个官方键）。

## 二、为什么要「名字组」

官方把同一段文案复用在几十处：「胡桃」在完整表里有 49 个键、「宗室之花」23 个、「炽烈的炎之魔女」11 个。enka 返回的是其中任意一个 —— 实测套装经 EquipAffix 链出来的是
`1928302715`，而 enka 给的是 `1524173875`，两个都对，只是变体不同。
离线时无法预知 enka 给哪个，所以把**所有变体都收进来指向同一组**。
实测同一组的各变体在英文/日文下文案完全一致，不会串味。

同组文案冲突：**13** 处（见下）

- ⚠️ 洛恩（en）→ ['Lohen', 'Rowan']
- ⚠️ 以理服人（en）→ ['Debate Club', 'Peacemonger', 'Time for a debate']
- ⚠️ 落霞（en）→ ['Fading Twilight', 'Luoxia']
- ⚠️ 少女飘摇的思念（en）→ ["Maiden's Heart-Stricken Infatuation", "Maiden's Heart-stricken Infatuation"]
- ⚠️ 盟誓金爵（en）→ ["Noble's Pledging Vessel", 'Pledging Vessel']
- ⚠️ 洛恩（ja）→ ['ローエン', 'ローワン']
- ⚠️ 成男体型测试（ja）→ ['成人男性テスト', '成人男性ボディテスト']
- ⚠️ 以理服人（ja）→ ['理屈責め', '道理を用いて説得する']
- ⚠️ 信使（ja）→ ['伝達使', '使者', '文使い']
- ⚠️ 阿蕾奇诺（ko）→ ['「아를레키노」', '아를레키노']

## 三、每种语言解析到多少组

| 语言 | 命中 |
|---|---|
| 简体中文（chs） | 756 / 756 |
| 繁體中文（cht） | 753 / 756 |
| English（en） | 753 / 756 |
| 日本語（ja） | 753 / 756 |
| 한국어（ko） | 753 / 756 |

## 四、没解析到的

- 上游 dump 落后于游戏时，比它新的角色/武器/套装会**整体缺席**（不是翻译缺失，是 id 根本没进表）。实测：uid 101242308 展柜里的「熔铸者」套装（比 dump 新），以及角色「奥黛塔」
- 完全没有任何语言的组：0 个

## 五、怎么复现

```bash
# 默认 chs,cht,en,ja,ko；原始大文件缓存在 .tmp/i18n-src/（已被 git 忽略）
python tools/sync_i18n.py
# 国内直连 gitlab 不通，需要代理时
I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py
```

> `vendor/miao/` 是「原样搬运 + 定点改写」，本目录不同：
> 它是**从 43 MB 原始表里提取出来的子集**，提取逻辑见脚本。
