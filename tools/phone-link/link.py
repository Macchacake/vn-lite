#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手机 -> 电脑 ComfyUI 的 USB 链路一键修复。

做四件事：
  1. 找到 adb，拉起 daemon
  2. 清掉占着 PC 8188 的 adb forward（这是"ComfyUI 挂了"的真正元凶）
  3. 建立 adb reverse tcp:18188 tcp:8188（方向是 手机 -> 电脑）
  4. 自检：PC 端能连通 ComfyUI 才报成功

用法：
    python tools/phone-link/link.py

成功后手机上插件里的地址填：  http://127.0.0.1:18188
手机开梯子、关 WiFi 都不影响（走 USB 通道，不经过网络）。
"""

import os
import shutil
import socket
import subprocess
import sys
import urllib.request

REV_PORT = 18188   # 手机侧端口（约定值，插件里已内置自动探测）
COMFY_PORT = 8188  # 电脑侧 ComfyUI 端口

ADB_CANDIDATES = [
    os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"),
    os.path.expandvars(r"%ANDROID_HOME%\platform-tools\adb.exe"),
    os.path.expandvars(r"%ANDROID_SDK_ROOT%\platform-tools\adb.exe"),
    r"C:\platform-tools\adb.exe",
    r"C:\adb\adb.exe",
    "/usr/bin/adb",
    "/usr/local/bin/adb",
]


def find_adb():
    hit = shutil.which("adb")
    if hit:
        return hit
    for p in ADB_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def run(adb, *args, timeout=20):
    try:
        r = subprocess.run([adb] + list(args), capture_output=True,
                           text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return -1, "timeout"
    except Exception as e:
        return -1, str(e)


def port_open(port, host="127.0.0.1", timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout):
            return True
    except OSError:
        return False


def http_ok(url, timeout=4):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    adb = find_adb()
    if not adb:
        print("[X] 找不到 adb。请安装 Android SDK Platform-Tools，或把 adb 加进 PATH。")
        return 1
    print("[1/4] adb =", adb)

    run(adb, "start-server")
    code, out = run(adb, "devices")
    devices = [ln.split("\t")[0] for ln in out.splitlines()
               if "\tdevice" in ln]
    if not devices:
        print("[X] 没有识别到手机。请确认：USB 线插好、手机上已允许「USB 调试」。")
        print("    当前 adb devices 输出：")
        print("    " + out.strip().replace("\n", "\n    "))
        return 1
    print("[2/4] 已连接设备：", ", ".join(devices))

    # 关键：清掉占着电脑 8188 的 forward。有它在，电脑自己的 ComfyUI 会被顶掉，
    # 表现成"ComfyUI 又崩了"，其实是被 adb 抢了端口。
    code, out = run(adb, "forward", "--list")
    removed = 0
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 2 and parts[1] == "tcp:%d" % COMFY_PORT:
            run(adb, "forward", "--remove", "tcp:%d" % COMFY_PORT)
            removed += 1
    if removed:
        print("      已清掉 %d 条占用电脑 %d 端口的 adb forward（这正是之前误判的原因）"
              % (removed, COMFY_PORT))

    # 建 reverse：方向是 手机 -> 电脑
    run(adb, "reverse", "--remove", "tcp:%d" % REV_PORT)
    code, out = run(adb, "reverse", "tcp:%d" % REV_PORT, "tcp:%d" % COMFY_PORT)
    if code != 0 or "cannot bind" in out.lower():
        print("[X] adb reverse 建立失败：", out.strip())
        return 1
    print("[3/4] 已建立 reverse：手机 127.0.0.1:%d  ->  电脑 %d" % (REV_PORT, COMFY_PORT))

    ok_pc = port_open(COMFY_PORT) and http_ok("http://127.0.0.1:%d/system_stats" % COMFY_PORT)
    print("[4/4] 电脑侧 ComfyUI：", "OK" if ok_pc else "连不上")
    if not ok_pc:
        print("      请先启动 ComfyUI（--listen 0.0.0.0 --port %d），再重跑本脚本。" % COMFY_PORT)

    print()
    print("-" * 52)
    if ok_pc:
        print("链路已通。手机上打开浏览器验证：")
        print("    http://127.0.0.1:%d/system_stats" % REV_PORT)
        print("能看到一串 JSON 就对了。插件里的「ComfyUI 地址」填同一个：")
        print("    http://127.0.0.1:%d" % REV_PORT)
        print()
        print("这条通道走 USB，不经过 WiFi/流量，所以手机开梯子、切网络都不受影响。")
        print("注意：拔掉 USB 或 adb 重启后需要重跑一次本脚本。")
    print("-" * 52)
    return 0 if ok_pc else 2


if __name__ == "__main__":
    sys.exit(main())
