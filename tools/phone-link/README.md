# 手机 → ComfyUI 的 USB 链路

手机上的酒馆要连电脑的 ComfyUI，最稳的是 **USB + adb reverse**，不是 WiFi、也不是内网穿透。

## 为什么

- 走 USB，**不经过网络**。所以手机开梯子、关 WiFi、换流量卡，都不影响。
- Android 同一时间只允许一个 VPN 生效。Clash / 梯子占了那个位置，Tailscale 这类点对点方案就会掉线，所以「手机和电脑不在一个 WiFi」这件事只能靠 USB 或公网隧道解决，别指望内网 IP。

## 一条命令修好

双击 `relink.bat`，或者：

```bash
python tools/phone-link/link.py
```

脚本会：找 adb → 清掉占用电脑 8188 的 `adb forward` → 建立 `adb reverse tcp:18188 tcp:8188` → 自检。

看到 `链路已通` 后，手机上打开：

```
http://127.0.0.1:18188/system_stats
```

能显示一串 JSON 就成功了。插件里的「ComfyUI 地址」填 `http://127.0.0.1:18188`。

## 端口方向的坑（重要）

| 命令 | 方向 | 后果 |
| --- | --- | --- |
| `adb forward tcp:8188 tcp:8188` | 电脑 → 手机 | **会抢走电脑自己的 8188**，ComfyUI 立刻表现为「连不上 / 空响应」，看起来像崩了，其实是被 adb 顶掉了 |
| `adb reverse tcp:18188 tcp:8188` | 手机 → 电脑 | 正确。手机访问 `127.0.0.1:18188` 就打到电脑的 ComfyUI |

为什么用 18188 而不是 8188：`adb reverse tcp:8188 tcp:8188` 会报 `cannot bind listener: Address already in use`，因为手机本地已经有东西占着 8188。换 18188 避开冲突。

## 什么时候需要重跑

- 拔掉 USB 再插回来
- adb 守护进程重启（`adb kill-server`、电脑睡眠唤醒等）
- 换了一台手机

`adb reverse` 不是持久的，属于会话级映射，掉了重跑脚本即可。
