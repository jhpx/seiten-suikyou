#!/usr/bin/env python3
# 把 screenshot/ 下的手机原始截图处理成可直接分享的 WebP：
#   1. 裁掉顶部手机状态栏（时间 / 信号 / 电量那一栏，约 100px）
#   2. 缩到网页友好的宽度，导出 WebP（体积小、清晰）
# 产物直接写回 screenshot/ 下，与原始图同名、后缀改为 .webp。
# 用法：python tools/screenshot_preview.py
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = [
    ('screenshot/01.png', '角色总览：评分网格 + 刷圣遗物建议'),
    ('screenshot/02.png', '角色详情：面板 / 圣遗物 / 伤害计算'),
    ('screenshot/03.jpg', '伤害模拟对比：调整前后逐项对照'),
    ('screenshot/04.png', '刷圣遗物建议：按套装聚合低分角色'),
]
CROP_TOP = 100          # 状态栏高度（像素）
TARGET_W = 900          # 导出宽度


def load_crop(src):
    im = Image.open(os.path.join(ROOT, src)).convert('RGB')
    w, h = im.size
    im = im.crop((0, CROP_TOP, w, h))
    if im.width > TARGET_W:
        nh = round(im.height * TARGET_W / im.width)
        im = im.resize((TARGET_W, nh), Image.LANCZOS)
    return im


def main():
    for i, (src, cap) in enumerate(SRC, 1):
        im = load_crop(src)
        dst = os.path.join(ROOT, 'screenshot', f'{i:02d}.webp')
        im.save(dst, format='WEBP', quality=82, method=4)
        print(f'  {dst}  {im.size[0]}x{im.size[1]}  {cap}')


if __name__ == '__main__':
    main()
