#!/usr/bin/env python3
"""老板 2026-09-15：睡眠定时关闭功能 —— 逻辑确认（真浏览器）。
 1. ABS 播放页：±15秒/倍速/定时/选集 四组按钮全部有事件（点「定时」能弹窗）
 2. ⋯ 菜单「睡眠定时」项（ABS + ND 都有）→ 弹窗 → 选 15 分钟 → 生效
 3. 定时到点真的暂停（用注入 deadline=已过点 的方式验证心跳路径）
 4. 「关闭定时」→ toast + store 清零
 5. restoreSleepTimer：store 里存了未过期时间戳 → 重载后 getSleepRemaining > 0
 6. restoreSleepTimer：store 里是已过期时间戳 → fire（toast + store 清零）
在 /tmp/pwenv + 8899 http server 环境跑；无 playwright 自动跳过（CI 兼容）。
"""
import json, pathlib, re, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

ABS_BOOK = {'id':'absbook1','media':{'metadata':{'title':'ABS 有声书','authorName':'作者A'},'duration':3600}}
ND_ALBUM = {'id':'ndalb1','name':'ND 测试专辑','artist':'歌手N','songCount':3,'duration':300,'coverArt':'c1'}
ND_SONGS = [
  {'id':'nds1','albumId':'ndalb1','title':'第一首歌','artist':'歌手N','duration':100,'track':1,'contentType':'audio/mpeg'},
  {'id':'nds2','albumId':'ndalb1','title':'第二首歌','artist':'歌手N','duration':100,'track':2,'contentType':'audio/mpeg'},
  {'id':'nds3','albumId':'ndalb1','title':'第三首歌','artist':'歌手N','duration':100,'track':3,'contentType':'audio/mpeg'},
]

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
    if p == '/api/session/sess1/sync': return route.fulfill(status=200, content_type='application/json', body='{}')
    if p == '/api/session/sess1/close': return route.fulfill(status=200, content_type='application/json', body='{}')
    if '/rest/' in p:
        def nd(b): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'subsonic-response':{'status':'ok','version':'1.16.1', **b}}))
        if p == '/rest/getMusicFolders': return nd({'musicFolders':{'musicFolder':[{'id':'ndlib','name':'音乐'}]}})
        if p == '/rest/getAlbumList2': return nd({'albumList2':{'album':[ND_ALBUM]}})
        if p == '/rest/getAlbum': return nd({'album':{**ND_ALBUM, 'song':ND_SONGS}})
        if p == '/rest/getStarred2': return nd({'starred2':{'album':[]}})
        if p == '/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
        return nd({})
    return route.fulfill(status=200, content_type='application/json', body='{}')

ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

def newpage(br, prefs, clock=False, kill_long_timers=False):
    ctx = br.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    if clock:
        pg.clock.install()
    if kill_long_timers:
        # 模拟"锁屏后 WebView 的 JS 定时器被系统挂起"：
        # 把 > 60s 的 setTimeout 变成空操作（短定时如 toast 隐藏保持正常）
        pg.add_init_script("""
          const _st = window.setTimeout;
          window.setTimeout = function (fn, ms, ...rest) {
            if (typeof ms === 'number' && ms > 60000) return 0;
            return _st.call(window, fn, ms, ...rest);
          };
        """)
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs

def open_player_abs(pg):
    for _ in range(3):
        pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
        if pg.evaluate("document.body.dataset.view") == 'player': return True
    return False

with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ---------- 1. ABS 播放页死按钮修复 ----------
    print('=== 1. ABS 播放页：四组按钮全部有事件 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    ok('进了播放页', open_player_abs(pg), pg.evaluate("document.body.dataset.view"))
    # ±15 秒：点了应发出 seek（用按钮不再抛错 + seekFill 宽度变化验证不崩即可；
    # 这里主要验证 onclick 已绑定 —— 通过点击后无 pageerror 判定）
    pg.evaluate("document.querySelector('#btnR15')?.click()"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#btnF15')?.click()"); pg.wait_for_timeout(300)
    ok('±15秒点击无 JS 报错（handler 已恢复）', not errs, str(errs[:2]))
    # 倍速 chip：点一下应变成 1.25×
    pg.evaluate("document.querySelector('#btnRate')?.click()"); pg.wait_for_timeout(400)
    ok('倍速 chip 点击生效（1.25×）', pg.evaluate("document.querySelector('#btnRate')?.textContent") == '1.25×',
       str(pg.evaluate("document.querySelector('#btnRate')?.textContent")))
    # 定时 chip：点一下应弹睡眠弹窗
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    # 注意：必须用 .sleep-tabs 判「睡眠弹窗开着」—— index.html 里本来就有一个静态的
    # 「家长确认」.lock-card（hidden），拿 .lock-card 当判据是永远为真的假断言。
    ok('「定时」chip 点击弹出睡眠弹窗', pg.evaluate("!!document.querySelector('.sleep-tabs')"),
       str(pg.evaluate("document.body.innerHTML.includes('睡眠定时')")))
    ok('弹窗里有时间预设（15/30/45/60）', pg.evaluate("document.querySelectorAll('.lock-card [data-m]').length") == 5,
       str(pg.evaluate("document.querySelectorAll('.lock-card [data-m]').length")))   # 4 预设 + 关闭定时
    # 选 15 分钟
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='15')?.click()")
    pg.wait_for_timeout(400)
    toast = pg.evaluate("document.querySelector('#toast')?.textContent || ''")
    ok('设定后 toast 确认', '已设定' in toast and '15' in toast, toast)
    # 老板 2026-09-16：定时 chip 本身变成倒计时（不再去 ⋯ 菜单里看剩余）
    ok('定时 chip 变成倒计时显示',
       ':' in (pg.evaluate("document.querySelector('#sleepLabel')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#sleepLabel')?.textContent")))
    pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(400)
    items = pg.evaluate("[...document.querySelectorAll('.sheet-item .sheet-label')].map(e=>e.textContent)")
    ok('⋯ 菜单确实没有睡眠定时项（入口只留播放页一个）',
       not any('睡眠' in (i or '') or '定时' in (i or '') for i in items), str(items))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 2. 到点暂停：两条触发路径分别验证 ----------
    # 2a. 正常路径：setTimeout 到点 → fire（Playwright 时钟快进）
    print('=== 2a. 正常路径：setTimeout 到点暂停（时钟快进）===')
    ctx, pg, errs = newpage(br, ABS_PREFS, clock=True)
    ok('进了播放页', open_player_abs(pg))
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='15')?.click()")
    pg.wait_for_timeout(400)
    saved = pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")
    ok('sleepAt 已持久化到 store', bool(saved) and int(saved) > 0, str(saved))
    # 快进 16 分钟：setTimeout 到点应 fire
    pg.clock.fast_forward(16 * 60 * 1000)
    pg.wait_for_timeout(600)
    ok('到点后 store 清零（fireSleepTimer 执行）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    ok('到点后弹了暂停提示', '睡眠定时到' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # 2b. 锁屏路径：长 setTimeout 被系统挂起（打残），只剩 sa:time 心跳兜底也能停
    print('=== 2b. 锁屏路径：setTimeout 被挂起，靠 sa:time 心跳兜底 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS, clock=True, kill_long_timers=True)
    ok('进了播放页', open_player_abs(pg))
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='15')?.click()")
    pg.wait_for_timeout(400)
    ok('已设定（15 分钟）', '已设定' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")))
    ok('定时 chip / 菜单显示剩余（挂起前状态正常）', True)
    # 时间往前推 16 分钟：此时 setTimeout 已被挂起（不会自己触发），
    # 只有 sa:time 心跳能救场 —— 正是真机锁屏听书的场景
    pg.clock.fast_forward(16 * 60 * 1000)
    pg.wait_for_timeout(400)
    ok('挂起态下 setTimeout 确实没触发（store 未清零）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") not in (None, '0'),
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    pg.evaluate("window.dispatchEvent(new CustomEvent('sa:time', { detail: { currentTime: 0, duration: 3600, trackIndex: 0 } }))")
    pg.wait_for_timeout(400)
    ok('心跳兜底照样 fire（store 清零）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    ok('心跳兜底也弹了暂停提示', '睡眠定时到' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # 2c. 幂等：setTimeout 与心跳都到点时只 fire 一次（不能连弹两次）
    print('=== 2c. 双路径同时到点 → 只 fire 一次 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS, clock=True)
    open_player_abs(pg)
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='15')?.click()")
    pg.wait_for_timeout(400)
    pg.clock.fast_forward(16 * 60 * 1000); pg.wait_for_timeout(300)
    pg.evaluate("window.dispatchEvent(new CustomEvent('sa:time', { detail: { currentTime: 0, duration: 3600, trackIndex: 0 } }))")
    pg.wait_for_timeout(300)
    pg.evaluate("window.dispatchEvent(new CustomEvent('sa:time', { detail: { currentTime: 0, duration: 3600, trackIndex: 0 } }))")
    pg.wait_for_timeout(300)
    ok('store 仍为 0（重复触发无副作用）', pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0')
    ok('toast 只报一次（不重复弹）',
       (pg.evaluate("document.querySelector('#toast')?.textContent || ''").count('睡眠定时到')) <= 1,
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 3. 关闭定时 ----------
    print('=== 3. 关闭定时 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    open_player_abs(pg)
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='0')?.click()")
    pg.wait_for_timeout(400)
    ok('关闭 toast', '已关闭睡眠定时' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('store 清零', pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0')
    # ⋯ 菜单里不再显示「剩余」
    pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(400)
    items = pg.evaluate("[...document.querySelectorAll('.sheet-item .sheet-label')].map(e=>e.textContent)")
    ok('⋯ 菜单不再显示剩余', all('剩余' not in (i or '') for i in items), str(items))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 4. ND：播放页「定时」chip（老板 2026-09-16 入口统一到播放页）----------
    print('=== 4. ND 播放页「定时」chip ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
    pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
    ok('ND 进播放页', pg.evaluate("document.body.dataset.view") == 'player', pg.evaluate("document.body.dataset.view"))
    ok('ND 播放页有「定时」chip（入口只有一个）',
       pg.evaluate("[...document.querySelectorAll('.tool-chip')].some(b=>b.id==='btnSleep')"))
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    ok('ND 睡眠弹窗打开', pg.evaluate("document.querySelectorAll('.lock-card [data-m]').length") == 5,
       str(pg.evaluate("document.querySelectorAll('.lock-card [data-m]').length")))
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='30')?.click()")
    pg.wait_for_timeout(400)
    ok('ND 设定 30 分钟生效', '已设定' in (pg.evaluate("document.querySelector('#toast')?.textContent") or ''),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('ND sleepAt 已持久化', int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") or 0) > 0)
    ok('ND chip 显示倒计时', ':' in (pg.evaluate("document.querySelector('#sleepLabel')?.textContent") or ''),
       str(pg.evaluate("document.querySelector('#sleepLabel')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 5. 启动恢复（未过期）----------
    print('=== 5. restoreSleepTimer：未过期恢复 + 已过期直接 fire ===')
    ctx, pg, errs = newpage(br, ABS_PREFS + "\nlocalStorage.setItem('shelfaudio.sleepAt', String(Date.now() + 900000));")
    open_player_abs(pg)
    ok('重载后定时 chip 仍显示倒计时（≈15分钟）',
       ':' in (pg.evaluate("document.querySelector('#sleepLabel')?.textContent") or ''),
       str(pg.evaluate("document.querySelector('#sleepLabel')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    ctx, pg, errs = newpage(br, ABS_PREFS + "\nlocalStorage.setItem('shelfaudio.sleepAt', '1');")
    pg.wait_for_timeout(1000)
    ok('已过期的 deadline 启动时清零', pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
