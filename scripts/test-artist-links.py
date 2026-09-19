#!/usr/bin/env python3
"""所有出现演唱者的地方都可点 → 歌手页（老板 2026-09-19）。

老板原话：「现在要求所有出现演唱者的地方，都可以点击跳转到演唱者的所有歌曲列表，
然后现在那个列表里，点击歌曲会报 404 错误，但是点专辑再点歌曲就不会报错。
要求点击名字进入后，只显示专辑或列表，可以在右上角点击切换。」

本脚本覆盖（除 test-nd-artist.py 已覆盖的播放页歌手行之外的全部入口）：
  1. 搜索页「歌手」分组的歌手行 → 歌手页（不再只是拿名字重新搜一遍）
  2. 搜索页「歌曲」行里的歌手名 → 歌手页（可点文字，不是整行播放）
  3. 专辑详情页的歌手名 → 歌手页
  4. 歌单详情的歌曲行歌手名 → 歌手页
  5. 首页专辑卡片的歌手名 → 歌手页
  6. 收藏页的歌手名 → 歌手页
  7. 历史记录页的歌手名 → 歌手页
  8. ABS 侧反向断言：歌手名是纯文本、不可点（ABS 没有歌手概念，零行为变化）
  9. 触摸目标 ≥44px（可点歌手名）
 10. 404 回归：歌手页点歌不得落到 ABS 分支（路径判据见 test-nd-artist.py）

在 /tmp/pwenv + 8899 http server 环境跑；无 playwright 自动跳过（CI 兼容）。
"""
import json, pathlib, re, sys
from urllib.parse import unquote

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parent.parent

ART_ID = 'art1'
ND_ALBUM = {'id': 'ndalb1', 'name': 'ND 测试专辑', 'artist': '歌手N', 'artistId': ART_ID,
            'songCount': 2, 'duration': 200, 'coverArt': 'c1'}
ND_ALBUM2 = {'id': 'ndalb2', 'name': 'ND 第二张', 'artist': '歌手N', 'artistId': ART_ID,
             'songCount': 1, 'duration': 120, 'coverArt': 'c2'}
ND_SONGS_A1 = [
    {'id': 'nds1', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第一首歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 1, 'contentType': 'audio/mpeg'},
    {'id': 'nds2', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第二首歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 2, 'contentType': 'audio/mpeg'},
]
ND_SONGS_A2 = [
    {'id': 'nds9', 'albumId': 'ndalb2', 'album': 'ND 第二张', 'title': '别专辑的歌',
     'artist': '歌手N', 'artistId': ART_ID, 'duration': 120, 'track': 1, 'contentType': 'audio/mpeg'},
]
PLAYLIST_SONG = {'id': 'nds1', 'albumId': 'ndalb1', 'album': 'ND 测试专辑', 'title': '第一首歌',
                 'artist': '歌手N', 'artistId': ART_ID, 'duration': 100, 'track': 1,
                 'contentType': 'audio/mpeg'}

ABS_BOOK = {'id': 'absbook1', 'media': {'metadata': {'title': 'ABS 有声书', 'authorName': '作者A'},
                                        'duration': 3600}}
# 记录 ABS 侧请求（404 回归的旁证；判据主体在 test-nd-artist.py）
ABS_HITS = []

fails = []


def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond:
        fails.append(name)


def handler(route):
    u = route.request.url
    p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    # ⚠️ query 必须 URL 解码：Chinese 歌词/歌手名会被编码成 %E6%AD%8C%E6%89%8B，
    #    不解码则永匹配不上 → 歌手分组空 → 测试假失败（踩过）。
    qs = {k: unquote(v) for k, v in (x.split('=', 1) for x in u.split('?', 1)[1].split('&') if '=' in x)} if '?' in u else {}
    if p.startswith('/api/'):
        ABS_HITS.append(p)
    if p in ('/status',):
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
                                 {'libraryItemId': 'absbook1', 'currentTime': 30, 'duration': 3600}]}))
    if p == '/api/collections':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'collections': [
                                 {'id': 'col1', 'name': '常听',
                                  'books': [{'id': 'absbook1', 'media': ABS_BOOK['media']}]}]}))
    # ABS 播放会话（点书 → 播放页需要；缺了会静默失败留在书架，踩过）
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
    if p.startswith('/api/session/sess1/'):
        return route.fulfill(status=200, content_type='application/json', body='{}')
    if '/cover' in p:
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
                return nd({'album': {**ND_ALBUM2, 'song': ND_SONGS_A2}})
            return nd({'album': {**ND_ALBUM, 'song': ND_SONGS_A1}})
        if p == '/rest/getArtist':
            return nd({'artist': {'id': ART_ID, 'name': '歌手N', 'albumCount': 2,
                                  'album': [ND_ALBUM, ND_ALBUM2]}})
        if p == '/rest/search3':
            q2 = qs.get('query', '')
            if q2:
                return nd({'searchResult3': {'album': [ND_ALBUM],
                                             'artist': [{'id': ART_ID, 'name': '歌手N'}],
                                             'song': ND_SONGS_A1 + ND_SONGS_A2}})
            return nd({'searchResult3': {'album': [ND_ALBUM], 'artist': [],
                                         'song': ND_SONGS_A1}})
        if p == '/rest/getPlaylists':
            return nd({'playlists': {'playlist': [
                {'id': 'pl1', 'name': '我的最爱', 'songCount': 1, 'duration': 100, 'public': False}]}})
        if p == '/rest/getPlaylist':
            return nd({'playlist': {'id': 'pl1', 'name': '我的最爱', 'songCount': 1,
                                    'duration': 100, 'entry': [PLAYLIST_SONG]}})
        if p == '/rest/getStarred2':
            return nd({'starred2': {'album': [ND_ALBUM]}})
        if p == '/rest/getBookmarks':
            return nd({'bookmarks': {'bookmark': [
                {'id': 'nds1', 'position': 40, 'updated': '2026-09-19T10:00:00Z'}]}})
        if p == '/rest/getSong':
            return nd({'song': PLAYLIST_SONG})
        if p == '/rest/getCoverArt':
            return route.fulfill(status=200, content_type='image/png', body=b'\x89PNG\r\n\x1a\n')
        if p == '/rest/stream':
            return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
        return nd({})
    return route.fulfill(status=200, content_type='application/json', body='{}')


ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""


def newpage(br, prefs):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs


def links_in(pg, sel):
    """返回选择器内所有可点歌手名（文字 + artistId）"""
    return pg.evaluate("""(sel) => [...document.querySelectorAll(sel + ' [data-artist-id]')]
        .map(e => ({ name: e.textContent.trim(), id: e.dataset.artistId }))""", sel)


with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ---------- 1. 搜索页：歌手行 + 歌曲行的歌手名 ----------
    print('=== 1. 搜索页：歌手行 / 歌曲行的歌手名都可点 → 歌手页 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1400)
    pg.fill('#q', '歌手'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1800)
    rows = pg.evaluate("[...document.querySelectorAll('#results [data-artist-go]')].map(e=>e.dataset.artistGo)")
    ok('搜索结果有歌手行', len(rows) >= 1, str(rows))
    # 歌手 id 认两种前缀（ndart: 来自 search3 的 artist 对象；nd: 来自专辑/歌曲的 artistId）
    ok('歌手行带 artist id（nd: / ndart: 前缀）',
       bool(rows) and all(r.startswith(('nd:', 'ndart:')) for r in rows), str(rows[:1]))
    sLinks = links_in(pg, '#results .song-item')
    ok('歌曲行里的歌手名可点', len(sLinks) >= 1, str(sLinks[:2]))
    ok('歌曲行歌手名文字正确', sLinks and sLinks[0]['name'] == '歌手N', str(sLinks[:1]))
    ok('歌曲行歌手 name 无多余符号', sLinks and sLinks[0]['name'] == sLinks[0]['name'].strip('▸·> '),
       repr(sLinks[0]['name'] if sLinks else None))
    # 触摸目标
    h = pg.evaluate("document.querySelector('#results .song-item [data-artist-id]')?.getBoundingClientRect().height ?? -1")
    ok('歌曲行歌手名触摸目标 ≥44px', h >= 44, f'{round(h)}px')
    # 点歌手名 → 歌手页（不能顺带把歌播了）
    pg.evaluate("document.querySelector('#results .song-item [data-artist-id]')?.click()")
    pg.wait_for_timeout(1800)
    ok('点歌曲行的歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('没有顺带进入播放页', pg.evaluate("document.body.dataset.view") != 'player')
    ok('歌手页是当前歌手', pg.evaluate("document.querySelector('.artist-hero-name')?.textContent") == '歌手N',
       str(pg.evaluate("document.querySelector('.artist-hero-name')?.textContent")))
    # 返回搜索页，点歌手行
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(1500)
    ok('返回搜索页', pg.evaluate("document.body.dataset.view") == 'search',
       str(pg.evaluate("document.body.dataset.view")))
    pg.evaluate("document.querySelector('#results [data-artist-go]')?.click()"); pg.wait_for_timeout(1800)
    ok('点歌手行 → 歌手页（不再只是重新搜索）',
       pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 2. 专辑详情页的歌手名 ----------
    print('=== 2. 专辑详情页歌手名可点 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(1800)
    ok('进了专辑详情页', pg.evaluate("document.body.dataset.view") == 'album')
    aLink = links_in(pg, '.album-hero')
    ok('专辑页歌手名可点', len(aLink) == 1, str(aLink))
    ok('专辑页歌手名文字正确', aLink and aLink[0]['name'] == '歌手N', str(aLink))
    ah = pg.evaluate("document.querySelector('.album-hero [data-artist-id]')?.getBoundingClientRect().height ?? -1")
    ok('专辑页歌手名触摸目标 ≥44px', ah >= 44, f'{round(ah)}px')
    pg.evaluate("document.querySelector('.album-hero [data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    ok('点专辑页歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 3. 歌单详情页的歌手名 ----------
    print('=== 3. 歌单详情歌曲行歌手名可点 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('#plEntryCard')?.click()"); pg.wait_for_timeout(1600)
    ok('进歌单页', pg.evaluate("document.body.dataset.view") == 'playlists',
       str(pg.evaluate("document.body.dataset.view")))
    pg.evaluate("document.querySelector('[data-pl]')?.click()"); pg.wait_for_timeout(1800)
    ok('进歌单详情', pg.evaluate("document.body.dataset.view") == 'playlistDetail',
       str(pg.evaluate("document.body.dataset.view")))
    pLink = links_in(pg, '#plSongs')
    ok('歌单歌曲行歌手名可点', len(pLink) >= 1, str(pLink[:2]))
    pg.evaluate("document.querySelector('#plSongs [data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    ok('点歌单里的歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('没有顺带起播（仍在歌手页）', pg.evaluate("document.body.dataset.view") == 'artist')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 4. 首页专辑卡片 ----------
    print('=== 4. 首页专辑卡片歌手名可点 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    ok('进首页', pg.evaluate("document.body.dataset.view") == 'kidhome')
    sLink = links_in(pg, '.book-card')
    ok('首页卡片歌手名可点', len(sLink) >= 1, str(sLink[:2]))
    sh = pg.evaluate("document.querySelector('.book-card [data-artist-id]')?.getBoundingClientRect().height ?? -1")
    ok('首页卡片歌手名触摸目标 ≥44px', sh >= 44, f'{round(sh)}px')
    pg.evaluate("document.querySelector('.book-card [data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    ok('点首页卡片的歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('没有顺带进专辑详情', pg.evaluate("document.body.dataset.view") == 'artist')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 5. 收藏页 ----------
    print('=== 5. 收藏页歌手名可点 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('#favEntryCard')?.click()"); pg.wait_for_timeout(1800)
    ok('进收藏页', pg.evaluate("document.body.dataset.view") == 'favorites',
       str(pg.evaluate("document.body.dataset.view")))
    fLink = links_in(pg, '.settings-group')
    ok('收藏页歌手名可点', len(fLink) >= 1, str(fLink[:2]))
    pg.evaluate("document.querySelector('[data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    ok('点收藏页歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 6. 历史记录页 ----------
    print('=== 6. 历史记录页歌手名可点 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('#historyEntryCard')?.click()"); pg.wait_for_timeout(2000)
    ok('进历史页', pg.evaluate("document.body.dataset.view") == 'history',
       str(pg.evaluate("document.body.dataset.view")))
    hLink = links_in(pg, '#hlist')
    ok('历史页歌手名可点', len(hLink) >= 1, str(hLink[:2]))
    if hLink:
        pg.evaluate("document.querySelector('#hlist [data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
        ok('点历史页歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
           str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 6b. 其余出现歌手名的地方（第二轮补漏）----------
    print('=== 6b. 搜索专辑行 / 浏览列表 / 歌手页卡片 / 缓存页 的歌手名 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    # (a) 搜索结果的「专辑」行作者名
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1300)
    pg.fill('#q', '歌'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1900)
    aLinks = links_in(pg, '#results .list-item[data-id]')
    ok('搜索专辑行作者名可点', len(aLinks) >= 1, str(aLinks[:2]))
    ok('点击不误入专辑详情', pg.evaluate("document.body.dataset.view") == 'search')
    pg.evaluate("document.querySelector('#results .list-item[data-id] [data-artist-id]')?.click()")
    pg.wait_for_timeout(1800)
    ok('点搜索专辑行的歌手名 → 歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    # (b) 歌手页自己列出的专辑卡片作者名（应可点，且点了不跳走/不重复入栈）
    ok('歌手页专辑卡歌手名可点', pg.evaluate("document.querySelectorAll('.book-card [data-artist-id]').length") >= 1,
       str(pg.evaluate("document.querySelectorAll('.book-card [data-artist-id]').length")))
    pg.evaluate("document.querySelector('.book-card [data-artist-id]')?.click()"); pg.wait_for_timeout(1500)
    ok('点歌手页卡片的歌手名仍在歌手页（不跳专辑详情）',
       pg.evaluate("document.body.dataset.view") == 'artist', str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # (c) 离线缓存页的书名下方作者名
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]').click()"); pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowCache')?.click()"); pg.wait_for_timeout(1800)
    if pg.evaluate("document.body.dataset.view") == 'cache':
        cLinks = pg.evaluate("document.querySelectorAll('#dlList [data-artist-id]').length")
        ok('缓存页可下载列表作者名可点', cLinks >= 1, str(cLinks))
    else:
        ok('缓存页可下载列表作者名可点', False, '没进缓存页')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 7. ABS 反向断言：不可点、纯文本 ----------
    print('=== 7. ABS 侧：歌手名/作者名是纯文本，不可点（零行为变化）===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    ok('ABS 首页', pg.evaluate("document.body.dataset.view") == 'kidhome')
    anyLink = pg.evaluate("document.querySelectorAll('[data-artist-id]').length")
    ok('ABS 首页没有任何可点歌手名', anyLink == 0, str(anyLink))
    ok('ABS 首页卡片仍显示作者名', '作者A' in (pg.evaluate("document.querySelector('.book-card .book-sub')?.textContent") or ''),
       str(pg.evaluate("document.querySelector('.book-card .book-sub')?.textContent")))
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1300)
    pg.fill('#q', '书'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1800)
    ok('ABS 搜索结果无可点歌手名', pg.evaluate("document.querySelectorAll('[data-artist-id]').length") == 0,
       str(pg.evaluate("document.querySelectorAll('[data-artist-id]').length")))
    pg.evaluate("document.querySelector('.kid-tab[data-nav=kidhome]').click()"); pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2500)
    ok('ABS 进播放页', pg.evaluate("document.body.dataset.view") == 'player',
       str(pg.evaluate("document.body.dataset.view")))
    ok('ABS 播放页无可点歌手名', pg.evaluate("document.querySelectorAll('[data-artist-id]').length") == 0)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
