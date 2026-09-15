#!/usr/bin/env python3
"""CDP 监听器审计 v2：对每个页面里全部可见可点元素，用 DOMDebugger.getEventListeners
真实查询监听器（.onclick= / addEventListener / 祖先委托都算），报出「可见、可点、
却没有任何监听器」的死按钮。

v1 的教训（重要）：v1 没断言「确实到达了目标视图」，播放页压根没打开 → 死按钮不在
DOM 里 → 假通过。v2 每个场景先断言视图/元素数量，**检查数为 0 直接判失败**。

0.8.0 的 bug（模板有按钮、handler 被删）在这里必然现形 —— 已验证：
对修复前的 dist 运行会精确报出 btnR15/btnF15/btnSleep。
"""
import json, pathlib, re, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8899/index.html'
SELS = ('button, [role="button"], .book-card, .list-item, .tool-chip, .sheet-item, '
        '.entry-btn, .day-arrow, .cal-cell, .chapter-item, .book-grid > *')

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
    if p.startswith('/api/session/'): return route.fulfill(status=200, content_type='application/json', body='{}')
    if p == '/api/items/absbook1/cover': return route.fulfill(status=200, content_type='image/png', body=b'\x89PNG\r\n\x1a\n')
    if '/rest/' in p:
        def nd(b): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'subsonic-response':{'status':'ok','version':'1.16.1', **b}}))
        if p == '/rest/getMusicFolders': return nd({'musicFolders':{'musicFolder':[{'id':'ndlib','name':'音乐'}]}})
        if p == '/rest/getAlbumList2': return nd({'albumList2':{'album':[ND_ALBUM]}})
        if p == '/rest/getAlbum': return nd({'album':{**ND_ALBUM, 'song':ND_SONGS}})
        if p == '/rest/getStarred2': return nd({'starred2':{'album':[]}})
        if p == '/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
        if p == '/rest/getPlaylists': return nd({'playlists':{'playlist':[]}})
        return nd({})
    return route.fulfill(status=200, content_type='application/json', body='{}')

ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

def audit_view(pg, client, name):
    infos = pg.evaluate("""(sels) => [...document.querySelectorAll(sels)]
      .map((e, i) => ({ i, tag: e.tagName, id: e.id || '',
          cls: (e.className || '').toString().slice(0, 45),
          text: (e.textContent || '').trim().slice(0, 16),
          aria: e.getAttribute('aria-label') || '',
          vis: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) }))
      .filter(x => x.vis)""", SELS)
    dead = []
    for it in infos:
        ro = client.send('Runtime.evaluate', {
            'expression': f'document.querySelectorAll({json.dumps(SELS)})[{it["i"]}]',
            'returnByValue': False})
        oid = ro.get('result', {}).get('objectId')
        if not oid:
            continue
        try:
            lst = client.send('DOMDebugger.getEventListeners', {'objectId': oid})
        except Exception:
            continue
        if [l for l in lst.get('listeners', []) if l.get('type') in ('click', 'pointerup', 'touchend', 'mousedown', 'pointerdown')]:
            continue
        # 祖先委托（最多 6 层）
        delegated = False
        for k in range(1, 7):
            aro = client.send('Runtime.evaluate', {
                'expression': f'''(() => {{ let n = document.querySelectorAll({json.dumps(SELS)})[{it["i"]}];
                    for (let j = 0; j < {k}; j++) n = n?.parentElement;
                    return (n && n !== document.body && n !== document.documentElement) ? n : null }})()''',
                'returnByValue': False})
            aoid = aro.get('result', {}).get('objectId')
            if not aoid:
                break
            try:
                al = client.send('DOMDebugger.getEventListeners', {'objectId': aoid})
            except Exception:
                continue
            if any(l.get('type') == 'click' for l in al.get('listeners', [])):
                delegated = True
                break
        if not delegated:
            dead.append(it)
    return infos, dead

fails = []
with sync_playwright() as pw:
    br = pw.chromium.launch()
    for name, prefs, nd in [('ABS', ABS_PREFS, False), ('ND', ND_PREFS, True)]:
        ctx = br.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page()
        pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
        pg.add_init_script(prefs)
        pg.goto(BASE); pg.wait_for_timeout(2400)
        client = pg.context.new_cdp_session(pg)

        did = 0
        # 书架
        infos, dead = audit_view(pg, client, f'{name}/书架')
        print(f'  [{name}/书架] 检查 {len(infos)} 个可点元素')
        did += len(infos)
        fails += [(name, 'shelf', d) for d in dead]

        # 播放页
        for _ in range(3):
            pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
            if pg.evaluate("document.body.dataset.view") == 'player':
                break
            if nd and pg.evaluate("document.body.dataset.view") == 'album':
                pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
                break
        view = pg.evaluate("document.body.dataset.view")
        if view != 'player':
            print(f'  ❌ [{name}] 没能进入播放页（view={view}）—— 审计无意义')
            fails.append((name, 'player', {'tag': 'N/A', 'id': '', 'cls': '', 'text': f'未进播放页 view={view}', 'aria': ''}))
        else:
            infos, dead = audit_view(pg, client, f'{name}/播放页')
            print(f'  [{name}/播放页] 检查 {len(infos)} 个可点元素')
            did += len(infos)
            fails += [(name, 'player', d) for d in dead]
            # ⋯ 菜单展开后也要查
            pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(600)
            if pg.evaluate("!!document.querySelector('.sheet-item')"):
                infos, dead = audit_view(pg, client, f'{name}/⋯菜单')
                print(f'  [{name}/⋯菜单] 检查 {len(infos)} 个可点元素')
                did += len(infos)
                fails += [(name, 'sheet', d) for d in dead]
            else:
                fails.append((name, 'sheet', {'tag': 'N/A', 'id': '', 'cls': '', 'text': '⋯菜单没打开', 'aria': ''}))
        if did == 0:
            fails.append((name, '-', {'tag': 'N/A', 'id': '', 'cls': '', 'text': '检查数为 0（假通过）', 'aria': ''}))
        ctx.close()
    br.close()

if fails:
    print(f'\n⚠️ {len(fails)} 项问题：')
    for (sc, view, d) in fails:
        print(f"   [{sc}/{view}]  <{d['tag']} id={d.get('id') or '-'} class={d.get('cls')}>  text={d.get('text')!r} aria={d.get('aria')!r}")
    sys.exit(1)
print('\n✅ 全部可见可点元素都有监听器（自身或委托）')
