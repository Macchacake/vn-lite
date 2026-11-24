# vnl-tunnel — 让手机在任意网络下连上 ComfyUI

## 为什么需要它

手机和电脑不在同一 WiFi、也不插 USB 时，手机要连电脑的 ComfyUI，只有两条路：

1. 两端在同一个虚拟局域网（Tailscale / ZeroTier）
2. 电脑把 ComfyUI 暴露到公网

**路 1 在你的手机上走不通**：Android 同一时间只允许一个 VPN。
梯子（Clash TUN）占了那个槽位，Tailscale 就上不了线。

所以走公网隧道。`vnl-tunnel.py` 是带令牌的反向代理，
因为 ComfyUI 本身**没有任何鉴权**，直接暴露等于把显卡和自定义节点的
执行权限送人。没有令牌的请求一律 403。

## 用法

```bat
:: 1) 先确保 ComfyUI 在 8188 上跑着
:: 2) 一键起代理 + 开隧道
python tools\tunnel\start-tunnel.py
```

第一次会提示你去开启 Funnel，点一下授权链接，再跑一次即可。
成功后它会打印一行地址，形如：

```
https://neko.tailxxxxx.ts.net/8Y3UCqPK40HqI6_0zt73n_3W
```

把这一整行填进插件设置的「ComfyUI 地址」。
这个地址在任何网络、开不开梯子都能用。

## 手动方式

```bat
:: 终端 A
python tools\tunnel\vnl-tunnel.py

:: 终端 B
tailscale funnel --bg 8199
tailscale funnel status
```

令牌存在 `token.txt`，想换就删掉它重新生成。

## 安全

- 不带令牌 → 403
- `/` 只回一行 `vnl-tunnel ok`，给隧道健康检查用
- 令牌是 24 字符随机串，别贴到公开地方
- 不想要公网了：`tailscale funnel reset`
