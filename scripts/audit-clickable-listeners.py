#!/usr/bin/env python3
"""全 UI 可点元素审计 v3（老板 2026-09-19：「检查所有 UI 上的所有按钮、可以点击的链接
有没有别的问题」）。

三层审计，缺一层就会漏一类 bug：

  层 1 · 覆盖全部视图（v2 只查书架/播放页/⋯菜单 —— 看不见的地方等于没查）。
        每个场景**先断言真的到达了目标视图**，没到=直接判失败（v1 假通过的根因）。

  层 2 · CDP `DOMDebugger.getEventListeners` 逐元素查真实监听器（含祖先委托）：
        「可见、可点、却没有任何监听器」= 死按钮。

  层 3 · 行为审计：对每个**带 id 的**稳定元素，重新导航回该视图后真实点击，
        断言 (a) 没抛 JS 异常 (b) 点击前后有可观测变化（视图切换 / DOM 变化 /
        浮层出现 / toast / 类名变化）。(a)+(b) 都过才算「点得动」。
        ⚠️ 必须每次重新导航：点击常导致跳页，元素引用随即过期 ——
        第一版没有重导航，结果后面所有场景都在错的页面上跑（假结果）。

用法：python3 scripts/audit-clickable-listeners.py [base_url]
无 Playwright 自动跳过（CI 兼容）。
"""
import json, pathlib, re, sys
from urllib.parse import unquote

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8899/index.html'
SELS = ('button, [role="button"], .book-card, .list-item, .tool-chip, .sheet-item, '
        '.entry-btn, .day-arrow, .cal-cell, .chapter-item, .pick-toggle, .pick-all, '
        '.artist-link, [data-artist-go], .icon-btn, .btn, .kid-tab, .mini-btn, #mini')

ART_ID = 'art1'
ABS_BOOK = {'id': 'absbook1', 'media': {'metadata': {'title': 'ABS 有声书', 'authorName': '作者A'},
                                        'duration': 3600}}
ND_ALBUM = {'id': 'ndalb1', 'name': 'ND 测试专辑', 'artist': '歌手N', 'artistId': ART_ID,
            'songCount': 3, 'duration': 300, 'coverArt': 'c1'}
ND_ALBUM2 = {'id': 'ndalb2', 'name': 'ND 第二张', 'artist': '歌手N', 'artistId': ART_ID,
             'songCount': 1, 'duration': 120, 'coverArt': 'c2'}
ND_SONGS = [
    {'id': 'nds1', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第一首歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 1, 'contentType': 'audio/mpeg'},
    {'id': 'nds2', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第二首歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 2, 'contentType': 'audio/mpeg'},
    {'id': 'nds3', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第三首歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 3, 'contentType': 'audio/mpeg'},
]


def handler(route):
    u = route.request.url
    p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    qs = {k: unquote(v) for k, v in (x.split('=', 1) for x in u.split('?', 1)[1].split('&') if '=' in x)} if '?' in u else {}
    if p == '/status':
        return route.fulfill(status=200, content_type='application/json', body='{"version":"2.36.0"}')
    if p == '/login':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'user': {'token': 't', 'username': 'bin', 'type': 'root'}}))
    if p == '/api/libraries':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'libraries': [{'id': 'abslib', 'name': '有声书'}]}))
    if p.endswith('/items'):
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'results': [ABS_BOOK]}))
    if p == '/api/me/items-in-progress':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'libraryItems': [ABS_BOOK]}))
    if p == '/api/me':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'username': 'bin', 'mediaProgress': [
                                 {'libraryItemId': 'absbook1', 'currentTime': 300, 'duration': 3600,
                                  'lastUpdate': 1700000000}]}))
    if p == '/api/collections':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'collections': [
                                 {'id': 'col1', 'name': '常听', 'books': [ABS_BOOK]}]}))
    if p == '/api/items/absbook1':
        return route.fulfill(status=200, content_type='application/json', body=json.dumps(
            {**ABS_BOOK, 'media': {**ABS_BOOK['media'], 'audioFiles': [{'ino': 'f1', 'duration': 3600}],
                                   'chapters': [{'id': 0, 'start': 0, 'end': 1800, 'title': '第一章'},
                                                {'id': 1, 'start': 1800, 'end': 3600, 'title': '第二章'}]}}))
    if p == '/api/items/absbook1/play':
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({
            'id': 'sess1', 'duration': 3600, 'audioTracks': [
                {'index': 1, 'startOffset': 0, 'duration': 1800,
                 'contentUrl': '/api/items/absbook1/file/f1', 'title': '第一章'},
                {'index': 2, 'startOffset': 1800, 'duration': 1800,
                 'contentUrl': '/api/items/absbook1/file/f1', 'title': '第二章'}]}))
    if p.startswith('/api/session/'):
        return route.fulfill(status=200, content_type='application/json', body='{}')
    if '/cover' in p or p == '/rest/getCoverArt':
        return route.fulfill(status=200, content_type='image/png', body=b'\x89PNG\r\n\x1a\n')
    if '/rest/' in p:
        def nd(b):
            return route.fulfill(status=200, content_type='application/json',
                                 body=json.dumps({'subsonic-response': {'status': 'ok', 'version': '1.16.1', **b}}))
        if p == '/rest/getMusicFolders':
            return nd({'musicFolders': {'musicFolder': [{'id': 'ndlib', 'name': '音乐'}]}})
        if p == '/rest/getAlbumList2':
            return nd({'albumList2': {'album': [ND_ALBUM, ND_ALBUM2]}})
        if p == '/rest/getAlbum':
            aid = qs.get('id', 'ndalb1')
            if aid == 'ndalb2':
                return nd({'album': {**ND_ALBUM2, 'song': [
                    {'id': 'nds9', 'albumId': 'ndalb2', 'album': 'ND 第二张', 'title': '别专辑的歌',
                     'artist': '歌手N', 'artistId': ART_ID, 'duration': 120, 'track': 1,
                     'contentType': 'audio/mpeg'}]}})
            return nd({'album': {**ND_ALBUM, 'song': ND_SONGS}})
        if p == '/rest/getArtist':
            return nd({'artist': {'id': ART_ID, 'name': '歌手N', 'albumCount': 2,
                                  'album': [ND_ALBUM, ND_ALBUM2]}})
        if p == '/rest/search3':
            q2 = qs.get('query', '')
            if q2:
                return nd({'searchResult3': {'album': [ND_ALBUM],
                                             'artist': [{'id': ART_ID, 'name': '歌手N'}],
                                             'song': ND_SONGS}})
            return nd({'searchResult3': {'album': [], 'artist': [], 'song': []}})
        if p == '/rest/getPlaylists':
            return nd({'playlists': {'playlist': [
                {'id': 'pl1', 'name': '我的最爱', 'songCount': 1, 'duration': 100, 'public': False}]}})
        if p == '/rest/getPlaylist':
            return nd({'playlist': {'id': 'pl1', 'name': '我的最爱', 'songCount': 1, 'duration': 100,
                                    'entry': [ND_SONGS[0]]}})
        if p == '/rest/getStarred2':
            return nd({'starred2': {'album': [ND_ALBUM]}})
        if p == '/rest/getBookmarks':
            return nd({'bookmarks': {'bookmark': [
                {'id': 'nds1', 'position': 40, 'updated': '2026-09-19T10:00:00Z'}]}})
        if p == '/rest/getSong':
            return nd({'song': ND_SONGS[0]})
        if p in ('/rest/getLyrics', '/rest/getLyricsBySongId'):
            return nd({'lyricsList': {'structuredLyrics': [
                {'lang': 'chi', 'synced': True, 'line': [
                    {'start': 5000, 'value': '第一句歌词'}, {'start': 12000, 'value': '第二句歌词'}]}]}})
        if p == '/rest/stream':
            return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
        return nd({})
    return route.fulfill(status=200, content_type='application/json', body='{}')


ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');
  localStorage.setItem('shelfaudio.kidPin','1234');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');
  localStorage.setItem('shelfaudio.kidPin','1234');"""

VIEWS = {
    'abs': ['kidhome', 'player', 'sheet', 'sleep', 'search', 'searchResult', 'settings', 'parents',
            'about', 'favorites', 'history', 'cache'],
    'nd': ['kidhome', 'player', 'sheet', 'sleep', 'lyrics', 'playlistAdd', 'album', 'artist',
           'artistSongs', 'search', 'searchResult', 'settings', 'parents', 'about', 'playlists',
           'playlistNew', 'playlistDetail', 'favorites', 'history'],
}

fails = []
pageerrors = []

# 行为审计的可观测状态快照（对文本变化敏感、浮层只数可见的）
SNAPSHOT = """() => JSON.stringify({
    view: document.body.dataset.view || '',
    mini: document.body.dataset.mini || '',
    tabs: document.body.dataset.tabs || '',
    nodes: document.querySelectorAll('#view *').length,
    visOverlays: [...document.querySelectorAll('.lock, .voice-overlay, .lyrics-page, .sheet, .sleep-tabs')]
        .filter(e => !e.classList.contains('hidden') && (e.offsetWidth || e.offsetHeight)).length,
    lockHidden: document.querySelector('#lock')?.classList.contains('hidden') ?? null,
    text: (document.body.innerText || '').slice(0, 300),
    toast: document.querySelector('#toast')?.textContent || '',
    toastHidden: document.querySelector('#toast')?.classList.contains('hidden') ?? null,
    rate: document.querySelector('#btnRate')?.textContent || '',
    title: document.querySelector('#pTitle')?.textContent || '',
    picked: document.querySelectorAll('.picked').length,
    sleep: document.querySelector('#sleepLabel')?.textContent || '',
})"""



def reset_home(pg):
    """把页面强制拉回书架（tab 视图）。

    ⚠️ 为什么必须先 reset：播放页/专辑页**没有底栏 tab**，
    直接 `document.querySelector('.kid-tab[data-nav=search]')` 会拿到 null，
    后续整个场景都跑在错的页面上（第一版就这么假跑过一轮）。
    """
    pg.evaluate("document.querySelectorAll('.lock, .voice-overlay, .lyrics-page, .sleep-tabs').forEach(e=>e.remove())")
    for _ in range(4):
        if pg.evaluate("document.body.dataset.view") == 'kidhome':
            return
        if pg.evaluate("!!document.querySelector('#btnBack')"):
            pg.evaluate("document.querySelector('#btnBack').click()"); pg.wait_for_timeout(1100)
        else:
            break
    if pg.evaluate("document.body.dataset.view") != 'kidhome':
        # 兜底：整页重载（localStorage 里的登录态会恢复，等价冷启动）
        pg.reload(); pg.wait_for_timeout(2600)


def go_view(pg, name, src):
    """把页面导航到指定视图（每次重导航，元素引用才新鲜）"""
    reset_home(pg)
    if name == 'kidhome':
        return   # reset_home 已确保在书架
    if name == 'search':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=search]')?.click()"); pg.wait_for_timeout(1300)
    elif name == 'searchResult':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=search]')?.click()"); pg.wait_for_timeout(1200)
        pg.fill('#q', '歌'); pg.evaluate("document.querySelector('#btnGo')?.click()"); pg.wait_for_timeout(1900)
    elif name == 'settings':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]')?.click()"); pg.wait_for_timeout(1300)
    elif name == 'parents':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]')?.click()"); pg.wait_for_timeout(1200)
        pg.evaluate("document.querySelector('#rowParent')?.click()"); pg.wait_for_timeout(700)
        if pg.evaluate("[...document.querySelectorAll('.lock-input')].some(e=>e.offsetWidth||e.offsetHeight)"):
            pg.fill('.lock-input:visible', '1234')
            pg.evaluate("[...document.querySelectorAll('.lock-actions .btn')].find(b => !b.classList.contains('ghost'))?.click()")
            pg.wait_for_timeout(1400)
    elif name == 'about':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]')?.click()"); pg.wait_for_timeout(1200)
        pg.evaluate("document.querySelector('#rowAbout')?.click()"); pg.wait_for_timeout(1400)
    elif name == 'player':
        # ⚠️ 必须挑**多首歌**那张专辑：ND 首页是洗过牌的（老板要的随机排序），
        #    第一张可能是单曲专辑 → prev/next 本来就无处可跳 → 审计假阳性（踩过）。
        for _ in range(3):
            pg.evaluate("""() => {
                const cards = [...document.querySelectorAll('.book-card')];
                const multi = cards.find(c => (c.textContent || '').includes('测试专辑')) || cards[0];
                multi?.click();
            }"""); pg.wait_for_timeout(2100)
            v = pg.evaluate("document.body.dataset.view")
            if v == 'player':
                break
            if v == 'album':
                pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2400)
                break
    elif name == 'sheet':
        go_view(pg, 'player', src)
        pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(600)
    elif name == 'album':
        # ⚠️ 必须点**多首歌**那张专辑：书架顺序是洗过牌的（ND 首页随机），
        #    点第一张有可能进到单曲专辑 → prev/next 本来就无处可跳 → 假阳性（踩过）。
        pg.evaluate("""() => {
            const cards = [...document.querySelectorAll('.book-card')];
            const multi = cards.find(c => (c.textContent || '').includes('测试专辑')) || cards[0];
            multi?.click();
        }"""); pg.wait_for_timeout(1900)
    elif name == 'artist':
        go_view(pg, 'album', src)
        pg.evaluate("document.querySelector('[data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    elif name == 'artistSongs':
        go_view(pg, 'artist', src)
        pg.evaluate("document.querySelector('#btnView')?.click()"); pg.wait_for_timeout(800)
    elif name == 'playlists':
        pg.evaluate("document.querySelector('#plEntryCard')?.click()"); pg.wait_for_timeout(1500)
    elif name == 'playlistDetail':
        go_view(pg, 'playlists', src)
        pg.evaluate("document.querySelector('[data-pl]')?.click()"); pg.wait_for_timeout(1700)
    elif name == 'favorites':
        pg.evaluate("document.querySelector('#favEntryCard')?.click()"); pg.wait_for_timeout(1700)
    elif name == 'history':
        pg.evaluate("document.querySelector('#historyEntryCard')?.click()"); pg.wait_for_timeout(1900)
    elif name == 'sleep':
        go_view(pg, 'player', src)
        pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(700)
    elif name == 'lyrics':
        go_view(pg, 'player', src)
        pg.evaluate("document.querySelector('#btnLyrics')?.click()"); pg.wait_for_timeout(900)
    elif name == 'playlistAdd':
        go_view(pg, 'player', src)
        pg.evaluate("document.querySelector('#btnMore')?.click()"); pg.wait_for_timeout(600)
        pg.evaluate("""[...document.querySelectorAll('.sheet-item')]
            .find(b => b.dataset.act === 'playlist')?.click()"""); pg.wait_for_timeout(1000)
    elif name == 'playlistNew':
        go_view(pg, 'playlists', src)
        pg.evaluate("document.querySelector('#btnNew')?.click()"); pg.wait_for_timeout(700)
    elif name == 'cache':
        pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]')?.click()"); pg.wait_for_timeout(1200)
        pg.evaluate("document.querySelector('#rowCache')?.click()"); pg.wait_for_timeout(1700)


EXPECT = {'kidhome': 'kidhome', 'player': 'player', 'search': 'search', 'searchResult': 'search',
          'settings': 'settings', 'parents': 'parents', 'about': 'about', 'album': 'album',
          'artist': 'artist', 'artistSongs': 'artist', 'playlists': 'playlists',
          'playlistDetail': 'playlistDetail', 'favorites': 'favorites', 'history': 'history',
          'cache': 'cache',
          # 非视图场景：到达判据不同（浮层打开即算到达；底下的 view 仍是 player/playlists）
          'sheet': 'player', 'sleep': 'player', 'lyrics': 'player',
          'playlistAdd': 'player', 'playlistNew': 'playlists'}

# 浮层场景的「到达」判据：必须真的出现对应浮层
OVERLAY_PROBE = {
    'sheet': ".sheet-item",
    'sleep': ".sleep-tabs",
    'lyrics': ".lyrics-page, .lyrics-body, .lyrics-empty, .lyrics-loading",
    'playlistAdd': ".lock-card",
    'playlistNew': ".lock-card",
}


def listener_audit(pg, client, label):
    """层 2：CDP 逐元素真实监听器（含祖先委托）"""
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
        if [l for l in lst.get('listeners', []) if l.get('type') in
                ('click', 'pointerup', 'touchend', 'mousedown', 'pointerdown')]:
            continue
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
    print(f'  [{label}] 监听器审计 {len(infos)} 个元素' + (f'，⚠️ {len(dead)} 个死元素' if dead else ' ✓'))
    if not infos:
        fails.append((label, {'text': '检查数为 0（假通过）'}))
    # 用 extend 而不是 +=：+= 会在函数内把 fails 当局部变量重绑定 → UnboundLocalError（踩过）
    fails.extend((label, d) for d in dead)
    return infos


def behavior_audit(pg, client_page, label, ids):
    """层 3：带 id 的稳定元素 → 重导航后真实点击，断言无异常且有效果"""
    bad = []
    for eid in ids:
        pg.evaluate("""() => {
            document.querySelectorAll('.lock, .voice-overlay, .lyrics-page').forEach(e => e.remove());
        }""")
        go_view(pg, VIEW_NAME[0], VIEW_NAME[1])
        if not pg.evaluate(f"!!document.querySelector('#{eid}')"):
            continue   # 该视图这一态下没有这个元素，跳过
        # 搜索框空着点「搜索」本来就该没反应（空关键词直接 return，是正确行为）——
        # 要测的是「有输入时点了有用」，所以先填词。
        if eid == 'btnGo':
            pg.fill('#q', '歌'); pg.wait_for_timeout(200)
        # #btnPrev 语义：曲内时间 >3s = 回本曲开头，否则上一首。刚起播时本就在
        # 开头 → seek(0) 后界面文本完全一样 → 「无变化」是**正确行为**不是 bug。
        # 先把曲内时间推过 3 秒，再点 prev 才会真正换轨。
        if eid == 'btnPrev' and pg.evaluate("!!window.__saPlayer"):
            pg.evaluate("window.__saPlayer.seek((window.__saPlayer.tracks?.[window.__saPlayer.trackIndex]?.startOffset || 0) + 30)")
            pg.wait_for_timeout(300)
        errs_before = len(pageerrors)
        # ⚠️ 快照必须对「文本变化」敏感：切歌/切倍速只改 textContent，DOM 结构不变。
        #    第一版只比 (view, 节点数, 浮层数, toast类名) → 把 btnNext/btnRate 这类
        #    正常工作但只改文本的按钮误报成「无变化」（踩过，白查一轮）。
        #    浮层也要只数**可见的**：index.html 里的 #lock 是常驻静态元素，
        #    数 presence 永远不变 → 对家长锁弹窗失明。
        before = pg.evaluate(SNAPSHOT)
        # searchResult 态下 #btnGo 重搜同一关键词 = 结果重渲染且内容一致，
        # 快照几乎必然相同 → 这是「正确但无可见变化」。跳过行为审计（监听器审计已覆盖）。
        if VIEW_NAME[0] == 'searchResult' and eid == 'btnGo':
            continue
        pg.evaluate(f"document.querySelector('#{eid}').click()")
        # ⚠️ 必须**轮询**而不是等一个固定短时间：切歌/播放全部要先建播放会话、
        #    拉专辑详情（网络 + 异步），实测 650ms 内界面什么都不变 →
        #    把 btnNext/#playAll 这类正常工作但慢的按钮误报成「无变化」（踩过）。
        #    改成 6 次 × 450ms（≈2.7s）内只要出现一次变化就算「有响应」。
        after = before
        for _ in range(6):
            pg.wait_for_timeout(450)
            after = pg.evaluate(SNAPSHOT)
            if after != before:
                break
        raised = pageerrors[errs_before:]
        if raised:
            bad.append((eid, f'点击抛异常：{raised[0][:80]}'))
        elif before == after:
            bad.append((eid, '点击后无任何变化'))
    return bad


with sync_playwright() as pw:
    br = pw.chromium.launch()
    global VIEW_NAME
    for src, prefs in [('ABS', ABS_PREFS), ('ND', ND_PREFS)]:
        key = 'abs' if src == 'ABS' else 'nd'
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
        pg.add_init_script(prefs)
        pg.goto(BASE); pg.wait_for_timeout(2600)
        client = pg.context.new_cdp_session(pg)
        pageerrors.clear()
        total = 0

        print(f'--- {src} ---')
        for view in VIEWS[key]:
            VIEW_NAME = (view, src)
            go_view(pg, view, src)
            got = pg.evaluate("document.body.dataset.view")
            want = EXPECT[view]
            if view in OVERLAY_PROBE:
                # 浮层场景：底下 view 对 + 浮层真的出现，才算到达
                #（否则「没打开」会被误判成通过）
                if pg.evaluate(f"!!document.querySelector('{OVERLAY_PROBE[view]}')"):
                    got = want
            if got != want:
                fails.append((f'{src}/{view}', {'text': f'没到达目标视图（want={want} got={got}）'}))
                continue
            infos = listener_audit(pg, client, f'{src}/{view}')
            total += len(infos)

        # 行为审计：各视图里带 id 的元素（重导航后逐个点）
        BEHAVIOR = {
            'abs': {'kidhome': ['historyEntryCard', 'favEntryCard'],
                    'player': ['btnPlay', 'btnNext', 'btnF15', 'btnR15', 'btnRate', 'btnSleep',
                               'btnFavTop', 'btnBack'],
                    'sheet': ['mDownload', 'mChapters', 'mRate', 'mSleep', 'mInfo'],
                    'search': ['btnGo', 'btnBack'],
                    'settings': ['rowFav', 'rowCache', 'rowServers', 'rowParent', 'rowAbout'],
                    'favorites': ['btnBack'],
                    'history': ['btnBack'],
                    'cache': ['btnBack']},
            'nd': {'kidhome': ['historyEntryCard', 'favEntryCard', 'plEntryCard'],
                   'player': ['btnPlay', 'btnNext', 'btnPrev', 'btnMode', 'btnLyrics', 'btnSleep',
                              'btnFavTop', 'btnBack'],
                   'sheet': ['mDownload', 'mPlaylist', 'mSleep', 'mInfo'],
                   'album': ['playAll', 'btnBack'],
                   'artist': ['btnView', 'btnBack'],
                   'artistSongs': ['btnView', 'btnBack'],
                   'search': ['btnGo', 'btnBack'],
                   'searchResult': ['pickToggle', 'btnGo'],
                   'settings': ['rowFav', 'rowCache', 'rowServers', 'rowParent', 'rowAbout'],
                   'playlists': ['btnNew', 'btnBack'],
                   'playlistDetail': ['playAll', 'addSongs', 'btnMore', 'btnBack'],
                   'favorites': ['btnBack'],
                   'history': ['btnBack']},
        }
        for view, ids in BEHAVIOR[key].items():
            VIEW_NAME = (view, src)
            go_view(pg, view, src)
            if not pg.evaluate("document.body.dataset.view") == EXPECT[view]:
                continue   # 上一轮已记为失败
            bad = behavior_audit(pg, client, f'{src}/{view}', ids)
            if bad:
                for eid, why in bad:
                    print(f'  [{src}/{view}] ⚠️ #{eid}：{why}')
                    fails.append((f'{src}/{view}·行为', {'id': eid, 'text': why}))

        if errs:
            fails.append((f'{src}/JS异常', {'text': str(errs[:3])}))
        print(f'  [{src}] 合计监听器审计 {total} 个元素；JS 异常 {len(errs)}')
        ctx.close()
    br.close()

print()
if fails:
    print(f'⚠️ {len(fails)} 项问题：')
    for (label, d) in fails:
        print(f"   [{label}]  <{d.get('tag', '-')} id={d.get('id') or '-'} class={d.get('cls', '-')}>  "
              f"{d.get('text')!r}")
    sys.exit(1)
print('✅ 全 UI 可点元素：全部有监听器、全部有响应（无死按钮、无点击无反应）')
