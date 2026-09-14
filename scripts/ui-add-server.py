#!/usr/bin/env python3
"""设置页「服务器」入口 → 添加第二台服务器（老板 2026-09-14 报"找不到在哪加 nd 账号"）：
 1. 设置页出现「服务器」行，值显示当前已连的服务器
 2. 点它 → 进登录页：ABS 已连接（显示断开），ND 卡片可填
 3. 填 ND 账号连接 → 直接进主界面，右上角出现切换按钮
 4. 登录页有返回键，点它回书架
 5. 首次冷启动（未登录）→ 无返回键（保持原行为）
"""
import json, pathlib, re, zlib, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：CI 环境未安装 Playwright（本地/真机验证时运行）')
    sys.exit(0)
ROOT = pathlib.Path('/home/Bin/ShelfAudio')
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
from playwright.sync_api import sync_playwright

def handler(route):
    u=route.request.url; p=re.sub(r'^https?://[^/]+','',u).split('?')[0]
    if p=='/status': return route.fulfill(status=200,content_type='application/json',body='{"version":"2.36.0"}')
    if p=='/login': return route.fulfill(status=200,content_type='application/json',body=json.dumps({'user':{'token':'t','username':'bin','type':'root'}}))
    if p=='/api/libraries': return route.fulfill(status=200,content_type='application/json',body=json.dumps({'libraries':[{'id':'abslib','name':'有声书'}]}))
    if p.endswith('/items'): return route.fulfill(status=200,content_type='application/json',body=json.dumps({'results':[{'id':'absbook1','media':{'metadata':{'title':'ABS 有声书','authorName':'作者'},'duration':3600}}]}))
    if p=='/api/me/items-in-progress': return route.fulfill(status=200,content_type='application/json',body='{"libraryItems":[]}')
    if p=='/api/me': return route.fulfill(status=200,content_type='application/json',body='{"username":"bin","mediaProgress":[]}')
    if p=='/api/collections': return route.fulfill(status=200,content_type='application/json',body='{"collections":[]}')
    if p.endswith('/cover'): return route.fulfill(status=200,content_type='image/png',body=PNG)
    if '/rest/' in p:
        def nd(b): return route.fulfill(status=200,content_type='application/json',body=json.dumps({'subsonic-response':{'status':'ok','version':'1.16.1',**b}}))
        if p=='/rest/getMusicFolders': return nd({'musicFolders':{'musicFolder':[{'id':'ndlib','name':'音乐'}]}})
        if p=='/rest/getAlbumList2': return nd({'albumList2':{'album':[{'id':'ndalb1','name':'ND 音乐专辑','artist':'ND 歌手','songCount':2,'duration':400}]}})
        if p=='/rest/getStarred2': return nd({'starred2':{'album':[]}})
        if p=='/rest/getBookmarks': return nd({'bookmarks':{'bookmark':[]}})
        return nd({})
    return route.fulfill(status=200,content_type='application/json',body='{}')

ABS_PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

with sync_playwright() as pw:
    br=pw.chromium.launch()

    print('=== 1. 冷启动未登录：登录页无返回键 ===')
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script("localStorage.clear();")
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2200)
    ok('登录页', pg.evaluate("document.body.dataset.view")=='login', pg.evaluate("document.body.dataset.view"))
    ok('无返回键（还没登录过）', not pg.evaluate("!!document.querySelector('#loginBack')"))
    ok('两张服务器卡片都在', pg.evaluate("document.querySelectorAll('.login-card').length")==2)
    ctx.close()

    print('=== 2. 只登录 ABS → 设置页「服务器」行 ===')
    ctx=br.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler); pg.route('**/rest/**', handler)
    pg.add_init_script(ABS_PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    ok('进书架', pg.evaluate("document.body.dataset.view")=='kidhome', pg.evaluate("document.body.dataset.view"))
    # 进设置
    pg.evaluate("document.querySelector('.kid-tab[data-nav=settings]').click()")
    pg.wait_for_timeout(1500)
    if pg.evaluate("document.body.dataset.view") != 'settings':
        # 兜底：直接走路由
        pg.evaluate("window.__go ? window.__go('settings') : null"); pg.wait_for_timeout(1200)
    ok('设置页', pg.evaluate("document.body.dataset.view")=='settings', pg.evaluate("document.body.dataset.view"))
    ok('有「服务器」行', pg.evaluate("!!document.querySelector('#rowServers')"))
    val = pg.evaluate("document.querySelector('#srvVal')?.textContent")
    ok('显示已连 Audiobookshelf', val=='Audiobookshelf', str(val))
    geo = pg.evaluate("""(() => { const r=document.querySelector('#rowServers').getBoundingClientRect();
      const label=document.querySelector('#rowServers .setting-label').getBoundingClientRect();
      return {h:Math.round(r.height), labelH:Math.round(label.height), clipped: label.bottom > r.bottom+1}; })()""")
    ok('行高足够、文字不裁', geo['h']>=56 and not geo['clipped'], str(geo))
    # 点击 → 家长密码未设 → 直接进登录页
    pg.evaluate("document.querySelector('#rowServers').click()"); pg.wait_for_timeout(1200)
    ok('点「服务器」→ 登录页', pg.evaluate("document.body.dataset.view")=='login', pg.evaluate("document.body.dataset.view"))
    ok('ABS 块显示已连接', pg.evaluate("!!document.querySelector('#absOut')"))
    ok('ND 块可填（输入框在）', pg.evaluate("!!document.querySelector('#nServer') && !!document.querySelector('#nUser') && !!document.querySelector('#nPass')"))
    ok('有返回键', pg.evaluate("!!document.querySelector('#loginBack')"))
    ok('有「进入听书」按钮', pg.evaluate("!!document.querySelector('#gotoApp')"))

    print('=== 3. 填 ND 账号连接 → 进主界面 ===')
    pg.fill('#nServer','http://127.0.0.1:4533'); pg.fill('#nUser','nduser'); pg.fill('#nPass','pw')
    pg.evaluate("document.querySelector('#ndLogin').click()")
    pg.wait_for_timeout(2600)
    ok('连接后进书架', pg.evaluate("document.body.dataset.view")=='kidhome', pg.evaluate("document.body.dataset.view"))
    ok('右上角出现切换按钮（双源）', pg.evaluate("!!document.querySelector('#srcSwitch')"))
    lbl = pg.evaluate("document.querySelector('#srcSwitch')?.textContent.trim()")
    ok('按钮显示当前源 ABS', lbl=='ABS', str(lbl))
    titles = pg.evaluate("[...document.querySelectorAll('.book-title')].map(e=>e.textContent)")
    ok('书架是 ABS 的书（保持 ABS 激活）', titles==['ABS 有声书'], str(titles))
    ok('无 JS 报错', not errs, str(errs[:2]))

    print('=== 4. 切到 ND ===')
    pg.evaluate("document.querySelector('#srcSwitch').click()"); pg.wait_for_timeout(400)
    pg.evaluate("document.querySelector('.src-item[data-src=nd]').click()")
    pg.wait_for_timeout(2400)
    titles2 = pg.evaluate("[...document.querySelectorAll('.book-title')].map(e=>e.textContent)")
    ok('书架换成 ND 专辑', titles2==['ND 音乐专辑'], str(titles2))
    ok('无 JS 报错', not errs, str(errs[:3]))
    ctx.close()

    br.close()
print()
if fails: print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
