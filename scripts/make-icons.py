#!/usr/bin/env python3
"""
生成 ShelfAudio（听书）App 图标

设计（反 AI-slop，题材驱动）：
  题材 = 有声书（书 + 声音），受众 = 儿童，色板取 App 自身 UI 的靛紫/粉
  构图 = 一本摊开的书，三道声波从书页上方扩散 —— 一个焦点（声波），
         书安静地托住它，不堆装饰
  配色 = 靛紫渐变底 + 纸白书页 + 紫→粉声波（与 App 内 UI 同色系）
  避开 = 暖奶油底/陶土色、纯黑底+荧光单色、hairline 报纸式、
         SaaS 圆角卡片堆叠、全大写 eyebrow、"A · B · C" 圆点连接

输出：
  iOS     ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png (1024)
  Android mipmap-*/ic_launcher.png / ic_launcher_round.png（圆角/圆形，旧启动器）
          mipmap-*/ic_launcher_foreground.png（自适应图标前景，含安全区）
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IOS_ICON = os.path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
ANDROID_RES = os.path.join(ROOT, 'android/app/src/main/res')

# ---- 色板 ----
BG_A = (0x3A, 0x2C, 0x86)       # 靛紫（渐变起点）
BG_B = (0x12, 0x0F, 0x28)       # 深靛（渐变终点）
PAPER = (0xF7, 0xF5, 0xFF)      # 纸白（书页）
VIOLET = (0xA9, 0x8F, 0xFF)     # 紫（提亮，保证在深底上有对比）
PINK = (0xFF, 0x8A, 0xCE)       # 粉（略提亮，小尺寸不发闷）
SPINE = (0xCD, 0xC6, 0xEA)      # 书脊阴影
LINE = (0xAE, 0xA5, 0xD6)       # 页内文字线

DESIGN = 1024.0                  # 设计稿边长
SS = 4                           # 超采样倍数 → 消锯齿


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, c0, c1):
    """对角线性渐变"""
    img = Image.new('RGB', (size, size))
    px = img.load()
    denom = 2.0 * size - 2
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            px[x, y] = lerp(c0, c1, t if 0 <= t <= 1 else (0 if t < 0 else 1))
    return img


def draw_art(img, d, size, inset=1.0, detail=True):
    """
    在边长 size 的图上画「书 + 声波」。
    inset: 内容缩放（自适应图标前景要缩小到安全区内）
    detail: 小尺寸传 False，省掉页内细线（放不下会糊成一团）
    设计稿以 1024 为基准；内容整体等比缩放后**居中**绘制。
    """
    k = size / DESIGN * inset
    off = (size - DESIGN * k) / 2.0

    def P(x, y):
        return (off + x * k, off + y * k)

    def V(v):
        return max(1, int(round(v * k)))

    # ---------- 声波：三道弧，向上张开 ----------
    cx, cy = 512, 596
    # 小尺寸把线加粗、弧拉近，保证缩下去还看得见
    w = 33 if detail else 46
    # 小尺寸：三道弧收紧间距（仍全部位于书的上方），线更粗，避免糊成一片
    r1, r2, r3 = (140, 222, 304) if detail else (152, 226, 300)
    for r, col in [
        (r1, VIOLET),
        (r2, lerp(VIOLET, PINK, 0.5)),
        (r3, PINK),
    ]:
        r = max(6, r)
        box = [*P(cx - r, cy - r), *P(cx + r, cy + r)]
        d.arc(box, start=207, end=333, fill=col, width=V(w))
        for ang in (207, 333):
            ax = cx + r * math.cos(math.radians(ang))
            ay = cy + r * math.sin(math.radians(ang))
            d.ellipse([*P(ax - w / 2, ay - w / 2), *P(ax + w / 2, ay + w / 2)], fill=col)

    # ---------- 书：摊开的两页 ----------
    top_y, bot_y = 648, 816
    spine_x, half_w = 512, 284
    if not detail:
        top_y, bot_y = 640, 828
        half_w = 300

    left_page = [
        P(spine_x - 18, top_y + 12),
        P(spine_x - half_w, top_y - 24),
        P(spine_x - half_w + 8, bot_y - 20),
        P(spine_x - 18, bot_y - 4),
    ]
    right_page = [
        P(spine_x + 18, top_y + 12),
        P(spine_x + half_w, top_y - 24),
        P(spine_x + half_w - 8, bot_y - 20),
        P(spine_x + 18, bot_y - 4),
    ]
    d.polygon(left_page, fill=PAPER)
    d.polygon(right_page, fill=PAPER)

    # 中缝
    d.polygon([P(spine_x - 18, top_y + 12), P(spine_x + 18, top_y + 12),
               P(spine_x + 18, bot_y - 4), P(spine_x - 18, bot_y - 4)], fill=SPINE)

    # 页内文字线（小尺寸时不画，否则糊）
    if detail:
        for i in range(3):
            y = top_y + 54 + i * 44
            lx0 = spine_x - half_w + 56
            lx1 = spine_x - 56 if i < 2 else spine_x - 150
            d.line([*P(lx0, y), *P(lx1, y)], fill=LINE, width=V(13))
            rx0 = spine_x + 56 if i < 2 else spine_x + 150
            rx1 = spine_x + half_w - 56
            d.line([*P(rx0, y), *P(rx1, y)], fill=LINE, width=V(13))


def render(target_px, kind='square', inset=1.0, bg=True, trim=False):
    """渲染一张图标。内部按 SS 倍超采样再降采样。
    trim=True 时按内容包围盒裁切并居中（自适应图标前景用，保证视觉居中）。"""
    big = target_px * SS
    # 小尺寸（<=72px）用简化版：去掉页内细线，加粗声波
    detail = target_px > 72
    layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    draw_art(layer, d, big, inset=inset, detail=detail)

    if trim:
        bbox = layer.getbbox()
        if bbox:
            content = layer.crop(bbox)
            # 内容按 inset 缩放到目标画布，然后居中
            target = int(big * inset)
            content = content.resize((target, target), Image.LANCZOS)
            layer = Image.new('RGBA', (big, big), (0, 0, 0, 0))
            off = (big - target) // 2
            layer.alpha_composite(content, (off, off))

    if bg:
        base = gradient(big, BG_A, BG_B).convert('RGBA')
        out = Image.alpha_composite(base, layer)
    else:
        out = layer

    out = out.resize((target_px, target_px), Image.LANCZOS)

    if kind == 'rounded':
        m = Image.new('L', (target_px, target_px), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, target_px - 1, target_px - 1],
                                            radius=int(target_px * 0.225), fill=255)
        out.putalpha(Image.composite(out.getchannel('A'), Image.new('L', out.size, 0), m))
    elif kind == 'circle':
        m = Image.new('L', (target_px, target_px), 0)
        ImageDraw.Draw(m).ellipse([0, 0, target_px - 1, target_px - 1], fill=255)
        out.putalpha(Image.composite(out.getchannel('A'), Image.new('L', out.size, 0), m))
    return out


def main():
    os.makedirs(os.path.dirname(IOS_ICON), exist_ok=True)

    # iOS：1024，满幅（系统自己切圆角，不能自带圆角/透明）
    render(1024, 'square').convert('RGB').save(IOS_ICON, 'PNG')
    print(f'iOS    {IOS_ICON}  {os.path.getsize(IOS_ICON)} bytes')

    # Android
    for name, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        folder = os.path.join(ANDROID_RES, f'mipmap-{name}')
        os.makedirs(folder, exist_ok=True)

        render(px, 'rounded').save(os.path.join(folder, 'ic_launcher.png'), 'PNG')
        render(px, 'circle').save(os.path.join(folder, 'ic_launcher_round.png'), 'PNG')

        # 自适应图标前景：108dp 画布，内容须落在中心 72dp 安全区 → 内容占 66%
        fg_px = round(px * 108 / 48)
        fg_px = min(1024, fg_px)     # 避免超采样过大
        render(fg_px, 'square', inset=0.66, bg=False, trim=True).save(
            os.path.join(folder, 'ic_launcher_foreground.png'), 'PNG')
        print(f'Android {name:8} {px}px  前景 {fg_px}px')


if __name__ == '__main__':
    main()
