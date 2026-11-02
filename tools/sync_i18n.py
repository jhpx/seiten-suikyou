#!/usr/bin/env python3
"""
把官方多语言文案搬进 `vendor/i18n/` —— **能原样的就原样**。

产物布局
--------
| 文件 | 来源 | 处理 |
|---|---|---|
| `locs.json` | enka `store/gi/locs.json` | **字节级原样复制** |
| `avatars.json` | enka `store/gi/avatars.json` | **原样** |
| `weapons.json` | enka `store/gi/weapons.json` | **原样** |
| `relics.json` | enka `store/gi/relics.json` | **原样** |
| `slots.json` | 无上游（手写） | 5 个部位名 |
| `textmap/{chs,cht,en,ja,ko}.json` | Dimbreath TextMap | 提取件：43 MB 里只留部件名，`{hash: 文案}` |

为什么原样：上游一更新，`git diff` 直接就能看出 `locs.json` 里哪条变了。

只有 TextMap 没法原样（单语言 43 MB × 5），才做提取件。允许清单来自 Dimbreath 的
`ReliquaryExcelConfigData`（哪些 hash 算部件名），**只在构建期用，不落 vendor** ——
运行时靠玩家接口给的 `nameTextMapHash` 直接查 `textmap/*.json`。

两个数据源，各取它权威的地方
----------------------------
1. enka `store/gi/`（**名字主源**）：它跟着 enka 线上口径走，新角色/新套装一上线就有。
2. Dimbreath TextMap（**只为圣遗物部件名**）：enka 的 9 个 store/gi 文件里一条部件名都没有，
   所以「魔女的炎之花」这类每套 5 个的诗意名只能从 TextMap 取。

⚠️ 两套 hash 空间别混：
   - enka 玩家接口给的是 `setNameTextMapHash`（千岩 1337665995），**locs.json 里没有它**；
   - 套装名要用 `setId → Sets[setId].Name`（千岩 15017 → 4007101907）才查得到。
   所以套装身份一律走 **setId**（由 itemId 推出），别拿接口那个 hash 去查表。

用法
----
    python tools/sync_i18n.py
    python tools/sync_i18n.py --refresh              # 无视缓存，全部重下
    python tools/sync_i18n.py --locales chs,en       # 只要两种语言
    I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".tmp" / "i18n-src"          # 原始大文件缓存（.tmp 已被 git 忽略）
OUT_DIR = ROOT / "vendor" / "i18n"
TEXTMAP_OUT = OUT_DIR / "textmap"
REPORT = ROOT / "docs" / "reports" / "i18n-report.md"

# enka 的资产目录（名字主源）。拉单个文件走 raw，别用 jsdelivr —— 那是按 tag 缓存的，
# 实测会给到几个月前的旧副本，正是「同步完还是没有炉火」的坑之一。
ENKA_GI = "https://raw.githubusercontent.com/EnkaNetwork/API-docs/refs/heads/master/store/gi/{}.json"
ENKA_FILES = {
    "locs.json": "15 语言文案（角色 / 武器 / 套装 / 词条名都在这）",
    "avatars.json": "avatarId → NameTextMapHash",
    "weapons.json": "weaponId → NameTextMapHash",
    "relics.json": "Items[itemId].SetId 与 Sets[setId].Name",
}

# 部件名只能从 TextMap 取。这张 Excel 表只当「哪些 hash 算部件名」的允许清单，构建期用完就扔。
DIMBREATH = "https://gitlab.com/Dimbreath/AnimeGameData/-/raw/master"
ALLOWLIST_FILE = "ReliquaryExcelConfigData.json"
TEXTMAP_URL = DIMBREATH + "/TextMap/TextMap_Medium{suffix}.json"

# 支持的语言。字段依次是：本项目代码 / TextMap 文件名后缀 / enka locs.json 的键 / 显示名
# （RU 与 TH 在上游被拆成 _0、_1 两个文件，暂不支持；要加就补下载逻辑。）
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

# 圣遗物五个部位的显示名。**enka 不提供这五个词**（它连部件名都没有），
# 而它们是固定 5 条游戏常量，所以手写在这儿、单独落 slots.json。
SLOTS = {
    "1": {"chs": "生之花", "cht": "生之花", "en": "Flower of Life", "ja": "生の花", "ko": "생명의 꽃"},
    "2": {"chs": "死之羽", "cht": "死之羽", "en": "Plume of Death", "ja": "死の羽", "ko": "죽음의 깃털"},
    "3": {"chs": "时之沙", "cht": "時之沙", "en": "Sands of Eon", "ja": "時の砂", "ko": "시간의 모래"},
    "4": {"chs": "空之杯", "cht": "空之杯", "en": "Goblet of Eonothem", "ja": "空の杯", "ko": "공간의 성배"},
    "5": {"chs": "理之冠", "cht": "理之冠", "en": "Circlet of Logos", "ja": "理の冠", "ko": "이성의 왕관"},
}

# 缓存有效天数。⚠️ 上一版的坑：缓存**永不过期**，于是「同步跑过了、时间也更新了，
# 但名字表还是旧的」。现在超期就重下；重下失败才退回旧缓存，并在报告里写明它的年龄。
CACHE_TTL_DAYS = 7


# ----------------------------------------------------------------- 下载

def curl(url: str, dest: Path, proxy: str | None = None, timeout: int = 900) -> bool:
    cmd = ["curl", "-sL", "--fail", "--max-time", str(timeout)]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd += ["-o", str(dest), url]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def age_days(dest: Path) -> float:
    return (time.time() - dest.stat().st_mtime) / 86400


def fetch(url: str, name: str, attempts: list[str | None], refresh: bool) -> tuple[Path, float]:
    """按顺序试 attempts（`None` = 直连，字符串 = 代理）。返回 (路径, 文件年龄天数)。

    缓存过期仍会先下载；下载全失败才退回旧缓存（并且把年龄交出去写进报告，
    不许「悄悄用三个月的旧表」）。
    """
    dest = CACHE / name
    have = dest.exists() and dest.stat().st_size > 0
    if have and not refresh and age_days(dest) < CACHE_TTL_DAYS:
        return dest, age_days(dest)

    # 先落到 .part 再改名：下到一半被掐断时，旧缓存还在，不会被半截文件顶掉
    tmp = dest.with_name(dest.name + ".part")
    for p in attempts:
        where = "直连" if p is None else p
        sys.stdout.write(f"  下载 {name}（{where}）… ")
        sys.stdout.flush()
        # 直连只给 60 秒：国内是「连得上但不给数据」，等满 900 秒纯浪费
        if curl(url, tmp, p, 60 if p is None else 900):
            tmp.replace(dest)
            print(f"{dest.stat().st_size / 1024:.0f} KB")
            return dest, 0.0
        print("失败")
        if tmp.exists():
            tmp.unlink()

    if have:
        print(f"  [警告] {name} 下载全失败，退回缓存（已 {age_days(dest):.0f} 天，可能落后游戏版本）")
        return dest, age_days(dest)
    print(f"[错误] 拿不到 {name}：{url}")
    sys.exit(1)


# ----------------------------------------------------------------- 读写

def load(name: str):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def write_json(dest: Path, payload) -> int:
    """紧凑写：不缩进（文件小），键排序保证「同数据同字节」，diff 才干净。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
                    encoding="utf-8", newline="\n")
    return dest.stat().st_size


def copy_raw(name: str) -> int:
    """字节级复制上游文件 —— 不解码、不重新序列化。这才叫「原样」。"""
    dest = OUT_DIR / name
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(CACHE / name, dest)
    return dest.stat().st_size


# ----------------------------------------------------------------- 提取：部件名

def piece_allowlist(relics: dict) -> dict[str, str]:
    """部件 id → 部件名 hash。只收「属于正式套装」的（4000+ 条里大部分 setId=0，是低星狗粮）。"""
    sets = relics["Sets"]
    out: dict[str, str] = {}
    for x in load(ALLOWLIST_FILE):
        if str(x.get("setId")) in sets and x.get("nameTextMapHash"):
            out[str(x["id"])] = str(x["nameTextMapHash"])
    return out


def build_textmap(hashes: set[str], suffix: str) -> dict[str, str]:
    """从 43 MB 的完整 TextMap 里只挑出部件名那几条，{hash: 文案}。"""
    full = load(f"TextMap_Medium{suffix}.json")
    return {h: full[h] for h in hashes if h in full}


# ----------------------------------------------------------------- 审计

def audit(avatars: dict, weapons: dict, relics: dict, locs: dict,
          pieces: dict[str, str], textmaps: dict[str, dict[str, str]],
          locales: list[str]) -> dict:
    """核对「该有名字的都有名字」，并把上游滞后点名出来。

    重点看 set_piece_gap：enka 已经有的套装，它下面的部件名 TextMap 里有没有。
    没有 = TextMap 落后于游戏版本 → 这些部件会退回中文名（不是崩，但要写进报告）。
    """
    loc_hits = {}
    for code, _suffix, loc_key, _label in LOCALES:
        if code not in locales:
            continue
        d = locs.get(loc_key) or {}
        loc_hits[code] = {
            "avatar": sum(1 for v in avatars.values() if str(v.get("NameTextMapHash")) in d),
            "weapon": sum(1 for v in weapons.values() if str(v.get("NameTextMapHash")) in d),
            "set": sum(1 for v in relics["Sets"].values() if str(v.get("Name")) in d),
        }

    # 每个套装下的部件：enka 说它有几个，允许清单认几个名字
    enka_by_set: dict[str, list[str]] = {}
    for item_id, it in relics["Items"].items():
        sid = str(it.get("SetId"))
        if sid in relics["Sets"]:
            enka_by_set.setdefault(sid, []).append(str(item_id))
    piece_ids = set(pieces)
    set_piece_gap = sorted(
        (sid, sum(1 for i in ids if i in piece_ids), len(ids))
        for sid, ids in enka_by_set.items()
        if sum(1 for i in ids if i in piece_ids) < len(ids)
    )

    # 差在哪一层，看这两个数就够：TextMap 里最大的 setId 只要追上 enka，缺口自然消失。
    tm_max = max((int(x["setId"]) for x in load(ALLOWLIST_FILE) if x.get("setId")), default=0)
    enka_max = max((int(s) for s in relics["Sets"]), default=0)

    return {
        "loc_hits": loc_hits,
        "set_piece_gap": set_piece_gap,
        "textmap_max": tm_max,
        "enka_max": enka_max,
        "sets": len(relics["Sets"]),
        "avatars": len(avatars),
        "weapons": len(weapons),
        "allow": len(set(pieces.values())),
        "textmap_hits": {c: sum(1 for v in pieces.values() if v in textmaps.get(c, {})) for c in locales},
    }


# ----------------------------------------------------------------- 文档

def build_vendor(meta: dict, counts: dict, locales: list[str]) -> str:
    labels = {c: n for c, _s, _l, n in LOCALES}
    return "\n".join([
        "# vendor/i18n 来源记录",
        "",
        "本目录由 `python tools/sync_i18n.py` 生成，**请勿手工编辑**。",
        "",
        "## 目录里都是什么",
        "",
        "| 文件 | 来源 | 处理方式 |",
        "|---|---|---|",
        "| `locs.json` | enka `store/gi/locs.json` | **原样**（字节级复制） |",
        "| `avatars.json` | enka `store/gi/avatars.json` | **原样** |",
        "| `weapons.json` | enka `store/gi/weapons.json` | **原样** |",
        "| `relics.json` | enka `store/gi/relics.json` | **原样** |",
        "| `slots.json` | 无上游，手写 | 5 个部位名 |",
        "| `textmap/*.json` | Dimbreath `TextMap` | **提取件**：43 MB 里只留部件名，`{hash: 文案}` |",
        "",
        f"同步时间：{meta['fetched_at']}　语言：{'、'.join(labels[c] for c in locales)}",
        "",
        f"体量：{counts['set']} 个套装 / {counts['avatar']} 个角色 / {counts['weapon']} 把武器 / "
        f"{counts['item']} 个部件归属 / {counts['hash']} 个部件名 hash。",
        "",
        "上游一更新，`git diff` 直接就能看出 `locs.json` 里哪条变了 —— 这是「原样」的唯一理由。",
        "TextMap 做不到原样（单语言 43 MB），所以只留提取件；它的允许清单来自 Dimbreath 的",
        "`ReliquaryExcelConfigData`，只在构建期用，不落在本目录。",
        "",
        "## 为什么角色/武器/套装/词条走 enka，只有部件名走 TextMap",
        "",
        "enka 的 `store/gi/` 是它自己的线上口径，新角色/新套装一上线就有；"
        "而 TextMap dump 是社区周更的，会滞后。",
        "但 enka **不收录圣遗物部件名**（它的网页也不显示这个），"
        "所以「魔女的炎之花」这类名字只能从 TextMap 取。",
        "",
        "## 两套 hash 空间别混",
        "",
        "玩家接口给的是 `setNameTextMapHash`（千岩 = 1337665995），"
        "它**不在 locs.json 里**；套装名要经 `itemId → setId → Sets[setId].Name` "
        "（千岩 = 15017 → 4007101907）才查得到。所以套装身份一律用 **setId**。",
        "",
    ])


def build_report(meta: dict, counts: dict, audit_res: dict, locales: list[str],
                 sizes: dict[str, int], cache_ages: dict[str, float]) -> str:
    labels = {c: n for c, _s, _l, n in LOCALES}
    L = [
        "# 多语言文案同步报告",
        "",
        f"- 同步时间：{meta['fetched_at']}",
        f"- 名字主源：`{meta['enka']}`（原样复制）",
        f"- 部件名来源：`{meta['textmap']}`（enka 不收录部件名）",
        f"- 语言：{'、'.join(labels[c] for c in locales)}",
        "",
        "## 一、产物",
        "",
        "| 文件 | 大小 | 来源 | 处理方式 |",
        "|---|---|---|---|",
        f"| `locs.json` | {sizes['locs.json'] / 1024:.0f} KB | enka | **原样** |",
        f"| `avatars.json` | {sizes['avatars.json'] / 1024:.0f} KB | enka | **原样** |",
        f"| `weapons.json` | {sizes['weapons.json'] / 1024:.0f} KB | enka | **原样** |",
        f"| `relics.json` | {sizes['relics.json'] / 1024:.0f} KB | enka | **原样** |",
        f"| `slots.json` | {sizes['slots.json'] / 1024:.0f} KB | 手写 | 5 个部位名 |",
    ]
    for c in locales:
        L.append(f"| `textmap/{c}.json` | {sizes[f'textmap/{c}.json'] / 1024:.0f} KB | "
                 f"Dimbreath TextMap | 提取 |")
    L += [
        f"| **合计** | **{sum(sizes.values()) / 1024:.0f} KB** | | |",
        "",
        f"条数：套装 {counts['set']}、角色 {counts['avatar']}、武器 {counts['weapon']}、"
        f"部件归属 {counts['item']}、部件名 hash {counts['hash']}。",
        "",
        "源文件里 TextMap 是单语言 43 MB / 54 万条，这里只挑出部件名那几条 ——"
        "其余是任务对白和道具描述，用不上。",
        "",
        "## 二、覆盖审计（每种语言命中率）",
        "",
        "| 语言 | 角色 | 武器 | 套装 | 部件名 |",
        "|---|---|---|---|---|",
    ]
    for code, hit in audit_res["loc_hits"].items():
        L.append(f"| {labels[code]}（{code}） | {hit['avatar']}/{audit_res['avatars']} | "
                 f"{hit['weapon']}/{audit_res['weapons']} | {hit['set']}/{audit_res['sets']} | "
                 f"{audit_res['textmap_hits'][code]}/{audit_res['allow']} |")

    L += ["", "## 三、上游滞后预警", ""]
    gap = audit_res["set_piece_gap"]
    if gap:
        L.append("下面这些套装 enka 已经有，但 TextMap 里凑不齐部件名（这些部件会退回中文名）：")
        L.append("")
        for sid, named, total in gap:
            L.append(f"- setId `{sid}`：{named}/{total} 个部件有名字")
        L.append("")
        L.append(f"上游进度：TextMap（Dimbreath `master`）最大 setId 是 **{audit_res['textmap_max']}**，"
                 f"enka 已经到 **{audit_res['enka_max']}**。"
                 "等 dump 追上来重跑本脚本即可，不用改代码。")
    else:
        L.append("- 无：enka 的每个套装，TextMap 都能凑齐部件名。")

    stale = {n: a for n, a in cache_ages.items() if a >= CACHE_TTL_DAYS}
    L += ["", "## 四、缓存状态", ""]
    if stale:
        L.append("⚠️ 下面这些原始文件**下载失败、退回了旧缓存**，本轮产物可能落后游戏版本：")
        L.append("")
        for n, a in sorted(stale.items()):
            L.append(f"- `{n}`：{a:.0f} 天前")
        L.append("")
        L.append("先换代理/网络，再 `python tools/sync_i18n.py --refresh`。")
    else:
        L.append(f"- 全部为本轮新下载或 {CACHE_TTL_DAYS} 天内的新鲜缓存。")
        L.append("- 想强制重下（怀疑上游更新了）：`python tools/sync_i18n.py --refresh`。")

    L += [
        "",
        "## 五、怎么复现",
        "",
        "```bash",
        "# 原始大文件缓存在 .tmp/i18n-src/（已被 git 忽略），只有产物进仓库",
        "python tools/sync_i18n.py",
        "# 国内直连不通时（enka 在 raw.githubusercontent、TextMap 在 gitlab）",
        "I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py",
        "```",
        "",
        "> enka 那 4 个文件是**字节级原样复制**；TextMap 那份是提取件，提取逻辑见脚本。",
        "",
    ]
    return "\n".join(L)


# ----------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser(description="同步官方多语言文案（enka 原样 + TextMap 提取件）")
    ap.add_argument("--locales", default=os.environ.get("I18N_LOCALES", ",".join(DEFAULT_LOCALES)),
                    help=f"逗号分隔，默认 {','.join(DEFAULT_LOCALES)}")
    ap.add_argument("--refresh", action="store_true",
                    help="无视缓存有效期，全部重新下载")
    args = ap.parse_args()

    locales = [x.strip() for x in args.locales.split(",") if x.strip()]
    known = {c for c, _s, _l, _n in LOCALES}
    bad = [c for c in locales if c not in known]
    if bad:
        print(f"[错误] 不支持的语言：{', '.join(bad)}；可用：{', '.join(sorted(known))}")
        return 2

    refresh = args.refresh or os.environ.get("I18N_REFRESH") == "1"
    # 显式给了 I18N_PROXY 就只走代理 —— 国内直连 gitlab / raw.githubusercontent 会一直挂着，
    # 先试直连等于白等十几分钟。没给才「直连 → 本地那台代理」依次试。
    explicit = os.environ.get("I18N_PROXY")
    attempts: list[str | None] = [explicit] if explicit else [None, "socks5h://127.0.0.1:4080"]
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT.parent.mkdir(parents=True, exist_ok=True)

    cache_ages: dict[str, float] = {}

    print("① 拉 enka store/gi（角色 / 武器 / 套装 / 词条名）")
    for name, what in ENKA_FILES.items():
        _p, age = fetch(ENKA_GI.format(name.replace(".json", "")), name, attempts, refresh)
        cache_ages[name] = age
        print(f"     {name}：{what}")

    print("② 拉 Dimbreath（部件名允许清单 + TextMap，单语言 43 MB）")
    _p, age = fetch(f"{DIMBREATH}/ExcelBinOutput/{ALLOWLIST_FILE}", ALLOWLIST_FILE, attempts, refresh)
    cache_ages[ALLOWLIST_FILE] = age
    for code, suffix, _lk, _n in LOCALES:
        if code not in locales:
            continue
        p, age = fetch(TEXTMAP_URL.format(suffix=suffix), f"TextMap_Medium{suffix}.json", attempts, refresh)
        cache_ages[p.name] = age

    print("③ 提取")
    locs = load("locs.json")
    avatars = load("avatars.json")
    weapons = load("weapons.json")
    relics = load("relics.json")
    pieces = piece_allowlist(relics)
    hashes = set(pieces.values())
    textmaps = {code: build_textmap(hashes, suffix)
                for code, suffix, _lk, _n in LOCALES if code in locales}

    counts = {
        "avatar": len(avatars),
        "weapon": len(weapons),
        "set": len(relics["Sets"]),
        # enka 里「属于某个正式套装」的部件件数（散件 SetId=0，不算）
        "item": sum(1 for v in relics["Items"].values() if str(v.get("SetId")) in relics["Sets"]),
        # 这些件去重后有多少个不同的名字 hash（TextMap 里就按这个挑）
        "hash": len(hashes),
    }
    audit_res = audit(avatars, weapons, relics, locs, pieces, textmaps, locales)

    # ---- 落盘 ----
    sizes: dict[str, int] = {}
    for name in ENKA_FILES:
        sizes[name] = copy_raw(name)
    sizes["slots.json"] = write_json(OUT_DIR / "slots.json", SLOTS)
    for code, table in textmaps.items():
        sizes[f"textmap/{code}.json"] = write_json(TEXTMAP_OUT / f"{code}.json", table)

    meta = {
        "enka": "EnkaNetwork/API-docs store/gi/{locs,avatars,weapons,relics}.json",
        "textmap": "gitlab.com/Dimbreath/AnimeGameData（TextMap，只取部件名）",
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
    }
    (OUT_DIR / "VENDOR.md").write_text(build_vendor(meta, counts, locales), encoding="utf-8", newline="\n")
    REPORT.write_text(build_report(meta, counts, audit_res, locales, sizes, cache_ages),
                      encoding="utf-8", newline="\n")

    print()
    print(f"语言: {', '.join(locales)}")
    print(f"套装 {counts['set']} / 角色 {counts['avatar']} / 武器 {counts['weapon']} / "
          f"部件归属 {counts['item']} / 部件名 hash {counts['hash']}")
    if audit_res["set_piece_gap"]:
        print(f"[警告] {len(audit_res['set_piece_gap'])} 个套装的部件名 TextMap 凑不齐（TextMap 滞后，见报告）")
    print(f"产物: {OUT_DIR.relative_to(ROOT).as_posix()}（合计 {sum(sizes.values()) / 1024:.0f} KB）")
    print(f"报告: {REPORT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
