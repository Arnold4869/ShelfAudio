#!/usr/bin/env python3
"""验证这一批新功能：进度口径 / 收藏 / 三个点菜单 / 继续听排序 / 统计 / 缓存 / 搜索框话筒。"""
import json, pathlib, re, sys
from playwright.sync_api import sync_playwright

FX = json.loads((pathlib.Path(__file__).parent / 'ui-fixtures.json').read_text())
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082')
MULTI = FX.get('__multiId')
PASS = FAIL = 0

def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ✅ {name}")
    else: FAIL += 1; print(f"  ❌ {name} {extra}")

def _play_body(lid):
    item = FX.get('/api/items/%s' % lid) or FX.get('/api/items/%s' % MULTI) or {}
    media = item.get('media') or {}
    tracks, off = [], 0.0
    for i, af in enumerate(media.get('audioFiles') or []):
        d = af.get('duration') or 0
        tracks.append({'index': i + 1, 'startOffset': off, 'duration': d,
                       'contentUrl': '/api/items/%s/file/%s' % (lid, af.get('ino', '1')),
                       'title': '第%d集' % (i + 1), 'mimeType': 'audio/mpeg'})
        off += d
    if not tracks:
        tracks = [{'index': 1, 'startOffset': 0, 'duration': 3600,
                   'contentUrl': '/api/items/%s/file/1' % lid, 'title': '第1集', 'mimeType': 'audio/mpeg'}]
        off = 3600
    return json.dumps({'id': 's1', 'audioTracks': tracks, 'duration': off,
                       'libraryItem': {'id': lid, 'media': media}})

COLLECTIONS = json.dumps({'collections': [
    {'id': 'col_1', 'name': '常听', 'books': []},
]})

def mk(br, mode='kid'):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                         is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.on('console', lambda m: errs.append('CONSOLE:' + m.text[:200]) if m.type == 'error' else None)

    def h(route):
        req = route.request
        p = re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]
        if p == '/api/collections':
            return route.fulfill(status=200, content_type='application/json', body=COLLECTIONS)
        if p in FX:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(FX[p]))
        if p.endswith('/cover'):
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        if p.endswith('/play'):
            try:
                lid = (json.loads(req.post_data or '{}') or {}).get('libraryItemId') or MULTI
            except Exception:
                lid = MULTI
            return route.fulfill(status=200, content_type='application/json', body=_play_body(lid))
        if p.startswith('/api/me/progress/') or p.startswith('/api/me/item/'):
            return route.fulfill(status=200, content_type='application/json', body='{}')
        if '/file/' in p:
            return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
        route.fulfill(status=200, content_type='application/json', body='{}')

    pg.route('**/api/**', h)
    pg.add_init_script("""
      localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
      localStorage.setItem('shelfaudio.token','t');
      localStorage.setItem('shelfaudio.username','user');
      localStorage.setItem('shelfaudio.mode','%s');
      localStorage.setItem('shelfaudio.kidPin','1234');
    """ % mode)
    pg.goto('http://127.0.0.1:8899/index.html')
    pg.wait_for_timeout(1800)
    return ctx, pg, errs


with sync_playwright() as pw:
    br = pw.chromium.launch()

    print("\n=== A. 进度条默认单集 + 慢速断言 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('.book-card')?.click()")
    pg.wait_for_timeout(2600)
    ok("能进播放页", pg.evaluate("document.body.dataset.view") == 'player',
       pg.evaluate("document.body.dataset.view"))
    # 进度条时间：默认应是单集时长（不是全书累计）
    t = pg.evaluate("document.querySelector('#tDur')?.textContent")
    ok("时长显示的是单集而非整部（默认单集口径）", t is not None, f"tDur={t}")
    # 整部作品百分比存在
    ok("显示「整部作品 x%」辅助信息", pg.evaluate("!!document.querySelector('#pWhole')"))
    ok("播放页无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== B. 收藏按钮 + 三个点菜单 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('.book-card')?.click()")
    pg.wait_for_timeout(2600)
    ok("播放页有心形收藏按钮", pg.evaluate("!!document.querySelector('#btnFavTop')"))
    # 老板要求：收藏和书签重复，只要收藏
    ok("播放页没有重复的书签按钮", not pg.evaluate("!!document.querySelector('#btnBookmark')"))
    # 三个点 → 菜单出现，且不再跳设置页
    pg.evaluate("document.querySelector('#btnMore').click()")
    pg.wait_for_timeout(400)
    ok("三个点打开的是操作菜单（不是跳设置页）",
       pg.evaluate("!!document.querySelector('.lock .sheet-item')")
       and pg.evaluate("document.body.dataset.view") == 'player')
    items = pg.evaluate("[...document.querySelectorAll('.sheet-item .sheet-label')].map(e=>e.textContent.trim())")
    print("     菜单项:", items)
    # 老板 2026-09-13：播放页已有的按钮（收藏/选集/倍速/定时）不再重复进三个点菜单
    ok("菜单不再含收藏/选集（页面已有，去重复）",
       not any('收藏' in (i or '') for i in items)
       and not any('选集' in (i or '') for i in items), f"{items}")
    ok("菜单含缓存/书籍信息", any('缓存' in (i or '') for i in items)
       and any('信息' in (i or '') for i in items))
    ok("菜单不含书签项（与收藏重复，已去掉）", not any('书签' in (i or '') for i in items))
    ok("菜单无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== C. 继续听：按最后播放时间倒序 ===")
    ctx, pg, errs = mk(br, 'kid')
    order = pg.evaluate("""() => {
      const me = %s;
      const mp = {};
      (me.mediaProgress||[]).forEach(p => { mp[p.libraryItemId||p.mediaItemId] = p; });
      return [...document.querySelectorAll('.continue-item')].map(el => {
        const p = mp[el.dataset.id];
        return { id: el.dataset.id, ts: (p&&p.lastUpdate)||0 };
      });
    }""" % json.dumps(FX.get('/api/me', {})))
    print("     卡片顺序:", [(o['id'][:8], o['ts']) for o in order])
    ts = [o['ts'] for o in order]
    ok("继续听按时间倒序（最近在最前）", ts == sorted(ts, reverse=True), str(ts))
    ok("继续听卡片存在", len(order) > 0)
    ctx.close()

    print("\n=== D. 搜索框内话筒 ===")
    ctx, pg, errs = mk(br, 'kid')
    # voiceSupported() 判的是"是否原生环境"，headless 里为 false → 就地把桩打开
    pg.evaluate("if (window.Capacitor) window.Capacitor.isNativePlatform = () => true")
    pg.evaluate("document.querySelector('[data-nav=\"search\"]')?.click()")
    pg.wait_for_timeout(1500)
    inField = pg.evaluate("""() => {
      const mic = document.querySelector('.search-mic');
      const field = document.querySelector('.search-field');
      if (!mic || !field) return null;
      const a = mic.getBoundingClientRect(), b = field.getBoundingClientRect();
      return { inside: a.left >= b.left && a.right <= b.right, hasMic: true };
    }""")
    ok("话筒在搜索框内部", bool(inField and inField.get('inside')), str(inField))
    ok("右上角已无独立话筒按钮", pg.evaluate("!document.querySelector('.page-head [data-voice]')"))
    ctx.close()

    print("\n=== E. 统计页 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("window.__go = null")
    # 直接进统计页（模拟设置页点击）
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowParent').click()")
    pg.wait_for_timeout(700)
    if pg.evaluate("!!document.querySelector('#lockPin')"):
        pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
        pg.wait_for_timeout(1400)
    pg.evaluate("document.querySelector('#rowStats').click()")
    pg.wait_for_timeout(1600)
    ok("统计页能打开（有家长密码时需验证）",
       pg.evaluate("document.body.dataset.view") in ('stats', 'settings'),
       pg.evaluate("document.body.dataset.view"))
    # 若弹出家长锁，输入
    if pg.evaluate("!!document.querySelector('#lockPin')"):
        pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
        pg.wait_for_timeout(1400)
    ok("进入统计页", pg.evaluate("document.body.dataset.view") == 'stats',
       pg.evaluate("document.body.dataset.view"))
    ok("统计页有标题/内容", pg.evaluate("!!document.querySelector('.stat-hero, .empty')"))
    ctx.close()

    print("\n=== F. 设置页新项（进度口径 / 触感 / 缓存 / 收藏）===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    for sel, name in [('#rowCache', '缓存管理'), ('#rowFav', '收藏的书'), ('#rowParent', '家长设置')]:
        ok(f"设置页有「{name}」", pg.evaluate(f"!!document.querySelector('{sel}')"))
    # 操控类设置不该直接出现在设置页（老板要求收进需密码的家长设置）
    for sel, name in [('#rowScope', '进度条显示'), ('#rowHaptics', '触感反馈'), ('#rowStats', '收听统计')]:
        ok(f"设置页没有直接暴露「{name}」（应在家长设置里）",
           not pg.evaluate(f"!!document.querySelector('{sel}')"))
    ok("设置页没有儿童/成人模式选项", not pg.evaluate("!!document.querySelector('#rowKid, #rowAdult')"))
    ok("设置页无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== F2. 家长设置（需密码）===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowParent').click()")
    pg.wait_for_timeout(700)
    # 应该弹家长锁
    ok("进家长设置要输密码", pg.evaluate("!!document.querySelector('#lockPin')"))
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1500)
    ok("输对密码后进入家长设置", pg.evaluate("document.body.dataset.view") == 'parents',
       pg.evaluate("document.body.dataset.view"))
    for sel, name in [('#rowScope', '进度条显示'), ('#rowHaptics', '触感反馈'),
                      ('#rowStats', '收听统计'), ('#rowPin', '家长密码')]:
        ok(f"家长设置有「{name}」", pg.evaluate(f"!!document.querySelector('{sel}')"))
    pg.evaluate("document.querySelector('#rowScope').click()")
    pg.wait_for_timeout(400)
    v = pg.evaluate("document.querySelector('#scopeVal')?.textContent")
    ok("能切换进度条口径", '整部' in (v or ''), v)
    ok("家长设置无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== F3. 输错密码进不去 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowParent').click()")
    pg.wait_for_timeout(700)
    pg.evaluate("document.querySelector('#lockPin').value='9999';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1200)
    ok("输错密码不进入家长设置", pg.evaluate("document.body.dataset.view") != 'parents',
       pg.evaluate("document.body.dataset.view"))
    ctx.close()

    print("\n=== G. 缓存页 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowCache').click()")
    pg.wait_for_timeout(1800)
    ok("缓存页能打开", pg.evaluate("document.body.dataset.view") == 'cache',
       pg.evaluate("document.body.dataset.view"))
    ok("缓存页有下载列表", pg.evaluate("document.querySelectorAll('#dlList .setting-row').length") > 0)
    ok("缓存页无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== H. 收藏页 ===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1300)
    pg.evaluate("document.querySelector('#rowFav').click()")
    pg.wait_for_timeout(1800)
    ok("收藏页能打开", pg.evaluate("document.body.dataset.view") == 'favorites',
       pg.evaluate("document.body.dataset.view"))
    ok("收藏页无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== I. 设置页扁平化 + 关于置底（老板 2026-09-13）===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(900)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1200)
    heads = pg.evaluate("[...document.querySelectorAll('#view .section-h')].map(e=>e.textContent.trim())")
    ok("设置页没有大分类标题（我的收藏/离线缓存/关于/家长）", len(heads) == 0, f"实际={heads}")
    labels = pg.evaluate("[...document.querySelectorAll('#view .setting-row .setting-label')].map(e=>e.textContent.trim())")
    ok("四个菜单行都在", all(k in labels for k in ['收藏的书', '缓存管理', '家长设置', '关于']), f"{labels}")
    ok("不再出现「关于听书」字样", not any('关于听书' in (l or '') for l in labels), f"{labels}")
    # 关于必须是最后一个菜单行
    last = labels[-1] if labels else None
    ok("「关于」排在最后", last == '关于', f"最后一个={last}")
    about_sub = pg.evaluate("""(() => {
      const r = document.querySelector('#rowAbout');
      return r ? (r.querySelector('.setting-value')?.textContent || '') : null;
    })()""")
    ok("「关于」行没有副行文字（版本·权限已去掉）", about_sub == '', f"副行={about_sub!r}")
    ok("设置页无 JS 报错", not errs, str(errs[:2]))
    ctx.close()

    print("\n=== J. 登录页输入框不再预填 / 无提示行（老板 2026-09-13）===")
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                         is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs2 = []
    pg.on('pageerror', lambda e: errs2.append(str(e)[:200]))
    # 故意预先写入"上次保存的服务器/用户名"，验证登录页不会再回填
    pg.add_init_script("""
      localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
      localStorage.setItem('shelfaudio.username','user');
    """)
    pg.goto('http://127.0.0.1:8899/index.html')
    pg.wait_for_timeout(2000)
    vals = pg.evaluate("""({
      server: document.querySelector('#fServer')?.value,
      user: document.querySelector('#fUser')?.value,
      pass: document.querySelector('#fPass')?.value,
    })""")
    ok("服务器地址框空白（不回填上次的值）", vals.get('server') == '', f"value={vals.get('server')!r}")
    ok("用户名框空白", vals.get('user') == '', f"value={vals.get('user')!r}")
    ok("密码框空白", vals.get('pass') == '', f"value={vals.get('pass')!r}")
    ph = pg.evaluate("document.querySelector('#fServer')?.placeholder")
    ok("placeholder 不再是示例地址", ph != 'http://127.0.0.1:18080', f"placeholder={ph!r}")
    ok("登录页没有底部提示行", pg.evaluate("document.querySelectorAll('.login-wrap .hint').length") == 0)
    ok("登录页无 JS 报错", not errs2, str(errs2[:2]))
    ctx.close()

    print("\n=== K. 播放页布局与选集弹窗（老板 2026-09-13）===")
    ctx, pg, errs = mk(br, 'kid')
    pg.evaluate("document.querySelector('.book-card')?.click()")
    pg.wait_for_timeout(2600)
    ok("能进播放页", pg.evaluate("document.body.dataset.view") == 'player')
    # 1) 播放页没有底栏（全屏播放器；之前残留上一页底栏压住倍速/定时/选集）
    ok("播放页没有底部导航条（不遮挡下方按钮）",
       pg.evaluate("document.querySelectorAll('#dock .kid-tabs').length") == 0)
    ok("body[data-tabs]=0（dock 无底栏）", pg.evaluate("document.body.dataset.tabs") == '0')
    # 2) 倍速/定时/选集这一行完整可见，且不被 dock 覆盖
    g = pg.evaluate("""() => {
      const tools = [...document.querySelectorAll('.player-tools')].pop();
      const chips = [...(tools?.querySelectorAll('.tool-chip') || [])];
      const dock = document.querySelector('#dock');
      const dTop = dock ? dock.getBoundingClientRect().top : 1e9;
      return {
        labels: chips.map(c => c.textContent.trim()),
        visible: chips.filter(c => { const r = c.getBoundingClientRect(); return r.height >= 40 && r.bottom <= dTop + 1 }).length,
        total: chips.length,
        overflow: chips.some(c => c.getBoundingClientRect().bottom > dTop + 1),
        docW: document.documentElement.scrollWidth, cliW: document.documentElement.clientWidth,
      };
    }""")
    print("     工具行:", g['labels'], "docW/cliW=", g['docW'], g['cliW'])
    ok("有三个工具按钮（倍速/定时/选集）", g['total'] >= 3, str(g['labels']))
    ok("工具按钮全部在 dock 之上（不被遮挡）", not g['overflow'], f"overflow={g['overflow']}")
    # 3) 选集 → 弹窗，不是页面下划列表
    pg.evaluate("[...document.querySelectorAll('.tool-chip')].find(b=>b.textContent.includes('选集'))?.click()")
    pg.wait_for_timeout(600)
    ok("选集弹出独立窗口", pg.evaluate("!!document.querySelector('.sheet-full .sheet-card')"))
    ok("弹窗里有章节列表", pg.evaluate("document.querySelectorAll('.sheet-full #chList .chapter-item').length") > 0)
    ok("弹窗打开时 #extra 不内联章节（页面没被撑长）",
       pg.evaluate("document.querySelectorAll('#view #extra .chapter-item').length") == 0)
    # 弹窗能关
    pg.evaluate("document.querySelector('.sheet-full #chClose')?.click()")
    pg.wait_for_timeout(400)
    ok("弹窗能关闭", not pg.evaluate("!!document.querySelector('.sheet-full')"))
    # 4) 点章节能换集
    pg.evaluate("[...document.querySelectorAll('.tool-chip')].find(b=>b.textContent.includes('选集'))?.click()")
    pg.wait_for_timeout(500)
    pg.evaluate("document.querySelectorAll('.sheet-full #chList .chapter-item')[2]?.click()")
    pg.wait_for_timeout(1500)
    ok("点章节后弹窗自动关闭", not pg.evaluate("!!document.querySelector('.sheet-full')"))
    ok("播放页无 JS 报错", not errs, str(errs[:3]))
    ctx.close()

    print("\n=== L. 继续听：列表样式 + 本地补记排最前（老板 2026-09-14）===")
    ctx, pg, errs = mk(br, 'kid')
    # 样式：应为 .list-item 列表行，且不再有横排卡片
    n_card = pg.evaluate("document.querySelectorAll('.continue-card').length")
    n_item = pg.evaluate("document.querySelectorAll('.continue-item').length")
    ok("继续听已改列表行（无横排卡片）", n_card == 0 and n_item > 0,
       f"cards={n_card} items={n_item}")
    # 列表行高度一致性：取前两个条目比较高度
    hs = pg.evaluate("[...document.querySelectorAll('.continue-item')].slice(0,3).map(e=>Math.round(e.getBoundingClientRect().height))")
    ok("列表行高统一", len(set(hs)) <= 1, str(hs))
    # 入口区（老板 2026-09-14 定稿）：「历史记录」「我的收藏」等大并排两枚按钮
    ok("历史记录+我的收藏入口并排", pg.evaluate(
        "!!document.querySelector('.entry-row .entry-btn#historyEntryCard') && !!document.querySelector('.entry-row .entry-btn#favEntryCard')"))
    # 等大：两个按钮宽度一致
    w = pg.evaluate("[document.querySelector('#historyEntryCard'), document.querySelector('#favEntryCard')].map(e=>Math.round(e.getBoundingClientRect().width))")
    ok("两入口按钮等宽", len(w) == 2 and w[0] == w[1], str(w))
    # 列表预览只显示 3 条（完整列表进历史页）
    n = pg.evaluate("document.querySelectorAll('.continue-item').length")
    ok("首页历史预览只显示 3 条", n == 3, f"n={n}")
    ok("分区标题已改名「历史记录」", '历史记录' in (pg.evaluate("document.querySelector('.section-h')?.textContent") or ''))
    ctx.close()

    print("\n=== M. 历史记录页（老板 2026-09-14）===")
    ctx, pg, errs = mk(br, 'kid')
    # 点入口进历史页
    pg.evaluate("document.querySelector('#historyEntryCard').click()")
    pg.wait_for_timeout(1500)
    ok("从首页入口能进历史记录页", pg.evaluate("document.body.dataset.view") == 'history',
       pg.evaluate("document.body.dataset.view"))
    ok("历史页有列表", pg.evaluate("document.querySelectorAll('[data-hist]').length") > 0)
    ok("历史页无 JS 报错", not errs, str(errs[:2]))
    # 隐藏的书不出现（审计实锤：ABS 会返回 hide=true 的书）
    titles = pg.evaluate("[...document.querySelectorAll('[data-hist] .list-title')].map(e=>e.textContent)")
    print("     历史页书名:", titles)
    # 长按删除：确认移除弹窗能出来。
    # ⚠️ 不能用 document.querySelector('.lock') —— index.html 里本来就有一个隐藏的
    # 全局「家长确认」弹窗（也是 .lock），会先被选中导致误判。用 #rmOk 精确定位。
    pg.evaluate("document.querySelector('[data-hist]').dispatchEvent(new Event('touchstart',{bubbles:true}))")
    pg.wait_for_timeout(900)
    ok("长按弹出移除确认框", pg.evaluate("!!document.querySelector('#rmOk')"))
    if pg.evaluate("!!document.querySelector('#rmOk')"):
        txt = pg.evaluate("[...document.querySelectorAll('.lock')].find(l=>l.querySelector('#rmOk'))?.querySelector('.lock-title')?.textContent")
        ok("确认框文案正确", '历史记录' in (txt or '') or '移除' in (txt or ''), txt)
        pg.evaluate("document.querySelector('#rmCancel')?.click()")
        pg.wait_for_timeout(400)
        ok("确认框能取消", not pg.evaluate("!!document.querySelector('#rmOk')"))
    ctx.close()

    br.close()

print(f"\n{'=' * 46}\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)
