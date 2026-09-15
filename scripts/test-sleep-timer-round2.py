#!/usr/bin/env python3
"""第二轮审计（不同角度）：睡眠定时的状态机 + 监听器泄漏。

角度 1：设了定时后离开播放页（回书架）→ 到点仍要暂停（定时器不属于播放页）。
角度 2：定时生效后 ⋯ 菜单剩余归零、再设一次能正常覆盖。
角度 3：反复进出播放页 6 次 → window 上 sa:time 监听器数量不能累加（泄漏检查）。
角度 4：设「关闭定时」后立刻重设，不残留旧 deadline。
角度 5：ABS 的定时 chip 文本/行为与 ⋯ 菜单项一致（同一个 deadline）。
无 playwright 自动跳过（CI 兼容）。
"""
import json, re, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

ABS_BOOK = {'id':'absbook1','media':{'metadata':{'title':'ABS 有声书','authorName':'作者A'},'duration':3600}}

def handler(route):
    u = route.request.url; p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    if p == '/status': return route.fulfill(status=200, content_type='application/json', body='{"version":"2.36.0"}')
    if p == '/login': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'user':{'token':'t','username':'bin','type':'root'}}))
    if p == '/api/libraries': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'libraries':[{'id':'abslib','name':'有声书'}]}))
    if p.endswith('/items'): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'results':[ABS_BOOK]}))
    if p == '/api/me/items-in-progress': return route.fulfill(status=200, content_type='application/json', body='{"libraryItems":[]}')
    if p == '/api/me': return route.fulfill(status=200, content_type='application/json', body='{"username":"bin","mediaProgress":[]}')
    if p == '/api/collections': return route.fulfill(status=200, content_type='application/json', body='{"collections":[{"id":"col1","name":"常听","books":[ABS_BOOK]}]}')
    if p == '/api/items/absbook1': return route.fulfill(status=200, content_type='application/json', body=json.dumps({**ABS_BOOK, 'media':{**ABS_BOOK['media'], 'audioFiles':[{'ino':'f1','duration':3600}], 'chapters':[]}}))
    if p == '/api/items/absbook1/play': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'id':'sess1','duration':3600,'audioTracks':[{'index':1,'startOffset':0,'duration':3600,'contentUrl':'/api/items/absbook1/file/f1','title':'第一章'}]}))
    if p.startswith('/api/session/'): return route.fulfill(status=200, content_type='application/json', body='{}')
    return route.fulfill(status=200, content_type='application/json', body='{}')

ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

def newpage(br):
    ctx = br.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install()
    pg.route('**/api/**', handler)
    pg.add_init_script(ABS_PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs

def open_player(pg):
    for _ in range(3):
        pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
        if pg.evaluate("document.body.dataset.view") == 'player': return True
    return False

def set_sleep(pg, minutes):
    pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.sheet-item')].find(b=>b.textContent.includes('睡眠定时'))?.click()")
    pg.wait_for_timeout(400)
    pg.evaluate(f"[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='{minutes}')?.click()")
    pg.wait_for_timeout(400)

def count_sa_time_listeners(pg):
    """window 上 sa:time 的监听器数量（用 CDP getEventListeners）"""
    cl = pg.context.new_cdp_session(pg)
    ro = cl.send('Runtime.evaluate', {'expression': 'window', 'returnByValue': False})
    oid = ro['result']['objectId']
    l = cl.send('DOMGetEventListeners'.replace('DOMGet', 'DOMDebugger.get') or 'DOMDebugger.getEventListeners', {'objectId': oid})
    n = sum(1 for x in l.get('listeners', []) if x.get('type') == 'sa:time')
    cl.detach()
    return n

with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ---- 角度 1 + 2：离开播放页后定时仍生效；到点后状态归零、可重设 ----
    print('=== 角度 1/2：跨页面生效 + 到点归零 + 可重设 ===')
    ctx, pg, errs = newpage(br)
    ok('进了播放页', open_player(pg))
    set_sleep(pg, 30)
    ok('已设 30 分钟', int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") or 0) > 0)
    # 离开播放页（回书架）
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(800)
    ok('已离开播放页', pg.evaluate("document.body.dataset.view") != 'player', pg.evaluate("document.body.dataset.view"))
    # 快进到点
    pg.clock.fast_forward(31 * 60 * 1000); pg.wait_for_timeout(500)
    ok('在书架页也会到点触发（store 清零）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    # 再设一次能正常覆盖
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2000)
    if pg.evaluate("document.body.dataset.view") != 'player':
        open_player(pg)
    set_sleep(pg, 45)
    ok('可重设（45 分钟）', '已设定 45' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---- 角度 3：监听器泄漏 ----
    print('=== 角度 3：反复进出播放页 → sa:time 监听器不累加 ===')
    ctx, pg, errs = newpage(br)
    open_player(pg)
    set_sleep(pg, 15)
    n1 = count_sa_time_listeners(pg)
    for i in range(6):
        pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(500)
        open_player(pg)
    n2 = count_sa_time_listeners(pg)
    ok('sa:time 监听器数量不随进出播放页增长', n2 == n1, f'{n1} → {n2}')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---- 角度 4：关闭后立刻重设，不残留旧 deadline ----
    print('=== 角度 4：关闭 → 重设，无旧残留 ===')
    ctx, pg, errs = newpage(br)
    open_player(pg)
    set_sleep(pg, 15)
    a = int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')"))
    set_sleep(pg, 0)   # 关闭
    ok('关闭后 store = 0', pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0')
    set_sleep(pg, 60)
    b = int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')"))
    ok('重设后 deadline 是新值（比旧的晚）', b > a, f'{a} → {b}')
    # 旧的 15 分钟到点时不该触发（因为已被清除）
    pg.clock.fast_forward(16 * 60 * 1000); pg.wait_for_timeout(500)
    ok('旧 deadline 不触发（60 分钟仍在）',
       int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") or 0) > 0,
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    # 再快进到 60 分钟总点
    pg.clock.fast_forward(45 * 60 * 1000); pg.wait_for_timeout(500)
    ok('新 deadline 到点触发', pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---- 角度 5：chip 与 ⋯ 菜单同一个 deadline ----
    print('=== 角度 5：chip 与 ⋯ 菜单一致 ===')
    ctx, pg, errs = newpage(br)
    open_player(pg)
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='45')?.click()")
    pg.wait_for_timeout(400)
    d1 = int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')"))
    pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(400)
    labels = pg.evaluate("[...document.querySelectorAll('.sheet-item .sheet-label')].map(e=>e.textContent)")
    ok('⋯ 菜单显示剩余 ≈45 分钟', any('44' in (l or '') or '45' in (l or '') or '剩余' in (l or '') for l in labels), str(labels))
    ok('deadline 未被菜单打开动作改动',
       int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")) == d1)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
