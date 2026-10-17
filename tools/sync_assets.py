#!/usr/bin/env python3
"""
把 miao-plugin 的图片素材**全量**复制进 web/assets/（前端子仓库 seiten-suikyou-web 的检出）。

落盘点在子仓库里：同步完素材的变动要在 web/ 里提交，母仓库再跟着更新子模块指针。

为什么是「本地全量复制」而不是「按需从远端下载」：

1. miao 的素材本来就是仓库自带的 —— resources/ 直接躺在 miao-plugin 目录里，
   远端 GitHub 上是同一个目录。绕一圈网络去拿本地已有的东西没有意义，
   还白白继承「国内连不上 + 连不上当 404 静默跳过」两个坑。
   （miao 唯一额外拉的是「图片加量包」miao-res-plus，见 apps/admin.js:131 的 git clone，
    那装的是 character-img/ 同人插画，评分面板根本不用，我们不跟。）
2. 「按需」的前提是能猜对名字：先拿 id 反查中文名，再按名拼 URL。
   名字表谁都覆盖不全（新角色没进表、圣遗物 id 跟游戏对不上），
   结果就是零星角色/套装整片没图 —— 珐露珊、瓦雷莎、达达利亚就是这么空的。
3. 全量之后不再需要任何名字表：**源目录里有什么就拷什么**。
   缺哪张由源端决定，跟页面按存在性拼路径的逻辑（miao CharImg.getImgs）天然一致。

用法：
    python tools/sync_assets.py
    MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_assets.py
    python tools/sync_assets.py --out web/assets

全程离线，一张图都不从网络下。唯一的例外是 7 张元素符号（common/elem/{元素}.png）：
miao 整个仓库没有这图，所以把它们（7 张共 45KB）直接放在仓库里当种子
tools/assets-seed/，同步时从种子复制 —— 换机器、断网都能重建出完整素材。
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "web" / "assets"
DEFAULT_LIST = ROOT / ".tmp" / "asset-list.json"
# 仓库自带的种子素材：miao 那边找不到、又必须有的图放这里，进 git
SEED = ROOT / "tools" / "assets-seed"

# miao-plugin 在哪：环境变量优先，其次 sibling 目录（跟 tools/sync_miao.py 一个约定）
_env = os.environ.get("MIAO_PLUGIN_PATH")
MIAO = Path(_env).resolve() if _env else (ROOT.parent / "miao-plugin").resolve()

"""
通用 UI 小图，页面按固定路径直接引用（不是按角色/套装名拼出来的）。
清单以外的 resources/common/ 大多是 css/less 字体，页面不需要。
"""
COMMON_ASSETS = [
    "common/cont/card-bg.png",
    # 属性表那一行的小图标 2026-10-07 起改用仓库自带的 assets/character/svgs/*.svg（CSS mask 上色），
    # miao 侧的 character/imgs/icon.png / icon-new.png 已不再需要，别再列进来（会把这张死资源拷回去）。
    "character/imgs/star.png",
    "character/imgs/up-num-icon0.png",
    "character/imgs/up-num-icon1.png",
    "character/imgs/up-num-icon2.png",
    "character/imgs/crown.png",
    "character/imgs/main-01.png",
    "character/imgs/main-02.png",
    # 武器卡的星级图（miao common.css 里 .artis .weapon .star 用的）
    "common/item/star.png",
    # 首页角色卡的星级底色：五星 bg5、四星 bg4，就是游戏里那张橙/紫底
    "common/item/bg5.png",
    "common/item/bg4.png",
]

# 角色页整张画布的背景按元素分图：common/bg/bg-{元素}.webp
# 天赋图标那个圆环底盘是 talent-{元素}.webp（miao common.css 的 .elem-x .talent-icon）
ELEM_BGS = ["pyro", "hydro", "anemo", "electro", "dendro", "cryo", "geo"]

# 天赋「普攻」图标按武器类型取，是公共图（miao CharImg.getImgs 的规则）
WEAPON_TYPES = ["sword", "claymore", "bow", "catalyst", "polearm"]

# 旅行者的立绘/命座在 meta-gs/character/旅行者/{元素}/ 下，不在自己名字的目录里
TRAVELER_ELEMS = ["anemo", "geo", "electro", "dendro", "hydro", "pyro", "cryo"]

"""
角色要拷哪些图 —— 与 src/view/shape.js 的 charImgs() 一一对应。

talent-e / talent-q 是**可选**的：miao 的规则是「哪个命座提升这个天赋就用哪个命座图标，
否则才用 talent-{e,q}.webp」，所以绝大多数角色目录里根本没有这俩文件（121/126 都没有）。
源端没有就跳过，不算错误。
"""
CHAR_IMGS = ["splash.webp", "face.webp", "card.webp", "banner.webp"]
CHAR_ICONS = [f"cons-{i}.webp" for i in range(1, 7)] + ["talent-e.webp", "talent-q.webp"]

# 元素符号：miao 仓库里没有（星穹铁道那套 meta-sr/icons/elem-*.webp 不是原神的），
# 所以从仓库自带的种子目录取，见 sync_elem_icons()


def log(*args):
    print(*args, file=sys.stderr)


def resolve_miao_root() -> Path:
    """定位 miao-plugin 的 resources 目录，找不到就把候选列出来让人一眼能改。"""
    res = MIAO / "resources"
    if res.is_dir():
        return res
    log(f"[err] 找不到素材源：{res}")
    log(f"[hint] 设 MIAO_PLUGIN_PATH=/path/to/miao-plugin，或把 miao-plugin 放到 {MIAO.parent}")
    cands = sorted(p.name for p in MIAO.parent.glob("miao-plugin*") if p.is_dir())
    if cands:
        log(f"[hint] {MIAO.parent} 下有这些候选：{', '.join(cands)}")
    sys.exit(1)


def copy_one(src_file: Path, out: Path, rel: str, stats):
    """复制单个素材。rel 是相对 assets 根目录的路径。"""
    dest = out / rel
    if not src_file.exists():
        stats["src_miss"] += 1  # 源端本来就没有（多半是上面说的可选图），正常
        return
    if dest.exists() and dest.stat().st_size == src_file.stat().st_size:
        stats["skip"] += 1
        return
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_file, dest)
        stats["ok"] += 1
    except OSError as e:
        stats["fail"] += 1
        log(f"  [fail] {rel} {e}")


def char_dirs(res: Path):
    """
    枚举角色素材目录。

    为什么要单独处理旅行者：它的 imgs/icons 在 旅行者/{元素}/ 下面，
    而 character/ 下还有个 common/ 是公用图（不是角色），都得避开。
    """
    base = res / "meta-gs" / "character"
    if not base.is_dir():
        return
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name == "common":
            continue
        if d.name == "旅行者":
            # 立绘/头像在 旅行者/imgs/ 下（元素无关），
            # 卡片/横幅/命座在 旅行者/{元素}/ 下 —— miao 的 CharImg 就是这么分的，
            # 两份都要，缺一份旅行者就半残。
            yield d
            for elem in TRAVELER_ELEMS:
                if (d / elem).is_dir():
                    yield d / elem
            continue
        yield d


def sync_common(res: Path, out: Path, stats):
    """通用 UI 图 + 元素背景/底盘 + 天赋普攻图标。"""
    for rel in COMMON_ASSETS + [f"common/item/atk-{t}.webp" for t in WEAPON_TYPES]:
        copy_one(res / rel, out, rel, stats)
    for el in ELEM_BGS:
        for rel in (f"common/bg/bg-{el}.webp", f"common/bg/talent-{el}.webp"):
            copy_one(res / rel, out, rel, stats)


def sync_chars(res: Path, out: Path, stats):
    """全角色：立绘 / 头像 / 卡片 / 横幅 + 6 个命座图标（+ 可选的 talent-e/q）。"""
    n = 0
    for d in char_dirs(res):
        rel_dir = d.relative_to(res).as_posix()  # meta-gs/character/瓦雷莎 或 .../旅行者/anemo
        for f in CHAR_IMGS:
            copy_one(d / "imgs" / f, out, f"{rel_dir}/imgs/{f}", stats)
        for f in CHAR_ICONS:
            copy_one(d / "icons" / f, out, f"{rel_dir}/icons/{f}", stats)
        n += 1
    log(f"[info] 角色目录 {n} 个")


def sync_weapons(res: Path, out: Path, stats):
    """武器图标：meta-gs/weapon/{类型}/{名}/icon.webp，全量。"""
    base = res / "meta-gs" / "weapon"
    n = 0
    for tdir in sorted(base.iterdir()) if base.is_dir() else []:
        if not tdir.is_dir():
            continue
        for wdir in sorted(tdir.iterdir()):
            if not wdir.is_dir():
                continue
            rel = f"meta-gs/weapon/{tdir.name}/{wdir.name}/icon.webp"
            copy_one(wdir / "icon.webp", out, rel, stats)
            n += 1
    log(f"[info] 武器 {n} 把")


def sync_artifacts(res: Path, out: Path, stats):
    """圣遗物：meta-gs/artifact/imgs/{套装}/{1..5}.webp，全量。"""
    base = res / "meta-gs" / "artifact" / "imgs"
    n = 0
    for sdir in sorted(base.iterdir()) if base.is_dir() else []:
        if not sdir.is_dir():
            continue
        for pos in range(1, 6):
            copy_one(sdir / f"{pos}.webp", out, f"meta-gs/artifact/imgs/{sdir.name}/{pos}.webp", stats)
        n += 1
    log(f"[info] 套装 {n} 个")


def sync_elem_icons(out: Path, stats):
    """
    7 张元素符号，从仓库自带的种子目录 tools/assets-seed/ 复制。

    为什么种子要进 git：miao 仓库没有这图，以前只能去 paimon-moe 下，
    于是「同步素材」这件本该纯本地的事就挂上了网络 —— 国内连不上就静默缺图。
    这 7 张一共才 45KB，直接随仓库走，谁都能离线重建。
    """
    missing = []
    for el in ELEM_BGS:
        rel = f"common/elem/{el}.png"
        src = SEED / rel
        if not src.exists():
            missing.append(rel)
            continue
        copy_one(src, out, rel, stats)
    if missing:
        log(f"[warn] 种子里缺 {len(missing)} 张元素图标：{', '.join(missing)}")
        log(f"[hint] 补到 {SEED}/common/elem/ 下即可（来源 paimon-moe 的 static/images/elements）")


def check_against_list(out: Path, stats):
    """
    拿「页面真正会请求的图」的清单反查一遍落盘。

    这一层防的是另一类错：shape.js 拼了个源端没有的路径（比如改了 imgs 名、
    或某个角色 miao 侧真的没素材）。全量复制解决不了这种错，只能对账。
    清单由 tools/list_assets.mjs 生成，不在就跳过这一步。
    """
    list_path = DEFAULT_LIST
    if not list_path.exists():
        return []
    rels = json.loads(list_path.read_text(encoding="utf-8"))
    missing = [r for r in rels if not (out / r).exists()]
    if missing:
        log(f"[warn] 页面要的图里有 {len(missing)} 个没落到盘上，页面会出现空框：")
        for r in missing:
            log(f"  [缺] {r}")
        log("[hint] 先跑 node tools/list_assets.mjs 刷新清单再对一次")
    return missing


def main():
    parser = argparse.ArgumentParser(description="从 miao-plugin 全量复制图片素材")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="素材输出目录")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    res = resolve_miao_root()
    log(f"[info] 素材源：{res}")

    stats = {"ok": 0, "skip": 0, "fail": 0, "src_miss": 0}

    log("[info] 同步通用 UI 素材 ...")
    sync_common(res, out, stats)

    log("[info] 同步元素图标（仓库种子）...")
    sync_elem_icons(out, stats)

    log("[info] 同步角色素材（全量）...")
    sync_chars(res, out, stats)

    log("[info] 同步武器图标（全量）...")
    sync_weapons(res, out, stats)

    log("[info] 同步圣遗物图标（全量）...")
    sync_artifacts(res, out, stats)

    missing = check_against_list(out, stats)

    log(
        f"[info] 完成：新复制 {stats['ok']} / 已存在 {stats['skip']} / "
        f"复制失败 {stats['fail']} / 源端本就没有（可选图）{stats['src_miss']}"
    )
    sys.exit(1 if (missing or stats["fail"]) else 0)


if __name__ == "__main__":
    main()
