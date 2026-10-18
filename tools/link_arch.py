"""
给两份架构图互相加一个跳转入口（顶栏最左边一个按钮）。

为什么要有这个脚本：archify deliver 每次都整份重写 HTML，插进去的按钮会被冲掉。
所以顺序固定 —— 先 deliver，再跑这里：
    python tools/link_arch.py

可重复执行：先删掉自己上次插的样式和按钮，再插一遍。真正的图（SVG、卡片）一个字都不动。
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# 源文件 -> (跳去哪, 按钮文字)
LINKS = {
    "seiten-suikyou-architecture.html": ("seiten-suikyou-web-architecture.html", "前端架构图"),
    "seiten-suikyou-web-architecture.html": ("seiten-suikyou-architecture.html", "全局架构图"),
}

# 抄 .toolbar button 的样式，只是把标签从 button 换成 a，并关掉下划线
STYLE = """
    <style data-arch-jump-style>
      .toolbar a.arch-jump {
        background: var(--toolbar-bg);
        color: var(--toolbar-text);
        border: 1px solid var(--toolbar-border);
        padding: 0.5rem 0.875rem;
        border-radius: 0.625rem;
        font-family: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        text-decoration: none;
        white-space: nowrap;
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
        transition: background 0.15s, border-color 0.15s, color 0.15s;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        min-height: 2.75rem;
        box-sizing: border-box;
      }
      .toolbar a.arch-jump:hover {
        background: var(--toolbar-hover);
        border-color: color-mix(in srgb, var(--arrow) 62%, var(--toolbar-border));
      }
    </style>
"""

TOOLBAR_OPEN = re.compile(r'<div class="toolbar" role="toolbar" aria-label="图表操作">')


def patch(name, target, label):
    path = DOCS / name
    if not path.exists():
        print(f"[SKIP] 没有 {name}（先跑 archify deliver）")
        return False

    text = path.read_text(encoding="utf-8")

    # 先清掉上次插的东西，保证幂等
    text = re.sub(r'\n?\s*<style data-arch-jump-style>[\s\S]*?</style>', '', text)
    text = re.sub(r'\n?\s*<a class="arch-jump"[\s\S]*?</a>', '', text)

    anchor = (
        '<a class="arch-jump" data-arch-jump="1" href="{t}" '
        'title="切到{l}">⇄ {l}</a>'
    ).format(t=target, l=label)

    if not TOOLBAR_OPEN.search(text):
        print(f"[FAIL] {name} 里找不到 toolbar，未改动")
        return False

    # 按钮放顶栏最左边（右上是主题/风格/导出，别插在那儿）
    text = TOOLBAR_OPEN.sub(lambda m: m.group(0) + "\n    " + anchor, text, count=1)

    # 样式放 </head> 前
    text = text.replace("</head>", STYLE + "</head>", 1)

    path.write_text(text, encoding="utf-8")
    print(f"[OK] {name} -> {target}")
    return True


def main():
    done = 0
    for name, (target, label) in LINKS.items():
        if patch(name, target, label):
            done += 1
    print(f"\n处理 {done} / {len(LINKS)} 份")


if __name__ == "__main__":
    main()
