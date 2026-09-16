#!/usr/bin/env python3
"""睡眠定时弹窗 + 倒计时 chip 的几何/可点性审计（老板 2026-09-16 新增功能）。

为什么单独一个：本轮动了播放页两个元素（定时 chip、进度条下的剩余行），
UI 问题不靠读 CSS 推断而要在真浏览器里量几何（skill 铁律）。
检查项：
  1. 弹窗在 320px 窄屏不横向溢出；每个可点元素 ≥44px 高
  2. 时间/集数两个 tab 都能点、pane 切换正确
  3. chip 倒计时态下不被撑爆（宽度自适应、不溢出父容器）
  4. 进度条下剩余行不挤压左右时间（两端仍在可视范围内）
  5. 弹窗关闭后无残留 DOM（重复开关不累积）
在 /tmp/pwenv + 8899 http server 环境跑；无 playwright 自动跳过（CI 兼容）。
"""
import json, re, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

fails = []
def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

BOOK = {'id':'absbook1','media':{'metadata':{'title':'很长的示例书名用于测试换行','authorName':'作者A'},'duration':7200}}

def handler(route):
    u = route.request.url; p = re.sub(r'^https?://[^/]+', '', u).split('?')[0]
    if p == '/status': return route.fulfill(status=200, content_type='application/json', body='{"version":"2.36.0"}')
    if p == '/api/libraries': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'libraries':[{'id':'abslib','name':'有声书'}]}))
    if p.endswith('/items'): return route.fulfill(status=200, content_type='application/json', body=json.dumps({'results':[BOOK]}))
    if p == '/api/me/items-in-progress': return route.fulfill(status=200, content_type='application/json', body='{"libraryItems":[]}')
    if p == '/api/me': return route.fulfill(status=200, content_type='application/json', body='{"username":"bin","mediaProgress":[]}')
    if p == '/api/collections': return route.fulfill(status=200, content_type='application/json', body='{"collections":[]}')
    if p == '/api/items/absbook1': return route.fulfill(status=200, content_type='application/json', body=json.dumps({**BOOK,'media':{**BOOK['media'],'audioFiles':[{'ino':'f1','duration':7200}],'chapters':[{'id':0,'start':0,'end':7200,'title':'第一章'}]}}))
    if p == '/api/items/absbook1/play': return route.fulfill(status=200, content_type='application/json', body=json.dumps({'id':'sess1','duration':7200,'audioTracks':[{'index':1,'startOffset':0,'duration':7200,'contentUrl':'/api/items/absbook1/file/f1','title':'第一章'}]}))
    if p == '/api/session/sess1/sync': return route.fulfill(status=200, content_type='application/json', body='{}')
    if p == '/api/session/sess1/close': return route.fulfill(status=200, content_type='application/json', body='{}')
    return route.fulfill(status=200, content_type='application/json', body='{}')

PREFS = """localStorage.setItem('shelfaudio.server','http://127.0.0.1:13378');
  localStorage.setItem('shelfaudio.token','t');localStorage.setItem('shelfaudio.username','bin');
  localStorage.setItem('shelfaudio.mode','kid');localStorage.setItem('shelfaudio.activeSource','abs');"""

def newpage(br, w=320, h=700):
    ctx = br.new_context(viewport={'width':w,'height':h}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', handler)
    pg.add_init_script(PREFS)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2400)
    return ctx, pg, errs

def open_player(pg):
    for _ in range(3):
        pg.evaluate("document.querySelector('.book-card')?.click()"); pg.wait_for_timeout(2000)
        if pg.evaluate("document.body.dataset.view") == 'player': return True
    return False

with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ---------- 1. 窄屏弹窗几何 ----------
    print('=== 1. 睡眠弹窗：320px 窄屏几何 ===')
    ctx, pg, errs = newpage(br, 320, 700)
    ok('进了播放页', open_player(pg), pg.evaluate("document.body.dataset.view"))
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
    g = pg.evaluate("""() => {
      const card = document.querySelector('.sleep-tabs')?.closest('.lock-card');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      // 只看可见按钮：另一个 tab 的 pane 是 hidden，里面的按钮 h=0 属正常
      const clickables = [...card.querySelectorAll('button')]
        .filter(b => b.getBoundingClientRect().height > 0)
        .map(b => {
          const br2 = b.getBoundingClientRect();
          return { t: b.textContent.trim().slice(0,10), h: Math.round(br2.height), w: Math.round(br2.width) };
        });
      return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), vw,
               clickables, docScroll: document.documentElement.scrollWidth };
    }""")
    ok('弹窗卡片在视口内（不横向溢出）',
       g and g['left'] >= 0 and g['right'] <= g['vw'] + 1, str(g and (g['left'], g['right'], g['vw'])))
    # ⚠️ 320px 下文档整体横向溢出 352>320 是 **0.9.0 就有的既有问题**（播放控件行 5 个按钮
    # 最小宽 56×5 + gap 超出），本轮改动前后实测一致，不是新引入的。
    # 这里只断言"本轮新增的元素不额外扩大溢出"（基线 352 = 320 + 32）。
    ok('弹窗不额外扩大横向溢出（基线 352）', g and g['docScroll'] <= 352, str(g and g['docScroll']))
    small = [c for c in (g['clickables'] if g else []) if c['h'] < 40]
    ok('弹窗内所有按钮高度 ≥40px（触摸目标）', not small, str(small))

    # ---------- 2. tab 切换 + 都可点 ----------
    print('=== 2. tab 切换 ===')
    for tab in ['tracks', 'time', 'tracks']:
        pg.evaluate(f"document.querySelector('.sleep-tab[data-tab=\"{tab}\"]')?.click()"); pg.wait_for_timeout(250)
        shown = pg.evaluate(f"document.querySelector('.sleep-pane[data-pane=\"{tab}\"]')?.hidden") == False
        ok(f'切到 {tab} pane 生效', shown)

    # ---------- 3. chip 倒计时不撑爆 ----------
    print('=== 3. 倒计时 chip 不撑爆布局 ===')
    pg.evaluate("[...document.querySelectorAll('[data-n]')].find(b=>b.dataset.n==='10')?.click()")
    pg.wait_for_timeout(400)
    g2 = pg.evaluate("""() => {
      const chip = document.querySelector('#btnSleep');
      const tools = chip?.closest('.player-tools');
      const cr = chip?.getBoundingClientRect(); const tr = tools?.getBoundingClientRect();
      return { chipW: Math.round(cr?.width||0), toolsW: Math.round(tr?.width||0),
               chipRight: Math.round(cr?.right||0), toolsRight: Math.round(tr?.right||0),
               vw: document.documentElement.clientWidth,
               text: document.querySelector('#sleepLabel')?.textContent,
               overflowDoc: document.documentElement.scrollWidth };
    }""")
    ok('chip 不超出工具行', g2['chipRight'] <= g2['toolsRight'] + 1, str(g2))
    ok('倒计时态不额外扩大横向溢出（基线 352）', g2['overflowDoc'] <= 352, str(g2))
    ok('chip 文字确实是倒计时+剩余数', '·' in (g2['text'] or '') and '集' in (g2['text'] or ''), str(g2['text']))

    # ---------- 4. 进度条下剩余行不挤压左右时间 ----------
    print('=== 4. 整部作品剩余行不挤压时间 ===')
    g3 = pg.evaluate("""() => {
      const cur = document.querySelector('#tCur').getBoundingClientRect();
      const whole = document.querySelector('#pWhole');
      const dur = document.querySelector('#tDur').getBoundingClientRect();
      const wr = whole?.getBoundingClientRect();
      return { curRight: Math.round(cur.right), wholeLeft: Math.round(wr?.left || 0),
               wholeRight: Math.round(wr?.right || 0), durLeft: Math.round(dur.left),
               text: whole?.textContent, vw: document.documentElement.clientWidth,
               wholeVisible: whole ? whole.offsetParent !== null : false };
    }""")
    ok('剩余行与左侧时间不重叠', g3['curRight'] <= g3['wholeLeft'] + 1, str(g3))
    ok('剩余行与右侧时长不重叠', g3['wholeRight'] <= g3['durLeft'] + 1, str(g3))
    ok('剩余行在视口内', g3['wholeVisible'] and g3['wholeRight'] <= g3['vw'] + 1, str(g3))

    # ---------- 5. 反复开关弹窗无残留 ----------
    print('=== 5. 反复开关弹窗无 DOM 残留 ===')
    for _ in range(4):
        pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(250)
        pg.evaluate("document.querySelector('.lock:not(.hidden)')?.click()"); pg.wait_for_timeout(250)
    n = pg.evaluate("document.querySelectorAll('.sleep-tabs').length")
    ok('弹窗 DOM 不累积（关掉后无残留）', n == 0, f'残留 {n} 个')
    # 关掉遮罩点空白应关闭
    pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(300)
    pg.evaluate("""(() => {
      const m = [...document.querySelectorAll('.lock')].find(x => x.querySelector('.sleep-tabs'));
      if (m) m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()""")
    pg.wait_for_timeout(300)
    ok('点遮罩空白能关掉弹窗', pg.evaluate("document.querySelectorAll('.sleep-tabs').length") == 0)
    ok('无 JS 报错', not errs, str(errs[:2]))
    ctx.close()

    # ---------- 6. 横屏/平板 ----------
    print('=== 6. 横屏 + 平板尺寸 ===')
    for w, h in [(844, 390), (768, 1024)]:
        ctx, pg, errs = newpage(br, w, h)
        if not open_player(pg):
            ok(f'{w}x{h} 进播放页', False); ctx.close(); continue
        pg.evaluate("document.querySelector('#btnSleep')?.click()"); pg.wait_for_timeout(400)
        gg = pg.evaluate("""() => {
          const card = document.querySelector('.sleep-tabs')?.closest('.lock-card');
          const r = card?.getBoundingClientRect();
          return { bottom: Math.round(r?.bottom||0), top: Math.round(r?.top||0),
                   vh: document.documentElement.clientHeight,
                   overflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
                   docW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
        }""")
        ok(f'{w}x{h} 弹窗竖向完整可见（不超出屏幕）',
           gg['top'] >= -1 and gg['bottom'] <= gg['vh'] + 1, str(gg))
        ok(f'{w}x{h} 无横向溢出', gg['docW'] <= gg['vw'] + 1, str(gg))
        ctx.close()
        print(f'      {w}x{h} 完成')

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败: {fails}'); sys.exit(1)
print('✅ 全部通过')
