#!/usr/bin/env python3
"""
防止 emoji 再次混进界面。
背景：⏮ ▶ ⏭ ⚙️ 📚 🔍 🎤 这些字符由各系统的 emoji 字体渲染，
iOS 画成彩色 3D 小图、Android 又是另一套，风格与界面不搭（老板明确要求不要用）。
图标统一走 src/lib/icons.js 的自绘 SVG。

用法：node scripts/check-emoji.mjs
退出码非 0 表示发现 emoji，CI 应拦下。
"""
import pathlib, sys

# 只扫"会出现在界面上"的文件；注释里的 ⚠️ → 等无害，单独放行
FILES = ['src/app.js', 'src/index.html', 'src/styles.css']
ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'src/lib').glob('*.js'))]
FILES += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'src/views').glob('*.js'))]

# 允许的符号：这些是排版符号/箭头，不是 emoji，界面里当文字用没问题
ALLOW = set('·—–…“”‘’《》〈〉→←↑↓≤≥×✓✗§¶•‹›「」【】')


def is_emoji(ch):
    o = ord(ch)
    if ch in ALLOW:
        return False
    ranges = [
        (0x1F000, 0x1FAFF),   # 各类 emoji
        (0x1F300, 0x1F5FF),
        (0x2600, 0x27BF),     # 杂项符号 + 装饰符号（⏰ ⚙ ⚠ 等）
        (0x2B00, 0x2BFF),
        (0xFE0F, 0xFE0F),     # 变体选择符（把字符变成 emoji 呈现）
        (0x2300, 0x23FF),     # 技术符号（⏮ ⏭ ⏸ 等）
    ]
    return any(a <= o <= b for a, b in ranges)


bad = []
for rel in FILES:
    p = ROOT / rel
    if not p.exists():
        continue
    for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
        stripped = line.strip()
        # 注释行放行（⚠️ 只用于代码标注，不会显示给用户）
        if stripped.startswith(('//', '*', '/*', '<!--')):
            continue
        for ch in line:
            if is_emoji(ch):
                bad.append((rel, i, ch, stripped[:100]))
                break

if bad:
    print("❌ 发现 emoji（界面里应改用自绘 SVG 图标，见 src/lib/icons.js）：")
    for rel, i, ch, ctx in bad:
        print("  %s:%d  U+%04X %s  | %s" % (rel, i, ord(ch), ch, ctx))
    sys.exit(1)

print("✅ 界面代码里没有 emoji（图标全部为自绘 SVG）")
