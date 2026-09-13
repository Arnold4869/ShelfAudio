#!/usr/bin/env python3
"""老 WebView 兼容性回归：模拟 Chrome<108（小米 8SE 内核）的 CSS 解析行为

老板 2026-09-13 反馈"播放页只占屏幕 2/3，下面 1/3 空白"。
根因：`min-height: 100dvh` —— 老内核不认 dvh 单位时**整条声明被丢弃**，
#view 塌成内容高度（≈2/3 屏），下半截露底色。

本测试真的模拟老内核：把已加载页面里所有含 dvh/svh/lvh 的 CSS 声明**删掉**
（等价于老内核的解析结果），再量播放页 #view 是否仍撑满视口。
只写 dvh 不写 vh 兜底时，这里必然失败。
"""
import json, pathlib, re, sys
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：CI 环境未安装 Playwright（本地/真机验证时运行）')
    sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parent.parent
if not (ROOT / 'dist' / 'index.html').exists():
    print('跳过：dist 未构建（需先 npm run build）')
    sys.exit(0)

FX = json.loads((pathlib.Path(__file__).parent / 'ui-fixtures.json').read_text())
MULTI = FX.get('__multiId')
PASS = FAIL = 0


def _play_body(lid):
    """与 ui-new-features.py 相同的 /play 响应（缺了它进不了播放页）。"""
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
                   'contentUrl': '/api/items/%s/file/1' % lid, 'title': '第1集',
                   'mimeType': 'audio/mpeg'}]
        off = 3600
    return json.dumps({'id': 's1', 'audioTracks': tracks, 'duration': off,
                       'libraryItem': {'id': lid, 'media': media}})


COLLECTIONS = json.dumps({'collections': [{'id': 'col_1', 'name': '常听', 'books': []}]})

def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond: PASS += 1; print(f'  ✅ {name}')
    else: FAIL += 1; print(f'  ❌ {name} {extra}')

# 在页面里"卸载" dvh：等价于老内核的解析结果（整条声明被丢弃）。
# 关键：vite 产物样式是**外链** stylesheet，必须取回文本净化后再注入覆盖，
# 同时禁掉原表，否则原表里的 dvh 声明仍然生效。
DROP_DVH = """
async () => {
  // 声明级删除：不管嵌套多深（@media 里也能删），且不会碰坏花括号结构。
  // 注意不能加 \b —— "100dvh" 中 0 与 d 都是词字符，\b 永不匹配，正则会空转。
  const strip = css => css.replace(
    /[-a-zA-Z]+\s*:\s*[^;{}]*(?:dvh|svh|lvh)[^;{}]*;?/g, '')
  let n = 0
  for (const s of document.querySelectorAll('style')) {
    if (s.textContent && /dvh|svh|lvh/.test(s.textContent)) {
      s.textContent = strip(s.textContent); n++
    }
  }
  for (const l of [...document.querySelectorAll('link[rel=stylesheet]')]) {
    try {
      const css = await (await fetch(l.href)).text()
      if (!/dvh|svh|lvh/.test(css)) continue
      const st = document.createElement('style')
      st.textContent = strip(css)
      document.head.appendChild(st)   // 后注入 = 同优先级下覆盖
      l.disabled = true               // 禁掉仍含 dvh 的原表
      n++
    } catch (e) {}
  }
  for (const el of document.querySelectorAll('[style]')) {
    const v = el.getAttribute('style') || ''
    if (/dvh|svh|lvh/.test(v)) {
      el.setAttribute('style', v.replace(
        /[-a-zA-Z]+\s*:\s*[^;{}]*(?:dvh|svh|lvh)[^;{}]*;?/g, ''))
      n++
    }
  }
  return n
}
"""

with sync_playwright() as pw:
    br = pw.chromium.launch()
    for label, w, h in [('小米8SE 393x673', 393, 673), ('大屏 430x932', 430, 932)]:
        print(f'\n=== {label} ===')
        ctx = br.new_context(viewport={'width': w, 'height': h},
                             user_agent='Mozilla/5.0 (Linux; Android 10; MI 8 SE) '
                                        'AppleWebKit/537.36 (KHTML, like Gecko) '
                                        'Version/4.0 Chrome/105.0 Mobile Safari/537.36')
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))

        def hdl(route):
            req = route.request
            p = re.sub(r'^https?://[^/]+', '', req.url).split('?')[0]
            if p == '/api/collections':
                return route.fulfill(status=200, content_type='application/json',
                                     body=COLLECTIONS)
            if p in FX:
                return route.fulfill(status=200, content_type='application/json',
                                     body=json.dumps(FX[p]))
            if p.endswith('/cover'):
                return route.fulfill(status=200, content_type='image/png',
                                     body=bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082'))
            if p.endswith('/play'):
                try:
                    lid = (json.loads(req.post_data or '{}') or {}).get('libraryItemId') or MULTI
                except Exception:
                    lid = MULTI
                return route.fulfill(status=200, content_type='application/json',
                                     body=_play_body(lid))
            if '/file/' in p:
                return route.fulfill(status=200, content_type='audio/mpeg', body=b'')
            route.fulfill(status=200, content_type='application/json', body='{}')

        pg.route('**/api/**', hdl)
        pg.add_init_script("""
          localStorage.setItem('shelfaudio.server','http://127.0.0.1:18080');
          localStorage.setItem('shelfaudio.token','t');
          localStorage.setItem('shelfaudio.username','user');
          localStorage.setItem('shelfaudio.mode','kid');
        """)
        pg.goto('http://127.0.0.1:8899/index.html')
        pg.wait_for_timeout(1800)
        # 进播放页：与 ui-new-features 相同路径 —— 点书卡 → 触发 play → 自动进入
        pg.evaluate("document.querySelector('.book-card')?.click()")
        pg.wait_for_timeout(2600)
        view0 = pg.evaluate("document.body.dataset.view")
        if view0 != 'player':
            # 有的书卡是打开详情，再点一次播放按钮
            pg.evaluate("document.querySelector('#btnPlayTop, .play-fab, [data-play]')?.click()")
            pg.wait_for_timeout(2600)

        # 关键一步：模拟老内核丢弃所有 dvh/svh/lvh 声明
        n = pg.evaluate(DROP_DVH)
        pg.wait_for_timeout(300)
        print(f"     已净化 {n} 个含新单位的 style 块")

        m = pg.evaluate("""() => {
          const v = document.querySelector('#view')
          if (!v) return null
          const t = document.querySelector('.player-tools')
          return {
            view: document.body.dataset.view,
            viewH: Math.round(v.getBoundingClientRect().height),
            winH: window.innerHeight,
            docH: Math.round(document.documentElement.scrollHeight),
            toolsBottom: t ? Math.round(t.getBoundingClientRect().bottom) : null
          }
        }""")
        if not m:
            ok('播放页已渲染', False, '(#view 不存在)')
            ctx.close(); continue
        print(f"     view={m['view']} #view 高 {m['viewH']} / 视口 {m['winH']}")
        ok('进到了播放页', m['view'] == 'player', f"(实际 {m['view']})")
        ok('无 dvh 时播放页仍撑满视口', m['viewH'] >= m['winH'] - 2,
           f"(差 {m['winH'] - m['viewH']}px)")
        ok('工具行（倍速/定时/选集）在屏内',
           m['toolsBottom'] is not None and m['toolsBottom'] <= m['winH'] + 2,
           f"(底 {m['toolsBottom']} vs 视口 {m['winH']})")
        ok('无 JS 报错', not errs, str(errs[:1]))
        ctx.close()
    br.close()

print('\n' + '=' * 46)
print(f'结果：{PASS} 通过 / {FAIL} 失败')
sys.exit(1 if FAIL else 0)
