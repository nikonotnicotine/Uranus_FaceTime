# Uranus FaceTime

[Uranus](https://github.com/nikonotnicotine/Uranus_Imessage) 的 FaceTime 通话节点。

在 iPhone 上创建一条 FaceTime 链接、用 iMessage 发给角色，角色就会**用自己的声音接起来** —— 真的 FaceTime，全程在 iPhone 原生的通话界面里。听得出你的语气、听得到你那边的背景声音，开着摄像头的话还看得到你。

**完整教程看 [使用教程.pdf](./使用教程.pdf)**（也有 链接 版：[facetime使用教程](https://ccnb9dqqjtkg.feishu.cn/docx/L2FqdqCpXoNeeBxR8YtcKfvVnKg))（截图级的步骤、四种部署、常见问题）。

---

## 这是什么

接电话分两半：

- **Uranus 本体**：问角色接不接、转写你说的话、让角色回话、合成语音。
- **这个节点**：开一个浏览器加入 FaceTime，把你的声音和画面送给 Uranus、把角色的声音放出去。

拆开是因为 FaceTime 只能在浏览器里加入，而 Uranus 跑在小手机（Cloudflare）、安卓上时开不了浏览器。节点**不存任何 API 密钥**，也**没有任何 npm 依赖**。

## 要求

- Node.js **22 以上**
- **官方版** Chrome 或 Edge（开源 Chromium 不行，FaceTime 的视频要 H.264）
- Linux 还要 `xvfb`
- 内存 2G 以上；能直接访问 `facetime.apple.com`
- Uranus 本体 **v1.22.0 以上**

Linux / Windows / macOS 都能跑，安卓不行。

## 选你的部署方式

在 Uranus「角色 → 接 FaceTime 通话 → 通话节点」里，第一项「节点在哪」：

| 你的 Uranus 跑在 | 节点放哪 | 在 Uranus 里选 |
|---|---|---|
| Linux VPS / Windows / Mac | 同一台 | **节点在本机** |
| VPS，节点想放别处 | 另一台机器 | 节点不在本机 → **节点来连 Uranus** |
| 安卓 / 小手机 / 家里电脑 | 一台 VPS（或常开的电脑） | 节点不在本机 → **Uranus 去连节点** |

```bash
git clone https://github.com/nikonotnicotine/Uranus_FaceTime.git
cd Uranus_FaceTime
```

### 节点在本机

```bash
sudo bash install-service.sh      # Linux：装成服务，开机自启
node src/index.mjs                # Windows / Mac：直接跑，窗口别关
```

不用配对码、不用密钥。

### 节点来连 Uranus

Uranus 里点「随机生成」密钥、复制下面那串**配对码**，然后在节点上：

```bash
sudo bash pair.sh                 # Linux（Windows / Mac：node src/index.mjs --pair）
sudo bash install-service.sh
```

### Uranus 去连节点

```bash
node src/index.mjs --listen 8788  # 打出配对密钥，记下后 Ctrl+C
sudo bash install-service.sh
```

放行 TCP 8788（安全组 + 防火墙），在 Uranus 里填节点地址 `http://<节点地址>:8788` 和那串密钥。**小手机必须填域名，不能填 IP**；域名托管在 Cloudflare 的话记录选「仅 DNS」。

## 常用命令（Linux 服务）

```bash
journalctl -u uranus-facetime -f          # 看日志
sudo systemctl restart uranus-facetime    # 重启
sudo systemctl stop uranus-facetime       # 停掉
```

## 更新

```bash
cd Uranus_FaceTime && git pull && sudo systemctl restart uranus-facetime
```

## 排查

```bash
node src/index.mjs --debug                # 详细日志
node src/index.mjs --dump                 # 苹果改了页面、按钮点不到时，把页面元素打出来
npm test                                  # 自测
```


## 许可

**非商业使用**，详见 [LICENSE](./LICENSE)。自己玩、自己学，随便；赚钱，不行。

问题反馈：QQ 群 **1125033956**
