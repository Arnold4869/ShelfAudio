#!/usr/bin/env python3
"""test-fake-button.py 用的本地 mock：/status /api/libraries /api/me 等最小实现 + dist 静态文件。"""
import json, os, re, sys, zlib
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DIST = '/home/Bin/ShelfAudio/dist'
BOOK = {"id": "b1", "media": {"metadata": {"title": "测试有声书", "authorName": "作者A"}, "duration": 3600,
                              "audioFiles": [{"ino": "f1", "duration": 3600}], "chapters": []}}


def png(w=40, h=40, rgb=(90, 140, 200)):
    def chunk(t, d):
        c = t + d
        return len(d).to_bytes(4, 'big') + c + zlib.crc32(c).to_bytes(4, 'big')
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + b'\x08\x02\x00\x00\x00')
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


PNG = png()


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        # 允许跨端口访问（页面由别处的静态服务托管时也要能调）
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path.split('?')[0]
        # 登录接口（POST 也走同一分支）
        if p == '/status':
            return self._json({'version': '2.36.0'})
        if p == '/api/libraries':
            return self._json({'libraries': [{'id': 'lib1', 'name': '有声书', 'mediaType': 'book'}]})
        if p.endswith('/items'):
            return self._json({'results': [BOOK], 'total': 1})
        if p == '/api/me':
            return self._json({'username': 'Bin', 'mediaProgress': []})
        if p == '/api/me/items-in-progress':
            return self._json({'libraryItems': []})
        if p == '/api/collections':
            return self._json({'collections': []})
        if re.search(r'/api/items/[^/]+/cover', p):
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
            return
        return super().do_GET()


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8897), H).serve_forever()
