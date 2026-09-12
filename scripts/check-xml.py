#!/usr/bin/env python3
"""
校验 Android 资源 XML。

为什么需要：AAPT 对 XML 注释有额外限制 —— 注释里出现连续两个连字符（"--"）会直接
让构建失败（报 "The string \"--\" is not permitted within comments"），而且是在 CI 里
才炸。本地测不到，所以固化成检查。

用法：python3 scripts/check-xml.py
"""
import pathlib, re, sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
bad = []

for p in sorted((ROOT / 'android').rglob('*.xml')):
    txt = p.read_text(encoding='utf-8')
    rel = str(p.relative_to(ROOT))
    try:
        ET.fromstring(txt)
    except Exception as e:
        bad.append((rel, 'XML 解析失败: %s' % e))
        continue
    # AAPT：注释里不能出现 "--"
    for m in re.finditer(r'<!--(.*?)-->', txt, re.S):
        if '--' in m.group(1):
            bad.append((rel, 'XML 注释里含 "--"（AAPT 会拒绝）'))

if bad:
    print('❌ Android XML 检查未通过：')
    for f, why in bad:
        print('   %s | %s' % (f, why))
    sys.exit(1)

print('✅ Android XML 全部合法（注释无 "--"）')
