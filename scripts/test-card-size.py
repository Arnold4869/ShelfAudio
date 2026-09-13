#!/usr/bin/env python3
"""卡片尺寸一致性回归（老板 2026-09-14）

背景：老板反馈「有的没封面，但它的卡片大小比别的有封面的会小，不是所有没封面的都这样」。
实测根因：.book-card 高度由内容撑开 —— 标题 1 行 vs 2 行、有无「听 N%」徽标，
同一屏出现 237/251/258/272 四种高度（封面槽都是 171px，问题全在文字区）。
修复：卡片改网格 + 文字区固定高度、标题固定两行位。

本测试断言：**有封面 / 无封面**、**1 行标题 / 2 行标题**的卡片高度必须完全一致。
"""
import json, pathlib, re, sys
try:
    import zlib
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：CI 环境未安装 Playwright（本地/真机验证时运行）')
    sys.exit(0)


FX = json.loads((pathlib.Path(__file__).parent / 'ui-fixtures.json').read_text())
MULTI = FX.get('__multiId')
def _png(w=40, h=40, rgb=(90, 140, 200)):
    def chunk(t, d):
        c = t + d
        return len(d).to_bytes(4, 'big') + c + zlib.crc32(c).to_bytes(4, 'big')
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00')
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))
PNG = _png()

MEASURE = """
() => [...document.querySelectorAll('.book-card')].map(el => {
  const r = el.getBoundingClientRect()
  const img = el.querySelector('img[data-cover]')
  const ph = el.querySelector('.cover-ph')
  const slot = el.querySelector('.cover-slot')
  const sr = slot ? slot.getBoundingClientRect() : null
  const title = el.querySelector('.book-title')
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    slotW: sr ? Math.round(sr.width) : null, slotH: sr ? Math.round(sr.height) : null,
    imgDisplay: img ? getComputedStyle(img).display : null,
    imgOK: img ? (img.complete && img.naturalWidth > 0) : null,
    phDisplay: ph ? getComputedStyle(ph).display : null,
    titleLines: title ? Math.round(title.getBoundingClientRect().height / 20.25) : null,
    title: (title?.textContent || '').slice(0, 16),
    hasCover: !!el.dataset.coverOk,
  }
})
"""

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                         is_mobile=True, has_touch=True)
    pg = ctx.new_page()

    def h(route):
        req = route.request
        p = re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]
        if p in FX:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(FX[p]))
        if p.endswith('/cover'):
            # 交替：一半 404（模拟无封面），一半返回图
            iid = p.split('/')[3] if len(p.split('/')) > 3 else ''
            if iid and (zlib.crc32(iid.encode()) % 4 == 0):
                return route.fulfill(status=404, body='')
            return route.fulfill(status=200, content_type='image/png', body=PNG)
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
      localStorage.setItem('shelfaudio.mode','kid');
    """)
    pg.goto('http://127.0.0.1:8899/index.html')
    pg.wait_for_timeout(2200)

    rows = pg.evaluate(MEASURE)
    print(f'{"w":>5}{"h":>5}{"槽h":>6}  {"img":<10}{"imgOK":<7}{"占位":<8}{"行":<3} 标题')
    for r in rows:
        print(f'{r["w"]:>5}{r["h"]:>5}{str(r["slotH"]):>6}  {str(r["imgDisplay"]):<10}{str(r["imgOK"]):<7}{str(r["phDisplay"]):<8}{str(r["titleLines"]):<3} {r["title"]}')
    withc = [r['h'] for r in rows if r['imgOK']]
    nocov = [r['h'] for r in rows if not r['imgOK']]
    print('\n有封面卡片高:', sorted(set(withc)), f'({len(withc)} 张)')
    print('无封面卡片高:', sorted(set(nocov)), f'({len(nocov)} 张)')
    hs = [r['h'] for r in rows]
    shs = [r['slotH'] for r in rows]
    print('\n卡片高集合:', sorted(set(hs)))
    print('封面槽高集合:', sorted(set(shs)))
    print('卡片数:', len(rows))
    if len(set(hs)) > 1:
        print('⚠️ 卡片高度不一致 —— UI bug 复现')
    else:
        print('✅ 卡片高度一致')
    br.close()

# ---- 断言 ----
if len(set([r['h'] for r in rows])) > 1:
    print(f"\n❌ 卡片高度不一致：{[r['h'] for r in rows][:12]} ...")
    sys.exit(1)
print('\n✅ 卡片高度全部一致')

