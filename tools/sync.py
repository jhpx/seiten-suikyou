#!/usr/bin/env python3
"""
同步上游的**唯一入口**：一条命令把三样东西全部更新到最新。

为什么要有这个
--------------
原先是三个脚本、三个 npm 命令：`sync_miao` / `sync_i18n` / `sync_assets`。
问题不在于三个脚本本身（它们各管一摊，拆分是对的），而在于**「更新上游」是一个动作**，
却要人记住三个入口、并且自己判断顺序。上游 miao-plugin 永远比我们新
（这是正常的，不是故障），所以这个动作会反复执行 —— 一次漏掉，页面上就会出现
「上游已有、我们还没有」的东西。

真实的踩坑：2026-10-06 发现沃雅妮莎的圣遗物权重是错的（显示 atk，实际是生命模组）。
根因是 vendor 里的权重表 `artis-mark.js` 比上游旧，**上游早已收录该角色，我们没同步**。
查的过程中才意识到：另外两个脚本大概也各落后了。
所以「同步」必须是**一个整体动作**，不能拆成三个可选步骤让人挑。

三步的依赖关系（顺序不是随便定的）
------------------------------------
1. miao    —— 搬内核代码 + 权重表 + 角色/武器数据到 vendor/，产出 sync-report.md
2. i18n    —— 提取名字表：角色/武器/套装/词条名来自 enka 的 `store/gi/`（自带上限清单，
              不依赖第 1 步搬下来的数据），只有**圣遗物部件名**还得从官方 TextMap 取
              （enka 不收录）。放第 2 步是历史顺序，实际与 miao 无依赖。
3. assets  —— 全量复制图片。素材目录由上游 miao-plugin 决定，与前两步无数据依赖，
              放最后纯粹因为它最慢（100MB / 1886 文件），失败时不影响前两步的产物。

用法
----
    python tools/sync.py                 # 三步全跑（推荐）
    python tools/sync.py miao            # 只跑第 1 步
    python tools/sync.py miao i18n       # 只跑指定的几步（按给定顺序执行）
    python tools/sync.py --skip assets   # 跳过某步
    python tools/sync.py --list          # 列出有哪些步、各自干什么
    python tools/sync.py --check         # 只体检不落盘：比对 vendor 与上游差异、查 thumbs/ 缩略图缺图

环境变量
--------
    MIAO_PLUGIN_PATH   指定 miao-plugin 源码目录，默认取同级目录下的 ../miao-plugin
    I18N_LOCALES       i18n 那步要哪几种语言，默认 chs,cht,en,ja,ko

退出码
------
    0   全部成功
    1   某一步失败（后续步不再执行 —— 前面失败还往下跑会产出半新半旧的东西）
    2   参数不对
"""

from __future__ import annotations

import argparse
import os
import importlib.util
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

# --------------------------------------------------------------------------
# 步骤表：key 是命令行里用的名字，script 是被编排的脚本，desc 写给 --list 看。
# ⚠️ 顺序即执行顺序，依赖见模块 docstring。
# --------------------------------------------------------------------------
STEPS: list[tuple[str, str, str]] = [
    ("miao", "sync_miao.py",
     "内核代码 + 权重表 artis-mark.js + 角色/武器元数据 → vendor/miao/，产出 sync-report.md"),
    ("i18n", "sync_i18n.py",
     "名字数据 → vendor/i18n/（enka 4 个原样 + 部件名提取件），产出 i18n-report.md"),
    ("assets", "sync_assets.py",
     "全量复制图片素材 → web/assets/（前端子仓库，约 100MB / 1886 文件）"),
]

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if not sys.stdout.isatty():
    GREEN = RED = YELLOW = DIM = RESET = ""


def load(script: str) -> Callable[[], int]:
    """按文件路径加载一个同步脚本，返回它的 main()。

    刻意用 importlib 而不是 subprocess 起进程：
      - 能直接传环境变量、复用同一个解释器，省掉每次几百毫秒的解释器冷启动；
      - 出错时 traceback 是连着的（subprocess 只会给你一段 stdout）。
    三个脚本的 main() 都在 `if __name__ == "__main__"` 保护下，import 不会触发执行。

    ⚠️ 子脚本的源目录常量（MIAO）是**模块级**的，在 import 那一刻求值。
      若调用方在 import 之后才设 MIAO_PLUGIN_PATH，子脚本会拿着旧路径跑
      （实测：MIAO_PLUGIN_PATH 指向空目录时仍报「成功」）。
      所以这里把校验提前 —— 路径不对就在 import 之前失败，别让错误的产物落盘。
    """
    path = TOOLS / script
    if not path.exists():
        raise FileNotFoundError(f"找不到脚本：{path}")

    # import 前先确认源目录存在：模块级常量一旦求值就固定了，事后改环境变量没用
    env = os.environ.get("MIAO_PLUGIN_PATH")
    miao = Path(env).resolve() if env else (ROOT.parent / "miao-plugin").resolve()
    if not miao.is_dir():
        raise FileNotFoundError(
            f"找不到 miao-plugin 源目录：{miao}\n"
            f"       可用环境变量 MIAO_PLUGIN_PATH 指定"
        )

    spec = importlib.util.spec_from_file_location(f"sync_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    main = getattr(mod, "main", None)
    if main is None:
        raise AttributeError(f"{path} 里没有 main()")

    # 被编排的脚本都收 main(argv)，而 sync_miao.parse_args 会把不认识的参数
    # 打成 `[warn] 忽略未知参数：xxx`。传 sys.argv[1:] 会把本脚本的步骤名
    # （如 `miao`）当成它的参数 → 每次同步都刷一条假警告。
    # 这里统一传空列表：编排器自己已经处理过全部命令行参数了。
    import inspect
    if "argv" in inspect.signature(main).parameters:
        return lambda: main([])

    # ⚠️ sync_i18n / sync_assets 的 main() 不收参数，是直接 argparse 读 sys.argv。
    #   不接管的话它们会把本脚本的步骤名当参数报错（实测 rc=2）。
    #   另一个坑：它们的路径常量（MIAO / ROOT）是**模块级**的，在 import 那一刻
    #   就被求值了 —— 那时 MIAO_PLUGIN_PATH 还没设进 os.environ 的话，
    #   子脚本会拿着错误的源目录跑。所以先设好环境变量再 import。
    def guarded(argv_guard: bool = True) -> int:
        if argv_guard:
            with _IsolatedArgv():
                return main() or 0
        return main() or 0

    return guarded


class _IsolatedArgv:
    """在上下文里把 sys.argv 换成空列表。

    ⚠️ 为什么要这个：sync_i18n.sync_assets 的 main() 不收 argv 参数，是直接
    `argparse.ArgumentParser()` 读 **sys.argv** 的。所以哪怕编排器一个参数都不传，
    加载它们时 argparse 仍会看到 `['sync.py', 'i18n']`，把「i18n」当成未知参数报错退出
    （实测 rc=2）。子步骤的参数已经由本脚本解析过了，子步骤不该再看得到它们。
    """

    def __enter__(self):
        self._saved = sys.argv
        sys.argv = [sys.argv[0] if sys.argv else "sync.py"]
        return self

    def __exit__(self, *exc):
        sys.argv = self._saved
        return False


def run_step(key: str, script: str, desc: str) -> tuple[str, bool, str]:
    """跑一步，返回 (key, 是否成功, 耗时秒)。

    异常不往外抛，改成返回失败 —— 抛出去的话调用方拿不到这一步的记录，
    汇总表里会把它显示成「未执行」，而它其实是**失败**（这两件事排查方向完全不同）。
    """
    print(f"\n{'=' * 64}\n{DIM}[{key}]{RESET} {desc}\n{'=' * 64}", flush=True)
    t0 = time.monotonic()
    rc = 1
    try:
        with _IsolatedArgv():
            rc = load(script)() or 0
    except SystemExit as e:
        # 子脚本用 sys.exit(非零) 表达失败，不是 return
        rc = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except Exception as e:
        print(f"{RED}[{key}] 异常：{type(e).__name__}: {e}{RESET}", file=sys.stderr)
        rc = 1
    dt = time.monotonic() - t0
    print(f"\n{DIM}── [{key}] {'成功' if rc == 0 else f'失败(rc={rc})'} · {dt:.1f}s{RESET}", flush=True)
    return key, rc == 0, f"{dt:.1f}s"


def do_check() -> int:
    """只体检不落盘：比对 vendor 与上游的差异规模，让人先知道「值不值得跑」。

    不导入任何同步脚本（它们在 import 期就会读文件、甚至有顶层 await），
    这里只做最朴素的目录比较。
    """
    env = os.environ.get("MIAO_PLUGIN_PATH")
    miao = Path(env).resolve() if env else (ROOT.parent / "miao-plugin").resolve()
    if not miao.is_dir():
        print(f"{RED}找不到 miao-plugin 源目录：{miao}{RESET}")
        print("       可用环境变量 MIAO_PLUGIN_PATH 指定")
        return 1

    print(f"上游：{miao}")
    checks = [
        ("vendor/miao", miao, "内核代码 / 权重表 / 元数据"),
        ("web/assets", miao / "resources", "图片素材"),
    ]
    total_diff = 0
    for rel, base, what in checks:
        cur = ROOT / rel
        if not cur.exists():
            print(f"  {rel:34} {what:26} {RED}本地不存在{RESET}")
            total_diff += 1
            continue
        newer = same = 0
        latest = None
        for p in cur.rglob("*"):
            if not p.is_file():
                continue
            # thumbs/ 整个目录都是本地预处理件（tools/gen_flower.py 产出，上游没有）。
            # 它在 web/assets/meta-gs/artifact/ 下面，不是 web/assets 的第一层，
            # 所以按「路径里有没有 thumbs 这一段」判，别写成 parts[0]。
            # 不跳过的话 59 张缩略图全会被算成「上游有更新」，把真差异淹了；
            # 它有没有缺由本函数末尾单独查。
            rel_parts = p.relative_to(cur).parts
            if "thumbs" in rel_parts[:-1]:
                continue
            src = base / p.relative_to(cur)
            if not src.exists():
                newer += 1
            elif src.stat().st_mtime > p.stat().st_mtime:
                newer += 1
                if latest is None or src.stat().st_mtime > latest[1]:
                    latest = (src.name, src.stat().st_mtime)
            else:
                same += 1
        total_diff += newer
        flag = f"{YELLOW}{newer} 个上游更新{RESET}" if newer else f"{GREEN}已是最新{RESET}"
        print(f"  {rel:34} {what:26} {same} 同 / {flag}")
        if latest:
            print(f"{DIM}    最新差异示例：{latest[0]}{RESET}")

    i18n = ROOT / "vendor/i18n"
    has_i18n = (i18n / "locs.json").exists() and (i18n / "textmap").is_dir()
    print(f"  {'vendor/i18n/':34} {'名字数据（enka 原样）':26} "
          f"{'存在' if has_i18n else RED + '不存在' + RESET}")

    # thumbs/ 里整套都是**本地预处理件**，上游目录比对根本看不见，得单独查漏。
    # 一套五个文件 1~5.webp：1 号（花）同时当套装代表图。
    # 目录名是 enka setId，不是 imgs/ 的中文套装名 —— 要一份中文名 → setId 的映射。
    # 上游新增套装、或补齐了某个部位的原图，不跑生成脚本，页面上那格就是破图。
    # ⚠️ 只查「有 1.webp」的那 59 套：祭冰/祭水/祭火/祭雷之人只有一顶冠（单件散件套），
    #    页面按 count >= 2 过滤，根本不显示，不需要代表图。
    imgs = ROOT / "web/assets/meta-gs/artifact/imgs"
    thumbs = ROOT / "web/assets/meta-gs/artifact/thumbs"
    if imgs.is_dir() and has_i18n:
        # 映射规则只在 gen_flower.py 的 set_ids() 里写一份，这里加载它来用，免得两处漂移。
        # 那个脚本模块级只有常量和函数定义，exec 一下没有副作用。
        spec = importlib.util.spec_from_file_location("gen_flower_ids", TOOLS / "gen_flower.py")
        if spec is None or spec.loader is None:
            raise ImportError("无法加载 tools/gen_flower.py 的 set_ids()")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ids: dict[str, str] = mod.set_ids()

        sets = sorted(p.parent for p in imgs.glob("*/1.webp"))
        wanted = [f"{n}.webp" for n in range(1, 6)]
        miss_files = 0
        miss_sets = []
        unmapped = []
        for d in sets:
            sid = ids.get(d.name)
            if sid is None:
                unmapped.append(d.name)       # 中文名对不上 id：先同步 i18n，不是缺图
                continue
            lack = [f for f in wanted
                    if (d / f).exists() and not (thumbs / sid / f).exists()]
            if lack:
                miss_sets.append(d.name)
                miss_files += len(lack)
        flag = (f"{YELLOW}缺 {miss_files} 张 / {len(miss_sets)} 套{RESET}" if miss_files
                else f"{GREEN}齐全{RESET}")
        print(f"  {'thumbs/*.webp':34} {'1~5 部位（本地预处理）':26} "
              f"{len(sets)} 套 × 5 / {flag}")
        if unmapped:
            print(f"{YELLOW}    {len(unmapped)} 套的中文名查不到 setId：{'、'.join(unmapped[:8])}{RESET}")
            print(f"{DIM}    先跑 python tools/sync.py i18n{RESET}")
        if miss_sets:
            preview = "、".join(miss_sets[:8]) + ("…" if len(miss_sets) > 8 else "")
            print(f"{DIM}    缺图：{preview}{RESET}")
            print(f"{DIM}    补图：python tools/gen_flower.py{RESET}")

    print()
    if total_diff:
        print(f"{YELLOW}检测到 {total_diff} 处待同步 —— 跑 python tools/sync.py 更新{RESET}")
    else:
        print(f"{GREEN}vendor 与上游一致{RESET}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="同步上游的唯一入口（内核+权重+数据 / 多语言 / 素材）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("steps", nargs="*", help=f"要跑的步骤，可选：{' '.join(k for k, _, _ in STEPS)}（默认全跑）")
    ap.add_argument("--skip", default="", help="跳过的步骤，逗号分隔")
    ap.add_argument("--list", action="store_true", help="列出步骤后退出")
    ap.add_argument("--check", action="store_true", help="只体检不落盘，比对与上游的差异规模")
    args = ap.parse_args()

    if args.list:
        print("同步步骤：")
        for i, (key, script, desc) in enumerate(STEPS, 1):
            print(f"  {i}. {key:8} {desc}")
            print(f"           （tools/{script}）")
        print(f"\n全跑：python tools/sync.py")
        return 0

    if args.check:
        return do_check()

    known = {k: (s, d) for k, s, d in STEPS}
    order = [k for k, _, _ in STEPS]

    picked = args.steps or order
    for k in picked:
        if k not in known:
            print(f"{RED}未知步骤：{k}{RESET}", file=sys.stderr)
            print(f"可用：{' '.join(order)}（--list 看说明）", file=sys.stderr)
            return 2

    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    for s in skip:
        if s not in known:
            print(f"{RED}--skip 里有个不存在的步骤：{s}{RESET}", file=sys.stderr)
            return 2

    todo = [k for k in picked if k not in skip]
    if not todo:
        print(f"{YELLOW}没选中任何步骤{RESET}")
        return 0

    print(f"{DIM}同步步骤：{' → '.join(todo)}"
          f"{'（跳过 ' + '、'.join(sorted(skip)) + '）' if skip else ''}{RESET}")

    t0 = time.monotonic()
    results: list[tuple[str, bool, str]] = []
    for key in todo:
        script, desc = known[key]
        key, good, cost = run_step(key, script, desc)
        results.append((key, good, cost))
        if not good:
            # 前面失败还往下跑 = 产出半新半旧的仓库，比直接停下更难查
            print(f"\n{RED}[{key}] 失败，后续步骤不再执行。{RESET}", file=sys.stderr)
            print(f"{DIM}已完成的步骤产物是好的，但仓库处于半同步状态 —— "
                  f"修好 {key} 后重跑本命令即可。{RESET}", file=sys.stderr)
            break

    dt = time.monotonic() - t0
    print(f"\n{'=' * 64}")
    ran = {r[0]: r[1] for r in results}
    # 「ok」= 选中的每一步都跑了，且都成功。中途失败 break 时 results 只含已跑的那些，
    # 必须同时比数量，否则「后续步骤没跑」会被当成成功（退出码 0，最难查的一类假绿）。
    ok = all(results) and len(results) == len(todo)
    for key in todo:
        if key in ran:
            good = ran[key]
            cost = next(r[2] for r in results if r[0] == key)
            mark = f"{GREEN}成功{RESET}" if good else f"{RED}失败{RESET}"
            print(f"  {key:8} {mark} {DIM}{cost}{RESET}")
        else:
            # 走到这里只有两种可能：上一步失败所以没轮到这里，或这步自己抛异常了
            print(f"  {key:8} {RED}未执行{RESET} {DIM}（上一步失败，中止）{RESET}")
    print(f"{DIM}总计 {dt:.1f}s{RESET}")
    if ok:
        print(f"\n{GREEN}同步完成。{RESET}")
        print(f"{DIM}接着跑：npm test（评分基线可能有变，verify 的 diff 必须为空）{RESET}")
    else:
        print(f"\n{RED}同步未完成 —— 仓库处于半同步状态，修好后重跑本命令即可。{RESET}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
