#!/usr/bin/env python3
"""
从 miao-plugin GitHub 仓库下载图片素材到 src/server/public/assets/。

本仓库的 vendor/miao/ 只同步代码与元数据，不同步二进制图片（太大了）。
页面要还原 miao 的评分卡，需要角色立绘、圣遗物图标、UI 小图三类素材。
这个脚本按需从上游拉取，下载结果进 src/server/public/assets/，并按原目录结构存放。

用法：
    python tools/sync_assets.py
    ASSETS_PROXY=socks5h://127.0.0.1:4080 python tools/sync_assets.py
    python tools/sync_assets.py --db data/gs.db --out src/server/public/assets

设计取舍：
- 只下载本地库里实际出现的角色和圣遗物套装，避免一上来就拖几百 MB。
- 404 不抛错 —— 上游没有这个角色/套装时安静地跳过，页面会回退到 CSS 占位。
- 文件存在且大小对才跳过，避免断网重跑时把已有图片破坏掉。
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
DEFAULT_DB = ROOT / "data" / "gs.db"
DEFAULT_OUT = ROOT / "src" / "server" / "public" / "assets"

REPO_RAW = "https://raw.githubusercontent.com/yoimiya-kokomi/miao-plugin/master/resources"

COMMON_ASSETS = [
    "common/cont/card-bg.png",
    # 属性表那一行的小图标是**一张横向精灵图**，靠 background-position 切
    "character/imgs/icon.png",
    "character/imgs/star.png",
    "character/imgs/up-num-icon0.png",
    "character/imgs/up-num-icon1.png",
    "character/imgs/up-num-icon2.png",
    "character/imgs/crown.png",
    "character/imgs/main-01.png",
    "character/imgs/main-02.png",
    # 武器卡的星级图（miao common.css 里 .artis .weapon .star 用的）
    "common/item/star.png",
]

# 角色页整张画布的背景按元素分图：common/bg/bg-{元素}.webp
# 上游 elemLayout 把 element 映射成英文类名后挂到 container 上（见 common/layout/elem.html）
ELEM_BGS = ["pyro", "hydro", "anemo", "electro", "dendro", "cryo", "geo"]

# 天赋「普攻」图标按武器类型取，是公共图（miao CharImg.getImgs 的规则）
WEAPON_TYPES = ["sword", "claymore", "bow", "catalyst", "polearm"]

# 旅行者的立绘/命座在 meta-gs/character/旅行者/{元素}/ 下，不在自己名字的目录里
TRAVELER_ELEMS = ["anemo", "geo", "electro", "dendro", "hydro", "pyro"]


def log(*args):
    print(*args, file=sys.stderr)


def load_names(path: Path):
    """读 vendor/i18n/names.json，拿到 id/hash/中文名 的映射。"""
    if not path.exists():
        log(f"[warn] 找不到 {path}，只能按中文名硬猜")
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def chs_name_by_hash(names: dict, h):
    """用 nameIndex 把任意 hash 翻成中文名。"""
    idx = names.get("nameIndex", {})
    groups = names.get("names", [])
    gi = idx.get(str(h))
    if gi is None:
        return None
    row = groups[gi] if 0 <= gi < len(groups) else {}
    return row.get("chs") or row.get("en")


def avatar_name(names: dict, avatar_id: int):
    """avatarId → 中文角色名。"""
    h = names.get("byId", {}).get("avatar", {}).get(str(avatar_id))
    if not h:
        return None
    return chs_name_by_hash(names, h)


def load_weapon_index() -> dict:
    """
    扫 vendor/miao/resources/meta-gs/weapon/{类型}/data.json，
    建出「武器 itemId → (类型, 中文名)」。

    为什么自己扫而不是查别的：sync 是 Python，拿不到 Node 那边的 Weapon.get()。
    而 vendor 里 data.json 就摆在那儿，格式是 id → { id, name, star }，够用了。
    """
    idx = {}
    base = ROOT / "vendor" / "miao" / "resources" / "meta-gs" / "weapon"
    for wtype in WEAPON_TYPES:
        f = base / wtype / "data.json"
        if not f.exists():
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            log(f"[warn] 读 {f} 失败：{e}")
            continue
        for key, row in data.items():
            if isinstance(row, dict) and row.get("name"):
                idx[str(row.get("id", key))] = (wtype, row["name"])
    return idx


def load_miao_char_index() -> dict:
    """
    avatarId → miao 的中文角色名。

    优先用 vendor/miao/resources/meta-gs/character/data.json —— 图片目录名就是按
    **miao 的角色名**起的，这份才是权威来源。names.json（官方文案表）里没有的新角色
    （比如 10000150 奥黛塔）会查不到，那正是之前漏图的根因。
    """
    idx = {}
    f = ROOT / "vendor" / "miao" / "resources" / "meta-gs" / "character" / "data.json"
    if not f.exists():
        return idx
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"[warn] 读 {f} 失败：{e}")
        return idx
    for key, row in data.items():
        if isinstance(row, dict) and row.get("name"):
            idx[str(row.get("id", key))] = row["name"]
    return idx


def load_miao_artifact_index() -> dict:
    """
    圣遗物 itemId → (套装中文名, 部位)。

    一样取自 vendor/miao/resources/meta-gs/artifact/data.json：
    顶层是套装 id，里面 idxs 是 部位 → { id, name }。
    按 itemId 反查比拿 set_hash 去 names.json 里撞更稳 —— hash 表缺一个就整套装漏图。
    """
    idx = {}
    f = ROOT / "vendor" / "miao" / "resources" / "meta-gs" / "artifact" / "data.json"
    if not f.exists():
        return idx
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"[warn] 读 {f} 失败：{e}")
        return idx
        for set_row in data.values():
            if not isinstance(set_row, dict):
                continue
            set_name = set_row.get("name")
            if not set_name:
                continue
            for pos, piece in (set_row.get("idxs") or {}).items():
                if not isinstance(piece, dict):
                    continue
                if piece.get("id"):
                    idx[str(piece["id"])] = (set_name, pos)
                # 也按「部件中文名」建一份索引。
                # 为什么要多这一份：miao 的 idxs[].id 跟游戏实际给的 item_id 偶尔对不上
                # （实测「炉火融炼之心」pos1 记作 48543，而 enka 给的是 48544），
                # 光靠 id 会漏图，名字则是两边的公约数。
                if piece.get("name"):
                    idx[f"name:{piece['name']}"] = (set_name, pos)
    return idx


def build_opener():
    """按环境变量决定要不要走代理（国内直连 GitHub raw 不通）。"""
    proxy = os.environ.get("ASSETS_PROXY") or os.environ.get("I18N_PROXY") or \
            os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


OPENER = build_opener()


def fetch(url: str, dest: Path):
    """下载一个文件到 dest。返回 True/None(404)/False。"""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "seiten-suikyou-sync"})
        with OPENER.open(req, timeout=60) as resp:
            if resp.status != 200:
                return False
            data = resp.read()
            if len(data) == 0:
                return False
            dest.write_bytes(data)
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # 上游没有这张图，不是网络错
        log(f"[err] {url} HTTP {e.code}")
        return False
    except Exception as e:
        log(f"[err] {url} {e}")
        return False


def sync_file(rel: str, out: Path, base_url: str):
    """同步单个相对路径的资源。rel 是本地文件路径（保留中文目录名），URL 会按段编码。"""
    dest = out / rel
    if dest.exists() and dest.stat().st_size > 0:
        return "skip"
    # URL 路径：段与段之间用 /，每段单独 encodeURIComponent
    url_rel = "/".join(urllib.parse.quote(seg, safe="") for seg in Path(rel).parts)
    url = f"{base_url}/{url_rel}"
    ok = fetch(url, dest)
    if ok is True:
        return "ok"
    if ok is None:
        return "miss"
    return "fail"


def main():
    parser = argparse.ArgumentParser(description="同步 miao-plugin 图片素材")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite 数据库路径")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="素材输出目录")
    parser.add_argument(
        "--list",
        default=str(ROOT / ".tmp" / "asset-list.json"),
        help="素材清单（由 tools/list_assets.mjs 生成）。存在时优先按它下载",
    )
    parser.add_argument("--all", action="store_true", help="也下载通用占位图之外的所有内容（未实现，仅预留）")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    names = load_names(ROOT / "vendor" / "i18n" / "names.json")

    stats = {"ok": 0, "skip": 0, "miss": 0, "fail": 0}

    # 1. 通用 UI 小图
    log("[info] 同步通用 UI 素材 ...")
    for rel in COMMON_ASSETS:
        res = sync_file(rel, out, REPO_RAW)
        stats[res] += 1
        if res in ("fail", "miss"):
            log(f"  [{res}] {rel}")

    # 1b. 元素背景 + 天赋底盘：都按元素分图
    #     bg-{元素}.webp     整张画布的底色
    #     talent-{元素}.webp 天赋图标那个 100px 圆环底盘（miao common.css 的 .elem-x .talent-icon）
    log("[info] 同步元素背景/天赋底盘图 ...")
    for el in ELEM_BGS:
        for rel in (f"common/bg/bg-{el}.webp", f"common/bg/talent-{el}.webp"):
            res = sync_file(rel, out, REPO_RAW)
            stats[res] += 1
            if res in ("fail", "miss"):
                log(f"  [{res}] {rel}")

    # 2. 角色 / 武器 / 圣遗物素材
    #
    # 优先走清单：tools/list_assets.mjs 用页面同一套代码把「真正会请求的图」列出来，
    # 和前端永远一致。下面的启发式扫描只是清单缺失时的兜底 —— 它靠几张元数据表反查
    # 中文名，每张表都有覆盖不到的地方（新角色、id 对不上的新套装），会零星漏图。
    list_path = Path(args.list)
    if list_path.exists():
        rels = json.loads(list_path.read_text(encoding="utf-8"))
        log(f"[info] 按清单同步：{len(rels)} 个素材（{list_path.name}）")
        for rel in rels:
            res = sync_file(rel, out, REPO_RAW)
            stats[res] += 1
            if res == "fail":
                log(f"  [fail] {rel}")
        report(stats)
        return

    log("[warn] 没找到素材清单，退回启发式扫描（建议先跑 tools/list_assets.mjs）")

    # 1b. 天赋「普攻」图标：按武器类型的公共图
    log("[info] 同步天赋普攻图标（按武器类型）...")
    for wtype in WEAPON_TYPES:
        res = sync_file(f"common/item/atk-{wtype}.webp", out, REPO_RAW)
        stats[res] += 1
        if res in ("fail", "miss"):
            log(f"  [{res}] atk-{wtype}.webp")

    # 2. 本地库里出现过的角色 / 武器 / 套装
    db_path = Path(args.db)
    if db_path.exists():
        log("[info] 扫描本地库 ...")
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()

        cur.execute("SELECT DISTINCT avatar_id FROM avatar")
        avatar_ids = [r[0] for r in cur.fetchall()]
        log(f"[info] 发现 {len(avatar_ids)} 个角色")

        cur.execute("SELECT DISTINCT weapon_item_id FROM avatar WHERE weapon_item_id IS NOT NULL")
        weapon_ids = [r[0] for r in cur.fetchall()]
        log(f"[info] 发现 {len(weapon_ids)} 把武器")

        cur.execute("SELECT DISTINCT item_id, name_hash FROM artifact")
        arti_rows = [r for r in cur.fetchall()]
        log(f"[info] 发现 {len(arti_rows)} 件圣遗物")

        cur.execute("SELECT DISTINCT set_hash FROM artifact WHERE set_hash IS NOT NULL")
        set_hashes = [r[0] for r in cur.fetchall()]
        log(f"[info] 发现 {len(set_hashes)} 个套装 hash")

        # 圣遗物图标：meta-gs/artifact/imgs/{套装名}/{部位}.webp
        #
        # 两条路都走、取并集，因为两条路各自都会漏：
        #   set_hash → 官方文案表（names.json）：新套装可能还没收录
        #   item_id  → miao 元数据（artifact/data.json）：只登记了 299 个 id，也有覆盖不到的
        # 实测两条合起来才齐。done_sets 负责去重，重复的算 skip。
        done_sets = set()

        def sync_arti(set_name, pos):
            if (set_name, pos) in done_sets:
                stats["skip"] += 1
                return
            done_sets.add((set_name, pos))
            res = sync_file(f"meta-gs/artifact/imgs/{set_name}/{pos}.webp", out, REPO_RAW)
            stats[res] += 1
            if res == "fail":
                log(f"  [fail] {set_name}/{pos}.webp")

        arti_idx = load_miao_artifact_index()
        for row in arti_rows:
            iid, nhash = row[0], row[1]
            # 先按 item_id，查不到再按部件中文名（见 load_miao_artifact_index 里的说明）
            hit = arti_idx.get(str(iid)) if iid is not None else None
            if not hit and nhash:
                pname = chs_name_by_hash(names, nhash)
                if pname:
                    hit = arti_idx.get(f"name:{pname}")
            if hit:
                sync_arti(hit[0], hit[1])

        for sh in set_hashes:
            name = chs_name_by_hash(names, sh)
            if not name:
                stats["miss"] += 1
                log(f"  [miss] set_hash={sh} 找不到中文名")
                continue
            for pos in range(1, 6):
                sync_arti(name, str(pos))

        # 角色：官方立绘 + 6 个命座图标
        # 注意是 meta-gs/character/{名}/ 下，不是 character-img/{名}/01.jpg ——
        # 后者是同人插画，miao 面板用的是官方 splash（见 CharImg.getImgs）
        char_idx = load_miao_char_index()
        for aid in avatar_ids:
            name = char_idx.get(str(aid)) or avatar_name(names, aid)
            if not name:
                stats["miss"] += 1
                log(f"  [miss] avatar_id={aid} 找不到中文名")
                continue

            if name in ("空", "荧", "旅行者"):
                # 旅行者按元素分目录，逐个试（命中的那个会落盘，其余是 404 静默跳过）
                for elem in TRAVELER_ELEMS:
                    base = f"meta-gs/character/{name}/{elem}"
                    for rel in [f"{base}/imgs/splash.webp"] + \
                               [f"{base}/icons/cons-{i}.webp" for i in range(1, 7)]:
                        res = sync_file(rel, out, REPO_RAW)
                        stats[res] += 1
                continue

            for rel in [f"meta-gs/character/{name}/imgs/splash.webp"] + \
                       [f"meta-gs/character/{name}/icons/cons-{i}.webp" for i in range(1, 7)]:
                res = sync_file(rel, out, REPO_RAW)
                stats[res] += 1
                if res == "fail":
                    log(f"  [fail] {rel}")

        # 武器图标：meta-gs/weapon/{类型}/{名}/icon.webp
        widx = load_weapon_index()
        for wid in weapon_ids:
            hit = widx.get(str(wid))
            if not hit:
                stats["miss"] += 1
                log(f"  [miss] weapon_item_id={wid} 在 vendor 元数据里查不到")
                continue
            wtype, wname = hit
            res = sync_file(f"meta-gs/weapon/{wtype}/{wname}/icon.webp", out, REPO_RAW)
            stats[res] += 1
            if res == "fail":
                log(f"  [fail] {wtype}/{wname}/icon.webp")

        conn.close()
    else:
        log(f"[warn] 找不到数据库 {db_path}，只同步通用素材")

    report(stats)


def report(stats):
    log(
        f"[info] 完成：成功 {stats['ok']} / 跳过 {stats['skip']} / "
        f"缺失 {stats['miss']} / 失败 {stats['fail']}"
    )


if __name__ == "__main__":
    main()
