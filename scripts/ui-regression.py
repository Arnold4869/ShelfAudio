#!/usr/bin/env python3
"""
UI 回归检查（真实渲染）——把审计中发现的 UI 问题固化成断言，防退化。

为什么要真渲染：UI 问题（字号不缩放、底栏被遮挡、元素重叠）靠读 CSS 推断
极易出错。本轮读 CSS 时漏掉多处，一上 Chromium 就暴露。

前置：
  cp scripts/ui-fixtures.json 到工作区（默认 ./scripts/ui-fixtures.json）
  起静态服务：python3 -m http.server 8899 -d dist
  装浏览器：/tmp/pwenv/bin/python -m playwright install chromium

用法：
  python3 scripts/ui-regression.py [--base http://127.0.0.1:8899] [--fixtures scripts/ui-fixtures.json]
"""
import argparse, json, pathlib, re, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://127.0.0.1:8899')
ap.add_argument('--fixtures', default=str(HERE / 'ui-fixtures.json'))
ap.add_argument('--token', default='')
args = ap.parse_args()

BASE = args.base.rstrip('/') + '/index.html'
FX = json.loads(pathlib.Path(args.fixtures).read_text())
# token 无处可取时用占位符：路由已被拦截，不会真的发给服务器
TOKEN = args.token or 'test-token-not-used'
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082')

PASS = FAIL = 0
def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ✅ {name}")
    else:
        FAIL += 1; print(f"  ❌ {name}{' — ' + extra if extra else ''}")


MULTI = FX.get('__multiId')


def _play_body(lid):
    """按 ABS 的 /play 结构合成 audioTracks（真实响应里是 audioTracks，不是 tracks）"""
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
                   'contentUrl': '/api/items/%s/file/1' % lid,
                   'title': '第1集', 'mimeType': 'audio/mpeg'}]
        off = 3600
    return json.dumps({'id': 's1', 'audioTracks': tracks, 'duration': off,
                       'libraryItem': {'id': lid, 'media': media}})


def routes(pg):
    def h(route):
        req = route.request
        p = re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]
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
        if p.startswith('/api/me/progress/'):
            return route.fulfill(status=200, content_type='application/json', body='{}')
        if '/file/' in p:
            return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
        route.fulfill(status=200, content_type='application/json', body='{}')
    pg.route('**/api/**', h)


def newpg(br, mode, vp={'width': 390, 'height': 844}):
    ctx = br.new_context(viewport=vp, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); routes(pg)
    pg.add_init_script(f"""
      localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
      localStorage.setItem('shelfaudio.token','{TOKEN}');
      localStorage.setItem('shelfaudio.username','user');
      localStorage.setItem('shelfaudio.mode','{mode}');
      localStorage.setItem('shelfaudio.kidPin','1234');
    """)
    pg.goto(BASE); pg.wait_for_timeout(1500)
    return ctx, pg


def overlap_area(a, b):
    if not a or not b:
        return 0
    ox = max(0, min(a['right'], b['right']) - max(a['left'], b['left']))
    oy = max(0, min(a['bottom'], b['bottom']) - max(a['top'], b['top']))
    return ox * oy


def rect(pg, sel):
    return pg.evaluate("""(s)=>{const e=document.querySelector(s); if(!e) return null;
      const r=e.getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,w:r.width,h:r.height};}""", sel)


with sync_playwright() as pw:
    br = pw.chromium.launch()

    print("\n=== 1. 占位封面文字不被裁切（全部书）===")
    for mode in ['kid']:
        ctx, pg = newpg(br, mode)
        r = pg.evaluate("""() => {
          const bad = [];
          document.querySelectorAll('.cover-ph').forEach((ph) => {
            const t = ph.querySelector('.cover-ph-title');
            if (!t) return;
            const rp = ph.getBoundingClientRect(), rt = t.getBoundingClientRect();
            if (t.scrollHeight > t.clientHeight + 1 || rt.top < rp.top - 0.5 ||
                rt.bottom > rp.bottom + 0.5 || t.scrollWidth > t.clientWidth + 1)
              bad.push(t.textContent.slice(0, 10));
          });
          return {total: document.querySelectorAll('.cover-ph').length, bad};
        }""")
        ok(f"[{mode}] {r['total']} 个占位封面全部放得下", len(r['bad']) == 0,
           json.dumps(r['bad'][:3], ensure_ascii=False))
        ctx.close()

    print("\n=== 2. 儿童模式：底栏 / FAB / 迷你条 互不遮挡 ===")
    ctx, pg = newpg(br, 'kid')
    tabs = rect(pg, '.kid-tabs')
    fab = rect(pg, '.voice-fab')
    ok("底栏存在", tabs is not None)
    ok("FAB 在底栏上方", bool(fab and tabs and fab['bottom'] <= tabs['top'] + 1),
       f"FAB底={fab['bottom'] if fab else None} 底栏顶={tabs['top'] if tabs else None}")

    pg.evaluate("""() => {
      document.querySelector('#mini').classList.remove('hidden');
      document.body.dataset.mini = '1';
      document.querySelector('#miniTitle').textContent = '测试书';
      document.querySelector('#miniSub').textContent = '已暂停';
    }""")
    pg.wait_for_timeout(400)
    mini = rect(pg, '#mini'); tabs2 = rect(pg, '.kid-tabs'); fab2 = rect(pg, '.voice-fab')
    ok("迷你条与底栏不重叠", overlap_area(mini, tabs2) <= 1,
       f"面积={overlap_area(mini, tabs2)}")
    ok("迷你条与 FAB 不重叠", overlap_area(mini, fab2) <= 1,
       f"面积={overlap_area(mini, fab2)}")
    ok("FAB 抬到底栏上方", bool(fab2 and tabs2 and fab2['bottom'] <= tabs2['top'] + 1),
       f"FAB底={fab2['bottom'] if fab2 else None} 底栏顶={tabs2['top'] if tabs2 else None}")
    ok("迷你条与底栏紧贴（无缝隙露内容）", abs(tabs2['top'] - mini['bottom']) <= 1.5,
       f"间隙={tabs2['top'] - mini['bottom']:.1f}px")
    # 新的 dock 设计：迷你条坐在底栏正上方，整个 dock 贴底（不再是浮在底部 10px 的胶囊）
    ok("整个 dock 贴底（底边贴屏底）", abs(844 - max(mini['bottom'], tabs2['bottom'])) <= 1.5,
       f"dock 底边离屏底={844 - max(mini['bottom'], tabs2['bottom']):.1f}px")
    # 迷你条与底栏已融合成一整块，底部由 dock 自己铺满，不再需要背板补缝。
    # 这里改成验证"dock 一直铺到屏底"，等价但更贴合新设计。
    ok("dock 铺满到屏幕底部（安全区无透色）", abs(tabs2['bottom'] - 844) <= 1.5,
       f"底栏底边={tabs2['bottom']:.1f}")
    ok("迷你条与底栏之间无缝隙", abs(tabs2['top'] - mini['bottom']) <= 1.5,
       f"接缝={tabs2['top'] - mini['bottom']:.1f}px")
    ctx.close()

    print("\n=== 3. 只有一套界面（儿童/成人模式已取消）===")
    ctx, pg = newpg(br, 'kid')
    ok("书架用网格", pg.evaluate("!!document.querySelector('.shelf-grid')")
       and not pg.evaluate("!!document.querySelector('.shelf-list')"))
    nxt = pg.evaluate("()=>({tabs:!!document.querySelector('.kid-tabs'),"
                      "fab:!!document.querySelector('.voice-fab'),fav:!!document.querySelector('#favEntryCard')})")
    ok("有底栏与语音球", nxt['tabs'] and nxt['fab'], json.dumps(nxt))
    ok("首页有收藏入口", nxt['fav'], json.dumps(nxt))
    # 即使本地存着老的 adult 值，也必须还是同一套界面（不能被卡在旧模式）
    ctx.close()
    ctx, pg = newpg(br, 'adult')
    ok("本地残留 mode=adult 也走同一套界面（有底栏、无 shelf-list）",
       pg.evaluate("!!document.querySelector('.kid-tabs')")
       and not pg.evaluate("!!document.querySelector('.shelf-list')"))

    print("\n=== 4. 书架卡片文字不横向溢出 ===")
    # 没有"成人列表"了，改为检查卡片标题/副标题是否溢出（有省略号才算正常）
    # 判据必须是"文字真的画到卡片外面"，而不是 scrollWidth > clientWidth：
    # -webkit-line-clamp 多行截断时 scrollWidth 本来就会大于 clientWidth，
    # 但那是被 overflow:hidden 正确裁掉的（实测右边缘仍在卡片内），不算 bug。
    r = pg.evaluate("""() => {
      const bad = [];
      const clipped = e => {
        const c = getComputedStyle(e);
        return c.overflow === 'hidden' || c.overflowX === 'hidden' || c.overflowY === 'hidden';
      };
      document.querySelectorAll('.book-card').forEach((el, i) => {
        const card = el.getBoundingClientRect();
        for (const sel of ['.book-title', '.book-sub']) {
          const e = el.querySelector(sel);
          if (!e) continue;
          const r = e.getBoundingClientRect();
          // 真的出框：元素边界越过了卡片，且没有被裁掉
          if ((r.right > card.right + 1 || r.left < card.left - 1) && !clipped(e))
            bad.push({i, sel, text: e.textContent.slice(0, 18), right: Math.round(r.right), card: Math.round(card.right)});
        }
      });
      return bad;
    }""")
    ok("卡片文字无未截断的溢出", len(r) == 0, json.dumps(r[:3], ensure_ascii=False))
    ctx.close()

    print("\n=== 5. 图标：全部自绘 SVG，界面无 emoji ===")
    for mode in ['kid']:
        ctx, pg = newpg(br, mode)
        n_svg = pg.evaluate("document.querySelectorAll('svg.ic-svg').length")
        leftover = pg.evaluate("""() => [...document.querySelectorAll('*')]
          .filter(e => e.children.length === 0 && e.textContent.includes('${icon(')).length""")
        emoji = pg.evaluate("""() => {
          const isEmoji = ch => { const o = ch.codePointAt(0);
            return (o >= 0x1F000 && o <= 0x1FAFF) || (o >= 0x2300 && o <= 0x27BF) ||
                   (o >= 0x2B00 && o <= 0x2BFF) || o === 0xFE0F; };
          const bad = [];
          document.querySelectorAll('button, .kid-tab, .mini-btn, .icon-btn, .setting-ic, .glyph')
            .forEach(e => { for (const ch of (e.textContent || ''))
              if (isEmoji(ch)) { bad.push({t: e.textContent.trim().slice(0, 12), ch}); break; } });
          return bad;
        }""")
        ok(f"[{mode}] 渲染出 {n_svg} 个自绘图标", n_svg > 0)
        ok(f"[{mode}] 无未求值的 ${{icon( 残留", leftover == 0, f"{leftover} 处")
        ok(f"[{mode}] 按钮里无 emoji", len(emoji) == 0, json.dumps(emoji[:3], ensure_ascii=False))
        ctx.close()

    print("\n=== 6. 播放页底部空白已收敛 ===")
    ctx, pg = newpg(br, 'kid')
    # 点到具体某本书（.book-card 可能被占位封面盖住，直接点它的容器）
    pg.evaluate("document.querySelector('.shelf-grid .book-card')?.click()")
    pg.wait_for_timeout(2600)
    if pg.evaluate("document.body.dataset.view") == 'player':
        g = pg.evaluate("""() => {
          const last = document.querySelector('#extra') || document.querySelector('.player-tools');
          const r = last ? last.getBoundingClientRect() : null;
          const first = document.querySelector('.player-cover-wrap');
          const fr = first ? first.getBoundingClientRect() : null;
          return {clientH: document.documentElement.clientHeight,
                  lastBottom: r ? r.bottom : null, firstTop: fr ? fr.top : null};
        }""")
        if g['lastBottom']:
            below = g['clientH'] - g['lastBottom']
            ok("底部留白 < 150px（修前 197px 全堆底部）", below < 150, f"留白 {below:.0f}px")
            ok("留白上下均衡（顶部也有空白）", g['firstTop'] > 20, f"顶部 {g['firstTop']:.0f}px")
    else:
        ok("进入播放页", False, "没能进入 player 视图")
    ctx.close()

    print("\n=== 7. 设置页版本号来自 VERSION 文件 ===")
    ctx, pg = newpg(br, 'kid')
    # 设置从底栏进（成人模式的右上角齿轮已随模式分类一起移除）
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1200)
    pg.evaluate("(()=>{const e=document.querySelector('#rowAbout'); if(e) e.click()})()")
    pg.wait_for_timeout(900)
    ver = pg.evaluate("(document.body.innerText.match(/听书 v([\\d.]+)/)||[])[1] || null")
    ok("关于页显示真实版本（非写死的 0.1.0）", bool(ver) and ver != '0.1.0', f"ver={ver}")
    ents = pg.evaluate("document.querySelectorAll('.setting-row').length")
    ok("设置页渲染出行项", ents > 0, f"{ents} 行")
    ctx.close()


    print("\n=== 8. 底部 dock 融合（迷你条 + 底栏）===")
    ctx, pg = newpg(br, 'kid')
    pg.evaluate("window.scrollTo(0, 800)")
    pg.evaluate("""() => {
      document.querySelector('#mini').classList.remove('hidden');
      document.body.dataset.mini = '1';
      document.querySelector('#miniTitle').textContent = '测试书';
      document.querySelector('#miniSub').textContent = '正在播放';
    }""")
    pg.wait_for_timeout(500)
    d = rect(pg, '#dock'); m = rect(pg, '#mini'); t = rect(pg, '.kid-tabs'); f = rect(pg, '.voice-fab')
    ok("迷你条与底栏紧贴（无缝，接缝 0）", bool(m and t and abs(t['top'] - m['bottom']) <= 1.5),
       f"接缝={t['top'] - m['bottom']:.1f}px" if m and t else "")
    ok("迷你条与底栏同宽同色（看起来是一整块）", bool(m and t and
       m['left'] == t['left'] and m['right'] == t['right']), "")
    ok("迷你条无圆角（与底栏同一平面）", pg.evaluate(
        "getComputedStyle(document.querySelector('#mini')).borderTopLeftRadius") == '0px')
    ok("FAB 在 dock 上方不遮挡", bool(f and d and f['bottom'] <= d['top'] + 1),
       f"FAB底={f['bottom'] if f else None} dock顶={d['top'] if d else None}")
    ok("--dock-h 已被写入（供留白与 FAB 定位）", pg.evaluate(
        "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h'))") > 0)
    ctx.close()

    print("\n=== 9. 儿童模式三页导航一致 + 主页无重复设置入口 ===")
    ctx, pg = newpg(br, 'kid')
    ok("主页右上角没有重复的齿轮（设置入口只留底栏）",
       not pg.evaluate("!!document.querySelector('#btnGear')"))
    ok("主页有底栏", pg.evaluate("!!document.querySelector('.kid-tabs')"))
    pg.evaluate("document.querySelector('[data-nav=\"search\"]')?.click()")
    pg.wait_for_timeout(1200)
    ok("搜索页有底栏", pg.evaluate("!!document.querySelector('.kid-tabs')"))
    ok("搜索页初始不是一片空白（显示可浏览列表）",
       pg.evaluate("document.querySelectorAll('#results .list-item').length") > 0)
    ctx.close()

    ctx, pg = newpg(br, 'kid')
    pg.evaluate("document.querySelector('[data-nav=\"settings\"]')?.click()")
    pg.wait_for_timeout(800)
    pg.evaluate("document.querySelector('#lockPin').value='1234';document.querySelector('#lockOk').click()")
    pg.wait_for_timeout(1400)
    ok("设置页也有底栏（与其他页一致）", pg.evaluate("!!document.querySelector('.kid-tabs')"),
       "view=" + str(pg.evaluate("document.body.dataset.view")))
    ok("设置页底栏高亮「设置」",
       (pg.evaluate("document.querySelector('.kid-tab.active')?.textContent.trim()") or '') == '设置')
    ctx.close()

    print("\n=== 10. 顶部/底部无白色安全区条带 ===")
    for mode in ['kid']:
        ctx, pg = newpg(br, mode)
        px_top = pg.evaluate("""() => {
          const b = document.body, h = document.documentElement;
          return getComputedStyle(b).backgroundColor + '|' + getComputedStyle(h).backgroundColor;
        }""")
        ok(f"[{mode}] HTML/body 底色为深色（不会露白）",
           'rgb(15, 13, 32)' in px_top or 'rgb(23, 20, 54)' in px_top, px_top)
        ctx.close()

    br.close()

print(f"\n{'=' * 46}\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)
