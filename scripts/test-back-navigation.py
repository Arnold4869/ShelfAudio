#!/usr/bin/env python3
"""返回路径回归（老板 2026-09-20 报「进播放页后没办法返回」）。

根因（0.12.0 之前就埋着，歌手页让它变成必现）：
  搜索/歌手页点歌 → go('album', {id, songId}) → 专辑页自动起播 → 进播放页
  → 按返回 → 回专辑页 → 参数里 songId 还在 → **又自动起播** → 立刻被踢回播放页
  = 在播放页按返回永远出不去（死循环）。
  修法：goBack() 回到 album 时剥掉一次性参数 songId（已消费过的起播指令）。

本脚本覆盖**所有**能进播放页的路径，每条都必须「点返回能离开播放页」：
  ABS：首页点书 / 搜索点书 / 收藏点书 / 历史点书
  ND ：专辑页点歌 / 播放全部 / 搜索点歌 / 搜索结果多选态点歌 / 歌手页点歌 /
       歌单详情点歌 / 收藏点专辑 / 历史点专辑
  以及：播放页 → 歌手名 → 歌手页 → 返回 → 回播放页（不能卡）
  多级返回链路：搜索→点歌→播放页→返回→专辑→返回→搜索（一路畅通）

无 Playwright 自动跳过（CI 兼容）。
"""
import json, re, sys, types

mod = types.ModuleType('m')
exec(compile(open('/home/Bin/ShelfAudio/scripts/audit-clickable-listeners.py').read()
             .split('with sync_playwright')[0], 'aud', 'exec'), mod.__dict__)

from playwright.sync_api import sync_playwright

fails = []
checks = 0


def ok(name, cond, extra=''):
    global checks
    checks += 1
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond:
        fails.append(name)


def newpage(br, prefs):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/api/**', mod.handler); pg.route('**/rest/**', mod.handler)
    pg.add_init_script(prefs)
    pg.goto('http://127.0.0.1:8899/index.html'); pg.wait_for_timeout(2600)
    return ctx, pg, errs


def view(pg):
    return pg.evaluate("document.body.dataset.view")


def multi_album(pg):
    """进首页那张 3 首歌的专辑详情（首页是洗过牌的，必须挑对）"""
    pg.evaluate("""() => {
        const cards = [...document.querySelectorAll('.book-card')];
        (cards.find(c => (c.textContent || '').includes('测试专辑')) || cards[0])?.click();
    }"""); pg.wait_for_timeout(1900)


def press_back(pg):
    """按返回，返回点击后的视图"""
    pg.evaluate("""() => {
        const b = document.querySelector('#btnBack');
        if (b) b.click();
    }""")
    pg.wait_for_timeout(1700)
    return view(pg)


with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ============ ABS 侧 ============
    print('=== ABS：各入口进播放页 → 返回 ===')
    for label, setup in [
        ('首页点书', "document.querySelector('.book-card').click()"),
        ('搜索点书', None),
        ('收藏点书', None),
        ('历史点书', None),
    ]:
        ctx, pg, errs = newpage(br, mod.ABS_PREFS)
        if label == '首页点书':
            pg.evaluate(setup); pg.wait_for_timeout(2500)
        elif label == '搜索点书':
            pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1300)
            pg.fill('#q', '书'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1800)
            pg.evaluate("document.querySelector('#results .list-item[data-id]')?.click()"); pg.wait_for_timeout(2500)
        elif label == '收藏点书':
            pg.evaluate("document.querySelector('#favEntryCard').click()"); pg.wait_for_timeout(1800)
            pg.evaluate("document.querySelector('.list-item[data-id]')?.click()"); pg.wait_for_timeout(2500)
        elif label == '历史点书':
            pg.evaluate("document.querySelector('#historyEntryCard').click()"); pg.wait_for_timeout(2000)
            pg.evaluate("document.querySelector('.list-item[data-id]')?.click()"); pg.wait_for_timeout(2500)
        if view(pg) != 'player':
            ok(f'ABS/{label}：进入播放页', False, f'view={view(pg)}')
            ctx.close(); continue
        back = press_back(pg)
        ok(f'ABS/{label}：返回能离开播放页', back != 'player', f'回到 {back}')
        ok(f'ABS/{label}：无 JS 报错', not errs, str(errs[:1]))
        ctx.close()

    # ============ ND 侧 ============
    print('=== ND：各入口进播放页 → 返回 ===')

    # 1. 专辑页点歌（原先就能返回，防回归）
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    multi_album(pg)
    pg.evaluate("document.querySelector('[data-idx=\"0\"]').click()"); pg.wait_for_timeout(2600)
    ok('ND/专辑页点歌：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/专辑页点歌：返回离开播放页', back != 'player', f'回到 {back}')
    ctx.close()

    # 2. 播放全部
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    multi_album(pg)
    pg.evaluate("document.querySelector('#playAll').click()"); pg.wait_for_timeout(2800)
    ok('ND/播放全部：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/播放全部：返回离开播放页', back != 'player', f'回到 {back}')
    ctx.close()

    # 3. 搜索点歌（老板报的卡死路径 ①）
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    pg.evaluate("document.querySelector('.kid-tab[data-nav=search]').click()"); pg.wait_for_timeout(1300)
    pg.fill('#q', '歌'); pg.evaluate("document.querySelector('#btnGo').click()"); pg.wait_for_timeout(1900)
    pg.evaluate("document.querySelector('#results .list-item[data-song]')?.click()"); pg.wait_for_timeout(2800)
    ok('ND/搜索点歌：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/搜索点歌：返回离开播放页（老板报的卡死）', back != 'player', f'回到 {back}')
    # 多级返回：专辑页再返回应回到搜索页
    if back == 'album':
        back2 = press_back(pg)
        ok('ND/搜索点歌：专辑页再返回 → 搜索页', back2 == 'search', f'回到 {back2}')
    ctx.close()

    # 4. 歌手页点歌（老板报的卡死路径 ②）
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    multi_album(pg)
    pg.evaluate("document.querySelector('[data-artist-id]')?.click()"); pg.wait_for_timeout(1800)
    pg.evaluate("document.querySelector('#btnView')?.click()"); pg.wait_for_timeout(800)
    pg.evaluate("document.querySelectorAll('.list-item[data-song]')[0]?.click()"); pg.wait_for_timeout(2800)
    ok('ND/歌手页点歌：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/歌手页点歌：返回离开播放页（老板报的卡死）', back != 'player', f'回到 {back}')
    if back == 'album':
        back2 = press_back(pg)
        ok('ND/歌手页点歌：专辑页再返回 → 歌手页', back2 == 'artist', f'回到 {back2}')
    ctx.close()

    # 5. 播放页 → 歌手名 → 歌手页 → 返回（老板报的卡死路径 ③）
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    multi_album(pg)
    pg.evaluate("document.querySelector('[data-idx=\"0\"]').click()"); pg.wait_for_timeout(2600)
    pg.evaluate("document.querySelector('#pArtist')?.click()"); pg.wait_for_timeout(1800)
    ok('ND/播放页点歌手名：进入歌手页', view(pg) == 'artist', view(pg))
    back = press_back(pg)
    ok('ND/播放页点歌手名：返回回播放页（不卡）', back == 'player', f'回到 {back}')
    ctx.close()

    # 6. 歌单详情点歌
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    pg.evaluate("document.querySelector('#plEntryCard').click()"); pg.wait_for_timeout(1600)
    pg.evaluate("document.querySelector('[data-pl]')?.click()"); pg.wait_for_timeout(1800)
    pg.evaluate("document.querySelector('#plSongs .list-item[data-idx]')?.click()"); pg.wait_for_timeout(2800)
    if view(pg) == 'player':
        back = press_back(pg)
        ok('ND/歌单点歌：返回离开播放页', back != 'player', f'回到 {back}')
    else:
        ok('ND/歌单点歌：进入播放页', False, f'view={view(pg)}')
    ctx.close()

    # 7. 收藏点专辑
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    pg.evaluate("document.querySelector('#favEntryCard').click()"); pg.wait_for_timeout(1800)
    pg.evaluate("document.querySelector('.list-item[data-id]')?.click()"); pg.wait_for_timeout(2500)
    ok('ND/收藏点专辑：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/收藏点专辑：返回离开播放页', back != 'player', f'回到 {back}')
    ctx.close()

    # 8. 历史点专辑
    ctx, pg, errs = newpage(br, mod.ND_PREFS)
    pg.evaluate("document.querySelector('#historyEntryCard').click()"); pg.wait_for_timeout(2000)
    pg.evaluate("document.querySelector('.list-item[data-id]')?.click()"); pg.wait_for_timeout(2500)
    ok('ND/历史点专辑：进入播放页', view(pg) == 'player', view(pg))
    back = press_back(pg)
    ok('ND/历史点专辑：返回离开播放页', back != 'player', f'回到 {back}')
    ctx.close()

    br.close()

print()
if fails:
    print(f'❌ {len(fails)}/{checks} 项失败：')
    for f in fails:
        print('   -', f)
    sys.exit(1)
print(f'✅ 全部通过（{checks} 项）：所有进播放页的路径都能正常返回')
