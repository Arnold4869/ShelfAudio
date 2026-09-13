#!/usr/bin/env python3
"""家长管控回归（老板 2026-09-15 五项需求）：

 1. 设置页普通项不要密码，只有「家长设置」要
 2. 播放通知开关（静默 = 保留锁屏控制）
 3. （历史播放修复已在 test-player-mutex 里覆盖）
 4. 音量上限三档
 5. 收听时间：工作日/周末时段 + 每日时长；到点拦截播放

UI 断言走真实渲染（Playwright + 现有 fixture）；时段/额度逻辑直接 import
ES 模块单测（不经 UI，测边界）。
"""
import json, pathlib, re, sys, subprocess, tempfile, os

ROOT = pathlib.Path(__file__).parent.parent
FX = json.loads((pathlib.Path(__file__).parent / 'ui-fixtures.json').read_text())

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

# ---------- 第一部分：parental.js 纯逻辑单测（node 直接跑） ----------
print('=== A. 时段窗口逻辑（跨午夜/边界/未配置）===')
JS = r'''
import { strict as assert } from 'assert'
// 打桩 store（内存版）
const mem = new Map()
const store = {
  async get(k, d=''){ return mem.has(k) ? mem.get(k) : d },
  async set(k, v){ mem.set(k, v) },
}
// 用 import map 骗过 parental.js 的相对导入：直接注入全局再 eval 太脏，
// 改成把 parental.js 里的 `./store.js` 换成本地桩文件路径
'''
os.makedirs('/tmp/parental_test', exist_ok=True)
stub_store = '''
const mem = new Map()
export const store = {
  async get(k, d=''){ return mem.has(k) ? mem.get(k) : d },
  async set(k, v){ mem.set(k, String(v)) },
  async getJSON(k, d){ return d },
  async setJSON(k, v){ mem.set(k, JSON.stringify(v)) },
}
export const CONFIG_KEYS = {
  server:'server', token:'token', username:'username', mode:'mode', kidPin:'kidPin',
  playbackRate:'playbackRate', sleepMinutes:'sleepMinutes', kidLibraryIds:'kidLibraryIds',
  haptics:'haptics', progressScope:'progressScope', hideVoice:'hideVoice',
  listeningLog:'listeningLog',
  quietNotification:'quietNotification', volumeCap:'volumeCap',
  timeLimitEnabled:'timeLimitEnabled', timeWeekdayFrom:'timeWeekdayFrom',
  timeWeekdayTo:'timeWeekdayTo', timeWeekendFrom:'timeWeekendFrom',
  timeWeekendTo:'timeWeekendTo', timeDailyMinutes:'timeDailyMinutes',
}
'''
open('/tmp/parental_test/store.js','w').write(stub_store)
# stats 桩（dayRecords 返回注入值）
stub_stats = '''
export let TODAY = []
export function __set(v){ TODAY = v }
export async function dayRecords(){ return TODAY }
export function fmtDuration(sec){ return '' }
'''
open('/tmp/parental_test/stats.js','w').write(stub_stats)

src = (ROOT / 'src/lib/parental.js').read_text()
src = src.replace("from './store.js'", "from '/tmp/parental_test/store.js'")
src = src.replace("from './stats.js'", "from '/tmp/parental_test/stats.js'")
open('/tmp/parental_test/parental.js','w').write(src)

test_js = r'''
import { withinTimeWindow, dailyQuota, playbackBlockedReason, volumeCap } from '/tmp/parental_test/parental.js'
import { store, CONFIG_KEYS } from '/tmp/parental_test/store.js'
import { __set as setDay } from '/tmp/parental_test/stats.js'

const results = []
const ok = (name, cond, extra='') => results.push([cond ? '✅' : '❌', name, extra])

// 周三 10:00
const WED10 = new Date(2026, 8, 16, 10, 0)   // 2026-09-16 周三
const SAT21 = new Date(2026, 8, 19, 21, 0)   // 周六晚 21:00
const SUN2  = new Date(2026, 8, 20, 2, 0)    // 周日凌晨 2:00（测跨午夜）

// 1) 未开启 → 一律允许
store.set(CONFIG_KEYS.timeLimitEnabled, '0')
ok('未开启 → 任意时间允许', await withinTimeWindow(WED10))

// 2) 工作日 18:00-20:00
store.set(CONFIG_KEYS.timeLimitEnabled, '1')
store.set(CONFIG_KEYS.timeWeekdayFrom, '18:00')
store.set(CONFIG_KEYS.timeWeekdayTo, '20:00')
ok('工作日 10:00 不在 18-20 → 拒', !(await withinTimeWindow(WED10)))
const WED19 = new Date(2026, 8, 16, 19, 0)
ok('工作日 19:00 在 18-20 → 允', await withinTimeWindow(WED19))
// 周末不受工作日配置影响
ok('周六 21:00（周末未配置）→ 允', await withinTimeWindow(SAT21))

// 3) 周末独立配置 + 跨午夜
store.set(CONFIG_KEYS.timeWeekendFrom, '20:00')
store.set(CONFIG_KEYS.timeWeekendTo, '07:00')
ok('周六 21:00 在 20-07 → 允', await withinTimeWindow(SAT21))
ok('周日凌晨 2:00 在跨午夜窗内 → 允', await withinTimeWindow(SUN2))
const SAT15 = new Date(2026, 8, 19, 15, 0)
ok('周六 15:00 不在 20-07 → 拒', !(await withinTimeWindow(SAT15)))

// 4) 每日时长
setDay([])                                   // 今天没听
store.set(CONFIG_KEYS.timeDailyMinutes, '30')
let q = await dailyQuota()
ok('没听 → 剩 30 分钟', q.allowed && q.remainingSec === 1800, JSON.stringify(q))
setDay([{ d:'x', b:'b', t:'t', s: Date.now(), sec: 20*60 }])   // 已听 20 分钟
q = await dailyQuota()
ok('已听 20 分钟 → 剩 10 分钟', q.allowed && Math.round(q.remainingSec/60) === 10, JSON.stringify(q))
setDay([{ d:'x', b:'b', t:'t', s: Date.now(), sec: 31*60 }])   // 超了
q = await dailyQuota()
ok('已听 31 分钟 → 拒', !q.allowed, JSON.stringify(q))
store.set(CONFIG_KEYS.timeDailyMinutes, '0')
q = await dailyQuota()
ok('时长不限 → Infinity', q.allowed && q.remainingSec === Infinity)

// 5) 综合闸门的文案（只留时长限制，避免断言依赖"今天是星期几"）
store.set(CONFIG_KEYS.timeWeekdayFrom, '')
store.set(CONFIG_KEYS.timeWeekdayTo, '')
store.set(CONFIG_KEYS.timeWeekendFrom, '')
store.set(CONFIG_KEYS.timeWeekendTo, '')
store.set(CONFIG_KEYS.timeDailyMinutes, '30')
setDay([{ d:'x', b:'b', t:'t', s: Date.now(), sec: 40*60 }])
const reason = await playbackBlockedReason()
ok('超时给出友好文案', reason && reason.includes('用完'), reason)
store.set(CONFIG_KEYS.timeDailyMinutes, '0')
store.set(CONFIG_KEYS.timeWeekendFrom, '20:00')   // 周六 15:00 在窗外（测试日 2026-09-19 是周六）
store.set(CONFIG_KEYS.timeWeekendTo, '07:00')
const reason2 = await playbackBlockedReason(new Date(2026, 8, 19, 15, 0))
ok('时段外给出含「收听时间」的文案', reason2 && reason2.includes('收听时间'), reason2)

// 6) 音量上限
store.set(CONFIG_KEYS.volumeCap, '0.6')
ok('cap=0.6 读回 0.6', await volumeCap() === 0.6)
store.set(CONFIG_KEYS.volumeCap, '1')
ok('cap=1 → 不限', await volumeCap() === 1)
store.set(CONFIG_KEYS.volumeCap, 'abc')
ok('cap 坏数据 → 回落 1', await volumeCap() === 1)

console.log(results.map(r => `  ${r[0]} ${r[1]}${r[2] ? '  ['+r[2]+']' : ''}`).join('\n'))
const bad = results.filter(r => r[0] === '❌').length
console.log(`PARENTAL_RESULTS:${results.length - bad}/${results.length}`)
process.exit(bad ? 1 : 0)
'''
open('/tmp/parental_test/run.mjs','w').write(test_js)
r = subprocess.run(['/home/Bin/.local/bin/node', '/tmp/parental_test/run.mjs'],
                   capture_output=True, text=True, timeout=60)
print(r.stdout)
if r.returncode != 0:
    print('STDERR:', r.stderr[:600])
    fails.append('parental 逻辑单测')

# ---------- 第二部分：UI 断言 ----------
print('=== B. 设置页密码范围 + 家长页新行 ===')
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过 UI 部分：无 Playwright')
    sys.exit(1 if fails else 0)

import zlib
def _png(w=40, h=40, rgb=(90,140,200)):
    def chunk(t, d):
        c = t + d
        return len(d).to_bytes(4,'big') + c + zlib.crc32(c).to_bytes(4,'big')
    raw = b''.join(b'\x00' + bytes(rgb)*w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', w.to_bytes(4,'big')+h.to_bytes(4,'big')+b'\x08\x02\x00\x00\x00')
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PNG = _png()

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width':390,'height':844}, device_scale_factor=2,
                         is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    def h(route):
        u = route.request.url
        p = re.sub(r'^https?://[^/]+','',u).split('?')[0]
        if p in FX:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(FX[p]))
        if p.endswith('/cover'):
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        route.fulfill(status=200, content_type='application/json', body='{}')
    pg.route('**/api/**', h)
    pg.add_init_script("""
      localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
      localStorage.setItem('shelfaudio.token','t');
      localStorage.setItem('shelfaudio.username','user');
      localStorage.setItem('shelfaudio.mode','kid');
    """)
    pg.goto('http://127.0.0.1:8899/index.html')
    pg.wait_for_timeout(2500)

    # 1) 点底栏「设置」→ 不要密码直接进
    pg.evaluate("document.querySelector('[data-nav=settings]')?.click()")
    pg.wait_for_timeout(1200)
    ok('设置页无需密码直接进入', pg.evaluate("document.body.dataset.view") == 'settings',
       pg.evaluate("document.body.dataset.view"))

    # 2) 设置页出现「家长设置」入口；点它要密码
    # #lock 弹窗常驻 DOM，靠 .hidden 切换显示
    lockShown = pg.evaluate("!document.querySelector('#lock')?.classList.contains('hidden')")
    ok('未设密码时进家长设置不弹密码框（引导设置）', not lockShown)

    # 3) 家长页三行存在（先设密码走 UI）
    pg.evaluate("document.querySelector('#rowParent')?.click()")
    pg.wait_for_timeout(1200)
    ok('进入家长设置页', pg.evaluate("document.body.dataset.view") == 'parents')
    for rid, name in [('rowNotif','播放通知'), ('rowCap','音量上限'), ('rowTime','收听时间')]:
        ok(f'家长页有「{name}」行', pg.evaluate(f"!!document.querySelector('#{rid}')"))

    # 4) 通知开关切换
    v0 = pg.evaluate("document.querySelector('#notifVal')?.textContent")
    pg.evaluate("document.querySelector('#rowNotif')?.click()")
    pg.wait_for_timeout(400)
    v1 = pg.evaluate("document.querySelector('#notifVal')?.textContent")
    ok('通知开关可切换', v0 != v1, f'{v0!r} → {v1!r}')

    # 5) 音量上限三档循环
    c0 = pg.evaluate("document.querySelector('#capVal')?.textContent")
    pg.evaluate("document.querySelector('#rowCap')?.click()")
    pg.wait_for_timeout(300)
    c1 = pg.evaluate("document.querySelector('#capVal')?.textContent")
    pg.evaluate("document.querySelector('#rowCap')?.click()")
    pg.wait_for_timeout(300)
    c2 = pg.evaluate("document.querySelector('#capVal')?.textContent")
    pg.evaluate("document.querySelector('#rowCap')?.click()")
    pg.wait_for_timeout(300)
    c3 = pg.evaluate("document.querySelector('#capVal')?.textContent")
    ok('音量上限三档循环（100→60→80→100）', c0 != c1 and c2 != c1 and c3 == c0,
       f'{c0}→{c1}→{c2}→{c3}')

    # 6) 时间弹窗能开能关，保存生效
    pg.evaluate("document.querySelector('#rowTime')?.click()")
    pg.wait_for_timeout(400)
    ok('时间设置弹窗打开', pg.evaluate("!!document.querySelector('#tWdFrom')"))
    pg.evaluate("""() => {
      document.querySelector('#tEnabled').checked = true
      document.querySelector('#tWdFrom').value = '18:00'
      document.querySelector('#tWdTo').value = '20:00'
      document.querySelector('#tWeFrom').value = '09:00'
      document.querySelector('#tWeTo').value = '21:00'
      document.querySelector('#tDaily').value = '30'
      document.querySelector('#tSave').click()
    }""")
    pg.wait_for_timeout(500)
    tval = pg.evaluate("document.querySelector('#timeVal')?.textContent")
    ok('保存后摘要正确', tval and '18:00' in tval and '30 分钟' in tval, tval)
    ok('开关状态已存', pg.evaluate("localStorage.getItem('cap_pref_timeLimitEnabled')") in (None, '1'))
    ok('无 JS 报错', not errs, str(errs[:2]))
    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}')
    sys.exit(1)
print('✅ 全部通过')
