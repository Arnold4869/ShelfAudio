#!/usr/bin/env python3
"""老板 2026-09-15「假按钮」回归测试。

背景：点「进入悦耳」/ 冷启动拉库失败时，异常被静默吞掉 —— 零请求零提示零跳转，
按钮看着像坏的。修复后必须满足：
  1. 失败必须弹人话提示（toast 非空）
  2. 失败留在登录页（不假装进去、也不假装回到登录页了事）
  3. 按钮要恢复可点（不能卡在「进入中…」）
  4. 失败提示必须是中文人话，不能是 "Failed to fetch"
  5. 成功路径不能受影响：能正常进主界面

跑法：python3 scripts/test-fake-button.py
前置：本机装了 chromium（~/.cache/ms-playwright/），脚本自己拉起来 + 起静态服务。
"""
import base64, json, os, socket, struct, subprocess, sys, time, urllib.request, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
PORT = 8910
CDP_PORT = 9334
CHROME_CANDIDATES = [
    os.path.expanduser('~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'),
    shutil.which('chromium') or '', shutil.which('google-chrome') or '',
]

fails = []


def ok(name, cond, extra=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))
    if not cond:
        fails.append(name)


# ---------------- 极简 WebSocket / CDP ----------------
class WS:
    def __init__(self, url):
        rest = url[5:]
        hostport, path = rest.split('/', 1)
        host, port = hostport.split(':')
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            resp += self.sock.recv(4096)
        self.buf = b''

    def _read(self, n):
        while len(self.buf) < n:
            ch = self.sock.recv(65536)
            if not ch:
                raise ConnectionError('closed')
            self.buf += ch
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b1, b2 = self._read(2)
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack('>H', self._read(2))[0]
        elif ln == 127:
            ln = struct.unpack('>Q', self._read(8))[0]
        masked = b2 & 0x80
        mask = self._read(4) if masked else None
        p = self._read(ln)
        if masked:
            p = bytes(c ^ mask[i % 4] for i, c in enumerate(p))
        return p.decode('utf-8', 'replace')

    def send(self, text):
        d = text.encode()
        h = bytearray([0x81])
        n = len(d)
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            h += bytes([0x80 | 127]) + struct.pack('>Q', n)
        m = os.urandom(4)
        h += m
        self.sock.sendall(bytes(h) + bytes(c ^ m[i % 4] for i, c in enumerate(d)))


class CDP:
    def __init__(self, url):
        self.w = WS(url)
        self.id = 0
        self.events = []

    def call(self, method, **params):
        self.id += 1
        mid = self.id
        self.w.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.w.recv())
            if msg.get('id') == mid:
                self._drain(0.3)
                return msg
            self.events.append(msg)

    def _drain(self, sec=0.3):
        self.w.sock.settimeout(sec)
        try:
            while True:
                self.events.append(json.loads(self.w.recv()))
        except Exception:
            pass
        self.w.sock.settimeout(60)

    def ev(self, expr, awaitp=False):
        r = self.call('Runtime.evaluate', expression=expr, awaitPromise=awaitp, returnByValue=True)
        res = r.get('result', {})
        if 'exceptionDetails' in res:
            return 'EXC: ' + str(res['exceptionDetails'].get('exception', {}).get('description', ''))[:200]
        return res.get('result', {}).get('value')


def main():
    if not os.path.isdir(DIST):
        print('跳过：dist 不存在，先 node ./node_modules/vite/bin/vite.js build')
        return 0
    chrome = next((c for c in CHROME_CANDIDATES if c and os.path.exists(c)), None)
    if not chrome:
        print('跳过：本机没有 chromium')
        return 0

    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                           cwd=DIST, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    br = subprocess.Popen([chrome, '--headless=new', '--no-sandbox', '--disable-gpu',
                           f'--remote-debugging-port={CDP_PORT}',
                           f'--user-data-dir=/tmp/sa-regress-{os.getpid()}', 'about:blank'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        base = f'http://127.0.0.1:{PORT}/index.html'
        for _ in range(40):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/version', timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        tabs = [t for t in json.load(urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json'))
                if t['type'] == 'page']
        c = CDP(tabs[0]['webSocketDebuggerUrl'])
        c.call('Runtime.enable')
        c.call('Network.enable')
        c.call('Network.setCacheDisabled', cacheDisabled=True)
        c.call('Page.enable')

        def fresh(prefs, wait=6.5):
            # ⚠️ 必须先落在目标 origin 再写 localStorage —— 在 about:blank 上写是
            # 写到空 origin 去的，导航后全丢（这个坑让第一版测试假通过/假失败过）。
            c.call('Page.navigate', url=base)
            time.sleep(2)
            c.ev(prefs)
            c.events.clear()
            c.call('Page.reload')
            time.sleep(wait)
            c._drain(1.5)

        def toast():
            return (c.ev("document.querySelector('#toast')?.textContent") or '').strip()

        BAD = 'https://no-such-host.invalid:2088'   # 一定连不上的地址

        print('=== 1. 冷启动：服务器连不上（本机有登录信息）===')
        fresh(f"""localStorage.clear();
          localStorage.setItem('shelfaudio.server','{BAD}');
          localStorage.setItem('shelfaudio.token','tok');
          localStorage.setItem('shelfaudio.username','Bin');
          localStorage.setItem('shelfaudio.activeSource','abs'); 'ok'""")
        ok('落在登录页', c.ev('document.body.dataset.view') == 'login', c.ev('document.body.dataset.view'))
        t = toast()
        ok('冷启动失败有提示（不再静默）', bool(t), t[:60])
        ok('提示不含 Failed to fetch 等英文原文', 'Failed to fetch' not in t, t[:60])

        print('\n=== 2. 点「进入悦耳」连不上 ===')
        ok('按钮存在', c.ev("!!document.querySelector('#gotoApp')"))
        # 「进入中…」只在请求真在飞时可见 —— no-such-host 是秒败的，1 秒后早已
        # 恢复文案。这里不模拟网络延迟，改为只验证防连点逻辑存在 + 终态正确。
        btn_seq = c.ev("""(async () => {
          const b = document.querySelector('#gotoApp');
          const seen = [];
          b.click();
          for (let i = 0; i < 6; i++) { seen.push(b.textContent); await new Promise(r => setTimeout(r, 50)); }
          return seen.join('|');
        })()""", awaitp=True)
        ok('点击期间有「进入中…」状态（防连点生效）', '进入中…' in str(btn_seq), str(btn_seq)[:80])
        time.sleep(4)
        ok('仍在登录页（没假装进去）', c.ev('document.body.dataset.view') == 'login', c.ev('document.body.dataset.view'))
        t2 = toast()
        ok('点击失败有提示', bool(t2), t2[:60])
        ok('提示是人话（中文）', any('\u4e00' <= ch <= '\u9fff' for ch in t2), t2[:60])
        ok('按钮恢复可点', c.ev("document.querySelector('#gotoApp')?.disabled") is False)
        ok('按钮文案恢复', c.ev("document.querySelector('#gotoApp')?.textContent") == '进入悦耳',
           str(c.ev("document.querySelector('#gotoApp')?.textContent")))

        print('\n=== 3. 成功路径不受影响（mock 服务器）===')
        # 起一个本地 mock，验证「能连上时照常进主界面」
        mock = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                              '..', 'scripts', 'test-fake-button-mock.py')],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.2)
        try:
            fresh(f"""localStorage.clear();
              localStorage.setItem('shelfaudio.server','http://127.0.0.1:8897');
              localStorage.setItem('shelfaudio.token','tok');
              localStorage.setItem('shelfaudio.username','Bin');
              localStorage.setItem('shelfaudio.activeSource','abs'); 'ok'""", wait=7)
            ok('能连上 → 进主界面', c.ev('document.body.dataset.view') == 'kidhome', c.ev('document.body.dataset.view'))
        finally:
            mock.terminate()
    finally:
        br.terminate()
        srv.terminate()

    print()
    if fails:
        print(f'❌ {len(fails)} 项失败: ' + '; '.join(fails))
        return 1
    print('✅ 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
