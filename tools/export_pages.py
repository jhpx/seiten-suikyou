#!/usr/bin/env python3
"""
把前端**单独**导成一个可以直接推给静态托管（GitHub Pages / 对象存储 / nginx）的目录。

为什么需要这一步：项目默认的部署形态是「一个 node 进程既给页面又给接口」，
页面和素材都在 src/server/public/ 下面，跟后端代码长在一起。
要前端单独托管，就得把这一份**静态的东西**原样摘出来 —— 页面全是原生 ES 模块、
零构建，所以「导出」就是复制文件，没有打包/编译这一步。

摘出来之后，页面要知道接口在哪儿（不同源了）：用 --api-base 写进 index.html 的
<meta name="api-base">，前端 core.js 的 API_BASE 会读它（留空 = 同源）。
后端那边要对应地加 --cors-origin=<前端地址>，否则浏览器拦掉跨域请求。

用法：
    python tools/export_pages.py --api-base https://gs.example.com
    python tools/export_pages.py --out dist/pages               # 不带后端地址，同源或稍后手改
    python tools/export_pages.py --no-assets                   # 跳过 101MB 素材，只导代码（调试用）
    python tools/export_pages.py --out dist/pages --force       # 目标已存在时先清空
"""
import argparse
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "src" / "server" / "public"
ASSETS = PUBLIC / "assets"
META_RE = r'(<meta\s+name="api-base"\s+content=")[^"]*(")'


def human (n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def copy_code (out: pathlib.Path) -> int:
    """复制页面代码（.html/.js/.css），跳过素材目录。"""
    n = 0
    for item in PUBLIC.iterdir():
        if item.is_dir():
            continue
        target = out / item.name
        if not target.exists() or target.read_bytes() != item.read_bytes():
            shutil.copy2(item, target)
        n += 1
    return n


def copy_assets (out: pathlib.Path) -> int:
    """素材全量复制（约 101MB / 1900+ 个文件）。已存在就增量覆盖。"""
    shutil.copytree(ASSETS, out / "assets", dirs_exist_ok=True)
    return sum(1 for _ in (out / "assets").rglob("*") if _.is_file())


def set_api_base (out: pathlib.Path, base: str) -> bool:
    """把 <meta name="api-base"> 的 content 改成后端地址。找不到那行就报 False。"""
    import re
    html = out / "index.html"
    text = html.read_text(encoding="utf-8")
    new, n = re.subn(META_RE, lambda m: m.group(1) + base + m.group(2), text, count=1)
    if n != 1:
        return False
    html.write_text(new, encoding="utf-8")
    return True


def main () -> int:
    ap = argparse.ArgumentParser(description="导出可静态托管的前端目录")
    ap.add_argument("--out", default="dist/pages", help="输出目录（默认 dist/pages）")
    ap.add_argument("--api-base", default="", help="后端地址，如 https://gs.example.com（留空 = 同源）")
    ap.add_argument("--no-assets", action="store_true", help="不复制图片素材（只导代码）")
    ap.add_argument("--force", action="store_true", help="输出目录已存在时先清空")
    args = ap.parse_args()

    out = (ROOT / args.out) if not pathlib.Path(args.out).is_absolute() else pathlib.Path(args.out)
    if out.exists() and any(out.iterdir()):
        if not args.force:
            print(f"[ERR] 目标目录非空：{out}\n      确认要覆盖就加 --force")
            return 1
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    code = copy_code(out)
    assets = 0 if args.no_assets else copy_assets(out)
    if args.api_base:
        if not set_api_base(out, args.api_base):
            print("[ERR] index.html 里没找到 <meta name=\"api-base\">，后端地址没写进去")
            return 1

    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"已导出 → {out}")
    print(f"  页面代码 {code} 个文件 · 图片素材 {assets} 个文件 · 合计 {human(total)}")
    print(f"  接口地址 {args.api_base or '(留空 = 同源)'}")
    print("后端对应地要加：npm run server -- --cors-origin=<前端地址>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
