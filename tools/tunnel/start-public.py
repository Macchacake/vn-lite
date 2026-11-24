#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手机 -> 电脑 ComfyUI 的「公网通道」一键启动。

适用场景：手机不插 USB、不跟电脑同一个 WiFi、还开着梯子。
原理：cloudflared 快速隧道把本地带 token 的代理（8199）映射到一个
公网 https 地址，手机无论在哪个网络、开不开梯子都能访问。

链路：
    手机  --https-->  xxx.trycloudflare.com  --隧道-->  127.0.0.1:8199
                                                      (vnl-tunnel.py, 校验 token)
                                                            |
                                                      127.0.0.1:8188 (ComfyUI)

用法：
    python tools/tunnel/start-public.py

成功后把打印出来的地址（形如 https://xxx.trycloudflare.com/<token>）
填进插件设置里的「ComfyUI 地址」。
"""

import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "token.txt")
URL_FILE = os.path.join(HERE, "public-url.txt")
CF_LOG = os.path.join(HERE, "cloudflared.log")
CF_PID = os.path.join(HERE, "cloudflared.pid")

PROXY_PORT = 8199
COMFY_PORT = 8188

DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

CF_CANDIDATES = [
    os.environ.get("CLOUDFLARED", ""),
    os.path.expandvars(r"%USERPROFILE%\.dsh\mobile-access\components\cloudflared\2026.9.1\cloudflared.exe"),
    os.path.join(HERE, "bin", "cloudflared.exe"),
    r"C:\Program Files\cloudflared\cloudflared.exe",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
]


def read_token():
    if not os.path.isfile(TOKEN_FILE):
        print("[X] 找不到 token.txt，请先运行一次 vnl-tunnel.py 生成。")
        sys.exit(1)
    t = open(TOKEN_FILE, encoding="utf-8").read().strip()
    if len(t) < 16:
        print("[X] token.txt 内容异常。")
        sys.exit(1)
    return t


def find_cloudflared():
    for p in CF_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    import shutil
    return shutil.which("cloudflared")


def port_open(port, host="127.0.0.1", timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout):
            return True
    except OSError:
        return False


def http_code(url, timeout=6, proxy=None):
    try:
        if proxy:
            op = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
            r = op.open(url, timeout=timeout)
        else:
            r = urllib.request.urlopen(url, timeout=timeout)
        return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def http_code_any(url, timeout=8, proxy=None):
    """直连不通就试代理，返回第一个非 0 的结果。"""
    c = http_code(url, timeout, None)
    if c:
        return c
    if proxy:
        return http_code(url, timeout, proxy)
    return 0


def ensure_proxy(token):
    """确保 8199 上的 token 代理在跑。"""
    if port_open(PROXY_PORT):
        print("[1/4] 代理已在运行：127.0.0.1:%d" % PROXY_PORT)
        return True

    print("[1/4] 启动 token 代理 127.0.0.1:%d ..." % PROXY_PORT)
    py = sys.executable
    script = os.path.join(HERE, "vnl-tunnel.py")
    if not os.path.isfile(script):
        print("[X] 缺少 vnl-tunnel.py")
        return False
    try:
        subprocess.Popen([py, script], cwd=HERE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=DETACHED, close_fds=True)
    except Exception as e:
        print("[X] 代理启动失败：", e)
        return False

    for _ in range(30):
        if port_open(PROXY_PORT):
            print("      代理已就绪")
            return True
        time.sleep(0.3)
    print("[X] 代理没能起来（端口 %d）" % PROXY_PORT)
    return False


def stop_old_cloudflared():
    """只清理本脚本上次启动的 cloudflared，不动别的程序。"""
    if not os.path.isfile(CF_PID):
        return
    try:
        pid = int(open(CF_PID).read().strip())
    except Exception:
        return
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                       capture_output=True, timeout=10)
        print("      已关闭上一次的隧道进程 pid=%d" % pid)
    except Exception:
        pass
    try:
        os.remove(CF_PID)
    except OSError:
        pass


def detect_proxy():
    """找一个可用的本机 HTTP 代理（Clash / v2ray 等常见端口）。"""
    for p in (7897, 7890, 10809, 1080):
        if port_open(p):
            return "http://127.0.0.1:%d" % p
    return None


def _spawn_cloudflared(cf, proxy=None):
    if os.path.isfile(CF_LOG):
        try:
            os.remove(CF_LOG)
        except OSError:
            pass
    args = [cf, "tunnel", "--url", "http://127.0.0.1:%d" % PROXY_PORT,
            "--no-autoupdate", "--logfile", CF_LOG, "--loglevel", "info"]
    env = os.environ.copy()
    if proxy:
        # cloudflared 没有 --http-proxy 参数，靠 Go 的标准环境变量走代理
        env["HTTPS_PROXY"] = proxy
        env["HTTP_PROXY"] = proxy
        env["ALL_PROXY"] = proxy
    p = subprocess.Popen(args, cwd=HERE, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=DETACHED, close_fds=True)
    try:
        open(CF_PID, "w").write(str(p.pid))
    except OSError:
        pass
    return p


def _wait_host(proc, seconds):
    pat = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(1)
        if os.path.isfile(CF_LOG):
            try:
                txt = open(CF_LOG, encoding="utf-8", errors="replace").read()
            except OSError:
                txt = ""
            m = pat.search(txt)
            if m:
                return m.group(0)
        if proc.poll() is not None:
            return None
    return None


def _kill(proc):
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/F"],
                           capture_output=True, timeout=10)
        except Exception:
            pass


def start_cloudflared(cf):
    print("[2/4] 建立公网隧道 ...")
    stop_old_cloudflared()

    proxy = detect_proxy()
    # 实测：国内直连会在 "Requesting new quick Tunnel" 卡死，
    # 有本机代理时优先走代理，没有才退回直连。
    plan = []
    if proxy:
        plan.append(("代理 " + proxy, proxy))
    plan.append(("直连", None))

    # 快速隧道会被 Cloudflare 按 IP 限流（表现为 API 超时），等一会儿再来
    for attempt in range(1, 4):
        for label, px in plan:
            print("      第 %d 轮 · %s ..." % (attempt, label))
            p = _spawn_cloudflared(cf, px)
            host = _wait_host(p, 75)
            if host:
                print("      隧道地址：", host)
                return host
            reason = ""
            if os.path.isfile(CF_LOG):
                txt = open(CF_LOG, encoding="utf-8", errors="replace").read()
                if "429" in txt:
                    reason = "（Cloudflare 限流 429）"
                elif "context deadline exceeded" in txt:
                    reason = "（API 超时，多半也是限流）"
                elif "Requesting new quick Tunnel" in txt:
                    reason = "（请求卡住，出网被拦）"
                elif "hard_fail=true" in txt:
                    reason = "（连通性预检失败）"
            print("      失败 %s" % reason)
            _kill(p)
        if attempt < 3:
            wait = 20 * attempt
            print("      等 %d 秒后重试（限流是临时的）..." % wait)
            time.sleep(wait)

    print("[X] 三轮都没能建立隧道。日志末尾：")
    _dump_log()
    return None


def _dump_log():
    if not os.path.isfile(CF_LOG):
        return
    try:
        lines = open(CF_LOG, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return
    for ln in lines[-10:]:
        print("    " + ln[:220])


def main():
    token = read_token()
    print("token =", token[:6] + "..." + token[-4:])

    if not port_open(COMFY_PORT):
        print("[!] 注意：本地 %d 上没检测到 ComfyUI，隧道会通但生图会失败。" % COMFY_PORT)

    cf = find_cloudflared()
    if not cf:
        print("[X] 找不到 cloudflared。请下载后放到 tools/tunnel/bin/cloudflared.exe，")
        print("    或设置环境变量 CLOUDFLARED 指向它。")
        return 1
    print("      cloudflared =", cf)

    if not ensure_proxy(token):
        return 1

    host = start_cloudflared(cf)
    if not host:
        return 1

    print("[3/4] 校验公网可达性 ...")
    time.sleep(3)   # 隧道刚起来，路由生效需要一两秒
    px = detect_proxy()
    bare = http_code_any(host + "/", 12, px)
    good = http_code_any(host + "/" + token + "/system_stats", 15, px)
    print("      裸地址 /        => %s（应为 200，只回 vnl-tunnel ok）" % bare)
    print("      带 token /stats => %s（应为 200）" % good)

    if good != 200:
        print("[X] 带 token 的请求没通，隧道没接上代理。")
        _dump_log()
        return 2

    full = host + "/" + token
    try:
        open(URL_FILE, "w", encoding="utf-8").write(full + "\n")
    except OSError:
        pass
    copy_clip(full)

    print("[4/4] 完成（地址已复制到剪贴板，直接粘进插件即可）")
    print()
    print("=" * 58)
    print("插件设置 ->「ComfyUI 地址」填这一行：")
    print()
    print("    " + full)
    print()
    print("=" * 58)
    print("这个地址公网可访问，但没 token 一律 403，别人拿到域名也进不来。")
    print("电脑重启 / 隧道重启后域名会变，重跑本脚本再贴一次即可。")
    print("想固定域名：开启 Tailscale Funnel 后用 start-tunnel.py，")
    print("地址会固定成 https://<你的tailnet>.ts.net/<token>。")
    return 0


def copy_clip(text):
    try:
        if os.name == "nt":
            p = subprocess.Popen(["clip"], stdin=subprocess.PIPE)
            p.communicate(text.encode("utf-8"))
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
