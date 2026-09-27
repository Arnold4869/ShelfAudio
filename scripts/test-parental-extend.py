#!/usr/bin/env python3
"""家长加时回归（老板 2026-09-27 需求：每日时间到点后，输家长密码可以继续）。

功能链路：
  parental.js   —— dailyBonusSeconds/addDailyBonusMinutes（按天余额）、
                   playbackGate（结构化闸门：quota 才可续，window 不可续）
  parental-extend.js —— 加时弹窗（家长密码 → 选分钟 → 落盘）
  app.js        —— playItem 闸门（拦下→加时→重判→放行）、resumeGate（toggle 注入）、
                   guard 定时器（播放中到点 → 弹加时 → 原地续播）
  player.js     —— toggle()/remotePlay/web mediaSession 全走 gatedPlay

三部分：
  A. node 纯逻辑（余额按天、配额含加时、闸门结构化）—— 桩 store/stats 直接 import
  B. Playwright UI：到点 → 点播放键 → 弹加时 → 输密码 → 加时 → 起播成功
  C. Playwright UI：取消加时 → 维持拦截（孩子绕不过）

无 Playwright 自动跳过（CI 兼容）。
"""
import json, pathlib, re, sys, os, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

# ================= A. node 纯逻辑 =================
print('=== A. 加时余额 / 配额 / 结构化闸门（node 单测）===')
os.makedirs('/tmp/parental_ext_test', exist_ok=True)
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
  timeLimitEnabled:'timeLimitEnabled', timeWindowEnabled:'timeWindowEnabled',
  dailyLimitEnabled:'dailyLimitEnabled',
  timeWeekdayFrom:'timeWeekdayFrom', timeWeekdayTo:'timeWeekdayTo',
  timeWeekendFrom:'timeWeekendFrom', timeWeekendTo:'timeWeekendTo',
  timeDailyMinutes:'timeDailyMinutes',
}
'''
(pathlib.Path('/tmp/parental_ext_test/store.mjs')).write_text(stub_store)
stub_stats = '''
export let TODAY = []
export function __set(v){ TODAY = v }
export async function dayRecords(){ return TODAY }
export function fmtDuration(sec){ return '' }
'''
(pathlib.Path('/tmp/parental_ext_test/stats.mjs')).write_text(stub_stats)

src = (ROOT / 'src/lib/parental.js').read_text()
src = src.replace("from './store.js'", "from '/tmp/parental_ext_test/store.mjs'")
src = src.replace("from './stats.js'", "from '/tmp/parental_ext_test/stats.mjs'")
src = src.replace("import('./stats.js')", "import('/tmp/parental_ext_test/stats.mjs')")
(pathlib.Path('/tmp/parental_ext_test/parental.mjs')).write_text(src)

test_js = r'''
import { dailyBonusSeconds, addDailyBonusMinutes, dailyQuota, playbackGate,
         playbackBlockedReason, withinTimeWindow } from '/tmp/parental_ext_test/parental.mjs'
import { store, CONFIG_KEYS } from '/tmp/parental_ext_test/store.mjs'
import { __set as setDay } from '/tmp/parental_ext_test/stats.mjs'

const results = []
const ok = (name, cond, extra='') => results.push([cond ? '✅' : '❌', name, extra])

// 基础：时长限制 30 分钟，已听 31 分钟 → 被拦
store.set(CONFIG_KEYS.dailyLimitEnabled, '1')
store.set(CONFIG_KEYS.timeDailyMinutes, '30')
store.set(CONFIG_KEYS.timeWindowEnabled, '0')
setDay([{ d:'x', b:'b', t:'t', s: Date.now(), sec: 31*60 }])
let g = await playbackGate()
ok('超时被拦 kind=quota', g.blocked && g.kind === 'quota', JSON.stringify(g))
ok('quota 拦截文案含「用完」', g.message.includes('用完'), g.message)
let old = await playbackBlockedReason()
ok('旧接口 playbackBlockedReason 文案不变', old === g.message, String(old))

// 加时 15 分钟 → 放行，剩余 ≈ 14 分钟
await addDailyBonusMinutes(15)
g = await playbackGate()
ok('加时 15 分钟后放行', !g.blocked, JSON.stringify(g))
let q = await dailyQuota()
ok('剩余时间 ≈ 14 分钟', Math.round(q.remainingSec/60) === 14, JSON.stringify(q))
ok('bonusSec = 900', q.bonusSec === 900, String(q.bonusSec))

// 加时是累加的：再加 30 → 余额 45 分钟
await addDailyBonusMinutes(30)
ok('余额累加到 45 分钟', (await dailyBonusSeconds()) === 45*60, String(await dailyBonusSeconds()))

// 非法输入：负数/小数/非数字都安全
await addDailyBonusMinutes(-5)
await addDailyBonusMinutes('abc')
ok('非法输入不改变余额', (await dailyBonusSeconds()) === 45*60, String(await dailyBonusSeconds()))

// 时段限制被拦时 kind=window（不可加时续）
store.set(CONFIG_KEYS.timeWindowEnabled, '1')
store.set(CONFIG_KEYS.timeWeekdayFrom, '18:00')
store.set(CONFIG_KEYS.timeWeekdayTo, '20:00')
const NOON = new Date(2026, 8, 16, 12, 0)   // 周三中午（窗外）
g = await playbackGate(NOON)
ok('时段外 kind=window', g.blocked && g.kind === 'window', JSON.stringify(g))
ok('时段外文案含「收听时间」', g.message.includes('收听时间'), g.message)

// 基础上限 0 = 不限（即使有加时余额）
store.set(CONFIG_KEYS.timeWindowEnabled, '0')
store.set(CONFIG_KEYS.timeWeekdayFrom, '')
store.set(CONFIG_KEYS.timeWeekendFrom, '')
store.set(CONFIG_KEYS.timeDailyMinutes, '0')
g = await playbackGate()
ok('基础上限 0 = 不限（有余额也不变）', !g.blocked, JSON.stringify(g))

// 关掉时长开关 = 不限
store.set(CONFIG_KEYS.dailyLimitEnabled, '0')
g = await playbackGate()
ok('开关关 = 不限', !g.blocked, JSON.stringify(g))

console.log(results.map(r => `  ${r[0]} ${r[1]}${r[2] ? '  ['+r[2]+']' : ''}`).join('\n'))
const bad = results.filter(r => r[0] === '❌').length
console.log(`EXTEND_RESULTS:${results.length - bad}/${results.length}`)
process.exit(bad ? 1 : 0)
'''
(pathlib.Path('/tmp/parental_ext_test/run.mjs')).write_text(test_js)
r = subprocess.run([os.environ.get('NODE', 'node'), '/tmp/parental_ext_test/run.mjs'],
                   capture_output=True, text=True, timeout=60)
print(r.stdout)
if r.returncode != 0:
    print('STDERR:', r.stderr[:800])
    fails.append('加时逻辑单测')

# ================= B/C. Playwright UI =================
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过 UI 部分：无 Playwright')
    if fails:
        print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
    print('✅ 逻辑部分全部通过'); sys.exit(0)

# 复用 audit-clickable-listeners 的 handler + PREFERENCES（假服务器，同一套 fixture）
import types
_AUD = ROOT / 'scripts' / 'audit-clickable-listeners.py'
mod = types.ModuleType('m')
exec(compile(_AUD.read_text().split('with sync_playwright')[0], str(_AUD), 'exec'), mod.__dict__)

PORT = 8899
BASE = f'http://127.0.0.1:{PORT}'

def poll(pg, cond_js, tries=30, wait=200):
    """轮询直到条件满足（固定等待在本地绿 CI 挂过三次 —— 一律轮询）。"""
    for _ in range(tries):
        pg.wait_for_timeout(wait)
        if pg.evaluate(f"() => !!({cond_js})"):
            return True
    return False


def today_key():
    import datetime
    return datetime.date.today().isoformat()

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))

    def routed(route):
        mod.handler(route)
    pg.route('**/api/**', routed); pg.route('**/rest/**', routed)
    pg.add_init_script(mod.ABS_PREFS)
    # 预置：家长密码 + 每日 30 分钟 + 已听 31 分钟（今天已超）
    pg.add_init_script(f"""
      localStorage.setItem('shelfaudio.dailyLimitEnabled','1');
      localStorage.setItem('shelfaudio.timeDailyMinutes','30');
      localStorage.setItem('shelfaudio.dailyBonusUsed','0');
    """)
    # 注入今天的收听记录（31 分钟，超过 30 分钟上限）
    pg.add_init_script("""
      (async () => {
        const recs = [{ d: new Date().toISOString().slice(0,10), b: 'absbook1', t: '示例故事甲', s: Date.now()-60000, sec: 31*60 }]
        localStorage.setItem('shelfaudio.listeningLog', JSON.stringify(recs))
      })()
    """)
    pg.goto(BASE + '/index.html')
    pg.wait_for_timeout(2600)

    print('=== B. 到点 → 播放键 → 加时 → 起播 ===')
    # 直接点首页第一本书（ABS 点书 = 续听）→ 被闸门拦。
    # 流程（与实现一致）：① 先弹「用完啦」提示 + 家长密码框 → ② 输对密码 →
    # ③ 才出现加时面板选分钟数 → ④ 确定落盘 → 继续起播。
    pg.evaluate("() => { document.querySelector('.book-card')?.click() }")
    for _ in range(30):
        pg.wait_for_timeout(200)
        if pg.evaluate("() => !document.querySelector('#lock')?.classList.contains('hidden')"):
            break
    ok('超时后点书弹出家长密码框', pg.evaluate(
        "() => !document.querySelector('#lock')?.classList.contains('hidden')"))
    ok('先给出「用完」提示（孩子知道为什么被拦）',
       '用完' in (pg.evaluate("() => document.querySelector('#toast')?.textContent") or ''),
       pg.evaluate("() => document.querySelector('#toast')?.textContent") or '')

    pg.fill('#lockPin', '1234')
    pg.evaluate("() => { document.querySelector('#lockOk').click() }")
    for _ in range(30):
        pg.wait_for_timeout(200)
        if pg.evaluate("() => !!document.querySelector('.lock .ext-grid')"):
            break
    ok('密码对了出现「家长加时」面板', pg.evaluate("() => !!document.querySelector('.lock .ext-grid')"))
    ok('面板有 15/30/60 三档', pg.evaluate(
        "() => [...document.querySelectorAll('.ext-grid [data-min]')].map(b => b.dataset.min).join(',')") == '15,30,60')
    ok('显示今日已听/上限', '已听' in (pg.evaluate("() => document.querySelector('#extUsed')?.textContent") or ''),
       pg.evaluate("() => document.querySelector('#extUsed')?.textContent") or '')
    pg.evaluate("() => { document.querySelector('.ext-grid [data-min=\"15\"]').click() }")
    pg.wait_for_timeout(200)
    ok('选中 15 分钟后确定钮可用', pg.evaluate(
        "() => !document.querySelector('#extOk')?.disabled"))
    pg.evaluate("() => { document.querySelector('#extOk').click() }")
    for _ in range(30):
        pg.wait_for_timeout(200)
        if pg.evaluate('document.body.dataset.view') == 'player':
            break
    ok('加时后起播成功进播放页', pg.evaluate('document.body.dataset.view') == 'player',
       pg.evaluate('document.body.dataset.view'))
    ok('加时余额落盘（15 分钟）',
       pg.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')") == '900',
       pg.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')"))
    ok('toast 提示已加 15 分钟', '15' in (pg.evaluate("() => document.querySelector('#toast')?.textContent") or ''),
       pg.evaluate("() => document.querySelector('#toast')?.textContent"))

    print('=== C. 取消加时 → 维持拦截 ===')
    # 第二个上下文：已超时 → 弹密码框 → 取消（不开锁）→ 维持拦截
    ctx2 = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg2 = ctx2.new_page()
    errs2 = []
    pg2.on('pageerror', lambda e: errs2.append(str(e)))
    pg2.route('**/api/**', routed); pg2.route('**/rest/**', routed)
    pg2.add_init_script(mod.ABS_PREFS)
    pg2.add_init_script("""
      localStorage.setItem('shelfaudio.dailyLimitEnabled','1');
      localStorage.setItem('shelfaudio.timeDailyMinutes','30');
      const recs = [{ d: new Date().toISOString().slice(0,10), b: 'absbook1', t: '示例故事甲', s: Date.now()-60000, sec: 31*60 }]
      localStorage.setItem('shelfaudio.listeningLog', JSON.stringify(recs))
    """)
    pg2.goto(BASE + '/index.html')
    pg2.wait_for_timeout(2600)
    pg2.evaluate("() => { document.querySelector('.book-card')?.click() }")
    for _ in range(30):
        pg2.wait_for_timeout(200)
        if pg2.evaluate("() => !document.querySelector('#lock')?.classList.contains('hidden')"):
            break
    ok('（第二次）弹家长密码框', pg2.evaluate(
        "() => !document.querySelector('#lock')?.classList.contains('hidden')"))
    pg2.evaluate("() => { document.querySelector('#lockCancel').click() }")
    pg2.wait_for_timeout(500)
    ok('取消密码后面板关闭', pg2.evaluate(
        "() => document.querySelector('#lock')?.classList.contains('hidden') ?? true"))
    ok('取消后未进播放页', pg2.evaluate('document.body.dataset.view') != 'player',
       pg2.evaluate('document.body.dataset.view'))
    ok('取消后有「用完」toast 提示', '用完' in (pg2.evaluate("() => document.querySelector('#toast')?.textContent") or ''),
       pg2.evaluate("() => document.querySelector('#toast')?.textContent"))
    ok('余额未被写入', not pg2.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')"),
       pg2.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')"))

    print('=== C2. 加时面板内点取消 → 也不加时 ===')
    ctx2b = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg2b = ctx2b.new_page()
    errs2b = []
    pg2b.on('pageerror', lambda e: errs2b.append(str(e)))
    pg2b.route('**/api/**', routed); pg2b.route('**/rest/**', routed)
    pg2b.add_init_script(mod.ABS_PREFS)
    pg2b.add_init_script("""
      localStorage.setItem('shelfaudio.dailyLimitEnabled','1');
      localStorage.setItem('shelfaudio.timeDailyMinutes','30');
      const recs = [{ d: new Date().toISOString().slice(0,10), b: 'absbook1', t: '示例故事甲', s: Date.now()-60000, sec: 31*60 }]
      localStorage.setItem('shelfaudio.listeningLog', JSON.stringify(recs))
    """)
    pg2b.goto(BASE + '/index.html')
    pg2b.wait_for_timeout(2600)
    pg2b.evaluate("() => { document.querySelector('.book-card')?.click() }")
    for _ in range(30):
        pg2b.wait_for_timeout(200)
        if pg2b.evaluate("() => !document.querySelector('#lock')?.classList.contains('hidden')"):
            break
    pg2b.fill('#lockPin', '1234')
    pg2b.evaluate("() => { document.querySelector('#lockOk').click() }")
    for _ in range(30):
        pg2b.wait_for_timeout(200)
        if pg2b.evaluate("() => !!document.querySelector('.lock .ext-grid')"):
            break
    ok('（C2）解锁后出现加时面板', pg2b.evaluate("() => !!document.querySelector('.lock .ext-grid')"))
    pg2b.evaluate("() => { document.querySelector('#extCancel').click() }")
    pg2b.wait_for_timeout(500)
    ok('面板内取消 → 不进播放页', pg2b.evaluate('document.body.dataset.view') != 'player',
       pg2b.evaluate('document.body.dataset.view'))
    ok('面板内取消 → 余额未写入', not pg2b.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')"),
       pg2b.evaluate(f"() => localStorage.getItem('shelfaudio.bonus-{today_key()}')"))

    print('=== D. 播放键 toggle 闸门（到点自停后点播放键也被拦）===')
    # 第三个上下文：已超时，不点书，直接点迷你条播放键 → toggle → gatedPlay → 拦 + 弹密码
    ctx3 = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg3 = ctx3.new_page()
    errs3 = []
    pg3.on('pageerror', lambda e: errs3.append(str(e)))
    pg3.route('**/api/**', routed); pg3.route('**/rest/**', routed)
    pg3.add_init_script(mod.ABS_PREFS)
    pg3.add_init_script("""
      localStorage.setItem('shelfaudio.dailyLimitEnabled','1');
      localStorage.setItem('shelfaudio.timeDailyMinutes','30');
      const recs = [{ d: new Date().toISOString().slice(0,10), b: 'absbook1', t: '示例故事甲', s: Date.now()-60000, sec: 50*60 }]
      localStorage.setItem('shelfaudio.listeningLog', JSON.stringify(recs))
    """)
    pg3.goto(BASE + '/index.html')
    pg3.wait_for_timeout(2600)
    # 不点书（不走 playItem 入口），直接点迷你条的播放键 → toggle → gatedPlay
    pg3.evaluate("() => { document.querySelector('#miniToggle').click() }")
    for _ in range(30):
        pg3.wait_for_timeout(200)
        if pg3.evaluate("() => !document.querySelector('#lock')?.classList.contains('hidden')"):
            break
    ok('迷你条播放键也触发家长锁（toggle 兜底闸门）', pg3.evaluate(
        "() => !document.querySelector('#lock')?.classList.contains('hidden')"))
    pg3.evaluate("() => { document.querySelector('#lockCancel').click() }")
    pg3.wait_for_timeout(400)
    ok('取消后仍在暂停（未起播）', pg3.evaluate(
        "() => window.__saPlayer?.playing === false || window.__saPlayer === null"),
       str(pg3.evaluate("() => window.__saPlayer?.playing")))

    ok('无 JS 报错', not (errs or errs2 or errs2b or errs3), str((errs + errs2 + errs2b + errs3)[:2]))

    print('=== E. 并发去重（到点轮询与孩子点播放键同时触发）===')
    ctx4 = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg4 = ctx4.new_page()
    errs4 = []
    pg4.on('pageerror', lambda e: errs4.append(str(e)))
    pg4.route('**/api/**', routed); pg4.route('**/rest/**', routed)
    pg4.add_init_script(mod.ABS_PREFS)
    pg4.add_init_script("""
      localStorage.setItem('shelfaudio.dailyLimitEnabled','1');
      localStorage.setItem('shelfaudio.timeDailyMinutes','30');
      const recs = [{ d: new Date().toISOString().slice(0,10), b: 'absbook1', t: '示例故事甲', s: Date.now()-60000, sec: 31*60 }]
      localStorage.setItem('shelfaudio.listeningLog', JSON.stringify(recs))
    """)
    pg4.goto(BASE + '/index.html')
    pg4.wait_for_timeout(2600)
    # 连点两次书（模拟「60s 轮询与孩子点播放键同时到达」）→ 只能弹一个密码框
    pg4.evaluate("() => { document.querySelector('.book-card')?.click() }")
    for _ in range(30):
        pg4.wait_for_timeout(200)
        if pg4.evaluate("() => !document.querySelector('#lock')?.classList.contains('hidden')"):
            break
    # 密码框开着时再点一次书（模拟「轮询和用户操作同时到达」）
    pg4.evaluate("() => { document.querySelector('.book-card')?.click() }")
    pg4.wait_for_timeout(400)
    ok('并发触发只出现一个家长锁（不叠加）', pg4.evaluate(
        "() => document.querySelectorAll('.lock:not(.hidden)').length") <= 1,
       str(pg4.evaluate("() => document.querySelectorAll('.lock').length")))
    pg4.fill('#lockPin', '1234')
    pg4.evaluate("() => { document.querySelector('#lockOk').click() }")
    for _ in range(30):
        pg4.wait_for_timeout(200)
        if pg4.evaluate("() => !!document.querySelector('.lock .ext-grid')"):
            break
    ok('（E）解锁后只出现一个加时面板', pg4.evaluate(
        "() => document.querySelectorAll('.ext-grid').length") == 1,
       str(pg4.evaluate("() => document.querySelectorAll('.ext-grid').length")))
    ok('（E）无 JS 报错', not errs4, str(errs4[:2]))
    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}')
    sys.exit(1)
print('✅ 全部通过')
