# -*- coding: utf-8 -*-
"""
生成 icon-new.png = 15 个图标的统一规格雪碧图：600×40，横向 15 格。

雪碧图规格
----------
· **格子统一**：每格 40×40，前端用 `background-position: -{格号×40}px 0` 取格。
· **图形统一**：所有图标走同一条归一化流水线 —— 裁内容 bbox → 最长边对齐 38px
  （短边等比，不拉伸变形）→ 居中放进 40×40 格。图形不再保留原图的个体差异，
  否则前端拿出来大大小小没法用。
· 格 0-7 = icon.png 的 8 个属性图标（原图 500×40，图标在 x=40..360，每个占 40×40）。
· 格 8 = 暴击伤害：格 4 闪光星的中心挖一颗小星（洞 = 图形自身 ×0.42 的缩小版）。
· 格 9 = 治疗加成：程序画的粗十字（横竖两杠等宽 12px，总长 38）。
· 格 10-16 = 七元素图标（顺序与 miao attrIdMap 一致）。

元素图样式统一
--------------
icon.png 里的图标全是「纯白 + 透明底、边缘硬」的风格。元素图原图是彩色的，
且自带一圈半透明光晕 —— 直接刷白会把光晕也带进去，看着糊。
所以先对 **alpha 做阈值截断（>= 210 才保留）**：光晕和中间调全切掉，
只留下实心笔画，再刷白缩放 —— 边缘硬、轮廓清晰，与属性图标风格一致。
阈值别高于 210：240 时细笔画会断；别低于 170：光晕切不干净。

缩放质量
--------
缩小用 **area average（面积平均）** 保细笔画；放大用 **bilinear（双线性）** 防锯齿
（面积平均放大时会退化成最近邻）。两者都对 **premultiplied alpha** 运算 ——
否则半透明边缘会因 RGB 与 alpha 分别平均而发黑。
"""
import zlib
import struct
import io
import math
import os

BASE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(BASE, '..', 'src', 'server', 'public', 'assets')

# 顺序与 miao 的 attrIdMap 一致（15008 起）：pyro/electro/cryo/hydro/anemo/geo/dendro
ELEMS = ['pyro', 'electro', 'cryo', 'hydro', 'anemo', 'geo', 'dendro']

# alpha 阈值：>= 它才算实心笔画。210 是实测的甜点位 —— 低了光晕切不干净，高了细笔画断
ALPHA_THRESHOLD = 210


# ────────────────────────── PNG 解码 ──────────────────────────
def read_png(path):
    f = open(path, 'rb').read()
    pos, idat, w, h, ct, bd = 8, b'', 0, 0, 0, 0
    while pos < len(f):
        ln = struct.unpack('>I', f[pos:pos + 4])[0]
        typ = f[pos + 4:pos + 8]
        data = f[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    if bd != 8 or ct not in (2, 6):
        raise ValueError(f'只支持 8bit RGB/RGBA，实际 bitdepth={bd} colortype={ct}')
    ch = 4 if ct == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * ch
    rows, prev = [], bytearray(stride)
    for y in range(h):
        ft = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - ch] if x >= ch else 0
            b = prev[x]
            c = prev[x - ch] if x >= ch else 0
            if ft == 1:
                line[x] = (line[x] + a) & 255
            elif ft == 2:
                line[x] = (line[x] + b) & 255
            elif ft == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        # 统一成 RGBA
        rgba = bytearray(w * 4)
        for x in range(w):
            rgba[x * 4:x * 4 + 3] = line[x * ch:x * ch + 3]
            rgba[x * 4 + 3] = 255 if ch == 3 else line[x * ch + 3]
        rows.append(bytes(rgba))
        prev = line
    return w, h, rows


# ────────────────────────── PNG 编码 ──────────────────────────
def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + r for r in rows)          # filter type 0
    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)   # 8bit RGBA
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(out)


# ─────────────────────── 降采样：area average ───────────────────────
def shrink(rgba, sw, sh, dw, dh):
    """premultiplied area average：RGB 乘 alpha 后平均，再还原。"""
    out = []
    for dy in range(dh):
        y0, y1 = dy * sh / dh, (dy + 1) * sh / dh
        iy0, iy1 = int(y0), max(int(y0) + 1, min(sh, int(y1 + 0.999999)))
        row = bytearray(dw * 4)
        for dx in range(dw):
            x0, x1 = dx * sw / dw, (dx + 1) * sw / dw
            ix0, ix1 = int(x0), max(int(x0) + 1, min(sw, int(x1 + 0.999999)))
            ar = ag = ab = aa = 0.0
            wsum = 0.0
            for y in range(iy0, iy1):
                wy = min(y + 1, y1) - max(y, y0)
                if wy <= 0:
                    continue
                r = rgba[y]
                for x in range(ix0, ix1):
                    wx = min(x + 1, x1) - max(x, x0)
                    if wx <= 0:
                        continue
                    wgt = wx * wy
                    i = x * 4
                    al = r[i + 3] / 255.0
                    ar += r[i] * al * wgt
                    ag += r[i + 1] * al * wgt
                    ab += r[i + 2] * al * wgt
                    aa += al * wgt
                    wsum += wgt
            if wsum > 0 and aa > 0:
                row[dx * 4] = min(255, round(ar / aa))
                row[dx * 4 + 1] = min(255, round(ag / aa))
                row[dx * 4 + 2] = min(255, round(ab / aa))
            row[dx * 4 + 3] = round(aa / wsum * 255)
        out.append(bytes(row))
    return out


# ─────────────────────── 放大：bilinear ───────────────────────
def upscale_bilinear(rgba, sw, sh, dw, dh):
    """premultiplied bilinear。面积平均在放大时会退化成最近邻（方块锯齿），
    放大必须走插值。同样 RGB 乘 alpha 再插值，避免半透明边缘发黑。"""
    out = []
    for dy in range(dh):
        sy = (dy + 0.5) * sh / dh - 0.5
        y0 = math.floor(sy)                              # int() 对负数是向零截断，权重会爆
        fy = sy - y0
        if y0 < 0: y0, fy = 0, 0.0
        if y0 >= sh - 1: y0, fy = sh - 1, 0.0
        y1 = min(y0 + 1, sh - 1)
        row = bytearray(dw * 4)
        for dx in range(dw):
            sx = (dx + 0.5) * sw / dw - 0.5
            x0 = math.floor(sx)
            fx = sx - x0
            if x0 < 0: x0, fx = 0, 0.0
            if x0 >= sw - 1: x0, fx = sw - 1, 0.0
            x1 = min(x0 + 1, sw - 1)
            ar = ag = ab = aa = 0.0
            for yy, xx, wgt in ((y0, x0, (1 - fy) * (1 - fx)), (y0, x1, (1 - fy) * fx),
                                (y1, x0, fy * (1 - fx)), (y1, x1, fy * fx)):
                i = xx * 4
                r = rgba[yy]
                al = r[i + 3] / 255.0
                ar += r[i] * al * wgt
                ag += r[i + 1] * al * wgt
                ab += r[i + 2] * al * wgt
                aa += al * wgt
            if aa > 0:
                row[dx * 4] = min(255, round(ar / aa))
                row[dx * 4 + 1] = min(255, round(ag / aa))
                row[dx * 4 + 2] = min(255, round(ab / aa))
            row[dx * 4 + 3] = round(aa * 255)
        out.append(bytes(row))
    return out


def resample(rgba, sw, sh, dw, dh):
    """缩小用面积平均（保细笔画），放大用双线性（防锯齿）。"""
    if dw <= sw and dh <= sh:
        return shrink(rgba, sw, sh, dw, dh)
    return upscale_bilinear(rgba, sw, sh, dw, dh)


# ─────────────────────── 图形工具 ───────────────────────
def content_bbox(rgba, w, h):
    """非透明内容（alpha > 8）的边界框。返回 (x0, y0, x1, y1)。"""
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        r = rgba[y]
        for x in range(w):
            if r[x * 4 + 3] > 8:
                if x < x0: x0 = x
                if x >= x1: x1 = x + 1
                if y < y0: y0 = y
                if y >= y1: y1 = y + 1
    return x0, y0, x1, y1


def crop(rgba, w, x0, y0, x1, y1):
    return [bytes(r[x0 * 4:x1 * 4]) for r in rgba[y0:y1]]


def hollow_center(cell_rows, cell, ratio=0.42):
    """把格内图形按 ratio 缩小一份，从中心扣掉（挖空）。
    暴击伤害图标的做法：闪光星中间挖一颗小星 —— 洞就是图形自己的缩小版。
    扣洞用 a' = a·(1-sa/255)，洞边缘保留缩小版的抗锯齿，不会出毛边。"""
    x0, y0, x1, y1 = content_bbox(cell_rows, cell, cell)
    gw, gh = x1 - x0, y1 - y0
    g = crop(cell_rows, cell, x0, y0, x1, y1)
    sw, sh = round(gw * ratio), round(gh * ratio)
    small = resample(g, gw, gh, sw, sh)
    ox, oy = x0 + (gw - sw) // 2, y0 + (gh - sh) // 2
    out = [bytearray(r) for r in cell_rows]
    for y in range(sh):
        row = out[oy + y]
        sr = small[y]
        for x in range(sw):
            sa = sr[x * 4 + 3]
            if sa:
                i = (ox + x) * 4 + 3
                row[i] = round(row[i] * (1 - sa / 255))
    return [bytes(r) for r in out]


def draw_cross(cell, target, bar=12):
    """治疗加成图标：粗十字。横竖两杠等宽、交于中心，总长 target。
    轴对齐矩形不需要抗锯齿，硬边与整体风格一致。"""
    c0, c1 = (target - bar) // 2, (target - bar) // 2 + bar
    off = (cell - target) // 2
    rows = []
    for y in range(cell):
        line = bytearray(cell * 4)
        gy = y - off
        for x in range(cell):
            gx = x - off
            if 0 <= gx < target and 0 <= gy < target and (c0 <= gx < c1 or c0 <= gy < c1):
                line[x * 4:x * 4 + 4] = b'\xff\xff\xff\xff'
        rows.append(bytes(line))
    return rows


def normalize_glyph(rgba, w, h, target, cell):
    """雪碧图归一化：裁内容 → 最长边对齐 target（等比）→ 居中放进 cell×cell 的格。
    所有图标走这一条流水线，才能保证「每个图标一样大」。"""
    x0, y0, x1, y1 = content_bbox(rgba, w, h)
    cw, ch = x1 - x0, y1 - y0
    cropped = crop(rgba, w, x0, y0, x1, y1)
    s = target / max(cw, ch)
    dw, dh = max(1, round(cw * s)), max(1, round(ch * s))
    small = resample(cropped, cw, ch, dw, dh)
    ox, oy = (cell - dw) // 2, (cell - dh) // 2
    out = []
    for y in range(cell):
        line = bytearray(cell * 4)
        if oy <= y < oy + dh:
            src = small[y - oy]
            for x in range(dw):
                line[(ox + x) * 4:(ox + x) * 4 + 4] = src[x * 4:x * 4 + 4]
        out.append(bytes(line))
    return out, (cw, ch, dw, dh)


# ────────────────────────── 主流程 ──────────────────────────
def main():
    base_path = os.path.join(ASSETS, 'character', 'imgs', 'icon.png')
    bw, bh, brows = read_png(base_path)
    cell = 40                                            # 每格 40×40
    target = 38                                          # 图形最长边统一 38px，格内居中
    # icon.png 的 8 个图标在 x=40..360，前后都是空白
    base_icons = 8
    first_x = 40
    print(f'原 icon.png: {bw}×{bh} → 8 个图标（每格 {cell}×{cell}，从 x={first_x} 起）')
    print(f'归一化：所有图形裁内容后最长边对齐 {target}px，居中放进 {cell}×{cell} 格')

    cells = []
    # 左侧 8 个：从原图整格裁出，同走归一化流水线（本身已是纯白，不用阈值）
    for k in range(base_icons):
        x0 = first_x + k * cell
        glyph_rows = [row[x0 * 4:(x0 + cell) * 4] for row in brows]
        c, (cw, ch, dw, dh) = normalize_glyph(glyph_rows, cell, cell, target, cell)
        cells.append(c)
        print(f'  格{k:<2} 原图形 {cw}×{ch} → {dw}×{dh}')

    # 格8 暴击伤害：格4 闪光星中心挖一颗小星（洞的轮廓 = 星自己的缩小版）
    critdmg = hollow_center(cells[4], cell)
    cells.append(critdmg)
    print(f'  格8  暴击伤害 = 格4 星形中心挖空（小星 = 图形×0.42）')
    # 格9 治疗加成：程序画的粗十字
    heal = draw_cross(cell, target)
    cells.append(heal)
    print(f'  格9  治疗加成 = 十字（杠宽 12/{target}）')

    # 七元素：阈值截断取实心笔画 + 刷白，同走归一化流水线
    for e in ELEMS:
        ew, eh, erows = read_png(os.path.join(ASSETS, 'common', 'elem', f'{e}.png'))
        white_rows = []
        for row in erows:
            wr = bytearray(row)
            for x in range(ew):
                a = row[x * 4 + 3]
                wr[x * 4] = wr[x * 4 + 1] = wr[x * 4 + 2] = 255
                wr[x * 4 + 3] = 255 if a >= ALPHA_THRESHOLD else 0
            white_rows.append(bytes(wr))
        c, (cw, ch, dw, dh) = normalize_glyph(white_rows, ew, eh, target, cell)
        cells.append(c)
        idx = len(cells) - 1
        print(f'  格{idx:<2} {e:<8} 实心笔画 {cw}×{ch} → {dw}×{dh}')

    # 横向拼：输出的每一行 = 各格同一行首尾相接
    nw = len(cells) * cell
    lines = []
    for y in range(cell):
        lines.append(b''.join(c[y] for c in cells))
    out_path = os.path.join(ASSETS, 'character', 'imgs', 'icon-new.png')
    write_png(out_path, nw, cell, lines)
    print(f'\n✅ 已生成 {out_path}')
    print(f'   {nw}×{cell}，共 {len(cells)} 格横向排列：0-7 属性图标，8 暴击伤害，9 治疗加成，10-16 七元素')
    for i, e in enumerate(ELEMS, start=len(cells) - len(ELEMS)):
        print(f'     格{i} = {e}  （CSS: background-position: -{i * 40}px 0）')


if __name__ == '__main__':
    main()
