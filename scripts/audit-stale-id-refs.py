#!/usr/bin/env python3
"""审计：引用了「模板里不存在」的 id（删元素留绑定 = TypeError 中断整页初始化）。

规则（v2，v1 的三类误报已修正）：
- id 声明来源：本文件的 id="..." / src/index.html 的静态 id / 任意字符串字面量
  出现（覆盖 entBtn('favEntryCard', ...) 这类动态模板传参）
- 引用先剥掉注释再匹配（注释里的 $('#x') 示例不是真引用）
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []

# index.html 的静态 id 也是合法声明源
INDEX_IDS = set(re.findall(r'id="([A-Za-z0-9_\-]+)"', (ROOT / 'src/index.html').read_text()))

def strip_comments(s):
    s = re.sub(r'/\*[\s\S]*?\*/', '', s)
    s = re.sub(r'^\s*//.*$', '', s, flags=re.M)      # 整行注释
    s = re.sub(r'`(?:\\.|[^`\\])*`', lambda m: '`' + '0' * m.group(0).count('\n') + '`', s)  # 模板串保留换行
    return s

for f in sorted((ROOT / 'src').rglob('*.js')):
    raw = f.read_text()
    s = strip_comments(raw)
    # 声明：id="x"（模板里）或字符串字面量 'x' / "x" 出现（动态传参）
    declared = set(re.findall(r'id="([A-Za-z0-9_\-]+)"', raw))
    declared |= INDEX_IDS
    refs = {}
    for pat in (r"\$\('#([A-Za-z0-9_\-]+)'\)",
                r"querySelector\(\s*'#([A-Za-z0-9_\-]+)'\s*\)",
                r"querySelector\(\s*\"#([A-Za-z0-9_\-]+)\"\s*\)",
                r"getElementById\(\s*'([A-Za-z0-9_\-]+)'\s*\)"):
        for m in re.finditer(pat, s):
            line = s[:m.start()].count('\n') + 1
            refs.setdefault(m.group(1), line)
    for i, line in sorted(refs.items(), key=lambda x: x[1]):
        if i in declared:
            continue
        # 动态传参兜底：id 字符串在文件任意位置出现过（如 entBtn('favEntryCard',…)
        # → 生成 id="favEntryCard"）
        if re.search(rf"['\"`]({re.escape(i)})['\"`]", raw):
            continue
        fails.append(f'{f.name}:{line}  #{i}')

if fails:
    print(f'⚠️ {len(fails)} 处引用了未定义的 id（疑似残留引用 / 删元素没删绑定）：')
    for x in fails:
        print('   ' + x)
    sys.exit(1)
print('✅ 所有 #id 引用都有对应元素（含动态创建与 index.html 静态）')
