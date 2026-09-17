#!/usr/bin/env python3
"""歌手行 / 专辑行 / 歌手页 布局几何审计（老板 2026-09-17 新功能）。

按 skill 的 UI 铁律：不靠读 CSS 推断，在真浏览器里量几何。
多屏宽（320 窄屏 / 390 手机 / 844×390 横屏 / 768 平板）：
  - 横向溢出（scrollWidth > clientWidth 且非合法横滑容器）
  - 触摸目标 < 44px
  - 歌手行与歌名/专辑行的垂直顺序与间距
  - 长歌手名（多人合作）是否撑破布局
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


# 长歌手名（多人合作）+ 超长歌名/专辑名：最容易撑破布局的输入
LONG_ARTIST = '张三丰/李四光/王五岳/赵六合/孙七巧/周八斗（合唱团）'
LONG_TITLE = '这是一个特别特别长的歌曲标题用来测试文本截断行为是否正确处理'
LONG_ALBUM = '这是一个特别特别长的专辑名称用来测试文本截断与换行是否会把布局撑破'

ART_ID = 'art1'
ALBUM = {'id': 'ndalb1', 'name': LONG_ALBUM, 'artist': LONG_ARTIST, 'artistId': ART_ID,
         'songCount': 2, 'duration': 300, 'coverArt': 'c1'}
SONGS = [
    {'id': 'nds1', 'albumId': 'ndalb1', 'title': LONG_TITLE, 'artist': LONG_ARTIST, 'artistId': ART_ID,
     'duration': 100, 'track': 1, 'contentType': 'audio/mpeg'},
    {'id': 'nds2', 'albumId': 'ndalb1', 'title': '短歌名', 'artist': LONG_ARTIST, 'artistId': ART_ID,
     'duration': 100, 'track': 2, 'contentType': 'audio/mpeg'},
]


def handler(route):
    u = route.request.url
    p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    qs = dict(x.split('=', 1) for x in u.split('?', 1)[1].split('&')) if '?' in u else {}
    if p == '/status':
        return route.fulfill(status=200, content_type='application/json', body='{"version":"2.36.0"}')
    if p == '/api/libraries':
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({'libraries': [{'id': 'abslib', 'name': '有声书'}]}))
    if p == '/api/me/items-in-progress':
        return route.fulfill(status=200, content_type='application/json', body='{"libraryItems":[]}')
    if p == '/api/me':
        return route.fulfill(status=200, content_type='application/json',
                             body='{"username":"bin","mediaProgress":[]}')
    if p.endswith('/cover'):
        return route.fulfill(status=200, content_type='image/png', body=PNG)
    if '/rest/' in p:
        def nd(b):
            return route.fulfill(status=200, content_type='application/json',
                                 body=json.dumps({'subsonic-response': {'status': 'ok', 'version': '1.16.1', **b}}))
        if p == '/rest/getMusicFolders':
            return nd({'musicFolders': {'musicFolder': [{'id': 'ndlib', 'name': '音乐'}]}})
        if p == '/rest/getAlbumList2':
            return nd({'albumList2': {'album': [ALBUM]}})
        if p == '/rest/getAlbum':
            return nd({'album': {**ALBUM, 'song': SONGS}})
        if p == '/rest/getArtist':
            return nd({'artist': {'id': ART_ID, 'name': LONG_ARTIST, 'albumCount': 1, 'album': [ALBUM]}})
        if p == '/rest/search3':
            return nd({'searchResult3': {'album': [ALBUM], 'artist': [{'id': ART_ID, 'name': LONG_ARTIST}],
                                         'song': SONGS}})
        if p == '/rest/getStarred2':
            return nd({'starred2': {'album': []}})
        if p == '/rest/getBookmarks':
            return nd({'bookmarks': {'bookmark': []}})
        if p == '/rest/getCoverArt':
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        return nd({})
    return route.fulfill(status=200, content_type='application/json', body='{}')


ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""

# 常见机型视口（含横屏/平板）
VIEWPORTS = [
    ('320 窄屏', 320, 568, True),
    ('390 手机', 390, 844, True),
    ('横屏 844×390', 844, 390, True),
    ('768 平板', 768, 1024, False),
]

OVERFLOW_JS = """(() => {
  const de = document.documentElement;
  // 合法横向滚动容器（横滑书架/歌单行）不算溢出
  const okScroll = [...document.querySelectorAll('*')].some(el => {
    const s = getComputedStyle(el);
    return (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  });
  return { doc: de.scrollWidth - de.clientWidth, okScroll };
})()"""

with sync_playwright() as pw:
    br = pw.chromium.launch()

    for label, w, h, mobile in VIEWPORTS:
        print(f'=== {label} ===')
        ctx = br.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=True)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
        pg.add_init_script(ND_PREFS)
        pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
        # 进播放页
        pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2000)
        pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
        ok('进了播放页', pg.evaluate("document.body.dataset.view") == 'player')

        geo = pg.evaluate("""(() => {
          const q = s => document.querySelector(s);
          const box = el => { if (!el) return null; const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
                     left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; };
          const title = q('#pTitle'), art = q('#pArtist'), alb = q('#pAlbum');
          // 歌手行文字是否被截断（scrollWidth > clientWidth 说明触发了省略号 —— 合法，但要确认元素本身没超宽）
          const nameEl = q('#pArtistName');
          return {
            title: box(title), artist: box(art), album: box(alb),
            artistHidden: art ? art.hidden : null,
            artistText: nameEl ? nameEl.textContent : null,
            artistClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
            vw: window.innerWidth,
            overflow: (() => { const de = document.documentElement;
              return de.scrollWidth - de.clientWidth; })(),
          };
        })()""")
        ok('歌手行可见', geo['artistHidden'] is False, str(geo['artistHidden']))
        ok('歌手行在歌名下方', geo['artist']['top'] >= geo['title']['bottom'] - 1,
           f"title.bottom={geo['title']['bottom']} artist.top={geo['artist']['top']}")
        ok('专辑行在歌手行下方', geo['album']['top'] >= geo['artist']['bottom'] - 1,
           f"artist.bottom={geo['artist']['bottom']} album.top={geo['album']['top']}")
        ok('歌手行触摸目标 ≥44px', geo['artist']['h'] >= 44, f"{geo['artist']['h']}px")
        ok('歌手行不超出视口宽度', geo['artist']['left'] >= -1 and geo['artist']['right'] <= geo['vw'] + 1,
           f"left={geo['artist']['left']} right={geo['artist']['right']} vw={geo['vw']}")
        ok('专辑行不超出视口宽度', geo['album']['left'] >= -1 and geo['album']['right'] <= geo['vw'] + 1,
           f"left={geo['album']['left']} right={geo['album']['right']} vw={geo['vw']}")
        # 320 窄屏：播放页有 0.9.0 就存在的既有横向溢出（.player-controls 五按钮
        # min-width 56×5 + gap 22 > 320，实测 32px）——skill 已记录、本轮范围外，
        # 且已用旧代码验证过同样的 32px（非本轮引入）。这里断言它没变差。
        if w <= 320:
            ok('窄屏溢出未超过既有基线（32px，非本轮引入）', geo['overflow'] <= 36,
               f"overflow={geo['overflow']}")
        else:
            ok('无文档级横向溢出', geo['overflow'] <= 1, f"overflow={geo['overflow']}")
        # 窄屏时歌手名必须被截断（长名放不下）；宽屏（横屏/平板）放得下就不截断，都算正常。
        # 断言改成「窄屏必截断，宽屏不溢出」——不再假设所有视口都必须 clipped。
        if w <= 390:
            ok('窄屏长歌手名被截断（不撑破）', geo['artistClipped'] is True, f"clipped={geo['artistClipped']}")
        else:
            ok('宽屏长歌手名完整显示且不溢出',
               geo['artist']['right'] <= geo['vw'] + 1,
               f"right={geo['artist']['right']} vw={geo['vw']}")

        # 歌手页几何
        pg.evaluate("document.querySelector('#pArtist')?.click()"); pg.wait_for_timeout(1800)
        ok('进了歌手页', pg.evaluate("document.body.dataset.view") == 'artist')
        ageo = pg.evaluate("""(() => {
          const de = document.documentElement;
          const av = document.querySelector('.artist-avatar');
          const nm = document.querySelector('.artist-hero-name');
          const r = av ? av.getBoundingClientRect() : null;
          return {
            overflow: de.scrollWidth - de.clientWidth,
            avatarW: r ? Math.round(r.width) : null,
            avatarLeft: r ? Math.round(r.left) : null,
            avatarRight: r ? Math.round(r.right) : null,
            nameRight: nm ? Math.round(nm.getBoundingClientRect().right) : null,
            vw: window.innerWidth,
            cards: document.querySelectorAll('.book-card[data-album]').length,
            songs: document.querySelectorAll('.list-item[data-song]').length,
          };
        })()""")
        ok('歌手页无横向溢出', ageo['overflow'] <= 1, f"overflow={ageo['overflow']}")
        ok('歌手页头像不超出视口', ageo['avatarLeft'] >= -1 and ageo['avatarRight'] <= ageo['vw'] + 1,
           f"{ageo['avatarLeft']}..{ageo['avatarRight']} vw={ageo['vw']}")
        ok('歌手页歌名不超出视口', ageo['nameRight'] is not None and ageo['nameRight'] <= ageo['vw'] + 1,
           f"nameRight={ageo['nameRight']} vw={ageo['vw']}")
        ok('歌手页列出专辑', ageo['cards'] >= 1, f"cards={ageo['cards']}")
        ok('歌手页列出歌曲', ageo['songs'] >= 1, f"songs={ageo['songs']}")
        # 320 窄屏播放页 overflow=32 是 0.9.0 既有问题（.player-controls 五按钮超宽），
        # skill 已记录、本轮范围外；这里只保证「歌手页自身」无溢出（上面已断言）。
        ok('无 JS 报错', not errs, str(errs[:2]))
        ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
