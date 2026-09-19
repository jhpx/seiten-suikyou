#!/usr/bin/env python3
"""
把官方多语言文案搬进来，产出一份「本地化无关」的紧凑名字表。

为什么单独一个脚本
------------------
miao 零 i18n 能力：`resources/` 全是中文，角色目录名、权重表、套装缩写、武器特判
全都拿中文名当键。想显示英文/日文名，只能自建表。

而官方文案的原始体积离谱：单语言的完整 TextMap 是 43 MB / 54 万条，其中九成九
是对白和任务文本，我们一条都不要。所以只能**离线提取**：
下载 → 只挑我们可能用到的名字 → 落一份几十 KB 的表进仓库。运行时不碰原始文件。

两个数据源，各自用在它权威的地方
--------------------------------
1. 名字（角色 / 武器 / 圣遗物件 / 套装）
   - `id → hash`：Dimbreath/AnimeGameData 的 `ExcelBinOutput/*.json`
   - `hash → 文案`：同仓库的 `TextMap/TextMap_Medium{语言}.json`
   这两边是**原值直接对上**的，不需要任何偏移修正（实测：60 件圣遗物名称与 enka
   返回的 hash 逐字一致）。

2. 词条名（生命值 / 暴击率 / 火元素伤害加成 …）
   - 用 EnkaNetwork 的 `store/loc.json`：它的词条区块**直接用 `FIGHT_PROP_*` 当键**，
     正好是 miao `StatType` 的取值，没有歧义，也不需要 hash。
   - ⚠️ 这张表的**数字 hash 键**有 +512 的怪癖（同一个套装名，一半条目对得上、
     一半要 +512），所以名字类一律不用它。

用法:
    python tools/sync_i18n.py
    python tools/sync_i18n.py --locales chs,cht,en,ja,ko
    I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py

产物:
    vendor/i18n/names.json     紧凑名字表（提交进仓库）
    vendor/i18n/VENDOR.md      来源与覆盖情况（生成物，勿手工编辑）
    docs/reports/i18n-report.md 本次同步报告
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".tmp" / "i18n-src"          # 原始大文件缓存（.tmp 已被 git 忽略）
OUT_DIR = ROOT / "vendor" / "i18n"
OUT_JSON = OUT_DIR / "names.json"
OUT_VENDOR = OUT_DIR / "VENDOR.md"
REPORT = ROOT / "docs" / "reports" / "i18n-report.md"

RAW = "https://gitlab.com/Dimbreath/AnimeGameData/-/raw/master"
ENKA_LOC = "https://cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/loc.json"

# 支持的语言。字段依次是：本项目代码 / TextMap 文件名后缀 / enka loc.json 的键 / 显示名
# 注意 RU 与 TH 在上游被拆成了 _0、_1 两个文件，这里暂不支持（要加就补下载逻辑）。
LOCALES = [
    ("chs", "CHS", "zh-cn", "简体中文"),
    ("cht", "CHT", "zh-tw", "繁體中文"),
    ("en", "EN", "en", "English"),
    ("ja", "JP", "ja", "日本語"),
    ("ko", "KR", "ko", "한국어"),
    ("de", "DE", "de", "Deutsch"),
    ("es", "ES", "es", "Español"),
    ("fr", "FR", "fr", "Français"),
    ("id", "ID", "id", "Bahasa Indonesia"),
    ("it", "IT", "it", "Italiano"),
    ("pt", "PT", "pt", "Português"),
    ("tr", "TR", "tr", "Türkçe"),
    ("vi", "VI", "vi", "Tiếng Việt"),
]
DEFAULT_LOCALES = ["chs", "cht", "en", "ja", "ko"]

# 圣遗物五个部位的显示名。这五个名字在官方表里是**唯一**的，所以能按名字反查 hash。
# 词条名就绝不能这么干 ——「攻击力」在全量表里出现 22 次、「暴击率」6 次，
# 反查必然选错语境（那是对白里的「攻击力」）。词条走 enka 的 FIGHT_PROP_* 表。
SLOTS = [("1", "生之花"), ("2", "死之羽"), ("3", "时之沙"), ("4", "空之杯"), ("5", "理之冠")]

# 要下载的 ExcelBinOutput 表 → 它给什么
EXCEL_TABLES = {
    "AvatarExcelConfigData.json": "角色 id → 名字 hash",
    "WeaponExcelConfigData.json": "武器 id → 名字 hash",
    "ReliquaryExcelConfigData.json": "圣遗物部件 id → 名字 hash",
    "ReliquarySetExcelConfigData.json": "套装 setId → equipAffixId（再换套装名）",
    "EquipAffixExcelConfigData.json": "equipAffixId → 套装名 hash",
}


# ----------------------------------------------------------------- 下载

def curl(url: str, dest: Path, proxy: str | None = None) -> bool:
    cmd = ["curl", "-sL", "--fail", "--max-time", "600"]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd += ["-o", str(dest), url]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def fetch(url: str, name: str, proxies: list[str]) -> Path:
    """按顺序试：缓存 → 直连 → 各个代理。都不行就报错退出。"""
    dest = CACHE / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    tries = [None] + proxies
    for p in tries:
        where = "直连" if p is None else p
        sys.stdout.write(f"  下载 {name}（{where}）… ")
        sys.stdout.flush()
        if curl(url, dest, p):
            print(f"{dest.stat().st_size / 1024:.0f} KB")
            return dest
        print("失败")
    print(f"[错误] 拿不到 {name}：{url}")
    sys.exit(1)


# ----------------------------------------------------------------- 读取

def load(name: str) -> dict | list:
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


# ----------------------------------------------------------------- 构造

def build_name_hashes() -> dict[str, dict[str, int]]:
    """五类东西的 id → 名字 hash。

    关系链有一处需要绕：套装的**名字**不在 ReliquarySetExcelConfigData 里
    （那里只有 2/4 件套的说明文案），得先拿 equipAffixId 去 EquipAffixExcelConfigData
    取 level=0 那条的 nameTextMapHash（实测：setId 10001 → affix 210001 → 「行者之心」）。
    """
    avatars = {str(x["id"]): x["nameTextMapHash"] for x in load("AvatarExcelConfigData.json") if x.get("nameTextMapHash")}
    weapons = {str(x["id"]): x["nameTextMapHash"] for x in load("WeaponExcelConfigData.json") if x.get("nameTextMapHash")}

    sets_raw = load("ReliquarySetExcelConfigData.json")
    affix = {}
    for x in load("EquipAffixExcelConfigData.json"):
        # 同一个 id 有 level 0..N 多条，只有 level 0 是套装名本身
        if x.get("level") == 0 and x.get("nameTextMapHash"):
            affix[str(x["id"])] = x["nameTextMapHash"]
    sets = {}
    for s in sets_raw:
        h = affix.get(str(s.get("equipAffixId")))
        if not h:
            continue
        sets[str(s["setId"])] = h

    # 部件：按 ReliquaryExcelConfigData 自己的 setId 归属来筛（只收属于正式套装的，
    # 那 4000+ 条里大部分 setId=0，是低星狗粮）。
    # ⚠️ 不能用 ReliquarySetExcelConfigData 的 containsList 来筛 —— 那是一套**变体 id**
    # （给的是 51140 这种），和 enka 返回的 80543 不是同一个空间，筛完会全军覆没。
    pieces = {}
    for x in load("ReliquaryExcelConfigData.json"):
        if str(x.get("setId")) in sets and x.get("nameTextMapHash"):
            pieces[str(x["id"])] = x["nameTextMapHash"]

    return {"avatar": avatars, "weapon": weapons, "piece": pieces, "set": sets}


def build_stats(loc: dict, locales: list[str]) -> dict:
    """词条名：直接吃 loc.json 里 FIGHT_PROP_* 那一块。"""
    out = {}
    for prop, zh in loc.get("zh-cn", {}).items():
        if not prop.startswith("FIGHT_PROP_"):
            continue
        row = {}
        for code, _suffix, loc_key, _label in LOCALES:
            if code not in locales:
                continue
            v = (loc.get(loc_key) or {}).get(prop)
            if v:
                row[code] = v
        if row:
            out[prop] = row
    return out


def locate_slots() -> dict[str, str]:
    """部位名 → hash。按中文名反查，要求唯一（不唯一说明官方改了命名，必须人工看一眼）。"""
    inv: dict[str, list[str]] = {}
    for h, t in load("TextMap_MediumCHS.json").items():
        inv.setdefault(t, []).append(h)
    out = {}
    for pos, label in SLOTS:
        hs = inv.get(label) or []
        if len(hs) != 1:
            print(f"[错误] 部位名「{label}」在官方表里出现 {len(hs)} 次，无法唯一定位")
            sys.exit(1)
        out[pos] = hs[0]
    return out


def build_names(hashes: dict, slots: dict, locales: list[str]):
    """产出名字组与 hash 索引。

    **为什么要「组」**：官方把同一段文案复用在几十处 ——「胡桃」在完整表里有 49 个键，
    「宗室之花」23 个，「炽烈的炎之魔女」11 个。enka 返回的是其中任意一个，
    离线时无法预知它给哪个（实测：套装经 EquipAffix 链出来的是 1928302715，
    而 enka 给的是 1524173875，两个都对）。

    **但不能只按中文名合并**。中文是**不唯一**的键：`以理服人` 既是武器 Debate Club，
    也是任务里的一句 "Time for a debate"；`信使` 在日文下有 3 种写法。
    只按中文合并的话，enka 给武器那个 hash 时，可能查到任务那句话的英文 —— 这就是串味。

    所以合并条件是「**在所有语言下文案都相同**」：先按中文粗合并，
    再逐语言切分 —— 哪个变体在某门语言下跟代表键不一致，就自己分出去单过。
    结果是：真变体（各语言都同）照旧合并，省下重新抓 enka 的功夫；
    撞名的（各语言不同）被切开，各拿各的翻译。

    返回 (groups, index, per_locale, splits)：
      groups     —— [{语言: 文案, _h: [hash...]}, ...]，组内各语言文案已保证一致
      index      —— {hash: 组号}，运行时拿任何变体都查得到
      per_locale —— 每种语言解析出多少组
      splits     —— 同一中文名被切成多组的清单（合并策略的哨兵，不是错误）
    """
    # 第一步：我们关心哪些名字（ExcelBinOutput / 部位名 → CHS 文案），并找出它们的所有同名键
    chs = load("TextMap_MediumCHS.json")
    rep: dict[str, str] = {}          # CHS 文案 → 代表 hash（优先取我们 id 表里的那个）
    for group in hashes.values():
        for h in group.values():
            t = chs.get(str(h))
            if t:
                rep.setdefault(t, str(h))
    for h in slots.values():
        t = chs.get(h)
        if t:
            rep.setdefault(t, h)

    # 中文名 → 所有同名的官方键。先按中文粗合并，「撞名」留给后面按语言切开
    raw: dict[str, list[str]] = {t: [] for t in rep}
    for h, t in chs.items():
        if t in raw:
            raw[t].append(h)
    del chs

    groups: list[dict] = [{"_h": raw[t], "chs": t} for t in rep]
    per_locale = {"chs": len(groups)}
    splits: list[str] = []

    # 第二步：逐语言切分。一次只载入一种语言的表（单文件 43 MB），用完立刻释放
    for code, suffix, _lk, _label in LOCALES:
        if code not in locales or code == "chs":
            continue
        table = load(f"TextMap_Medium{suffix}.json")
        nxt: list[dict] = []
        for g in groups:
            texts = {h: table.get(h) for h in g["_h"]}
            distinct = {t for t in texts.values() if t}
            if len(distinct) <= 1:
                # 这门语言下所有变体文案一致（或都没收录）—— 保持合并
                if distinct:
                    g[code] = next(iter(distinct))
                nxt.append(g)
                continue

            # 有分歧：按文案分桶。这门语言没收录的键，并进代表键那一桶
            rep_txt = texts.get(rep.get(g["chs"])) or sorted(distinct)[0]
            buckets: dict[str, list[str]] = {}
            for h in g["_h"]:
                buckets.setdefault(texts[h] or rep_txt, []).append(h)

            first = True
            for txt, hs in buckets.items():
                if first:
                    g["_h"], g[code] = hs, txt
                    nxt.append(g)
                    first = False
                    continue
                # 切出去的那一坨：把之前各语言已填好的文案抄过来
                # （它们在那些语言下和代表键一致，否则早就被切走了）
                sub = {"_h": hs, "chs": g["chs"], code: txt}
                for c in per_locale:
                    if c in g:
                        sub[c] = g[c]
                nxt.append(sub)
                splits.append(f"{g['chs']}（{code}）→ {txt}")
        groups = nxt
        per_locale[code] = len(groups)
        del table

    index: dict[str, int] = {}
    for gi, g in enumerate(groups):
        for h in g["_h"]:
            index[h] = gi
    return groups, index, per_locale, splits


# ----------------------------------------------------------------- 报告

def build_report(meta: dict, hashes: dict, groups: list, index: dict, per_locale: dict,
                 stats: dict, slots: dict, splits: list, locales: list[str]) -> str:
    labels = {c: n for c, _s, _l, n in LOCALES}
    total = len(groups)
    L = [
        "# 多语言文案同步报告",
        "",
        f"- 同步时间：{meta['fetched_at']}",
        f"- 上游来源：`{meta['repo']}`（`{meta['rev']}`）",
        f"- 词条来源：`{meta['enka_loc']}`",
        f"- 语言：{'、'.join(labels[c] for c in locales)}",
        "",
        "## 一、同步了什么",
        "",
        "| 类别 | 条目数 | 说明 |",
        "|---|---|---|",
        f"| 角色 | {len(hashes['avatar'])} | ExcelBinOutput/AvatarExcelConfigData |",
        f"| 武器 | {len(hashes['weapon'])} | ExcelBinOutput/WeaponExcelConfigData |",
        f"| 圣遗物部件 | {len(hashes['piece'])} | 按 ReliquaryExcelConfigData 自己的 setId 归属筛（低星狗粮不入表） |",
        f"| 套装 | {len(hashes['set'])} | setId → equipAffixId → EquipAffixExcelConfigData[level=0] |",
        f"| 部位 | {len(slots)} | 生之花/死之羽/时之沙/空之杯/理之冠（官方表里唯一，可反查） |",
        f"| 词条 | {len(stats)} | loc.json 的 FIGHT_PROP_* 区块 |",
        "",
        f"落库：**{total} 个名字组**，`nameIndex` 索引了 **{len(index)} 个 hash**"
        f"（平均一个名字对应 {len(index) / max(total, 1):.1f} 个官方键）。",
        "",
        "## 二、为什么要「名字组」，以及为什么不能只按中文名合并",
        "",
        "官方把同一段文案复用在几十处：「胡桃」在完整表里有 49 个键、「宗室之花」23 个、"
        "「炽烈的炎之魔女」11 个。enka 返回的是其中任意一个 —— 实测套装经 EquipAffix 链出来的是",
        "`1928302715`，而 enka 给的是 `1524173875`，两个都对，只是变体不同。",
        "离线时无法预知 enka 给哪个，所以要把**变体键全部收进来**。",
        "",
        "但「同名」不等于「同一个东西」：中文是**不唯一**的键 —— `以理服人` 既是武器",
        "Debate Club，也是任务里的一句 *Time for a debate*；`信使` 在日文下有 3 种写法。",
        "只按中文合并的话，enka 给武器那个 hash 时，可能查出任务那句话的英文，这才是真的串味。",
        "",
        "所以合并条件是「**在所有语言下文案都相同**」：先按中文粗合并，再逐语言切分。",
        "真变体（各语言都一致）照旧合并在一起，撞名的被切开、各拿各的翻译。",
        "",
        f"因撞名而切出来的组：**{len(splits)}** 处"
        + ("（见下）" if splits else " —— 本轮没有撞名，合并全部保持"),
        "",
    ]
    for c in splits[:12]:
        L.append(f"- {c}")
    L += [
        "",
        "## 三、每种语言解析到多少组",
        "",
        "| 语言 | 有文案的组 | 占比 |",
        "|---|---|---|",
    ]
    for c in locales:
        n = per_locale.get(c, 0)
        L.append(f"| {labels[c]}（{c}） | {n} / {total} | {n / max(total, 1) * 100:.1f}% |")

    # 只剩中文的组 = 其它语言一条都没收录
    zh_only = [g for g in groups if all(c not in g for c in locales if c != "chs")]
    L += [
        "",
        "- 分母是**切分后**的最终组数；越靠后切出来的组，前面的语言还没轮到它，所以数字递增是正常的。",
        "",
        "## 四、没解析到的",
        "",
        f"- 上游 dump 落后于游戏时，比它新的角色/武器/套装会**整体缺席**"
        f"（不是翻译缺失，是 id 根本没进表）。实测：{meta['missing_sample']}",
        f"- 只有中文、其它语言一条都没收录的组：{len(zh_only)} 个",
        "",
        "## 五、怎么复现",
        "",
        "```bash",
        "# 默认 chs,cht,en,ja,ko；原始大文件缓存在 .tmp/i18n-src/（已被 git 忽略）",
        "python tools/sync_i18n.py",
        "# 国内直连 gitlab 不通，需要代理时",
        "I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py",
        "```",
        "",
        "> `vendor/miao/` 是「原样搬运 + 定点改写」，本目录不同：",
        "> 它是**从 43 MB 原始表里提取出来的子集**，提取逻辑见脚本。",
        "",
    ]
    return "\n".join(L)


def build_vendor(meta: dict, hashes: dict, groups: list, index: dict, locales: list[str]) -> str:
    labels = {c: n for c, _s, _l, n in LOCALES}
    return "\n".join([
        "# vendor/i18n 来源记录",
        "",
        "本目录由 `python tools/sync_i18n.py` 生成，**请勿手工编辑**。",
        "",
        f"- 上游：`{meta['repo']}`（`{meta['rev']}`）",
        f"- 词条上游：`{meta['enka_loc']}`",
        f"- 同步时间：{meta['fetched_at']}",
        f"- 语言：{', '.join(labels[c] for c in locales)}",
        f"- 内容：{len(groups)} 个名字组 / {len(index)} 个 hash 索引 / {len(hashes['set'])} 个套装",
        "",
        "## 为什么不直接放原始 TextMap",
        "",
        "单语言完整表 43 MB / 54 万条，九成九是对白，我们一条都不要。",
        "这里存的是**离线提取后的子集**（几百 KB）。要核对提取对不对，重跑脚本并对比",
        "`docs/reports/i18n-report.md` —— 报告里有每种类别的条目数、每语言的命中率、以及撞名切分哨兵。",
        "",
    ])


# ----------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser(description="同步官方多语言文案（提取版）")
    ap.add_argument("--locales", default=os.environ.get("I18N_LOCALES", ",".join(DEFAULT_LOCALES)),
                    help=f"逗号分隔，默认 {','.join(DEFAULT_LOCALES)}")
    args = ap.parse_args()

    locales = [x.strip() for x in args.locales.split(",") if x.strip()]
    known = {c for c, _s, _l, _n in LOCALES}
    bad = [c for c in locales if c not in known]
    if bad:
        print(f"[错误] 不支持的语言：{', '.join(bad)}；可用：{', '.join(sorted(known))}")
        return 2

    proxies = [p for p in [os.environ.get("I18N_PROXY"), "socks5h://127.0.0.1:4080"] if p]
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.parent.mkdir(parents=True, exist_ok=True)      # 报告在 docs/reports/ 子目录下

    print("① 拉 ExcelBinOutput（id → 名字 hash）")
    for name in EXCEL_TABLES:
        fetch(f"{RAW}/ExcelBinOutput/{name}", name, proxies)

    print("② 拉 TextMap（hash → 文案，单语言 43 MB）")
    for code, suffix, _lk, label in LOCALES:
        if code in locales:
            fetch(f"{RAW}/TextMap/TextMap_Medium{suffix}.json", f"TextMap_Medium{suffix}.json", proxies)

    print("③ 拉 enka 的 loc.json（词条名，按 FIGHT_PROP_* 键）")
    fetch(ENKA_LOC, "loc.json", proxies)

    print("④ 提取")
    hashes = build_name_hashes()
    slot_hashes = locate_slots()
    groups, index, per_locale, splits = build_names(hashes, slot_hashes, locales)
    stats = build_stats(load("loc.json"), locales)
    slots = {pos: groups[index[h]] for pos, h in slot_hashes.items() if h in index}

    # _h 是构建期的中间产物（这一组包含哪些 hash）。它已经汇总进 nameIndex 了，
    # 不落盘 —— 落盘等于把 11931 个 hash 再存一遍，白占空间。
    for g in groups:
        g.pop("_h", None)

    meta = {
        "repo": "gitlab.com/Dimbreath/AnimeGameData",
        "rev": "master（最近提交 2026-06-29，游戏 6.6.0）",
        "enka_loc": "cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/loc.json",
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "missing_sample": "uid 101242308 展柜里的「熔铸者」套装（比 dump 新），以及角色「奥黛塔」",
    }

    payload = {
        "source": meta,
        "locales": [{"code": c, "label": n} for c, _s, _l, n in LOCALES if c in locales],
        # 名字组：同一个名字的多种官方写法合并成一组；中文撞名的会被切开（见 build_names）
        "names": groups,
        # hash → 组号。官方把同一段文案复用在几十处，enka 返回哪个变体都能落到同一组
        "nameIndex": index,
        "slots": slots,          # 部位 1..5 → 文案
        "stats": stats,          # FIGHT_PROP_* → 文案
        "byId": hashes,          # avatarId / weaponId / pieceId / setId → hash
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
                        encoding="utf-8", newline="\n")
    OUT_VENDOR.write_text(build_vendor(meta, hashes, groups, index, locales), encoding="utf-8", newline="\n")
    REPORT.write_text(build_report(meta, hashes, groups, index, per_locale, stats, slots, splits, locales),
                      encoding="utf-8", newline="\n")

    print()
    print(f"语言: {', '.join(locales)}")
    print(f"名字组: {len(groups)}（角色 {len(hashes['avatar'])} / 武器 {len(hashes['weapon'])} "
          f"/ 部件 {len(hashes['piece'])} / 套装 {len(hashes['set'])}）")
    print(f"hash 索引: {len(index)} 条" + (f"　因撞名切分 {len(splits)} 处" if splits else ""))
    print(f"部位: {len(slots)} 个　词条: {len(stats)} 个 FIGHT_PROP_*")
    print(f"产物: {OUT_JSON.relative_to(ROOT).as_posix()} "
          f"({OUT_JSON.stat().st_size / 1024:.0f} KB)")
    print(f"报告: {REPORT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
