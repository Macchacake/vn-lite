#!/usr/bin/env python3
"""
start-tunnel — 一键把 ComfyUI 通过 Tailscale Funnel 暴露到公网，并打印插件要填的地址。

它会做这几件事：
  1. 确保带令牌的反向代理在跑（没跑就拉起来）
  2. 查本机的 tailnet 域名
  3. 开 tailscale funnel
  4. 真的去访问一次公网地址，确认通了
  5. 打印「插件里 ComfyUI 地址」应该填什么

用法：  python start-tunnel.py
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.path.join(HERE, "vnl-tunnel.py")
TOKEN_FILE = os.path.join(HERE, "token.txt")

TS = r"C:\Program Files\Tailscale\tailscale.exe"
LOCAL_PORT = 8199
COMFY_PORT = 8188


def ts(*args, timeout=60):
    try:
        p = subprocess.run([TS, *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 1, "timeout"
    except FileNotFoundError:
        return 1, "tailscale not found"


def port_open(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def ensure_proxy():
    if port_open(LOCAL_PORT):
        return True
    print("· 启动反向代理 …")
    creation = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    subprocess.Popen([sys.executable, PROXY, "--port", str(LOCAL_PORT),
                      "--target", "127.0.0.1:%d" % COMFY_PORT],
                     cwd=HERE, creationflags=creation)
    for _ in range(40):
        time.sleep(0.25)
        if port_open(LOCAL_PORT):
            return True
    return False


def tailnet_host():
    rc, out = ts("status", "--json")
    if rc != 0:
        return ""
    try:
        d = json.loads(out[out.index("{"):])
        return (d.get("Self", {}).get("DNSName") or "").rstrip(".")
    except Exception:
        return ""


def main():
    if not os.path.isfile(TOKEN_FILE):
        rc, out = ts("version")  # 无关，只是确保文件被创建
        subprocess.run([sys.executable, PROXY, "--print-token"], cwd=HERE)
    token = open(TOKEN_FILE, encoding="utf-8").read().strip() if os.path.isfile(TOKEN_FILE) else ""
    if not token:
        print("✗ 读不到 token.txt，先手动跑一次： python vnl-tunnel.py --print-token")
        return 1

    if not port_open(COMFY_PORT):
        print("✗ ComfyUI 没在 %d 端口上，先把 ComfyUI 开起来" % COMFY_PORT)
        return 1
    print("· ComfyUI 在线（%d）" % COMFY_PORT)

    if not ensure_proxy():
        print("✗ 反向代理起不来")
        return 1
    print("· 反向代理在线（%d）" % LOCAL_PORT)

    host = tailnet_host()
    if not host:
        print("✗ 拿不到 tailnet 域名，Tailscale 是不是没登录？")
        return 1
    print("· tailnet 域名：%s" % host)

    print("· 开 Funnel …")
    rc, out = ts("funnel", "--bg", str(LOCAL_PORT), timeout=90)
    text = out.strip()
    if "not enabled" in text or "does not support" in text:
        print()
        print("!" * 62)
        print(" Funnel 还没在你的 tailnet 上开启，需要点一下授权：")
        for line in text.splitlines():
            if "https://" in line:
                print("   " + line.strip())
        print()
        print(" 点完授权后，再跑一次本脚本即可。")
        print("!" * 62)
        return 2

    url = "https://%s/%s" % (host, token)
    print("· 验证公网地址 …")
    ok = False
    for i in range(20):
        time.sleep(2)
        try:
            with urllib.request.urlopen(url + "/system_stats", timeout=12) as r:
                if r.status == 200:
                    ok = True
                    break
        except Exception as e:
            last = e
    print()
    if ok:
        print("=" * 62)
        print(" 成功。插件里「ComfyUI 地址」填这一整行：")
        print()
        print("   " + url)
        print()
        print(" 这个地址在任何网络、开不开梯子都能用。")
        print("=" * 62)
        return 0
    print("✗ 公网地址还没通（最后一次错误：%s）" % last)
    print("  等 1~2 分钟证书签发完再试，或看 tailscale funnel status")
    return 1


if __name__ == "__main__":
    sys.exit(main())
