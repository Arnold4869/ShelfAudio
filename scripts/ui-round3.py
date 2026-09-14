#!/usr/bin/env python3
"""老板 2026-09-14 第三轮反馈验证（真浏览器，全部仅 ND）：
 1. 播放页：ND 无倍速/选集/±15秒按钮；有播放模式按钮 + 歌词按钮；定时在 ⋯ 菜单里
 2. 播放模式三态轮转 + 图标切换 + 持久化
 3. 点封面 → 歌词页（加载行/返回）
 4. ⋯ 菜单：睡眠定时项 + 添加到歌单项
 5. 歌单：播放页「添加到歌单」→ 选歌单 → 加歌请求发出
 6. 搜索结果多选：选择 / 全选 → 添加到歌单
 7. 首页三入口（ND）：历史记录 / 我的收藏 / 歌单
 8. ABS 播放页保持原样（倍速/选集/±15 秒都在）
 9. App 名 = 悦耳（boot 标题/登录页）
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
LYRICS = {'lyricsList':{'structuredLyrics':[{'synced':True,'line':[
    {'start':0,'value':'第一句'},{'start':5000,'value':'第二句'},{'start':10000,'value':'第三句'}]}]}}
STATE = {'playlists':{'pl1':{'id':'pl1','name':'我的最爱','songIds':[]}}, 'updateCalls':[]}

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
        if p=='/rest/getAlbum': return nd({'album':{**ND_ALBUM,'song':ND_SONGS}})
        if p=='/rest/search3':
            return nd({'searchResult3':{'album':[ND_ALBUM],'artist':[{'id':'art1','name':'歌手N'}],'song':ND_SONGS}})
        if p=='/rest/getStarred2': return nd({'starred2':{'album':[]}})
        if p=='/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
        if p=='/rest/getLyricsBySongId':
            sid = re.search(r'id=([^&]+)', u)
            return nd(LYRICS) if sid and sid.group(1) in ('nds1','nds2','nds3') else nd({'lyricsList':{}})
        if p=='/rest/getPlaylists':
            lst=[{'id':k,'name':v['name'],'songCount':len(v['songIds']),'duration':0,'owner':'u','public':False} for k,v in STATE['playlists'].items()]
            return nd({'playlists':{'playlist':lst}})
        if p=='/rest/getPlaylist':
            pid=re.search(r'id=([^&]+)',u).group(1)
            pl=STATE['playlists'].get(pid)
            if not pl: return nd({})
            entry=[s for s in ND_SONGS if s['id'] in pl['songIds']]
            return nd({'playlist':{'id':pid,'name':pl['name'],'songCount':len(entry),'duration':0,'entry':entry}})
        if p=='/rest/createPlaylist':
            pid='pl'+str(len(STATE['playlists'])+1)
            STATE['playlists'][pid]={'id':pid,'name':'新歌单','songIds':re.findall(r'songId=([^&]+)',u)}
            return nd({'playlist':{'id':pid,'name':'新歌单','songCount':len(STATE['playlists'][pid]['songIds'])}})
        if p=='/rest/updatePlaylist':
            pid=re.search(r'playlistId=([^&]+)',u).group(1)
            STATE['updateCalls'].append(u)
            adds=re.findall(r'songIdToAdd=([^&]+)',u)
            STATE['playlists'][pid]['songIds'] += adds
            return nd({})
        return nd({})
    return route.fulfill(status=200,content_type='application/json',body='{}')

ND_PREFS = """localStorage.setItem('shelfaudio.ndServer','http://127.0.0.1:4533');
  localStorage.setItem('shelfaudio.ndUser','u');localStorage.setItem('shelfaudio.ndPassword','p');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','nd');"""
ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

def newpage(br, prefs):
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs

with sync_playwright() as pw:
    br=pw.chromium.launch()

    print('=== 1/2/3/4. ND 播放页：按钮形态 / 模式轮转 / 歌词页 / ⋯菜单 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    # ND：首页点专辑 → 先进详情页（这是预期行为，老板要的「自己选个单曲」）
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
    ok('ND 首页点专辑 → 进详情页', pg.evaluate("document.body.dataset.view")=='album', pg.evaluate("document.body.dataset.view"))
    # 详情页点第一首 → 播放页
    pg.evaluate("document.querySelector('[data-idx=\"0\"]')?.click()"); pg.wait_for_timeout(2500)
    ok('点单曲 → 进播放页', pg.evaluate("document.body.dataset.view")=='player', pg.evaluate("document.body.dataset.view"))
    ok('ND 无倍速按钮', not pg.evaluate("!!document.querySelector('#btnRate')"))
    ok('ND 无选集按钮', not pg.evaluate("!!document.querySelector('#btnChapters')"))
    ok('ND 无后退15秒', not pg.evaluate("!!document.querySelector('#btnR15')"))
    ok('ND 无前进15秒', not pg.evaluate("!!document.querySelector('#btnF15')"))
    ok('有播放模式按钮', pg.evaluate("!!document.querySelector('#btnMode')"))
    ok('有歌词按钮', pg.evaluate("!!document.querySelector('#btnLyrics')"))
    ok('页面上没有「定时」chip（已进⋯）', not pg.evaluate("[...document.querySelectorAll('.tool-chip')].some(b=>b.textContent.includes('定时'))"))
    # 模式轮转
    icon1 = pg.evaluate("document.querySelector('#btnMode').innerHTML")
    pg.evaluate("document.querySelector('#btnMode').click()"); pg.wait_for_timeout(300)
    icon2 = pg.evaluate("document.querySelector('#btnMode').innerHTML")
    toast1 = pg.evaluate("document.querySelector('#toast').textContent")
    ok('模式切到单曲循环', toast1=='单曲循环', toast1)
    ok('图标跟着变了', icon1 != icon2)
    pg.evaluate("document.querySelector('#btnMode').click()"); pg.wait_for_timeout(300)
    ok('模式切到乱序播放', pg.evaluate("document.querySelector('#toast').textContent")=='乱序播放')
    pg.evaluate("document.querySelector('#btnMode').click()"); pg.wait_for_timeout(300)
    ok('转回顺序播放', pg.evaluate("document.querySelector('#toast').textContent")=='顺序播放')
    saved = pg.evaluate("localStorage.getItem('shelfaudio.playMode')")
    ok('模式已持久化（order）', saved=='order', str(saved))
    # 歌词页：点封面
    pg.evaluate("document.querySelector('.player-cover-wrap').click()"); pg.wait_for_timeout(900)
    ok('点封面打开了歌词页', pg.evaluate("!!document.querySelector('.lyrics-page')"))
    ok('歌词行渲染了', pg.evaluate("document.querySelectorAll('.lyrics-line').length")==3,
       str(pg.evaluate("document.querySelectorAll('.lyrics-line').length")))
    pg.evaluate("document.querySelector('#lyrBack')?.click()"); pg.wait_for_timeout(500)
    ok('歌词页能返回', not pg.evaluate("!!document.querySelector('.lyrics-page')"))
    # ⋯ 菜单
    pg.evaluate("document.querySelector('#btnMore').click()"); pg.wait_for_timeout(500)
    items = pg.evaluate("[...document.querySelectorAll('.sheet-item .sheet-label')].map(e=>e.textContent)")
    ok('⋯ 菜单含「睡眠定时」', any('睡眠定时' in (i or '') for i in items), str(items))
    ok('⋯ 菜单含「添加到歌单」', any('添加到歌单' in (i or '') for i in items), str(items))
    ok('⋯ 菜单仍含缓存/信息', any('缓存' in (i or '') for i in items) and any('信息' in (i or '') for i in items))
    # 添加到歌单流程
    pg.evaluate("[...document.querySelectorAll('.sheet-item')].find(b=>b.textContent.includes('添加到歌单'))?.click()")
    pg.wait_for_timeout(700)
    ok('弹出歌单选择器', pg.evaluate("!!document.querySelector('#plList')"))
    pg.evaluate("[...document.querySelectorAll('#plList .list-item')].find(e=>e.textContent.includes('我的最爱'))?.click()")
    pg.wait_for_timeout(700)
    ok('加歌请求已发出（updatePlaylist）', len(STATE['updateCalls'])>=1, str(len(STATE['updateCalls'])))
    ok('toast 报成功', '已添加' in (pg.evaluate("document.querySelector('#toast').textContent") or ''), pg.evaluate("document.querySelector('#toast').textContent"))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    print('=== 5. 歌单页：首页三入口 → 列表 → 详情 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    labels = pg.evaluate("[...document.querySelectorAll('.entry-btn .entry-label')].map(e=>e.textContent)")
    ok('首页三入口（历史/收藏/歌单）', labels==['历史记录','我的收藏','歌单'], str(labels))
    pg.evaluate("document.querySelector('#plEntryCard')?.click()"); pg.wait_for_timeout(1200)
    ok('进了歌单页', pg.evaluate("document.body.dataset.view")=='playlists', pg.evaluate("document.body.dataset.view"))
    ok('歌单列表有 1 个', pg.evaluate("document.querySelectorAll('#plBody [data-pl]').length")==1)
    pg.evaluate("document.querySelector('#plBody [data-pl]')?.click()"); pg.wait_for_timeout(1200)
    ok('进了歌单详情', pg.evaluate("document.body.dataset.view")=='playlistDetail', pg.evaluate("document.body.dataset.view"))
    ok('歌单详情有播放全部', pg.evaluate("!!document.querySelector('#playAll')"))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    print('=== 6. 搜索结果多选 / 全选 → 添加到歌单 ===')
    ctx, pg, errs = newpage(br, ND_PREFS)
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]')?.click()"); pg.wait_for_timeout(1200)
    pg.evaluate("document.querySelector('#q').value='歌'")
    pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1200)
    ok('歌曲组有「选择」入口', pg.evaluate("!!document.querySelector('#pickToggle')"))
    pg.evaluate("document.querySelector('#pickToggle').click()"); pg.wait_for_timeout(400)
    ok('勾选框出现了', pg.evaluate("document.querySelectorAll('.pick-box').length")==3)
    pg.evaluate("document.querySelectorAll('.list-item[data-song]')[0].click()")
    pg.evaluate("document.querySelectorAll('.list-item[data-song]')[1].click()"); pg.wait_for_timeout(300)
    ok('已选计数 = 2', '已选 2' in (pg.evaluate("document.querySelector('#pickCount').textContent") or ''), pg.evaluate("document.querySelector('#pickCount').textContent"))
    pg.evaluate("document.querySelector('#pickAll').click()"); pg.wait_for_timeout(300)
    ok('全选后计数 = 3', '已选 3' in (pg.evaluate("document.querySelector('#pickCount').textContent") or ''))
    n_before = len(STATE['updateCalls'])
    pg.evaluate("document.querySelector('#pickAdd').click()"); pg.wait_for_timeout(700)
    ok('弹出歌单选择器', pg.evaluate("!!document.querySelector('#plList')"))
    pg.evaluate("[...document.querySelectorAll('#plList .list-item')].find(e=>e.textContent.includes('我的最爱'))?.click()")
    pg.wait_for_timeout(700)
    ok('批量加歌请求已发出', len(STATE['updateCalls'])>n_before, f"{n_before}→{len(STATE['updateCalls'])}")
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    print('=== 8. ABS 播放页保持原样 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2200)
    ok('进播放页', pg.evaluate("document.body.dataset.view")=='player')
    ok('ABS 仍有倍速按钮', pg.evaluate("!!document.querySelector('#btnRate')"))
    ok('ABS 仍有选集按钮', pg.evaluate("!!document.querySelector('#btnChapters')"))
    ok('ABS 仍有 ±15 秒', pg.evaluate("!!document.querySelector('#btnR15') && !!document.querySelector('#btnF15')"))
    ok('ABS 无播放模式按钮（没让改）', not pg.evaluate("!!document.querySelector('#btnMode')"))
    ok('ABS 无歌词按钮', not pg.evaluate("!!document.querySelector('#btnLyrics')"))
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    print('=== 9. App 名 = 悦耳 ===')
    ctx, pg, errs = newpage(br, ABS_PREFS)
    ok('boot 标题是悦耳', pg.evaluate("document.querySelector('.boot-title')?.textContent")=='悦耳',
       pg.evaluate("document.querySelector('.boot-title')?.textContent"))
    ok('<title> 是悦耳', pg.title()=='悦耳', pg.title())
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}')
    sys.exit(1)
print('✅ 全部通过')
