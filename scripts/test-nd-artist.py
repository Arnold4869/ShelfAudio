#!/usr/bin/env python3
"""ND 播放页歌手名 + 歌手页（老板 2026-09-17，真浏览器）。

老板原话：「ND 的播放页看不到歌唱者的名字。正常的播放器就是在这里面会显示他的名字，
然后点击他的名字，会显示他的所有的作品。一般这个名字就在当前这个歌曲的歌名下方。」

覆盖：
  1. ND 播放页标题区三层：大字=歌名 / 二手行=歌手（可点）/ 三行=专辑（可点）
  2. 点歌手名 → 歌手页（头像 + 名下专辑 + 歌曲列表）
  3. 歌手页点专辑 → 专辑详情；点歌曲 → 进所在专辑从那首开始播
  4. 切歌后歌手行/歌名跟着变（sa:track 重绘）
  5. 拿不到 artistId 时歌手行隐藏（不渲染点了没反应的按钮）
  6. ABS 播放页零改动：没有歌手行/专辑行，章节行照旧显示
  7. 触摸目标 ≥44px（歌手行）
在 /tmp/pwenv + 8899 http server 环境跑；无 playwright 自动跳过（CI 兼容）。
"""
import json, pathlib, re, zlib, sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _png(w=40, h=40, rgb=(90, 140, 200)):
    def chunk(t, d):
        c = t + d
        return len(d).to_bytes(4, 'big') + c + zlib.crc32(c).to_bytes(4, 'big')
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00')
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


PNG = _png()
fails = []


def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond:
        fails.append(name)


# ---- fixture：ND 歌手「歌手N」名下 2 张专辑 + 3 首歌 ----
ART_ID = 'art1'
ND_ALBUM = {'id': 'ndalb1', 'name': 'ND 测试专辑', 'artist': '歌手N', 'artistId': ART_ID,
            'songCount': 3, 'duration': 300, 'coverArt': 'c1'}
ND_ALBUM2 = {'id': 'ndalb2', 'name': 'ND 第二张', 'artist': '歌手N', 'artistId': ART_ID,
             'songCount': 1, 'duration': 120, 'coverArt': 'c2'}
ND_SONGS = [
    {'id': 'nds1', 'albumId': 'ndalb1', 'title': '第一首歌', 'artist': '歌手N', 'artistId': ART_ID,
     'duration': 100, 'track': 1, 'contentType': 'audio/mpeg'},
    {'id': 'nds2', 'albumId': 'ndalb1', 'title': '第二首歌', 'artist': '歌手N', 'artistId': ART_ID,
     'duration': 100, 'track': 2, 'contentType': 'audio/mpeg'},
    {'id': 'nds3', 'albumId': 'ndalb1', 'title': '第三首歌', 'artist': '歌手N', 'artistId': ART_ID,
     'duration': 100, 'track': 3, 'contentType': 'audio/mpeg'},
]
# 第二张专辑只有 1 首（歌手页点歌 → 跨专辑情况）
ND_ALBUM2_SONGS = [
    {'id': 'nds9', 'albumId': 'ndalb2', 'title': '别专辑的歌', 'artist': '歌手N', 'artistId': ART_ID,
     'duration': 120, 'track': 1, 'contentType': 'audio/mpeg'},
]
# 合作曲：artistId 不是本人 → 歌手页必须按 artistId 过滤掉（不能只看文本）
COOP_SONG = {'id': 'nds8', 'albumId': 'ndalb9', 'title': '合作曲', 'artist': '歌手N/别人',
             'artistId': 'otherart', 'duration': 90, 'track': 1, 'contentType': 'audio/mpeg'}

# 无 artistId 的歌（老数据/元数据缺失）→ 歌手行应隐藏。
# 注意：startPlayback 里 artistId 会回落到**专辑级 artistId**（合理的兜底：同专辑同歌手），
# 所以真正「没有歌手信息」的场景必须连专辑也没有 artistId（见 ALBUM_NO_ARTIST）。
ND_SONGS_NO_ARTIST = [dict(s, artistId='') for s in ND_SONGS]
# 专辑本身也没 artistId：这才是「完全拿不到歌手」的真实场景
ALBUM_NO_ARTIST = {'id': 'ndalb1', 'name': '无歌手专辑', 'artist': '', 'artistId': '',
                   'songCount': 3, 'duration': 300, 'coverArt': 'c1'}
VARIANT = {'songs': ND_SONGS, 'album2': ND_ALBUM2_SONGS, 'album': ND_ALBUM, 'albumNoArtist': False}

ABS_BOOK = {'id': 'absbook1', 'media': {'metadata': {'title': 'ABS 有声书', 'authorName': '作者A'},
                                        'duration': 3600}}


def handler(route):
    u = route.request.url
    p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    qs = dict(x.split('=', 1) for x in u.split('?', 1)[1].split('&')) if '?' in u else {}
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
        return route.fulfill(status=200, content_type='application/json', body='{"libraryItems":[]}')
    if p == '/api/me':
        return route.fulfill(status=200, content_type='application/json',
                             body='{"username":"bin","mediaProgress":[]}')
    if p == '/api/collections':
        return route.fulfill(status=200, content_type='application/json', body='{"collections":[]}')
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
    if p == '/api/session/sess1/sync':
        return route.fulfill(status=200, content_type='application/json', body='{}')
    if p == '/api/session/sess1/close':
        return route.fulfill(status=200, content_type='application/json', body='{}')
    if p.endswith('/cover'):
        return route.fulfill(status=200, content_type='image/png', body=PNG)
    if '/rest/' in p:
        def nd(b):
            return route.fulfill(status=200, content_type='application/json',
                                 body=json.dumps({'subsonic-response': {'status': 'ok', 'version': '1.16.1', **b}}))
        if p == '/rest/getMusicFolders':
            return nd({'musicFolders': {'musicFolder': [{'id': 'ndlib', 'name': '音乐'}]}})
        if p == '/rest/getAlbumList2':
            return nd({'albumList2': {'album': [ND_ALBUM]}})
        if p == '/rest/getAlbum':
            aid = qs.get('id', 'ndalb1')
            if aid == 'ndalb2':
                return nd({'album': {**ND_ALBUM2, 'song': VARIANT['album2']}})
            base = ALBUM_NO_ARTIST if VARIANT['albumNoArtist'] else ND_ALBUM
            return nd({'album': {**base, 'song': VARIANT['songs']}})
        if p == '/rest/getArtist':
            # 名下 2 张专辑（含 getArtist 原生 album 数组）
            al = '1' if VARIANT['albumNoArtist'] else ART_ID
            return nd({'artist': {'id': al, 'name': '歌手N' if not VARIANT['albumNoArtist'] else '',
                                  'albumCount': 2, 'album': [ND_ALBUM, ND_ALBUM2]}})
        if p == '/rest/search3':
            # 按歌手名搜：返回本人 3 首 + 1 首合作曲（artistId 不同 → 必须被过滤）
            return nd({'searchResult3': {'album': [ND_ALBUM, ND_ALBUM2],
                                         'artist': [{'id': ART_ID, 'name': '歌手N'}],
                                         'song': VARIANT['songs'] + ([COOP_SONG] if not VARIANT['albumNoArtist'] else [])}})
        if p == '/rest/getStarred2':
            return nd({'starred2': {'album': []}})
        if p == '/rest/getBookmarks':
            return nd({'bookmarks': {'bookmark': []}})
        if p == '/rest/getPlaylists':
            return nd({'playlists': {'playlist': []}})
        if p == '/rest/getCoverArt':
            # artist 图：返回一张 PNG（视图层还有首字兜底，这里给真图验证 img 路径）
            return route.fulfill(status=200, content_type='image/png', body=PNG)
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


def into_nd_player(pg):
    """首页点专辑 → 详情页 → 点第一首 → 播放页。返回是否成功"""
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2000)
    pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
    return pg.evaluate("document.body.dataset.view") == 'player'


with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ---------- 1. ND 播放页标题区三层 ----------
    print('=== 1. ND 播放页：歌名 / 歌手（可点）/ 专辑（可点）===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    ok('进 ND 播放页', into_nd_player(pg))
    ok('大字是歌名（不是专辑名）', pg.evaluate("document.querySelector('#pTitle')?.textContent") == '第一首歌',
       str(pg.evaluate("document.querySelector('#pTitle')?.textContent")))
    ok('有歌手行', pg.evaluate("!!document.querySelector('#pArtist')"))
    ok('歌手行显示歌手名', pg.evaluate("document.querySelector('#pArtistName')?.textContent") == '歌手N',
       str(pg.evaluate("document.querySelector('#pArtistName')?.textContent")))
    # 老板 2026-09-17 二轮：「名字旁边为嘛会多个符号，不需要它，只需要点击姓名跳转就行」
    # → 歌手行内不得有任何图标/符号（曾有过 forward 箭头），只留纯文字。
    ok('歌手行没有多余符号（无 SVG 图标）',
       pg.evaluate("!document.querySelector('#pArtist svg') && !document.querySelector('#pArtist img')"),
       str(pg.evaluate("document.querySelector('#pArtist')?.innerHTML?.trim()")))
    ok('歌手行文字就是歌手名本身（无前后缀符号）',
       pg.evaluate("(document.querySelector('#pArtist')?.textContent || '').trim()") == '歌手N',
       repr(pg.evaluate("(document.querySelector('#pArtist')?.textContent || '').trim()")))
    ok('专辑行同样无多余符号', pg.evaluate("!document.querySelector('#pAlbum svg')"),
       str(pg.evaluate("document.querySelector('#pAlbum')?.innerHTML?.trim()")))
    ok('歌手行可见（未 hidden）', pg.evaluate("document.querySelector('#pArtist')?.hidden") == False)
    ok('歌手行在歌名下方（垂直位置 > 标题底部）',
       pg.evaluate("""(() => {
           const te = document.querySelector('#pTitle'), ae = document.querySelector('#pArtist');
           if (!te || !ae) return false;   // 元素不存在 = 失败（旧版无歌手行）
           return ae.getBoundingClientRect().top >= te.getBoundingClientRect().bottom - 1;
       })()"""))
    ok('有专辑行', pg.evaluate("!!document.querySelector('#pAlbum')"))
    ok('专辑行显示专辑名', pg.evaluate("document.querySelector('#pAlbum')?.textContent") == 'ND 测试专辑',
       str(pg.evaluate("document.querySelector('#pAlbum')?.textContent")))
    ok('ND 下章节行已隐藏（歌名不重复显示两遍）',
       pg.evaluate("document.querySelector('#pChapter')?.hidden") == True)
    # 触摸目标：歌手行 ≥44px（元素不存在时判失败，不抛异常）
    hh = pg.evaluate("document.querySelector('#pArtist')?.getBoundingClientRect().height ?? -1")
    ok('歌手行触摸目标 ≥44px', hh >= 44, f'{round(hh)}px')
    ok('无 JS 报错', not errs, str(errs[:2]))

    # ---------- 2. 点歌手名 → 歌手页 ----------
    print('=== 2. 点歌手名 → 歌手页（全部作品）===')
    pg.evaluate("document.querySelector('#pArtist')?.click()"); pg.wait_for_timeout(1800)
    ok('进了歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    ok('歌手页标题是歌手名', pg.evaluate("document.querySelector('.artist-hero-name')?.textContent") == '歌手N',
       str(pg.evaluate("document.querySelector('.artist-hero-name')?.textContent")))
    ok('画家头像槽', pg.evaluate("!!document.querySelector('.artist-avatar')"))
    ok('副标题写专辑数+歌曲数', '2 张专辑' in (pg.evaluate("document.querySelector('.artist-hero-sub')?.textContent") or ''),
       str(pg.evaluate("document.querySelector('.artist-hero-sub')?.textContent")))
    albums = pg.evaluate("[...document.querySelectorAll('.book-card[data-album]')].map(e=>e.dataset.album)")
    ok('列出名下 2 张专辑', albums == ['nd:ndalb1', 'nd:ndalb2'], str(albums))
    songs = pg.evaluate("[...document.querySelectorAll('.list-item[data-song]')].map(e=>e.dataset.song)")
    ok('列出 3 首歌（合作曲被 artistId 过滤掉）', sorted(songs) == ['nds1', 'nds2', 'nds3'], str(songs))
    ok('没有混进合作曲', 'nds8' not in songs, str(songs))
    ok('无 JS 报错', not errs, str(errs[:2]))

    # ---------- 3. 歌手页跳转：专辑 / 歌曲 ----------
    print('=== 3. 歌手页跳转 ===')
    pg.evaluate("document.querySelector('.book-card[data-album]')?.click()"); pg.wait_for_timeout(1800)
    ok('点专辑 → 专辑详情页', pg.evaluate("document.body.dataset.view") == 'album',
       str(pg.evaluate("document.body.dataset.view")))
    # 返回歌手页，点歌曲 → 进专辑页并自动播放
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(1500)
    ok('返回歌手页', pg.evaluate("document.body.dataset.view") == 'artist',
       str(pg.evaluate("document.body.dataset.view")))
    pg.evaluate("document.querySelectorAll('.list-item[data-song]')[0]?.click()"); pg.wait_for_timeout(2600)
    ok('点歌曲 → 进专辑页起播', pg.evaluate("document.body.dataset.view") == 'album',
       str(pg.evaluate("document.body.dataset.view")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 4. 切歌后标题区跟着变 ----------
    print('=== 4. 切歌后歌名/歌手跟着刷新 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    into_nd_player(pg)
    # 下一首 → sa:track
    pg.evaluate("document.querySelector('#btnNext')?.click()"); pg.wait_for_timeout(1500)
    ok('切到第二首：大字歌名更新', pg.evaluate("document.querySelector('#pTitle')?.textContent") == '第二首歌',
       str(pg.evaluate("document.querySelector('#pTitle')?.textContent")))
    ok('歌手行仍是歌手N', pg.evaluate("document.querySelector('#pArtistName')?.textContent") == '歌手N')
    ok('专辑行仍是专辑名', pg.evaluate("document.querySelector('#pAlbum')?.textContent") == 'ND 测试专辑')
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 5. 缺 artistId → 歌手行隐藏 ----------
    print('=== 5. 拿不到 artistId 时歌手行隐藏 ===')
    # 真实场景：歌曲级 + 专辑级都拿不到 artistId（老数据/元数据缺失）
    VARIANT['albumNoArtist'] = True
    VARIANT['songs'] = ND_SONGS_NO_ARTIST
    ctx, pg, errs = newpage(br, ND_PREFS)
    into_nd_player(pg)
    ok('歌手行被隐藏（不渲染死按钮）', pg.evaluate("document.querySelector('#pArtist')?.hidden") == True,
       str(pg.evaluate("document.querySelector('#pArtist')?.hidden")))
    ok('歌手行被禁用', pg.evaluate("document.querySelector('#pArtist')?.disabled") == True)
    ok('专辑行仍可见（仍可回专辑）', pg.evaluate("document.querySelector('#pAlbum')?.hidden") == False)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()
    VARIANT['albumNoArtist'] = False
    VARIANT['songs'] = ND_SONGS

    # ---------- 6. ABS 播放页零改动 ----------
    print('=== 6. ABS 播放页保持原样（无歌手行/专辑行，章节行照旧）===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2500)
    ok('进 ABS 播放页', pg.evaluate("document.body.dataset.view") == 'player',
       str(pg.evaluate("document.body.dataset.view")))
    ok('ABS 无歌手行', not pg.evaluate("!!document.querySelector('#pArtist')"))
    ok('ABS 无专辑行', not pg.evaluate("!!document.querySelector('#pAlbum')"))
    ok('ABS 章节行仍可见', pg.evaluate("document.querySelector('#pChapter')?.hidden") == False)
    ok('ABS 大字仍是书名', pg.evaluate("document.querySelector('#pTitle')?.textContent") == 'ABS 有声书',
       str(pg.evaluate("document.querySelector('#pTitle')?.textContent")))
    ok('ABS 章节行有内容', bool(pg.evaluate("document.querySelector('#pChapter')?.textContent")))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
