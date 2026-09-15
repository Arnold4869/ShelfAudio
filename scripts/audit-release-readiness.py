#!/usr/bin/env python3
"""发版前元数据一致性审计：
1. VERSION 文件（唯一真源）格式 + versionCode 计算不产前导 0
2. 版本号注入（__APP_VERSION__）没被写死进 UI（updater.js 的示例版本/clientVersion 是合法例外）
3. 应用名 = 悦耳（index.html / strings.xml / Info.plist / capacitor.config.json）
4. 仓库里不能有真实服务器数据残留（2026-09-15 安全重写后铁律）
"""
import json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

ver = (ROOT / 'VERSION').read_text().strip()
print(f'VERSION = {ver}')
ok('VERSION 是 x.y.z 三段', bool(re.fullmatch(r'\d+\.\d+\.\d+', ver)), ver)

# versionCode 计算（CI 用的同一条 awk 公式）
out = subprocess.run(['awk', '-F.', '{printf "%d", $1*10000 + $2*100 + $3}'],
                     input=ver, capture_output=True, text=True).stdout
ok('versionCode 无前导 0', not out.startswith('0'), out)
ok('versionCode 数值合理', out.isdigit() and int(out) > 0, out)

# 版本号必须来自 VERSION（构建注入）。合法例外：
#   - __APP_VERSION__ 引用处
#   - updater.js 的版本比较示例/测试值
#   - api.js 的 clientVersion（ABS 设备上报，独立于发版号）
EXC = ('updater.js', 'api.js', 'navidrome.js')  # navidrome.js 的 '1.16.1' 是 Subsonic 协议版本常量
hard = []
for f in (ROOT / 'src').rglob('*.js'):
    if f.name in EXC:
        continue
    s = f.read_text()
    for m in re.finditer(r"['\"]v?\d+\.\d+\.\d+['\"]", s):
        line = s[:m.start()].count('\n') + 1
        ctx = s[max(0, m.start() - 80):m.start() + 40]
        # 注释里的历史版本说明不算
        if 'APP_VERSION' in ctx or '//' in ctx.split('\n')[-1] or '*' in ctx.split('\n')[-1]:
            continue
        hard.append(f'{f.name}:{line} {m.group(0)}')
ok('UI 源码没有写死版本号（一律用 __APP_VERSION__）', not hard, '; '.join(hard[:3]))

def read_or_none(p):
    try:
        return pathlib.Path(p).read_text()
    except Exception:
        return None

# 应用名一致性（文件缺失时跳过该项而不是崩 —— CI 的 checkout 可能不含平台目录）
# 检查面：App 内 + 平台配置 + CI 发布文案 + README（0.9.0 曾漏掉 workflow 里的「听书」）
fails_appname = []
for rel in ('.github/workflows/build.yml', 'README.md'):
    t = read_or_none(ROOT / rel)
    if t is None:
        continue
    if '听书' in t:
        fails_appname.append(f'{rel}: 残留旧名「听书」')
sw = read_or_none(ROOT / 'src/index.html')
ok('index.html <title> = 悦耳', bool(sw) and '<title>悦耳</title>' in sw,
   (re.search(r'<title>(.*?)</title>', sw).group(1) if sw else 'index.html 缺失'))
strings = read_or_none(ROOT / 'android/app/src/main/res/values/strings.xml')
if strings is None:
    print('  ⚠️ 跳过 android strings.xml（文件不存在）')
else:
    ok('strings.xml app_name = 悦耳', '>悦耳<' in strings)
plist = read_or_none(ROOT / 'ios/App/App/Info.plist')
if plist is None:
    print('  ⚠️ 跳过 iOS Info.plist（文件不存在）')
else:
    ok('Info.plist 含 悦耳', '悦耳' in plist)
cfgtxt = read_or_none(ROOT / 'capacitor.config.json')
try:
    cfg = json.loads(cfgtxt) if cfgtxt else {}
except Exception:
    cfg = {}
ok('capacitor appName = 悦耳', cfg.get('appName') == '悦耳', str(cfg.get('appName')))
if fails_appname:
    ok('CI/README 无旧名「听书」残留', False, '; '.join(fails_appname))
else:
    ok('CI/README 无旧名「听书」残留', True)

# 不允许真实服务器数据（2026-09-15 安全重写后的铁律）
leaks = []
real_hosts = ['audio.dsnetwork.cn', 'nd.dsnetwork.cn', '192.168.1.28:13378', '192.168.1.28:4533']
for d in ('src', 'scripts'):
    for f in (ROOT / d).rglob('*'):
        if not f.is_file() or f.suffix not in ('.js', '.mjs', '.py', '.json'):
            continue
        if f.name == 'audit-release-readiness.py':
            continue   # 本脚本内的黑名单字面量不是泄漏
        s = f.read_text(errors='ignore')
        for h in real_hosts:
            if h in s:
                leaks.append(f'{d}/{f.name}: {h}')
ok('仓库无真实服务器地址残留', not leaks, '; '.join(leaks[:3]))

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 发版前元数据审计通过')
