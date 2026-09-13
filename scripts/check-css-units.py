#!/usr/bin/env python3
"""CSS 新单位兜底检查（CI 用）

背景（老板 2026-09-13 真机问题）：小米 8SE 的 Android WebView 内核较老
（Chrome < 108），不认 dvh / svh / lvh / :has() 等新语法。CSS 里不认的
**整条声明会被直接丢弃**（不是忽略那一个值），于是
`min-height: 100dvh` 一失效，播放页就塌成内容高度 —— 约占 2/3 屏，
下半截全变空白。老板连续两轮反馈"界面太小 / 只占 2/3"就是这个。

规则：凡是用 dvh/svh/lvh 的声明，**同一规则块内**必须有一条等价的
老式兜底（vh 或 px/%）写在前面，靠 CSS 级联覆盖：
    min-height: 100vh;
    min-height: 100dvh;   <- 新浏览器用这条
这样老内核用兜底值，新内核用精确值，两边都不塌。
"""
import re, sys, pathlib

UNITS = ('dvh', 'svh', 'lvh')
ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [ROOT / 'src/styles.css', ROOT / 'src/index.html']

# 允许"值为 0"或纯注释行出现这些单位时不做要求（0dvh 无意义，注释被排除）
def blocks(css):
    """按最外层 {} 切规则块，返回 (选择器, 块体) 列表（含嵌套）。"""
    out, depth, start, sel_start = [], 0, None, 0
    i = 0
    while i < len(css):
        c = css[i]
        if c == '{':
            if depth == 0:
                start = i + 1
                sel = css[sel_start:i]
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0 and start is not None:
                out.append((css[sel_start:i][:200], css[start:i]))
                start = None
                sel_start = i + 1
        i += 1
    return out

def strip_comments(s):
    return re.sub(r'/\*.*?\*/', '', s, flags=re.S)

problems, checked = [], 0
for f in FILES:
    if not f.exists():
        continue
    raw = f.read_text(encoding='utf-8')
    if f.suffix == '.css':
        for sel, body in blocks(raw):
            body_nc = strip_comments(body)
            for m in re.finditer(r'([-a-z]+)\s*:\s*([^;{}]+);', body_nc):
                prop, val = m.group(1), m.group(2)
                if not any(u in val for u in UNITS):
                    continue
                checked += 1
                # 同块内找该属性的非 dvh 兜底（必须写在这条之前）
                earlier = body_nc[:m.start()]
                pat = re.compile(r'(?<![-a-z])' + re.escape(prop) + r'\s*:\s*([^;{}]*[^;{}\s])[^;{}]*;')
                fallback = None
                for fm in pat.finditer(earlier):
                    if not any(u in fm.group(1) for u in UNITS):
                        fallback = fm.group(1).strip()
                if fallback is None:
                    # 也接受"独立规则兜底"模式：同文件里存在
                    # `selector { prop: <非新单位> }` 且选择器与当前块相同
                    # （构建器会把同块内的重复声明合并掉，兜底必须分块写）。
                    sel_key = re.sub(r'\s+', '', strip_comments(sel).split('{')[0])
                    all_css_nc = strip_comments(raw)
                    for bsel, bbody in blocks(all_css_nc):
                        bsel_key = re.sub(r'\s+', '', strip_comments(bsel).split('{')[0])
                        if bsel_key and bsel_key == sel_key:
                            for fm in pat.finditer(strip_comments(bbody)):
                                if not any(u in fm.group(1) for u in UNITS):
                                    fallback = fm.group(1).strip()
                    if fallback is not None:
                        # 记录一下模式，便于人工核对兜底确实存在
                        checked += 0
                if fallback is None:
                    problems.append(f'{f.name}: `{prop}: {val.strip()}` 用了新单位但同块内没有老式兜底（选择器 {sel.strip()[:60]}）')
    else:
        # HTML 内联样式（如 style="height:100dvh"）同样要求成对写
        for m in re.finditer(r'style="([^"]*)"', raw):
            style = m.group(1)
            if any(u in style for u in UNITS):
                checked += 1
                if 'vh' not in style.replace('dvh', '').replace('svh', '').replace('lvh', ''):
                    problems.append(f'{f.name}: 内联样式 `{style[:60]}` 用了新单位但没有 vh 兜底')

print(f'检查 {checked} 处新单位用法')
if problems:
    print('失败：')
    for p in problems:
        print('  ❌', p)
    print('\n修法：在用到 dvh/svh/lvh 的那条声明**前面**，补一条等价的 vh 兜底：')
    print('    min-height: 100vh;')
    print('    min-height: 100dvh;')
    sys.exit(1)
print('✅ 所有 dvh/svh/lvh 用法都有老内核兜底')
