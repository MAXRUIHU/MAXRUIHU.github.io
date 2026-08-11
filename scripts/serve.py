#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地开发服务器（零依赖）
  * 静态托管 public/ 目录
  * POST /api/update  -> 重新运行清洗管线（可选：先刷新指数数据），实现网页动态更新
  * --watch           -> 监听私募周报目录，出现新 xlsx 后自动重建

用法:
  python3 scripts/serve.py [--port 8000] [--watch]
"""
import argparse
import datetime
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
PUBLIC = os.path.join(ROOT, "public")
SRC = os.path.normpath(os.path.join(ROOT, "..", "私募周报"))
BENCH_SCRIPT = os.path.join(HERE, "fetch_benchmarks.py")
CLEAN_SCRIPT = os.path.join(HERE, "clean_data.py")


def run(cmd):
    print("  $", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-2000:])
        print(r.stderr[-2000:])
    return r.returncode == 0, r


def rebuild(fetch_bench=True):
    t0 = time.time()
    ok = True
    if fetch_bench:
        ok, r = run([sys.executable, BENCH_SCRIPT])
    ok2, r2 = run([sys.executable, CLEAN_SCRIPT])
    return ok and ok2, {"elapsed": round(time.time() - t0, 1),
                        "clean": r2.stdout.strip().splitlines()[-3:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (datetime.datetime.now().strftime("%H:%M:%S"), fmt % args), flush=True)

    def _send(self, code, body, ctype="application/json; charset=utf-8", cache="no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/status":
            data = json.dumps({"ok": True, "time": datetime.datetime.now().isoformat(),
                               "source": SRC}, ensure_ascii=False).encode()
            return self._send(200, data)
        # 静态文件
        rel = u.path.lstrip("/") or "index.html"
        if not rel or rel.endswith("/"):
            rel = rel + "index.html"
        fp = os.path.normpath(os.path.join(PUBLIC, rel))
        if not fp.startswith(PUBLIC) or not os.path.isfile(fp):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        cache = "no-cache" if fp.endswith(".json") else "public, max-age=60"
        with open(fp, "rb") as f:
            return self._send(200, f.read(), ctype, cache)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/update":
            q = {k: v for k, v in [p.split("=", 1) for p in u.query.split("&") if "=" in p]}
            ok, info = rebuild(fetch_bench=q.get("bench", "1") != "0")
            self._send(200 if ok else 500,
                       json.dumps({"ok": ok, **info}, ensure_ascii=False).encode())
        else:
            self._send(404, b"not found", "text/plain")


def watcher(stop):
    seen = {f for f in os.listdir(SRC) if f.endswith(".xlsx")} if os.path.isdir(SRC) else set()
    while not stop.is_set():
        time.sleep(5)
        if not os.path.isdir(SRC):
            continue
        now = {f for f in os.listdir(SRC) if f.endswith(".xlsx") and not f.startswith("~$")}
        if now - seen:
            added = sorted(now - seen)
            print(f"\n[watch] 检测到新周报: {added}，自动重建…", flush=True)
            rebuild(fetch_bench=False)
            seen = now


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--watch", action="store_true", help="监听私募周报目录，新文件自动重建")
    args = ap.parse_args()

    print("=" * 64)
    print(" 私募量化周刊 · 本地服务")
    print(f" 静态目录 : {PUBLIC}")
    print(f" 源数据   : {SRC}")
    print(f" 访问地址 : http://{args.host}:{args.port}/")
    print(" POST /api/update 可重新运行清洗管线（?bench=0 跳过指数下载）")
    if args.watch:
        print(" 监听模式 : 已开启（新 xlsx 自动重建）")
    print("=" * 64)

    stop = threading.Event()
    if args.watch:
        threading.Thread(target=watcher, args=(stop,), daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        stop.set()


if __name__ == "__main__":
    main()
