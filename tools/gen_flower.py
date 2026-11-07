#!/usr/bin/env python3
"""给每套圣遗物生成 1~5.webp 五张缩略图（裁掉透明边 + 缩到 96px）。

产物落在 web/assets/meta-gs/artifact/thumbs/<setId>/ 下，
和上游原图 imgs/ **分开**：imgs/ 是 tools/sync_assets.py 从 miao 全量复制的原样素材，
一个字节不改；thumbs/ 是本地加工件，上游根本没有。混在一起就分不清哪些是同步来的。

目录名为什么是 setId
--------------------
imgs/ 的目录名是上游给的**中文套装名**，但 thumbs/ 是我们自己的产物，用 enka 的
setId（游戏内稳定数字身份）当目录名更稳：中文名来自文案表，官方改一次译名、
或某些套装查不到名字，按中文拼的路径就 404 没图。setId 也是前端筛选／排序、
前端 core.js 认套装身份时用的同一个 id。映射从 vendor/i18n/ 的
locs.json（zh-cn）+ relics.json（Sets[sid].Name 是文案 hash）现算，不另维护一份表。
⚠️ 所以 imgs/ 中文、thumbs/ 数字，两层命名不同是有意的，别又统一回去。

为什么要有这些图
----------------
卡片（19px）、筛选框（18px）、刷取建议的套装图标（40px 里显示 31px）都用 1.webp
—— 花就是 1 号位，直接拿它当整套的代表图。
刷取建议里那排部位小图（18px，窄档 14px）用 1~5.webp。
上游的部位图有 150~380px 且四周透明留白不统一：老素材主体占 92~95%，
新素材只有 73~87%。直接给原图既白下十倍像素，又让一排图标看着参差。
这里把「裁边 + 缩小」提前做好，前端只管摆放，不用再拿 canvas 现算放大系数。
前端 advice.js 把 1.webp 的末段换成部位号推 2~5，pos=1 时换出来还是自己。

⚠️ 明细页的 artifacts[].icon 仍走 imgs/ 下的原图：那里显示 100px（高分屏 300px），
   96px 的小图会糊。本脚本只管首页 / 筛选框 / 刷取建议这类小尺寸场景。

为什么用无头浏览器
------------------
项目零构建、不装 Pillow / sharp / ffmpeg；而 Chrome 的 canvas 本来就会编 webp。
借 tools/shot.ts 那位现成的 chrome-headless-shell（准备方法见 shot.ts 头部），
起一个临时静态服务把原图喂给页面，页面算完把 base64 吐回 DOM，脚本落盘。
全程只用标准库 + 仓库里已有的 chrome，不新增依赖，也不改上游素材。

用法
----
    python tools/gen_flower.py            # 只补缺图（1~5.webp 都查）
    python tools/gen_flower.py --force    # 全部重生成（换尺寸 / 换画质时用）
    python tools/gen_flower.py --edge 128 # 改边长（默认 96）

上游新增了套装？先 python tools/sync.py assets 把 1~5.webp 拷过来，再跑本脚本补图；
`python tools/sync.py --check` 会报出 imgs/ 里有原图、thumbs/ 里却缺缩略图的套装。
"""
from __future__ import annotations

import argparse
import base64
import http.server
import json
import re
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
IMGS = ROOT / "web" / "assets" / "meta-gs" / "artifact" / "imgs"
THUMBS = ROOT / "web" / "assets" / "meta-gs" / "artifact" / "thumbs"
CHROME = ROOT / ".tmp" / "chs" / "chrome-headless-shell-win64" / "chrome-headless-shell.exe"

# 页面里的 JS 用的是 {{EDGE}} / {{ITEMS}} 两个占位符，别用 f-string —— JS 里全是花括号
PAGE = r'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>pending</title></head>
<body><pre id="out">pending</pre><script>
const ITEMS = {{ITEMS}}, EDGE = {{EDGE}}, Q = 0.82;
const out = {};
let done = 0;
function finish () { document.getElementById('out').textContent = JSON.stringify(out); document.title = 'done'; }
/* key 是「setId/输出文件名」，一套来 5 条（1~5） */
ITEMS.forEach(([key, u]) => {
  const im = new Image();
  im.onload = () => {
    try {
      const W = im.naturalWidth, H = im.naturalHeight;
      /* 先等比缩到 64 宽扫一遍 alpha，16 是「肉眼看不见」那档透明度 */
      const w = 64, h = Math.max(8, Math.round(64 * H / W));
      const c0 = document.createElement('canvas'); c0.width = w; c0.height = h;
      const g0 = c0.getContext('2d', { willReadFrequently: true });
      g0.drawImage(im, 0, 0, w, h);
      const d = g0.getImageData(0, 0, w, h).data;
      let l = w, r = -1, t = h, b = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 16) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
      }
      if (r < 0) throw new Error('整张全透明');
      /* 缩略图坐标映射回原图，裁出内容框再等比缩到最长边 EDGE */
      const sx = l / w * W, sy = t / h * H;
      const sw = (r - l + 1) / w * W, sh = (b - t + 1) / h * H;
      const k = EDGE / Math.max(sw, sh);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
      c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, c.width, c.height);
      out[key] = c.toDataURL('image/webp', Q);
    } catch (e) { out[key] = 'ERR ' + e }
    if (++done === ITEMS.length) finish();
  };
  im.onerror = () => { out[key] = 'ERR load'; if (++done === ITEMS.length) finish(); };
  im.src = u;
});
setTimeout(() => { if (document.title !== 'done') finish(); }, 45000);
</script></body></html>'''


def set_ids() -> dict[str, str]:
    """上游 imgs/ 的中文套装名 → enka setId（thumbs/ 用 id 当目录名）。

    locs.json 的 zh-cn 是「文案 hash → 中文」，relics.json 的 Sets[sid].Name 是那个 hash，
    两边一对就得到中文名 → setId。和 src/common/names.ts 的 zhSetIds() 同口径
    （先到先得；实测 63 个上游目录全对得上、无重名）。
    ⚠️ 这里只认 zh-cn：imgs/ 的目录名本来就是上游给的简体中文套装名。
    ⚠️ 为什么不直接 import TS：本脚本是纯搬文件的 Python 工具，不引 src/。
    """
    i18n = ROOT / "vendor" / "i18n"
    zh = json.loads((i18n / "locs.json").read_text(encoding="utf-8"))["zh-cn"]
    sets = json.loads((i18n / "relics.json").read_text(encoding="utf-8"))["Sets"]
    m: dict[str, str] = {}
    for sid, row in sets.items():
        text = zh.get(str(row.get("Name")))
        if text and text not in m:
            m[text] = str(sid)
    return m


def serve_once(html: str) -> tuple[int, threading.Thread, http.server.ThreadingHTTPServer]:
    """起一个只在本次生成期间活着的静态服务，根目录 = 仓库根。

    不能直接用 file:// —— 跨源会把 canvas 弄脏，toDataURL 直接抛错。
    """
    root = str(ROOT)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/__gen_flower.html"):
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv.server_address[1], t, srv


def main() -> int:
    ap = argparse.ArgumentParser(description="生成圣遗物缩略图 thumbs/<setId>/1~5.webp（裁边 + 缩到 96px）")
    ap.add_argument("--force", action="store_true", help="已有的也重新生成")
    ap.add_argument("--edge", type=int, default=96, help="最长边像素（默认 96）")
    args = ap.parse_args()

    if not CHROME.exists():
        print(f"没找到 chrome-headless-shell：{CHROME}\n准备方法见 tools/shot.ts 头部", file=sys.stderr)
        return 1
    if not IMGS.is_dir():
        print(f"找不到素材目录：{IMGS}", file=sys.stderr)
        return 1

    # 一套五个文件 1~5.webp；1 号（花）同时当套装代表图。
    # 源图在 imgs/<中文套装名>/ 下（上游原名，只读），产物写到 thumbs/<setId>/ 下。
    ids = set_ids()
    todo = []
    for set_dir in sorted(p.parent for p in IMGS.glob("*/1.webp")):
        name = set_dir.name
        sid = ids.get(name)
        if sid is None:
            print(f"找不到 setId：{name}（imgs/ 有这个套装，vendor/i18n 却对不上名字）", file=sys.stderr)
            return 1
        for pos in range(1, 6):
            out_name = f"{pos}.webp"
            src = set_dir / out_name
            if not src.exists():
                continue                      # 上游这套本来就缺这个部位，别凭空造
            if args.force or not (THUMBS / sid / out_name).exists():
                url = "/web/assets/meta-gs/artifact/imgs/" + quote(name) + f"/{pos}.webp"
                todo.append((sid + "/" + out_name, url))
    if not todo:
        print("thumbs/<setId>/ 里的 1~5.webp 全都有，没活干（要重生成加 --force）")
        return 0

    html = PAGE.replace("{{ITEMS}}", json.dumps(todo, ensure_ascii=False)).replace("{{EDGE}}", str(args.edge))
    port, thread, srv = serve_once(html)
    try:
        out = subprocess.run(
            [str(CHROME), "--headless", "--disable-gpu", "--no-sandbox", "--no-proxy-server",
             "--virtual-time-budget=60000", "--dump-dom",
             f"http://127.0.0.1:{port}/__gen_flower.html"],
            capture_output=True, text=True, timeout=180,
        ).stdout
    finally:
        srv.shutdown()
        thread.join(timeout=2)
        srv.server_close()

    m = re.search(r'<pre id="out">(.*?)</pre>', out, re.S)
    if not m:
        print("浏览器没吐回结果（可能素材还没加载完就超时了）", file=sys.stderr)
        return 1
    data = json.loads(m.group(1))
    ok = bad = 0
    total = 0
    for key, v in data.items():
        if not v.startswith("data:image/webp"):
            print(f"  跳过 {key}：{v[:60]}", file=sys.stderr)
            bad += 1
            continue
        raw = base64.b64decode(v.split(",", 1)[1])
        sid, out_name = key.split("/", 1)
        out_dir = THUMBS / sid
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / out_name).write_bytes(raw)
        total += len(raw)
        ok += 1
    print(f"生成 {ok} 张，共 {total / 1024:.1f} KB（平均 {total / max(ok, 1) / 1024:.2f} KB）"
          + (f"，失败 {bad} 张" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
