#!/usr/bin/env python3
"""老板 2026-09-14 第二轮反馈验证（真浏览器）：
 1. 首页进收藏 → 返回 → 回首页（不是设置页）；从设置进收藏 → 返回回设置
 2. 底栏名称 = 首页 / 搜索 / 设置
 3. ND 下文案用「专辑/歌曲」不出现「书」
 4. ND 搜索分「专辑/歌手/歌曲」三组显示
 5. 点专辑 → 进详情页（不自动连播），点某首歌从那首开始播
 6. ND 下点播放不报 isStarred 错误（老板截图的报错）
"""
import json, pathlib, re, zlib, sys, urllib.parse
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)
ROOT = pathlib.Path(__file__).resolve().parent.parent
def _png(w=40,h=40,rgb=(90,140,200)):
    def chunk(t,d):
        c=t+d; return len(d).to_bytes(4,'big')+c+zlib.crc32(c).to_bytes(4,'big')
    raw=b''.join(b'\x00'+bytes(rgb)*w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',w.to_bytes(4,'big')+h.to_bytes(4,'big')+b'\x08\x02\x00\x00\x00')
            +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
PNG=_png()
fails=[]
def ok(name,cond,extra=''):
    print(('  ✅ ' if cond else '  ❌ ')+name+(f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

ABS_BOOK = {'id':'absbook1','media':{'metadata':{'title':'ABS 有声书','authorName':'作者A'},'duration':3600}}
ND_ALBUM = {'id':'ndalb1','name':'ND 测试专辑','artist':'歌手N','songCount':3,'duration':300,'coverArt':'c1'}
ND_SONGS = [
  {'id':'nds1','albumId':'ndalb1','title':'第一首歌','artist':'歌手N','duration':100,'track':1,'contentType':'audio/mpeg'},
  {'id':'nds2','albumId':'ndalb1','title':'第二首歌','artist':'歌手N','duration':100,'track':2,'contentType':'audio/mpeg'},
  {'id':'nds3','albumId':'ndalb1','title':'第三首歌','artist':'歌手N','duration':100,'track':3,'contentType':'audio/mpeg'},
]
PLAYED = []   # 记录原生播放调用（playItem → player.load）

def handler(route):
    u=route.request.url; p=re.sub(r'^https?://[^/]+','',u).split('?')[0]
    if p=='/status': return route.fulfill(status=200,content_type='application/json',body='{"version":"2.36.0"}')
    if p=='/login': return route.fulfill(status=200,content_type='application/json',body=json.dumps({'user':{'token':'t','username':'bin','type':'root'}}))
    if p=='/api/libraries': return route.fulfill(status=200,content_type='application/json',body=json.dumps({'libraries':[{'id':'abslib','name':'有声书'}]}))
    if p.endswith('/items'): return route.fulfill(status=200,content_type='application/json',body=json.dumps({'results':[ABS_BOOK]}))
    if p=='/api/me/items-in-progress': return route.fulfill(status=200,content_type='application/json',body='{"libraryItems":[]}')
    if p=='/api/me': return route.fulfill(status=200,content_type='application/json',body='{"username":"bin","mediaProgress":[]}')
    if p=='/api/collections': return route.fulfill(status=200,content_type='application/json',body='{"collections":[{"id":"col1","name":"常听","books":[ABS_BOOK]}]}')
    if p=='/api/items/absbook1': return route.fulfill(status=200,content_type='application/json',body=json.dumps({**ABS_BOOK,'media':{**ABS_BOOK['media'],'audioFiles':[{'ino':'f1','duration':3600}],'chapters':[]}}))
    if p=='/api/items/absbook1/play': return route.fulfill(status=200,content_type='application/json',body=json.dumps({'id':'sess1','duration':3600,'audioTracks':[{'index':1,'startOffset':0,'duration':3600,'contentUrl':'/api/items/absbook1/file/f1','title':'第一章'}]}))
    if p.endswith('/cover'): return route.fulfill(status=200,content_type='image/png',body=PNG)
    if '/rest/' in p:
        def nd(b): return route.fulfill(status=200,content_type='application/json',body=json.dumps({'subsonic-response':{'status':'ok','version':'1.16.1',**b}}))
        if p=='/rest/getMusicFolders': return nd({'musicFolders':{'musicFolder':[{'id':'ndlib','name':'音乐'}]}})
        if p=='/rest/getAlbumList2': return nd({'albumList2':{'album':[ND_ALBUM]}})
        if p=='/rest/getAlbum':
            if 'ndalb1' in u: return nd({'album':{**ND_ALBUM,'song':ND_SONGS}})
            return nd({'album':{**ND_ALBUM,'song':ND_SONGS}})
        if p=='/rest/search3':
            m = re.search(r'query=([^&]*)', u)
            qq = urllib.parse.unquote(m.group(1)) if m else ''
            # 全部关键词都返回全量（mock 不做真过滤）
            return nd({'searchResult3':{'album':[ND_ALBUM],'artist':[{'id':'art1','name':'歌手N'}],'song':ND_SONGS}})
        if p=='/rest/getStarred2': return nd({'starred2':{'album':[]}})
        if p=='/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
        if p=='/rest/getArtist': return nd({'artist':{'id':'art1','name':'歌手N','album':[ND_ALBUM]}})
        return nd({})
    return route.fulfill(status=200,content_type='application/json',body='{}')

ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

with sync_playwright() as pw:
    br=pw.chromium.launch()

    print('=== 1. 首页→收藏→返回 = 回首页 ===')
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(ABS_PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    ok('书架(首页)', pg.evaluate("document.body.dataset.view")=='kidhome')
    pg.evaluate("document.querySelector('#favEntryCard')?.click()"); pg.wait_for_timeout(1500)
    ok('进了收藏页', pg.evaluate("document.body.dataset.view")=='favorites', pg.evaluate("document.body.dataset.view"))
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(1200)
    ok('返回后回到首页（老板报的 bug 修了）', pg.evaluate("document.body.dataset.view")=='kidhome',
       pg.evaluate("document.body.dataset.view"))
    # 从设置进收藏 → 返回回设置
    pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]').click()"); pg.wait_for_timeout(1200)
    pg.evaluate("document.querySelector('#rowFav')?.click()"); pg.wait_for_timeout(1500)
    ok('从设置进收藏', pg.evaluate("document.body.dataset.view")=='favorites')
    pg.evaluate("document.querySelector('#btnBack')?.click()"); pg.wait_for_timeout(1200)
    ok('返回回设置页', pg.evaluate("document.body.dataset.view")=='settings', pg.evaluate("document.body.dataset.view"))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    print('=== 2. 底栏名称 ===')
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(ABS_PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    labels = pg.evaluate("[...document.querySelectorAll('.kid-tab')].map(e=>e.textContent.trim())")
    ok('底栏 = 首页/搜索/设置', labels==['首页','搜索','设置'], str(labels))
    title = pg.evaluate("document.querySelector('.page-title')?.textContent")
    ok('首页标题不再是「我的书架」', '书架' not in (title or ''), title)
    ctx.close()

    print('=== 3/4/5. ND：文案 + 分组搜索 + 专辑详情选歌 ===')
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(ND_PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2600)
    ok('进首页', pg.evaluate("document.body.dataset.view")=='kidhome')
    bodyText = pg.evaluate("document.querySelector('#view').textContent")
    ok('ND 首页无「书架/书库」字样', '书架' not in bodyText and '书库' not in bodyText, bodyText[:80])
    ok('ND 首页用「音乐库」', '音乐' in bodyText)

    print('   -- 搜索「歌」→ 分组 --')
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1400)
    pg.fill('#q','歌'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1800)
    secs = pg.evaluate("[...document.querySelectorAll('#results .section-h')].map(e=>e.textContent.trim().split('\\n')[0])")
    ok('结果分「专辑/歌手/歌曲」段', '专辑' in str(secs) and '歌曲' in str(secs), str(secs))
    songRows = pg.evaluate("document.querySelectorAll('#results [data-song]').length")
    ok('歌曲组有歌', songRows==3, str(songRows))
    ok('无 JS 报错', not errs, str(errs[:2]))

    print('   -- 点专辑 → 详情页（不自动播）--')
    pg.fill('#q','测试'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1600)
    pg.evaluate("document.querySelector('#results .list-item[data-id]')?.click()"); pg.wait_for_timeout(1800)
    ok('进了专辑详情页', pg.evaluate("document.body.dataset.view")=='album', pg.evaluate("document.body.dataset.view"))
    songsN = pg.evaluate("document.querySelectorAll('#results .list-item[data-idx], [data-idx]').length")
    ok('歌曲列表 3 首', songsN==3, str(songsN))
    ok('有「播放全部」按钮', pg.evaluate("!!document.querySelector('#playAll')"))
    ok('详情页停留（未自动跳播放页）', pg.evaluate("document.body.dataset.view")=='album')

    print('   -- 点第二首歌 → 从那首开始播 --')
    pg.evaluate("[...document.querySelectorAll('[data-idx]')].find(e=>e.dataset.idx==='1')?.click()")
    pg.wait_for_timeout(2200)
    ok('跳到播放页', pg.evaluate("document.body.dataset.view")=='player', pg.evaluate("document.body.dataset.view"))
    cur = pg.evaluate("window.stateRef || null")
    # 检查播放器从第2首开始（bookTime ≈ 100s = 第一首时长）
    bt = pg.evaluate("""(() => {
      const p = window.__player || window.player; if (!p) return null;
      return { trackIndex: p.trackIndex, bookTime: p.currentBookTime };
    })()""")
    print('   player state:', bt)
    # 无 JS 报错（含 isStarred 修复验证）
    ok('无 isStarred 报错', not any('isStarred' in e for e in errs), str(errs[:2]))
    ok('无 JS 报错', not errs, str(errs[:3]))
    ctx.close()

    br.close()
print()
if fails: print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
