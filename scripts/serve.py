#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
私募量化周刊 · 本地/生产后端服务（零依赖，含真实登录鉴权）
============================================================

三种鉴权模式（环境变量 PE_AUTH_MODE 控制）：
  session  后端会话登录：GET / 未登录 -> 302 /login；登录成功后下发
           HMAC 签名、HttpOnly 的会话 Cookie；登录失败展示微信二维码。
  basic    HTTP Basic Auth（RFC 7617）：浏览器原生弹窗；401 + WWW-Authenticate。
  off      不鉴权（默认；仅用于本地开发，会打印警告）。

安全特性：
  * 密码不落盘比较 —— 启动时用 PBKDF2-HMAC-SHA256 派生校验，支持常量时间比较
  * 会话 Cookie：HttpOnly + SameSite=Lax（HTTPS 下自动加 Secure）
  * 登录限流：同一 IP 连续失败 PE_AUTH_MAX_ATTEMPTS 次锁定 PE_AUTH_LOCKOUT 秒
  * 除 /login、/logout、/img/1132.jpg 外，其余资源（含 data JSON）全部要求登录
  * 鉴权生效时，向 index.html 注入 <meta name="pe-auth">，前端自动跳过客户端弹窗

配置（环境变量，均有默认）：
  PE_AUTH_MODE      session | basic | off          默认 off
  PE_AUTH_PASSWORD  登录密码                        （必填，否则鉴权模式下拒绝启动）
  PE_AUTH_SECRET    Cookie 签名密钥（自动生成则重启后会话失效）
  PE_AUTH_TTL       会话有效期秒                    默认 43200 (12h)
  PE_AUTH_MAX_ATTEMPTS / PE_AUTH_LOCKOUT           默认 5 / 15

用法:
  PE_AUTH_MODE=session PE_AUTH_PASSWORD=你的密码 python3 scripts/serve.py --port 8000
  PE_AUTH_MODE=basic   PE_AUTH_PASSWORD=你的密码 python3 scripts/serve.py --port 8000
  python3 scripts/serve.py --watch        # 监听周报目录，新 xlsx 自动重建
  curl -u 任意用户名:密码 http://127.0.0.1:8000/   # basic 模式
"""
import argparse
import base64
import datetime
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
PUBLIC = os.path.join(ROOT, "public")
if not os.path.isdir(PUBLIC):
    PUBLIC = ROOT  # 兼容 github.io 仓库根目录即站点的部署形态
SRC = os.path.normpath(os.path.join(ROOT, "..", "私募周报"))
BENCH_SCRIPT = os.path.join(HERE, "fetch_benchmarks.py")
CLEAN_SCRIPT = os.path.join(HERE, "clean_data.py")

AUTH_MODE = os.environ.get("PE_AUTH_MODE", "off").strip().lower()
AUTH_PASSWORD = os.environ.get("PE_AUTH_PASSWORD", "")
AUTH_SECRET = os.environ.get("PE_AUTH_SECRET", "").strip() or secrets.token_hex(32)
AUTH_TTL = int(os.environ.get("PE_AUTH_TTL", "43200"))
MAX_ATTEMPTS = int(os.environ.get("PE_AUTH_MAX_ATTEMPTS", "5"))
LOCKOUT = int(os.environ.get("PE_AUTH_LOCKOUT", "15"))
AUTH_USERNAME = os.environ.get("PE_AUTH_USERNAME", "admin")  # basic 模式用户名
COOKIE_NAME = "pe_session"

# ---- 密码派生（PBKDF2），不保存明文 -------------------------------------
_PWD_SALT = secrets.token_hex(16)
_PWD_ITER = 200_000


def _derive(pwd: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pwd.encode(), salt.encode(), _PWD_ITER).hex()


_PWD_HASH = _derive(AUTH_PASSWORD, _PWD_SALT) if AUTH_PASSWORD else None


def _check_password(pwd: str) -> bool:
    if not _PWD_HASH:
        return False
    return hmac.compare_digest(_derive(pwd, _PWD_SALT), _PWD_HASH)


# ---- 会话签名（HMAC-SHA256） ---------------------------------------------
def sign_session(exp: int) -> str:
    payload = f"{exp}.{secrets.token_hex(8)}"
    sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}.{sig}".encode()).decode()


def verify_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        payload, sig = raw.rsplit(".", 1)
        expect = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return False
        exp = int(payload.split(".")[0])
        return exp > int(time.time())
    except Exception:
        return False


# ---- 登录限流 ------------------------------------------------------------
_lock = threading.Lock()
_fails: dict[str, list[float]] = {}


def rate_allowed(ip: str) -> tuple[bool, int]:
    now = time.time()
    with _lock:
        lst = [t for t in _fails.get(ip, []) if now - t < LOCKOUT]
        _fails[ip] = lst
        if len(lst) >= MAX_ATTEMPTS:
            return False, int(LOCKOUT - (now - lst[0]))
        return True, 0


def rate_fail(ip: str) -> None:
    with _lock:
        _fails.setdefault(ip, []).append(time.time())


def rate_clear(ip: str) -> None:
    with _lock:
        _fails.pop(ip, None)


# ---- 静态资源 & 业务 ------------------------------------------------------
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
        ok, _ = run([sys.executable, BENCH_SCRIPT])
    ok2, r2 = run([sys.executable, CLEAN_SCRIPT])
    return ok and ok2, {"elapsed": round(time.time() - t0, 1),
                        "clean": r2.stdout.strip().splitlines()[-3:]}


LOGIN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>登录 · 私募量化周刊</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC",
         "Helvetica Neue", sans-serif; background: #f5f5f7; color: #1d1d1f;
         min-height: 100vh; display: grid; place-items: center; padding: 20px;
         -webkit-font-smoothing: antialiased; }
  .card { width: 100%; max-width: 380px; background: #fff; border: 1px solid rgba(0,0,0,.08);
          border-radius: 24px; box-shadow: 0 24px 60px rgba(0,0,0,.08); padding: 36px 30px;
          text-align: center; }
  .icon { width: 62px; height: 62px; margin: 0 auto 16px; border-radius: 50%;
          background: rgba(0,113,227,.1); color: #0071e3; display: grid; place-items: center; }
  h1 { font-size: 22px; font-weight: 800; letter-spacing: -.02em; }
  .sub { font-size: 13px; color: #6e6e73; margin-top: 6px; }
  form { margin-top: 20px; }
  input { width: 100%; border: 1px solid rgba(0,0,0,.12); border-radius: 12px;
          padding: 12px 14px; font-size: 15px; outline: none; background: #fafafc;
          letter-spacing: 3px; transition: border-color .2s, box-shadow .2s; }
  input:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,.12); }
  button { width: 100%; margin-top: 12px; border: none; border-radius: 12px;
           background: #0071e3; color: #fff; font-size: 15px; font-weight: 700;
           padding: 12px; cursor: pointer; transition: transform .15s, box-shadow .2s; }
  button:hover { box-shadow: 0 6px 18px rgba(0,113,227,.28); transform: translateY(-1px); }
  .err { color: #e03131; font-size: 13px; margin-top: 12px; min-height: 18px; }
  .qr { margin-top: 14px; }
  .qr img { width: 176px; height: auto; border-radius: 16px; border: 1px solid rgba(0,0,0,.08);
            box-shadow: 0 8px 24px rgba(0,0,0,.1); }
  .qr p { font-size: 12.5px; color: #6e6e73; margin-top: 10px; }
  .hint { font-size: 11.5px; color: #a1a1a6; margin-top: 18px; }
  .shake { animation: sh .4s ease; }
  @keyframes sh { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-10px)}
                  60%{transform:translateX(6px)} 80%{transform:translateX(-4px)} }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="3"/>
           <path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
    </div>
    <h1>私募量化周刊</h1>
    <p class="sub">请输入访问密码以继续</p>
    <form method="post" action="/login" autocomplete="off">
      <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="off" />
      <button type="submit">进入</button>
    </form>
    <p class="err">__ERROR__</p>
    <div class="qr" id="qr" __QR_HIDDEN__>
      <img src="/img/1132.jpg" alt="微信二维码" />
      <p>密码错误 · 扫码添加微信获取访问密码</p>
    </div>
    <p class="hint">服务端会话鉴权 · 密码错误将展示微信二维码</p>
  </div>
  <script>
    if (location.search.indexOf('error') >= 0) {
      document.querySelector('.card').classList.add('shake');
    }
    document.querySelector('form').addEventListener('submit', function (e) {
      var v = this.querySelector('input').value;
      if (!v) { e.preventDefault(); }
    });
  </script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (datetime.datetime.now().strftime("%H:%M:%S"), fmt % args), flush=True)

    # ---- 基础工具 ------------------------------------------------------
    @property
    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def _cookie_value(self, name):
        raw = self.headers.get("Cookie", "")
        try:
            c = SimpleCookie()
            c.load(raw)
            morsel = c.get(name)
            return morsel.value if morsel else None
        except Exception:
            return None

    def _is_secure(self):
        return (self.headers.get("X-Forwarded-Proto") == "https"
                or os.environ.get("PE_FORCE_SECURE") == "1")

    def _basic_ok(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(auth[6:]).decode()
            _, pwd = decoded.split(":", 1)
            return _check_password(pwd)
        except Exception:
            return False

    def _authenticated(self) -> bool:
        if AUTH_MODE == "basic":
            return self._basic_ok()
        if AUTH_MODE == "session":
            return verify_session(self._cookie_value(COOKIE_NAME))
        return True

    def _send(self, code, body, ctype="text/plain; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, loc):
        self._send(302, b"", "text/html; charset=utf-8", {"Location": loc})

    def _serve_file(self, rel):
        if not rel or rel.endswith("/"):
            rel = rel + "index.html"
        fp = os.path.normpath(os.path.join(PUBLIC, rel))
        if not fp.startswith(PUBLIC) or not os.path.isfile(fp):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        with open(fp, "rb") as f:
            body = f.read()
        if rel == "index.html" and AUTH_MODE in ("session", "basic"):
            body = body.replace(b"</head>",
                                b'<meta name="pe-auth" content="%b"></head>' % AUTH_MODE.encode())
        return self._send(200, body, ctype, {"Cache-Control": "no-cache"})

    # ---- 路由 ----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.lstrip("/") or "index.html"
        if path == "api/status":
            return self._send(200, json.dumps({"ok": True, "auth": AUTH_MODE,
                                               "time": datetime.datetime.now().isoformat()}).encode())
        # 登录页（session 模式，未登录）
        if path == "login":
            if AUTH_MODE != "session":
                return self._redirect("/")
            if self._authenticated():
                return self._redirect("/")
            err = parse_qs(u.query).get("error")
            qr_hidden = "" if err else 'hidden'
            page = LOGIN_PAGE.replace("__ERROR__", "密码错误，请重新输入" if err else "")\
                             .replace("__QR_HIDDEN__", qr_hidden)
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if path == "logout":
            self._send(302, b"", "text/html; charset=utf-8",
                       {"Location": "/login",
                        "Set-Cookie": f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"})
            return
        # 登录页需要展示二维码，允许匿名访问该图片
        if path == "img/1132.jpg":
            return self._serve_file(path)
        # 其余资源鉴权
        if not self._authenticated():
            if AUTH_MODE == "basic":
                return self._send(401, b"Authentication required", "text/plain",
                                  {"WWW-Authenticate": 'Basic realm="PE Dashboard"'})
            return self._redirect("/login")
        return self._serve_file(path)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/login":
            if AUTH_MODE != "session":
                return self._redirect("/")
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length).decode("utf-8", "replace")
            pwd = parse_qs(raw).get("password", [""])[0]
            ip = self.client_ip
            ok, wait = rate_allowed(ip)
            if not ok:
                page = LOGIN_PAGE.replace("__ERROR__",
                                          f"尝试次数过多，请 {wait} 秒后再试")\
                                 .replace("__QR_HIDDEN__", 'hidden')
                return self._send(429, page.encode(), "text/html; charset=utf-8")
            if _check_password(pwd):
                rate_clear(ip)
                exp = int(time.time()) + AUTH_TTL
                token = sign_session(exp)
                secure = "; Secure" if self._is_secure() else ""
                self._send(302, b"", "text/html; charset=utf-8",
                           {"Location": "/",
                            "Set-Cookie": f"{COOKIE_NAME}={token}; Max-Age={AUTH_TTL}; "
                                          f"Path=/; HttpOnly; SameSite=Lax{secure}"})
            else:
                rate_fail(ip)
                self._redirect("/login?error=1")
            return
        if u.path == "/api/update":
            if not self._authenticated():
                return self._send(403, b"forbidden", "text/plain")
            q = {k: v for k, v in [p.split("=", 1) for p in u.query.split("&") if "=" in p]}
            ok, info = rebuild(fetch_bench=q.get("bench", "1") != "0")
            return self._send(200 if ok else 500,
                              json.dumps({"ok": ok, **info}, ensure_ascii=False).encode())
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
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--watch", action="store_true")
    args = ap.parse_args()

    if AUTH_MODE in ("session", "basic") and not AUTH_PASSWORD:
        print("[fatal] PE_AUTH_MODE=%s 但未设置 PE_AUTH_PASSWORD" % AUTH_MODE, file=sys.stderr)
        sys.exit(2)
    if AUTH_MODE == "off":
        print("[警告] 当前为无鉴权模式（PE_AUTH_MODE=off），仅建议本地开发使用。", flush=True)

    print("=" * 64)
    print(" 私募量化周刊 · 本地/生产服务")
    print(f" 静态目录 : {PUBLIC}")
    print(f" 源数据   : {SRC}")
    print(f" 鉴权模式 : {AUTH_MODE}" + ("" if AUTH_MODE == "off" else "（真实服务端鉴权）"))
    print(f" 访问地址 : http://{args.host}:{args.port}/")
    if AUTH_MODE == "session":
        print(" 会话有效期: %s 小时 | 限流: %s 次失败锁 %s 秒" % (AUTH_TTL // 3600, MAX_ATTEMPTS, LOCKOUT))
    if AUTH_MODE == "basic":
        print(f" Basic Auth 用户名: {AUTH_USERNAME}")
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
