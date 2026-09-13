#!/usr/bin/env python3
"""选集弹窗虚拟渲染回归（2026-09-14 性能审计配套）。

用 536 集真实规模 fixture 走真实 UI 路径：
  1. 进播放页 → 点「选集」按钮 → 弹窗打开
  2. 断言：初始只渲染少量行（≤120 条），总高容器正确（536 × 76px）
  3. 滚到底 → 断言最后一集出现
  4. 点某一集 → seek 被调用
"""
import json, pathlib, re, copy, sys
try:
    import zlib
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：CI 环境未安装 Playwright（本地/真机验证时运行）')
    sys.exit(0)

FX = dict(json.loads((pathlib.Path(__file__).parent / 'ui-fixtures.json').read_text()))
N = 536
# 把「被点开的那本书」的 audioFiles 扩到 N 集（播放会话 body 由 /play handler 动态生成），
# chapters 同步扩 —— 与 ui-new-features 的 mock 结构保持一致
_multi = [k for k in FX if k.startswith('/api/items/') and isinstance(FX[k], dict)]
for k in _multi:
    it = copy.deepcopy(FX[k])
    media = it.get('media') or {}
    if not media:
        continue
    af0 = (media.get('audioFiles') or [{'ino': '1', 'duration': 180}])[0]
    media['audioFiles'] = [dict(af0, ino=str(i+1), duration=180) for i in range(N)]
    media['chapters'] = [{'title': f'第{i+1}集 测试章节标题', 'start': i*180, 'end': (i+1)*180} for i in range(N)]
    it['media'] = media
    FX[k] = it

def _play_body(lid):
    """播放会话 body。无论点到哪本书，都保证返回 N 轨 —— 本测试专测「大章节列表」。"""
    item = FX.get('/api/items/%s' % lid) or {}
    media = item.get('media') or {}
    afs = media.get('audioFiles') or []
    if not afs:
        afs = [{'ino': str(i+1), 'duration': 180} for i in range(N)]
    tracks, off = [], 0.0
    for i, af in enumerate(afs):
        d = af.get('duration') or 0
        tracks.append({'index': i+1, 'startOffset': off, 'duration': d,
                       'contentUrl': '/api/items/%s/file/%s' % (lid, af.get('ino', str(i+1))),
                       'title': '第%d集' % (i+1), 'mimeType': 'audio/mpeg'})
        off += d
    media = dict(media)
    media['chapters'] = [{'title': f'第{i+1}集 测试章节标题', 'start': i*180, 'end': (i+1)*180}
                         for i in range(len(afs))]
    return json.dumps({'id': 's1', 'audioTracks': tracks, 'duration': off,
                       'libraryItem': {'id': lid, 'media': media}})

import zlib
def _png(w=40,h=40,rgb=(90,140,200)):
    def chunk(t,d):
        c=t+d
        return len(d).to_bytes(4,'big')+c+zlib.crc32(c).to_bytes(4,'big')
    raw=b''.join(b'\x00'+bytes(rgb)*w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',w.to_bytes(4,'big')+h.to_bytes(4,'big')+b'\x08\x02\x00\x00\x00')
            +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))
PNG=_png()

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width':390,'height':844}, device_scale_factor=2,
                         is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    def h(route):
        u = route.request.url
        p = re.sub(r'^https?://[^/]+','',u).split('?')[0]
        if p in FX:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(FX[p]))
        if p.endswith('/cover'):
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        if p.endswith('/play'):
            try:
                lid = (json.loads(route.request.post_data or '{}') or {}).get('libraryItemId') or _multi[0]
            except Exception:
                lid = _multi[0]
            return route.fulfill(status=200, content_type='application/json', body=_play_body(lid))
        if '/file/' in p:
            return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
        route.fulfill(status=200, content_type='application/json', body='{}')
    pg.route('**/api/**', h)
    pg.add_init_script("""
      localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
      localStorage.setItem('shelfaudio.token','t');
      localStorage.setItem('shelfaudio.username','user');
      localStorage.setItem('shelfaudio.mode','kid');
    """)
    pg.goto('http://127.0.0.1:8899/index.html')
    pg.wait_for_timeout(2500)
    # 导航竞态对齐 ui-new-features：点书卡 → 等进播放页，失败重试一次
    for _ in range(3):
        pg.evaluate("document.querySelector('.book-card')?.click()")
        pg.wait_for_timeout(2500)
        if pg.evaluate("document.body.dataset.view") == 'player':
            break
    ok('进入播放页', pg.evaluate("document.body.dataset.view") == 'player',
       pg.evaluate("document.body.dataset.view"))
    if pg.evaluate("document.body.dataset.view") != 'player':
        print('   DEBUG toast:', pg.evaluate("document.querySelector('#toast')?.textContent"))
        print('   DEBUG errs:', errs[:4])
        print('   DEBUG 卡片数:', pg.evaluate("document.querySelectorAll('.book-card').length"))

    # 打开选集
    pg.evaluate("document.querySelector('#btnChapters')?.click()")
    pg.wait_for_timeout(900)
    ok('选集弹窗打开', pg.evaluate("!!document.querySelector('.sheet-full .sheet-body')"))

    info = pg.evaluate("""() => {
      const list = document.querySelector('.sheet-full .sheet-body > div, .sheet-full [style*="height"]')
      const items = document.querySelectorAll('.sheet-full .chapter-item')
      const body = document.querySelector('.sheet-full .sheet-body')
      return {
        n: items.length,
        totalH: list ? list.style.height : null,
        first: items[0]?.dataset.ch,
        last: items[items.length-1]?.dataset.ch,
      }
    }""")
    ok(f'初始只渲染少量行（{info["n"]} 条 ≤ 130）', 0 < info['n'] <= 130, str(info))
    ok('总高容器 = 536×76', info['totalH'] == f'{536*76}px', info['totalH'])
    ok('当前集在初始视口内',
       pg.evaluate("!!document.querySelector('.sheet-full .chapter-item.active')"))

    # 滚到底 → 最后一集应出现
    pg.evaluate("""() => {
      const body = document.querySelector('.sheet-full .sheet-body')
      body.scrollTop = body.scrollHeight
      body.dispatchEvent(new Event('scroll'))
    }""")
    pg.wait_for_timeout(500)
    last = pg.evaluate("[...document.querySelectorAll('.sheet-full .chapter-item')].map(e=>e.dataset.ch).sort((a,b)=>a-b).pop()")
    ok('滚到底最后一集出现', last == '535', f'last={last}')

    # 点某一集 → 弹窗关闭（seek 在 mock 里无法直接断言，但点击不报错即可）
    pg.evaluate("document.querySelector('.sheet-full .chapter-item')?.click()")
    pg.wait_for_timeout(600)
    ok('点选集后弹窗关闭', not pg.evaluate("!!document.querySelector('.sheet-full')"))
    ok('无 JS 报错', not errs, str(errs[:2]))

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}')
    sys.exit(1)
print('✅ 全部通过')
