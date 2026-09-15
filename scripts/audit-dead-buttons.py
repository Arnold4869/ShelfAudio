#!/usr/bin/env python3
"""死按钮扫描（v2）：渲染出来的可点元素（button/a 上的 id）有没有被任何 JS 引用。

0.8.0 的 bug = 「模板里还有按钮，handler 却被删了」→ 点了没反应（老板报的"少了个功能"）。
判据：
  A = 模板里 <button>/<a> 上的 id（含 innerHTML 动态生成的）
  B = 该 id 在 **模板字符串以外** 的代码里作为选择器出现过（'#id' / "#id"）
只报 A 有、B 没有的。id 只出现在自己的 id="..." 里 = 没有任何代码碰它 = 死按钮。

用法：python3 scripts/audit-dead-buttons.py [--verbose]
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
files = sorted(SRC.rglob('*.js'))

BTN_ID = re.compile(r'<(?:button|a)\b[^>]*?\bid="([A-Za-z0-9_\-]+)"')
ANY_ID = re.compile(r'\bid="([A-Za-z0-9_\-]+)"')

# 合法的无 handler 情况：纯展示元素 + 由事件委托/父元素处理的已知例外
WHITELIST = set()

dead = {}
checked = 0
for f in files:
    s = f.read_text()
    btn_ids = set(BTN_ID.findall(s))
    all_ids = set(ANY_ID.findall(s))
    if not btn_ids:
        continue
    # 去掉 id="..." 本身之后的文本，再看还剩哪些 '#id' 出现
    stripped = ANY_ID.sub('id=""', s)
    for i in sorted(btn_ids):
        checked += 1
        # 该 id 在代码里作为选择器出现过吗（#id / ['id'] / getElementById）
        pats = [
            rf"['\"]#{re.escape(i)}['\"]",              # '#id' / "#id"
            rf"getElementById\(\s*['\"]{re.escape(i)}['\"]",
            rf"\bdata-id=\\?['\"]{re.escape(i)}",         # data-id="xxx" 反向查找
            rf"id:\s*['\"]{re.escape(i)}['\"]",
        ]
        if any(re.search(p, stripped) for p in pats):
            continue
        if i in WHITELIST:
            continue
        dead.setdefault((f.name, i), [])

print(f'检查了 {checked} 个模板按钮 id')
if dead:
    print(f'\n⚠️ 以下 {len(dead)} 个按钮没有任何代码引用（疑似死按钮）：')
    for (fn, i) in sorted(dead):
        print(f'   {fn:22s}  #{i}')
    sys.exit(1)
print('✅ 没有死按钮')
