#!/usr/bin/env python3
"""冷启动起播链路回归（老板 2026-09-20 报「历史记录点进去一直等不到声音」）。

真实服务器实测（2026-09-20，ABS 2.36.x）：
  1. POST /play 的响应自带 chapters（全量）和 startTime（=服务端存的进度），
     服务端开 session 时自己读 userProgress 定位（已听完自动归 0）。
     → 旧代码起播前的 getProgress 和补章节的 getItem 都是纯浪费：
       大书 getItem 775KB + 两趟串行网络往返，公网/弱网下用户干等 2~5 秒。
  2. 播放器 init() 里的 deinitPlugin 若与首次装载并发，会把刚装好的音轨停掉
     → 「点了等不到声音」。

本脚本断言：
  A. 起播只发 **1 个** API 请求（/play），不再发 getProgress / getItem
     （ABS 显式 startTime=0 时也只发 /play；ND 进度与开会话并行 = 2 个）。
  B. 恢复位置 = /play 响应里的 startTime（服务端定位）。
  C. 章节来自 /play 响应（不需要 getItem）。
  D. init（deinitPlugin）完成后才允许 load 装（冷启动竞态防护，node 单测守）。

无 Playwright 自动跳过（CI 兼容）。
"""
import json, re, sys, types

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：无 Playwright'); sys.exit(0)

import pathlib as _pl
_AUDIT = _pl.Path(__file__).resolve().parent / 'audit-clickable-listeners.py'
mod = types.ModuleType('m')
exec(compile(_AUDIT.read_text().split('with sync_playwright')[0], str(_AUDIT), 'exec'),
     mod.__dict__)

fails = []
checks = 0


def ok(name, cond, extra=''):
    global checks
    checks += 1
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond:
        fails.append(name)


def newpage(br, prefs, log):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))

    def routed(route):
        log.append(route.request)
        mod.handler(route)
    pg.route('**/api/**', routed); pg.route('**/rest/**', routed)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2600)
    return ctx, pg, errs


def path_of(req):
    return re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]


with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ===== ABS：历史记录点书 → 起播链路请求数 =====
    log = []
    ctx, pg, errs = newpage(br, mod.ABS_PREFS, log)
    ok('页面无 JS 报错', not errs, str(errs[:2]))

    log.clear()
    # 进历史页点第一条（走 openEntry → playItem 完整链路）；
    # 历史入口卡在首页，先点入口进列表再点条目（与 test-back-navigation 同款路径）
    # ⚠️ 用轮询而不是固定等待：网络/渲染快慢不一，固定 2.6s 偶发不够（本地连跑踩到过）
    pg.evaluate("() => { document.querySelector('#historyEntryCard')?.click() }")
    for _ in range(30):
        pg.wait_for_timeout(200)
        if pg.evaluate("() => !!document.querySelector('.list-item[data-id]')"):
            break
    pg.evaluate("() => { document.querySelector('.list-item[data-id]')?.click() }")
    for _ in range(40):
        pg.wait_for_timeout(200)
        if pg.evaluate('document.body.dataset.view') == 'player':
            break
    pg.wait_for_timeout(600)   # 等起播链路把请求发完
    ok('历史记录点书进入播放页', pg.evaluate('document.body.dataset.view') == 'player',
       pg.evaluate('document.body.dataset.view'))

    paths = [path_of(r) for r in log]
    api_paths = [p for p in paths if p.startswith('/api/')]
    plays = [p for p in api_paths if p.endswith('/play')]
    progs = [p for p in api_paths if '/progress/' in p and 'remove' not in p]
    gets = [p for p in api_paths if re.fullmatch(r'/api/items/absbook1', p)]
    ok('起播只发一次 /play', len(plays) == 1, str(api_paths))
    ok('起播前不再发 getProgress（服务端自己定位）', len(progs) == 0, str(progs))
    ok('起播不再发 getItem 补章节（/play 自带）', len(gets) == 0, str(gets))

    # 恢复位置 = /play 响应里的 startTime=300（fixture 里 mediaProgress 也是 300，口径一致）
    st = pg.evaluate("() => window.__saPlayer?.position()?.currentTime ?? -1")
    ok('恢复位置 = /play 返回的服务端进度（300s）', abs((st or 0) - 300) < 3, f'st={st}')

    # 章节数来自 /play 响应（2 章）
    ch = pg.evaluate("() => (window.__saPlayer?.tracks?.length) ?? -1")
    ok('音轨数来自 /play 响应', ch == 2, f'{ch}')
    # 播放页章节标题渲染正常（没因为章节来源切换而空）
    chTitle = pg.evaluate("() => document.querySelector('#pChapter')?.textContent || ''")
    ok('播放页章节标题正常（第一章）', '第一章' in chTitle, chTitle)

    # 播放态健康：UI 进入播放而不是「点了没反应」
    isPlaying = pg.evaluate("() => window.__saPlayer?.playing ?? null")
    ok('起播后处于播放态', isPlaying is True, f'{isPlaying}')

    # ===== ND：专辑页点歌 → 进度+开会话并行（2 个 rest 请求阶段）=====
    log2 = []
    ctx2, pg2, errs2 = newpage(br, mod.ND_PREFS, log2)
    pg2.evaluate("""() => {
        const cards = [...document.querySelectorAll('.book-card')];
        (cards.find(c => (c.textContent || '').includes('测试专辑')) || cards[0])?.click();
    }""")
    pg2.wait_for_timeout(1800)
    log2.clear()
    pg2.evaluate("""() => {
        const row = document.querySelector('[data-song], .song-row, .list-item');
        row?.click();
    }""")
    pg2.wait_for_timeout(2600)
    ok('ND 点歌进入播放页', pg2.evaluate('document.body.dataset.view') == 'player')
    ndPaths = [path_of(r) for r in log2 if '/rest/' in r.url]
    albums = [p for p in ndPaths if p == '/rest/getAlbum']
    # 专辑页点歌带显式 startTime → 本就不该查进度（旧代码同样不查）：
    # 开会话（getAlbum）只发 1 次，且没有任何多余的详情重拉
    ok('ND 点歌（带 startTime）getAlbum 只发 1 次', len(albums) == 1, str(ndPaths))
    ok('ND 无 JS 报错', not errs2, str(errs2[:2]))

    br.close()

print()
if fails:
    print(f'❌ {len(fails)} 项失败'); sys.exit(1)
print(f'✅ 全部通过（{checks} 项）：起播链路只发必要请求、服务端定位/章节自带均生效')
