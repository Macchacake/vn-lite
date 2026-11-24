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

## 两条路，选一条

| 方案 | 地址 | 需要你做什么 | 电脑重启后 |
| --- | --- | --- | --- |
| **A. 云隧道（立刻能用）** | `https://xxxx.trycloudflare.com/<token>`，**每次启动会变** | 双击 `public-tunnel.bat` | 重跑一次，重新粘地址 |
| **B. Tailscale Funnel（永久固定）** | `https://neko.xxx.ts.net/<token>`，**永不变** | 一次性点两个开关 | 不用管 |

先用 A 把东西跑起来；等 A 的「每次换地址」烦到你了，再去开 B。

---

## A. 云隧道（Cloudflare 快速隧道）

```bat
:: 确保 ComfyUI 在 8188 跑着，然后双击：
public-tunnel.bat
```

或者命令行：

```bat
python tools\tunnel\start-public.py
```

脚本会自动：起本地令牌代理 → 找本机代理（Clash 7897 等）→
建隧道 → 自检 200 → **把地址复制到剪贴板**。

成功后直接把剪贴板内容粘进插件设置的「ComfyUI 地址」，形如：

```
https://nearly-sugar-rapids-fall.trycloudflare.com/8Y3UCqPK40HqI6_0zt73n_3W
```

### 几个实测结论（别再踩一遍）

- **必须走本机代理**。国内直连会在 `Requesting new quick Tunnel` 卡死，
  最后报 `context deadline exceeded`。脚本会自动带上 `HTTPS_PROXY`。
- cloudflared **没有** `--http-proxy` 参数（那是 origin 相关的另一组），
  只能靠 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量。
- Cloudflare 按 IP 限流快速隧道。连续创建会失败，
  脚本内置 3 轮重试 + 递增等待，一般第 1~2 轮就成。
- 隧道进程是普通进程，**关掉终端窗口不影响**，但电脑重启就没了。
- 域名每次启动都变，这是免费快速隧道的固有行为，不是配置问题。

## B. Tailscale Funnel（地址固定）

一次性两个开关，都在后台管理页：

1. **开启 HTTPS 证书**（Funnel 依赖它）
   <https://login.tailscale.com/admin/dns>
   找到 *HTTPS Certificates*，点 Enable。
   不开启的话 `tailscale cert` 会报
   `500 ... your Tailscale account does not support getting TLS certs`。

2. **开启 Funnel**
   <https://login.tailscale.com/f/funnel?node=nMJv1vdbs111CNTRL>

两步都做完后：

```bat
python tools\tunnel\start-tunnel.py
```

它会打印 `https://<你的tailnet>.ts.net/<token>`，这个地址**永久不变**。
Funnel 由 tailscaled 后台服务托管，不占终端，开机自动生效。

### 手动方式

```bat
:: 终端 A
python tools\tunnel\vnl-tunnel.py

:: 终端 B
tailscale funnel --bg 8199
tailscale funnel status
```

## 安全

- 不带令牌 → 403
- `/` 只回一行 `vnl-tunnel ok`，给隧道健康检查用
- 令牌是 24 字符随机串（`token.txt`），别贴到公开地方；
  想换就删掉它重新生成
- 不想要公网了：`tailscale funnel reset`，或直接关掉 cloudflared 进程
