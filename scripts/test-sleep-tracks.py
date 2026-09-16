#!/usr/bin/env python3
"""按章节/歌曲定时 + 自定义时间 + 首页随机排序（老板 2026-09-16，真浏览器）。

  1. 播放页「定时」chip → 弹窗两个 tab（时间 / 按集数|首数）
  2. 按章节定时：选「听 2 集」→ store 持久化 + chip 显示剩余集数
  3. 模拟本集播完（complete）→ 剩余递减；到 0 时暂停且不推进下一集
  4. 自定义分钟：输入非法给提示；合法生效
  5. 进度条下方显示「还剩 X · N%」
  6. 首页随机排序：同一会话内两次渲染顺序一致；刷新后（模拟冷启动）重新洗牌
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

ABS_BOOK = {'id':'absbook1','media':{'metadata':{'title':'ABS 有声书','authorName':'作者A'},'duration':600}}
# 多本书用于随机排序验证
BOOKS = [{'id':f'absbook{i}','media':{'metadata':{'title':f'书{i}','authorName':'作者'},'duration':600}} for i in range(6)]
ND_ALBUM = {'id':'ndalb1','name':'ND 测试专辑','artist':'歌手N','songCount':3,'duration':300,'coverArt':'c1'}
ND_SONGS = [
  {'id':'nds1','albumId':'ndalb1','title':'第一首歌','artist':'歌手N','duration':100,'track':1,'contentType':'audio/mpeg'},
  {'id':'nds2','albumId':'ndalb1','title':'第二首歌','artist':'歌手N','duration':100,'track':2,'contentType':'audio/mpeg'},
  {'id':'nds3','albumId':'ndalb1','title':'第三首歌','artist':'歌手N','duration':100,'track':3,'contentType':'audio/mpeg'},
]

def mk_handler(books):
    def handler(route):
        u = route.request.url; p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
        if p == '/status': return route.fulfill(status=200, content_type='application/json', body='{"version":"2.36.0"}')
        if p == '/login': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'user':{'token':'t','username':'bin','type':'root'}}))
        if p == '/api/libraries': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'libraries':[{'id':'abslib','name':'有声书'}]}))
        if p.endswith('/items'): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'results':books}))
        if p == '/api/me/items-in-progress': return route.fulfill(status=200, content_type='application/json', body='{"libraryItems":[]}')
        if p == '/api/me': return route.fulfill(status=200, content_type='application/json', body='{"username":"bin","mediaProgress":[]}')
        if p == '/api/collections': return route.fulfill(status=200, content_type='application/json', body='{"collections":[]}')
        if re.fullmatch(r'/api/items/absbook\d+', p):
            bid = p.rsplit('/',1)[1]
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({**ABS_BOOK,'id':bid,'media':{**ABS_BOOK['media'],'audioFiles':[{'ino':'f1','duration':600}],'chapters':[{'id':0,'start':0,'end':300,'title':'第一章'},{'id':1,'start':300,'end':600,'title':'第二章'}]}}))
        if re.fullmatch(r'/api/items/absbook\d+/play', p):
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'id':'sess1','duration':600,'audioTracks':[
                {'index':1,'startOffset':0,'duration':300,'contentUrl':'/api/items/absbook1/file/f1','title':'第一章'},
                {'index':2,'startOffset':300,'duration':300,'contentUrl':'/api/items/absbook1/file/f1','title':'第二章'}]}))
        if p == '/api/session/sess1/sync': return route.fulfill(status=200, content_type='application/json', body='{}')
        if p == '/api/session/sess1/close': return route.fulfill(status=200, content_type='application/json', body='{}')
        if '/rest/' in p:
            def nd(b): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'subsonic-response':{'status':'ok','version':'1.16.1', **b}}))
            if p == '/rest/getMusicFolders': return nd({'musicFolders':{'musicFolder':[{'id':'ndlib','name':'音乐'}]}})
            if p == '/rest/getAlbumList2': return nd({'albumList2':{'album':[ND_ALBUM]}})
            if p == '/rest/getAlbum': return nd({'album':{**ND_ALBUM,'song':ND_SONGS}})
            if p == '/rest/getStarred2': return nd({'starred2':{'album':[]}})
            if p == '/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
            return nd({})
        return route.fulfill(status=200, content_type='application/json', body='{}')
    return handler

ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""
ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""

def newpage(br, prefs, handler):
    ctx = br.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs

def open_player(pg):
    for _ in range(3):
        pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
        if pg.evaluate("document.body.dataset.view") == 'player': return True
    return False

with sync_playwright() as pw:
    br = pw.chromium.launch()
    handler = mk_handler(BOOKS)

    # ---------- 1. 弹窗两个 tab ----------
    print('=== 1. 睡眠弹窗：时间 / 按集数 两个 tab ===')
    ctx, pg, errs = newpage(br, ABS_PREFS, handler)
    ok('进了播放页', open_player(pg))
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    ok('弹窗打开', pg.evaluate("!!document.querySelector('.sleep-tabs')"))
    ok('默认在「时间」tab', pg.evaluate("document.querySelector('.sleep-pane[data-pane=\"time\"]').hidden") == False)
    ok('有「按集数」tab（ABS 用「集」）', '按集数' in (pg.evaluate("document.body.innerHTML") or ''), '')
    pg.evaluate("[...document.querySelectorAll('.sleep-tab')].find(b=>b.dataset.tab==='tracks')?.click()")
    pg.wait_for_timeout(300)
    ok('切到按集数 tab', pg.evaluate("document.querySelector('.sleep-pane[data-pane=\"tracks\"]').hidden") == False)
    ok('时间 pane 被藏起', pg.evaluate("document.querySelector('.sleep-pane[data-pane=\"time\"]').hidden") == True)
    ok('有 4 个集数预设（1/3/5/10）', pg.evaluate("document.querySelectorAll('.sleep-pane[data-pane=\"tracks\"] [data-n]').length") == 4)
    # 输入只留数字
    pg.fill('#sleepTrackInput', '3a8b')
    ok('自定义输入只留数字', pg.input_value('#sleepTrackInput') == '38', pg.input_value('#sleepTrackInput'))

    # ---------- 2. 按章节定时生效 ----------
    print('=== 2. 按章节定时：听 2 集后暂停 ===')
    pg.fill('#sleepTrackInput', '2')
    pg.evaluate("document.querySelector('#sleepTrackGo')?.click()"); pg.wait_for_timeout(400)
    toast = pg.evaluate("document.querySelector('#toast')?.textContent || ''")
    ok('设定 toast 确认（听完这 2 集后暂停）', '听完这 2 集后暂停' == toast, toast)
    saved = pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')")
    ok('sleepTracks 已持久化', saved == '2', str(saved))
    chip = pg.evaluate("document.querySelector('#sleepLabel')?.textContent || ''")
    ok('chip 显示剩余（含集数后缀）', '2' in chip and '集' in chip, chip)

    # ---------- 3. 本集播完 → 递减；到点 → 暂停不推进 ----------
    print('=== 3. 本集播完：递减；到点暂停不推进 ===')
    # 第一次 complete（assetId 校验：当前是 sa-0）
    pg.evaluate("window.__saPlayer && window.__saPlayer._onTrackEnd({ assetId: 'sa-0' })")
    pg.wait_for_timeout(500)
    ok('第 1 集播完不暂停、自动进入第 2 集（剩 1 集）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '1',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')")))
    ok('还在播（未到点不断声）', pg.evaluate("window.__saPlayer?.playing") == True)
    chip = pg.evaluate("document.querySelector('#sleepLabel')?.textContent || ''")
    ok('chip 剩余变成 1 集', '1' in chip, chip)
    # 第二次 complete → 到点
    pg.evaluate("window.__saPlayer && window.__saPlayer._onTrackEnd({ assetId: 'sa-1' })")
    pg.wait_for_timeout(500)
    ok('第 2 集播完到点：store 清零',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')")))
    ok('到点后真的暂停（playing=false）', pg.evaluate("window.__saPlayer?.playing") == False)
    ok('到点后停在末集（没有推进/不存在第 3 集）', pg.evaluate("window.__saPlayer?.trackIndex") == 1,
       str(pg.evaluate("window.__saPlayer?.trackIndex")))
    toast = pg.evaluate("document.querySelector('#toast')?.textContent || ''")
    ok('到点弹了暂停提示', '睡眠定时到' in toast, toast)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 3b. 整本听完 → 章节计数静默清零（不带去下一本书）----------
    print('=== 3b. 整本播完清计数 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS, handler)
    open_player(pg)
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.sleep-tab')].find(b=>b.dataset.tab==='tracks')?.click()")
    pg.wait_for_timeout(250)
    pg.evaluate("[...document.querySelectorAll('[data-n]')].find(b=>b.dataset.n==='5')?.click()")
    pg.wait_for_timeout(400)
    ok('已设 5 集', pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '5')
    # 末集 complete → onBookEnd 清计数（此时不该弹「睡眠定时到」，书是自然听完的）
    # fixture 是 2 章（各 300s），先跳到第 2 章（末集）再 complete
    ok('fixture 是 2 章', pg.evaluate("window.__saPlayer?.tracks.length") == 2,
       str(pg.evaluate("window.__saPlayer?.tracks.length")))
    pg.evaluate("window.__saPlayer.seek(300)"); pg.wait_for_timeout(800)
    ok('已跳到末集（下标 1）', pg.evaluate("window.__saPlayer?.trackIndex") == 1,
       str(pg.evaluate("window.__saPlayer?.trackIndex")))
    pg.evaluate("window.__saPlayer && window.__saPlayer._onTrackEnd({ assetId: 'sa-1' })")
    pg.wait_for_timeout(500)
    ok('整本播完后 sleepTracks 清零（不带去下一本书）',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '0',
       str(pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')")))
    toast = pg.evaluate("document.querySelector('#toast')?.textContent || ''")
    ok('整本播完不弹「睡眠定时到」（书是自然听完的）', '睡眠定时到' not in toast, toast)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 4. 自定义分钟（时间 tab）----------
    print('=== 4. 自定义分钟 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS, handler)
    open_player(pg)
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    # 非法输入 → 明确提示，不静默
    pg.fill('#sleepMinInput', '99999')
    pg.evaluate("document.querySelector('#sleepMinGo')?.click()"); pg.wait_for_timeout(400)
    ok('超上限给出提示（不静默失败）', '1440' in (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    ok('弹窗仍开着（没关）', pg.evaluate("!!document.querySelector('.sleep-tabs')"))
    # 合法输入
    pg.fill('#sleepMinInput', '7')
    pg.evaluate("document.querySelector('#sleepMinGo')?.click()"); pg.wait_for_timeout(400)
    ok('自定义 7 分钟生效', '已设定 7 分钟后暂停' == (pg.evaluate("document.querySelector('#toast')?.textContent || ''")),
       str(pg.evaluate("document.querySelector('#toast')?.textContent")))
    at = int(pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") or 0)
    ok('deadline = 现在+7分钟', 6.8 * 60 * 1000 < at - __import__('time').time() * 1000 <= 7.05 * 60 * 1000,
       str(at))
    # 「关闭定时」按钮（data-m=0）
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    pg.evaluate("[...document.querySelectorAll('.lock-card [data-m]')].find(b=>b.dataset.m==='0')?.click()")
    pg.wait_for_timeout(300)
    ok('「关闭定时」清掉全部定时',
       pg.evaluate("localStorage.getItem('shelfaudio.sleepAt')") == '0'
       and pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '0')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 5. ND 术语：按「首」数 ----------
    print('=== 5. ND：按「首」数 + 术语 ===')
    ctx, pg, errs = newpage(br, ND_PREFS, handler)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
    pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
    ok('ND 进播放页', pg.evaluate("document.body.dataset.view") == 'player')
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    ok('ND tab 叫「按首数」',
       pg.evaluate("[...document.querySelectorAll('.sleep-tab')].some(b=>b.textContent==='按首数')"),
       str(pg.evaluate("[...document.querySelectorAll('.sleep-tab')].map(b=>b.textContent)")))
    pg.evaluate("[...document.querySelectorAll('.sleep-tab')].find(b=>b.dataset.tab==='tracks')?.click()")
    pg.wait_for_timeout(300)
    ok('ND 预设按钮写「听 N 首」', '首' in (pg.evaluate("[...document.querySelectorAll('[data-n]')][0]?.textContent || ''")),
       str(pg.evaluate("[...document.querySelectorAll('[data-n]')].map(b=>b.textContent)")))
    pg.evaluate("[...document.querySelectorAll('[data-n]')].find(b=>b.dataset.n==='3')?.click()")
    pg.wait_for_timeout(400)
    ok('ND 设 3 首生效', pg.evaluate("localStorage.getItem('shelfaudio.sleepTracks')") == '3')
    chip = pg.evaluate("document.querySelector('#sleepLabel')?.textContent || ''")
    ok('ND chip 显示「首」', '首' in chip, chip)
    ok('ND 不显示整部作品剩余行（老板 2026-09-16）',
       pg.evaluate("document.querySelector('#pWhole')?.style.display") == 'none',
       str(pg.evaluate("document.querySelector('#pWhole')?.style.display")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 6. 进度条下整部作品剩余 ----------
    print('=== 6. 进度条下方「还剩 X · N%」===')
    ctx, pg, errs = newpage(br, ABS_PREFS, handler)
    open_player(pg)
    pg.wait_for_timeout(600)
    whole = pg.evaluate("document.querySelector('#pWhole')?.textContent || ''")
    ok('显示剩余+百分比', '还剩' in whole and '%' in whole, whole)
    # 播放位置前进（模拟听了 300 秒 = 一半）
    pg.evaluate("window.__saPlayer.currentBookTime = 300; window.dispatchEvent(new CustomEvent('sa:time', { detail: { currentTime: 300, duration: 600, trackIndex: 1 } }))")
    pg.wait_for_timeout(400)
    whole = pg.evaluate("document.querySelector('#pWhole')?.textContent || ''")
    ok('位置前进后剩余减少（剩余时长 5 分钟 + 剩余百分比 50%）',
       '还剩' in whole and '5 分钟' in whole and '50%' in whole, whole)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 7. 首页随机排序 ----------
    print('=== 7. 首页随机排序（冷启动洗一次，会话内固定）===')
    ctx, pg, errs = newpage(br, ABS_PREFS, handler)
    pg.wait_for_timeout(400)
    def ids(pg):
        return pg.evaluate("[...document.querySelectorAll('.shelf-grid .book-card')].map(e=>e.dataset.id)")
    first = ids(pg)
    ok('首页有 6 张卡', len(first) == 6, str(first))
    # 回书架（导航往返）→ 顺序不变
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(800)
    second = ids(pg)
    ok('往返播放页后顺序不变（会话内固定）', first == second, f'{first} vs {second}')
    # 切到搜索再回来 → 顺序也不变
    pg.evaluate("[...document.querySelectorAll('.kid-tab')].find(b=>b.dataset.tab==='search')?.click()")
    pg.wait_for_timeout(600)
    pg.evaluate("[...document.querySelectorAll('.kid-tab')].find(b=>b.dataset.tab==='kidhome')?.click()")
    pg.wait_for_timeout(800)
    third = ids(pg)
    ok('切页签回来顺序也不变', first == third, f'{first} vs {third}')
    # 刷新 = 冷启动 → 允许重新洗牌（只验证刷新后仍渲染 6 张，顺序可能不同也可能相同——概率问题不断言不同）
    pg.reload(); pg.wait_for_timeout(2400)
    fourth = ids(pg)
    ok('刷新后卡片渲染正常（数量一致）', sorted(fourth) == sorted(first), f'{fourth}')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
