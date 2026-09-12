#!/usr/bin/env python3
"""
UI 回归检查（真实渲染）——把审计中发现的 UI 问题固化成断言，防退化。
覆盖：占位封面裁切、底部固定层重叠、成人/儿童布局差异、文本溢出。
"""
import json, pathlib, re, sys
from playwright.sync_api import sync_playwright

# 用法：
#   1) python3 -m http.server 8899 -d dist  （另开一个终端）
#   2) 需要 /tmp/abs-fixtures.json（真实 ABS 响应快照）与 /tmp/tok.txt（token）
# 说明：这是一套「真浏览器渲染」检查。UI 问题（字号不缩放、底栏被遮挡、元素重叠）
# 靠读 CSS 推断极易出错，必须在 Chromium 里量真实几何。
BASE = 'http://127.0.0.1:8899/index.html'
FX = json.loads(pathlib.Path('/tmp/abs-fixtures.json').read_text())
TOKEN = pathlib.Path('/tmp/tok.txt').read_text().strip()
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082')

PASS = FAIL = 0
def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ✅ {name}")
    else: FAIL += 1; print(f"  ❌ {name}{' — ' + extra if extra else ''}")

def routes(pg):
    def h(route):
        p = re.sub(r'^https?://[^/]+', '', route.request.url).split('?')[0]
        if p in FX:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(FX[p]))
        if p.endswith('/cover'):
            return route.fulfill(status=200, content_type='image/png', body=PNG)
        route.fulfill(status=200, content_type='application/json', body='{}')
    pg.route('**/api/**', h)

def newpg(br, mode, vp={'width':390,'height':844}):
    ctx = br.new_context(viewport=vp, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); routes(pg)
    pg.add_init_script(f"""
      localStorage.setItem('shelfaudio.server','http://内网IP:端口');
      localStorage.setItem('shelfaudio.token','{TOKEN}');
      localStorage.setItem('shelfaudio.username','Bin');
      localStorage.setItem('shelfaudio.mode','{mode}');
      localStorage.setItem('shelfaudio.kidPin','1234');
    """)
    pg.goto(BASE); pg.wait_for_timeout(1500)
    return ctx, pg

with sync_playwright() as pw:
    br = pw.chromium.launch()

    print("\n=== 1. 占位封面文字不被裁切（每种尺寸、全部 41 本）===")
    for mode in ['kid', 'adult']:
        ctx, pg = newpg(br, mode)
        r = pg.evaluate("""() => {
          const bad = [];
          document.querySelectorAll('.cover-ph').forEach((ph,i) => {
            const t = ph.querySelector('.cover-ph-title');
            if (!t) return;
            const rp = ph.getBoundingClientRect(), rt = t.getBoundingClientRect();
            const clipped = t.scrollHeight > t.clientHeight + 1;
            const belowTop = rt.top < rp.top - 0.5;
            const aboveBottom = rt.bottom > rp.bottom + 0.5;
            const wider = t.scrollWidth > t.clientWidth + 1;
            if (clipped || belowTop || aboveBottom || wider)
              bad.push({i, text:t.textContent.slice(0,10), fs:getComputedStyle(t).fontSize,
                        clipped, belowTop, aboveBottom, wider});
          });
          return {total: document.querySelectorAll('.cover-ph').length, bad};
        }""")
        ok(f"[{mode}] {r['total']} 个占位封面全部放得下", len(r['bad']) == 0, json.dumps(r['bad'][:3], ensure_ascii=False))
        ctx.close()

    print("\n=== 2. 儿童模式：底栏/FAB/迷你条互不遮挡 ===")
    ctx, pg = newpg(br, 'kid')
    tabs = pg.evaluate("()=>{const e=document.querySelector('.kid-tabs');const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom}}")
    fab  = pg.evaluate("()=>{const e=document.querySelector('.voice-fab');if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom}}")
    ok("底栏存在", tabs is not None)
    ok("FAB 在底栏上方（不遮挡）", fab and fab['bottom'] <= tabs['top'] + 1,
       f"FAB底={fab['bottom'] if fab else None} 底栏顶={tabs['top'] if tabs else None}")

    # 模拟迷你条出现
    pg.evaluate("""() => {
      document.querySelector('#mini').classList.remove('hidden');
      document.body.dataset.mini = '1';
      document.querySelector('#miniTitle').textContent = '测试';
      document.querySelector('#miniSub').textContent = '正在播放';
    }""")
    pg.wait_for_timeout(400)
    g = pg.evaluate("""() => {
      const q = s => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; };
      return {tabs:q('.kid-tabs'), mini:q('#mini'), fab:q('.voice-fab')};
    }""")
    def ov(a,b):
        if not a or not b: return 0
        ox=max(0,min(a['right'],b['right'])-max(a['left'],b['left']))
        oy=max(0,min(a['bottom'],b['bottom'])-max(a['top'],b['top']))
        return ox*oy
    ok("迷你条与底栏不重叠", ov(g['mini'], g['tabs']) <= 1, f"面积={ov(g['mini'], g['tabs'])}")
    ok("迷你条与 FAB 不重叠", ov(g['mini'], g['fab']) <= 1, f"面积={ov(g['mini'], g['fab'])}")
    ok("FAB 抬到底栏上方", g['fab'] and g['fab']['bottom'] <= g['tabs']['top'] + 1,
       f"FAB底={g['fab']['bottom'] if g['fab'] else None} 底栏顶={g['tabs']['top']}")

    print("\n=== 3. 儿童/成人模式布局必须不同 ===")
    ctx.close()
    ctx, pg = newpg(br, 'kid')
    kid_grid = pg.evaluate("!!document.querySelector('.shelf-grid')")
    kid_list = pg.evaluate("!!document.querySelector('.shelf-list')")
    ok("儿童模式用网格", kid_grid and not kid_list, f"grid={kid_grid} list={kid_list}")
    ctx.close()
    ctx, pg = newpg(br, 'adult')
    ad_grid = pg.evaluate("!!document.querySelector('.shelf-grid')")
    ad_list = pg.evaluate("!!document.querySelector('.shelf-list')")
    ad_rows = pg.evaluate("document.querySelectorAll('.shelf-list .list-item').length")
    ok("成人模式用列表（不是网格）", ad_list and not ad_grid, f"grid={ad_grid} list={ad_list}")
    ok("成人列表渲染出条目", ad_rows > 0, f"{ad_rows} 行")
    nxt = pg.evaluate("()=>{const e=document.querySelector('.kid-tabs'); const f=document.querySelector('.voice-fab'); return {tabs:!!e, fab:!!f}}")
    ok("成人模式无底栏/无 FAB", not nxt['tabs'] and not nxt['fab'], json.dumps(nxt))

    print("\n=== 4. 成人列表行的进度尾标与内容不溢出 ===")
    r = pg.evaluate("""() => {
      const bad = [];
      const usesEllipsis = e => {
        const c = getComputedStyle(e);
        return c.textOverflow === 'ellipsis' && c.whiteSpace === 'nowrap';
      };
      document.querySelectorAll('.shelf-list .list-item').forEach((el,i) => {
        const t = el.querySelector('.list-title'), s = el.querySelector('.list-sub');
        // 用了省略号截断是设计如此；没做截断却溢出容器才是 bug
        if (t && t.scrollWidth > t.clientWidth + 1 && !usesEllipsis(t)) bad.push({i, which:'title', text:t.textContent.slice(0,14)});
        if (s && s.scrollWidth > s.clientWidth + 1 && !usesEllipsis(s)) bad.push({i, which:'sub', text:s.textContent.slice(0,20)});
      });
      return bad;
    }""")
    ok("标题/副标题要么放得下、要么正确省略号截断", len(r) == 0, json.dumps(r[:3], ensure_ascii=False))
    ctx.close()

    print("\n=== 5. 版本号来自 VERSION 文件（不再是写死的 v0.1.0）===")
    ctx, pg = newpg(br, 'adult')
    pg.evaluate("document.querySelector('#btnGear')?.click()")
    pg.wait_for_timeout(900)
    print("  当前 view:", pg.evaluate("document.body.dataset.view"))
    ver = pg.evaluate("(document.body.innerText.match(/听书 v([\\d.]+)/)||[])[1] || null")
    print("  设置页渲染版本:", ver)
    ok("设置页显示真实版本（非写死的 0.1.0）", bool(ver) and ver != '0.1.0', f"ver={ver}")
    ents = pg.evaluate("document.querySelectorAll('.setting-row').length")
    ok("设置页渲染出行项", ents > 0, f"{ents} 行")
    ctx.close()

    br.close()

print(f"\n{'='*46}\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)
