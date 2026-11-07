#!/usr/bin/env python3
"""生成首页用的两类缩略图：圣遗物部位小图 + 武器小图（都缩到 96px 的 webp）。

产物是**本地加工件**，落在 web/assets/meta-gs/ 下各自的 thumbs/ 目录里，
和上游原图分开：原图是 tools/sync_assets.py 从 miao 全量复制的，一个字节不改；
混在一起就分不清哪些是同步来的。

圣遗物：artifact/thumbs/<setId>/1~5.webp
----------------------------------------
上游 imgs/ 按中文套装名摆，我们的产物用 enka 的 setId 当目录名：中文名来自文案表，
官方改译名或某些套装查不到名字，按中文拼的路径就 404。setId 也是前端筛选／排序
认套装身份用的同一个 id。映射从 vendor/i18n/ 的 locs.json + relics.json 现算。
花就是 1 号位，直接拿 1.webp 当整套代表图，1~5.webp 供建议面板画五个部位。
上游部位图 150~380px 且透明留白不统一（老素材主体 92~95%，新素材 73~87%），
所以这里**裁掉透明边再缩**，让一排图标主体大小一致。

武器：weapon/thumbs/<itemId>.webp
---------------------------------
上游是 weapon/<类型>/<中文名>/icon.webp，首页卡片只有 28×38px。小图按 miao 五个
data.json 里的武器 id 命名，**不按类型分目录** —— id 全局唯一，路径也不绑中文译名。
实测 257 张原图主体最长边占画布中位 98%（最小 77%），所以**只缩不裁**：
裁边等于白放大构图、体积反而多 3%。映射直接读 vendor/miao/resources/meta-gs/weapon/
的 5 份 data.json，和后端 MiaoWeapon.get(itemId) 用的是同一套 id。

⚠️ 明细页仍走上游原图（圣遗物 imgs/、武器 icon.webp）：那里显示 100px，
   96px 的小图会糊；而且明细页点进去才加载，不占首屏。

为什么用无头浏览器
------------------
项目零构建、不装 Pillow / sharp / ffmpeg；而 Chrome 的 canvas 本来就会编 webp。
借 tools/shot.ts 那位现成的 chrome-headless-shell（准备方法见 shot.ts 头部），
起一个临时静态服务把原图喂给页面，页面算完把 base64 吐回 DOM，脚本落盘。
全程只用标准库 + 仓库里已有的 chrome，不新增依赖，也不改上游素材。

用法
----
    python tools/gen_flower.py            # 只补缺图（两类都查）
    python tools/gen_flower.py --force    # 全部重生成（换尺寸 / 换画质时用）
    python tools/gen_flower.py --edge 128 # 改边长（默认 96）

上游新增素材？先 python tools/sync.py assets 把原图拷过来，再跑本脚本补图；
`python tools/sync.py --check` 会报出缺哪些缩略图。
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
WEAPON_META = ROOT / "vendor" / "miao" / "resources" / "meta-gs" / "weapon"
WEAPON_IMGS = ROOT / "web" / "assets" / "meta-gs" / "weapon"
WEAPON_THUMBS = WEAPON_IMGS / "thumbs"
CHROME = ROOT / ".tmp" / "chs" / "chrome-headless-shell-win64" / "chrome-headless-shell.exe"

# 页面里的 JS 用的是 {{EDGE}} / {{ITEMS}} 两个占位符，别用 f-string —— JS 里全是花括号
PAGE = r'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>pending</title></head>
<body><pre id="out">pending</pre><script>
const ITEMS = {{ITEMS}}, EDGE = {{EDGE}}, Q = 0.82;
const out = {};
let done = 0;
function finish () { document.getElementById('out').textContent = JSON.stringify(out); document.title = 'done'; }
/* key 是产物相对路径：圣遗物「<setId>/<部位>.webp」、武器「weapon/<itemId>.webp」；
   trim 决定要不要先裁透明边 —— 圣遗物留白不统一要裁，武器原图几乎满格不用裁 */
ITEMS.forEach(([key, u, trim]) => {
  const im = new Image();
  im.onload = () => {
    try {
      const W = im.naturalWidth, H = im.naturalHeight;
      let sx = 0, sy = 0, sw = W, sh = H;
      if (trim) {
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
        /* 缩略图坐标映射回原图，裁出内容框 */
        sx = l / w * W; sy = t / h * H;
        sw = (r - l + 1) / w * W; sh = (b - t + 1) / h * H;
      }
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
setTimeout(() => { if (document.title !== 'done') finish(); }, 120000);
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


def weapon_ids() -> list[tuple[str, str, str]]:
    """miao 五份 weapon/<类型>/data.json 的武器清单：[(itemId, 类型, 中文名)]。

    这些 id 就是后端 MiaoWeapon.get(itemId) 认的那一套，小图文件名也用它，
    一处映射两处用。data.json 形如 {"11101": {"id":11101,"name":"无锋剑","star":1}}。
    ⚠️ 同名多 id 是上游事实：「一心传」名刀有 11419/11420/11421 三个 id 共用一张原图，
       会产出三张内容相同的小图 —— 不同武器实体，不是「一张图起了两个名字」那种重复。
    """
    if not WEAPON_META.is_dir():
        return []
    rows: list[tuple[str, str, str]] = []
    for tdir in sorted(p for p in WEAPON_META.iterdir() if p.is_dir()):
        f = tdir / "data.json"
        if not f.is_file():
            continue
        for iid, row in json.loads(f.read_text(encoding="utf-8")).items():
            rows.append((str(iid), tdir.name, row["name"]))
    return rows


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
    ap = argparse.ArgumentParser(description="生成圣遗物 / 武器缩略图（缩到 96px 的 webp）")
    ap.add_argument("--force", action="store_true", help="已有的也重新生成")
    ap.add_argument("--edge", type=int, default=96, help="最长边像素（默认 96）")
    args = ap.parse_args()

    if not CHROME.exists():
        print(f"没找到 chrome-headless-shell：{CHROME}\n准备方法见 tools/shot.ts 头部", file=sys.stderr)
        return 1
    if not IMGS.is_dir():
        print(f"找不到素材目录：{IMGS}", file=sys.stderr)
        return 1
    if not WEAPON_META.is_dir():
        print(f"找不到 miao 武器元数据：{WEAPON_META}\n先跑 python tools/sync.py miao", file=sys.stderr)
        return 1

    # 一条 todo = (产物相对路径, 源图 URL, 要不要裁透明边)。
    # 圣遗物一套五个文件 1~5.webp（1 号花同时当代表图），源图在 imgs/<中文套装名>/ 下。
    ids = set_ids()
    todo: list[tuple[str, str, int]] = []
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
                todo.append((sid + "/" + out_name, url, 1))
    # 武器：按 itemId 命名、不按类型分目录；原图几乎满格，只缩不裁。
    for iid, wtype, wname in weapon_ids():
        if not (WEAPON_IMGS / wtype / wname / "icon.webp").exists():
            continue                          # 这个 id 上游没给原图，别凭空造
        out_name = iid + ".webp"
        if args.force or not (WEAPON_THUMBS / out_name).exists():
            url = "/web/assets/meta-gs/weapon/" + quote(wtype) + "/" + quote(wname) + "/icon.webp"
            todo.append(("weapon/" + out_name, url, 0))
    if not todo:
        print("artifact/thumbs 和 weapon/thumbs 都齐了，没活干（要重生成加 --force）")
        return 0

    html = PAGE.replace("{{ITEMS}}", json.dumps(todo, ensure_ascii=False)).replace("{{EDGE}}", str(args.edge))
    port, thread, srv = serve_once(html)
    try:
        out = subprocess.run(
            [str(CHROME), "--headless", "--disable-gpu", "--no-sandbox", "--no-proxy-server",
             "--virtual-time-budget=180000", "--dump-dom",
             f"http://127.0.0.1:{port}/__gen_flower.html"],
            capture_output=True, text=True, timeout=400,
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
        if key.startswith("weapon/"):
            out_file = WEAPON_THUMBS / key[len("weapon/"):]
        else:
            sid, out_name = key.split("/", 1)
            out_file = THUMBS / sid / out_name
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_bytes(raw)
        total += len(raw)
        ok += 1
    print(f"生成 {ok} 张，共 {total / 1024:.1f} KB（平均 {total / max(ok, 1) / 1024:.2f} KB）"
          + (f"，失败 {bad} 张" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
