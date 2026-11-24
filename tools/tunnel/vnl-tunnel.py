#!/usr/bin/env python3
"""
vnl-tunnel — 带令牌的反向代理，给文游Lite 的 ComfyUI 做公网入口。

为什么需要它：
  ComfyUI 本身没有任何鉴权。直接把 8188 暴露到公网，等于把显卡和
  自定义节点的执行权限送给任何人。这个代理要求 URL 里带一段随机令牌，
  没有令牌一律 403，这样隧道地址即使被扫到也进不来。

用法：
  python vnl-tunnel.py                 # 默认 127.0.0.1:8199 -> 127.0.0.1:8188
  python vnl-tunnel.py --port 8199 --target 127.0.0.1:8188
  python vnl-tunnel.py --print-token   # 只打印当前令牌

配合隧道（任选其一）：
  tailscale funnel --bg 8199           # 得到 https://<机器>.<tailnet>.ts.net/<令牌>
  cloudflared tunnel --url http://127.0.0.1:8199

插件里的「ComfyUI 地址」填：   https://<域名>/<令牌>
"""

import argparse
import http.client
import json
import os
import secrets
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "token.txt")

# 这些头是逐跳的，不能原样转发
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD, PUT, DELETE",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
}


def load_token(create=True):
    if os.path.isfile(TOKEN_FILE):
        t = open(TOKEN_FILE, "r", encoding="utf-8").read().strip()
        if t:
            return t
    if not create:
        return ""
    t = secrets.token_urlsafe(18)
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(t)
    return t


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "vnl-tunnel"

    # 由 main() 注入
    token = ""
    target_host = "127.0.0.1"
    target_port = 8188
    timeout = 120

    def log_message(self, fmt, *args):
        # 默认日志太吵（手机每秒轮询一次），只留错误
        pass

    # ---------- 内部 ----------
    def _deny(self, code, msg):
        body = json.dumps({"error": msg}, ensure_ascii=False).encode()
        self.send_response(code)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _strip_token(self, raw_path):
        """把 /<token>/xxx 变成 /xxx；不带令牌返回 None"""
        parts = urlsplit(raw_path)
        path = parts.path
        prefix = "/" + self.token
        if path == prefix:
            path = "/"
        elif path.startswith(prefix + "/"):
            path = path[len(prefix):]
        else:
            return None
        if parts.query:
            path += "?" + parts.query
        return path

    def _ok_root(self):
        """隧道服务的健康检查会打 / —— 给个 200，但不转发任何东西"""
        body = b"vnl-tunnel ok"
        self.send_response(200)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _forward(self):
        parts = urlsplit(self.path)
        if parts.path in ("/", "/health", "/healthz"):
            return self._ok_root()

        path = self._strip_token(self.path)
        if path is None:
            # 裸访问给个明确的 403，不泄露任何东西
            return self._deny(403, "forbidden: bad or missing token")

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {}
        for k, v in self.headers.items():
            if k.lower() in HOP_BY_HOP or k.lower() == "host":
                continue
            headers[k] = v
        headers["Host"] = "%s:%d" % (self.target_host, self.target_port)
        # 让 ComfyUI 知道原始客户端是 https（隧道终结 TLS）
        headers.setdefault("X-Forwarded-Proto", "https")

        conn = http.client.HTTPConnection(self.target_host, self.target_port, timeout=self.timeout)
        try:
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except Exception as e:
            conn.close()
            return self._deny(502, "upstream error: %s" % e)

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() in HOP_BY_HOP or k.lower() == "content-length":
                continue
            # 上游已经带 CORS 就别重复写
            if k.lower() in (n.lower() for n in CORS):
                continue
            self.send_header(k, v)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        conn.close()

    # ---------- HTTP 方法 ----------
    def do_GET(self):
        self._forward()

    def do_HEAD(self):
        self._forward()

    def do_POST(self):
        self._forward()

    def do_PUT(self):
        self._forward()

    def do_DELETE(self):
        self._forward()

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--target", default="127.0.0.1:8188")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--print-token", action="store_true")
    a = ap.parse_args()

    token = load_token()
    if a.print_token:
        print(token)
        return

    host, _, port = a.target.partition(":")
    Proxy.token = token
    Proxy.target_host = host or "127.0.0.1"
    Proxy.target_port = int(port or 8188)
    Proxy.timeout = a.timeout

    srv = ThreadingHTTPServer((a.bind, a.port), Proxy)
    srv.daemon_threads = True

    print("=" * 60)
    print(" vnl-tunnel 已启动")
    print("   本地监听 : http://%s:%d/%s" % (a.bind, a.port, token))
    print("   转发到   : http://%s:%d" % (Proxy.target_host, Proxy.target_port))
    print("")
    print(" 接下来开隧道（另开一个窗口）：")
    print("   tailscale funnel --bg %d" % a.port)
    print(" 或")
    print("   cloudflared tunnel --url http://127.0.0.1:%d" % a.port)
    print("")
    print(" 插件里「ComfyUI 地址」填：https://<域名>/%s" % token)
    print("=" * 60)
    sys.stdout.flush()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
