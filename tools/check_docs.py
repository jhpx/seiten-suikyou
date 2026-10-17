#!/usr/bin/env python3
"""
校验文档里的相对链接是否都指向真实存在的文件。

为什么单独做这个：文档搬过两次家（`docs/` 重构、两个设计文档改大写、参考图与样例挪进 `docs/`），
每次都有几处链接没跟着改。死链不会让任何测试变红，只有人点到才发现。

为什么不用 Node 写：这是个纯「读文件 + 比路径」的活，和 `tools/sync_*.py` 一路，
放一起省得又多一个运行时入口。

用法：python tools/check_docs.py     # 有问题时退出码 1
"""
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# 只查这几份「给人看」的文档；生成物（VENDOR.md / reports）不查
DOCS = ("README.md", "docs/DESIGN.md", "docs/DESIGN-DATA-MODEL.md",
        "docs/API.md", "docs/DEPLOY.md")
SKIP_DIRS = (".git", "node_modules", ".tmp", "__pycache__")

# 仓库里实际存在的文件（相对 ROOT、用 / 分隔）
real = set()
for dirpath, _dirs, files in os.walk(ROOT):
    if any(p in dirpath for p in SKIP_DIRS):
        continue
    for f in files:
        rel = pathlib.Path(dirpath, f).relative_to(ROOT).as_posix()
        real.add(rel)

bad = 0
checked = 0
for md in DOCS:
    path = ROOT / md
    if not path.exists():
        print(f"[MISS] 文档本身不在：{md}")
        bad += 1
        continue
    base = path.parent
    text = path.read_text(encoding="utf-8")
    for link in sorted(set(re.findall(r"\]\(([^)#]+?)\)", text))):
        if link.startswith(("http://", "https://", "mailto:")):
            continue
        target = pathlib.Path(os.path.normpath(base / link))
        rel = os.path.relpath(target, ROOT).replace(os.sep, "/")
        checked += 1
        # 命中：是仓库里的某个文件，或是个目录（目录链接指向其下任何文件也算）
        ok = rel in real or target.is_dir() or any(r.startswith(rel + "/") for r in real)
        print(f"{'OK  ' if ok else 'BAD '} {md} -> {link}")
        bad += 0 if ok else 1

print(f"\n检查 {checked} 条链接，死链 {bad} 条")
sys.exit(1 if bad else 0)
