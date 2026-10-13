#!/usr/bin/env bash
#
# 把通话节点装成一个 systemd 服务：开机自启、崩了自己重启。
#
# 和 Uranus 同机的话**直接跑这一个就完了**，不用配对。节点在别的机器上才要先
# 跑 pair.sh。
#
# 装完之后**再也不用碰命令行** —— 在 Uranus 控制台里点开关就行。
#
# 用法：
#   sudo bash install-service.sh
#
# 卸载：
#   sudo systemctl disable --now uranus-facetime && sudo rm /etc/systemd/system/uranus-facetime.service
set -euo pipefail

cd "$(dirname "$0")"
NODE_DIR="$(pwd)"
UNIT=/etc/systemd/system/uranus-facetime.service

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "要用 root：sudo bash install-service.sh"

# ── 先把该有的都检查一遍，别装完才发现跑不起来 ──────────────

# 1. 配对了没
#
# 和 Uranus 同机的话**不用配对**：节点默认连 http://127.0.0.1:8787，Uranus 那边
# 默认开着「本机的节点不用配对码」。所以没有 config.json 不是错，是同机的正常状态。
# 只在配置里写了别的机器、又没有密钥时才拦 —— 那种节点起来也连不上。
if [ -f "$NODE_DIR/config.json" ]; then
  URANUS_URL="$(grep -oE '"uranus"[[:space:]]*:[[:space:]]*"[^"]*"' "$NODE_DIR/config.json" | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  HAS_SECRET="$(grep -oE '"secret"[[:space:]]*:[[:space:]]*"[^"]+"' "$NODE_DIR/config.json" || true)"
  case "$URANUS_URL" in
    ""|http://127.*|https://127.*|http://localhost*|https://localhost*|http://\[::1\]*|https://\[::1\]*) ;;
    *)
      [ -n "$HAS_SECRET" ] || die "config.json 里 Uranus 在别的机器上（$URANUS_URL），但还没配对。
在 Uranus 控制台「角色 → 接 FaceTime 通话 → 通话节点」里，「节点在哪」选「节点不在本机」、「谁连谁」选「节点来连 Uranus」，复制配对码，然后：
  sudo bash pair.sh"
      ;;
  esac
  say "用的是已有的 config.json（Uranus：${URANUS_URL:-http://127.0.0.1:8787}）"
else
  say "没有 config.json —— 按同机部署来，连 http://127.0.0.1:8787，不用配对"
fi

# 2. Node 在哪。和 update-vps.sh 一个思路：先问正在跑的 uranus 服务
NODE_BIN=""
EXEC="$(systemctl show uranus -p ExecStart --value 2>/dev/null || true)"
CAND="$(printf '%s' "$EXEC" | grep -oE '/[^ ;]*/bin/node' | head -1 || true)"
[ -x "$CAND" ] && NODE_BIN="$CAND"
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || die "找不到 node"

VER="$("$NODE_BIN" -v)"
case "$VER" in
  v2[2-9].*|v[3-9][0-9].*) ;;
  *) die "Node 版本太低（$VER），要 22 以上 —— 节点用的是内置的 WebSocket" ;;
esac

# 3. 浏览器
BROWSER=""
for p in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/chrome \
         /usr/bin/microsoft-edge /usr/bin/microsoft-edge-stable; do
  [ -x "$p" ] && BROWSER="$p" && break
done
[ -n "$BROWSER" ] || die "没装 Chrome。FaceTime 的视频要 H.264，开源 Chromium 没有这个编解码器，必须用官方版：
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt install -y /tmp/chrome.deb"

# 4. Xvfb。无头模式下 WebRTC 容易出怪问题，所以跑的是「有头浏览器 + 虚拟显示器」
command -v Xvfb >/dev/null || die "没装 Xvfb（Linux 上要它给浏览器一块看不见的屏幕）：
  sudo apt install -y xvfb"

# 5. 用谁的身份跑 —— 跟着这个目录的属主走，和 Uranus 本体一致
OWNER="$(stat -c '%U' "$NODE_DIR")"

say "Node：$VER"
say "浏览器：$BROWSER"
say "跑的身份：$OWNER"

# ── 写服务文件 ───────────────────────────────────────────────

cat >"$UNIT" <<EOF
[Unit]
Description=Uranus FaceTime 通话节点
# 要等 Uranus 起来才连得上。它没起也不要紧 —— 节点会自己重试
After=network-online.target uranus.service
Wants=network-online.target

[Service]
Type=simple
User=$OWNER
WorkingDirectory=$NODE_DIR
ExecStart=$NODE_BIN $NODE_DIR/src/index.mjs

# 崩了就重启。通话节点长期挂着，偶尔被 OOM 杀掉是正常的
Restart=always
RestartSec=5

# 日志进 journal，和 Uranus 一样：journalctl -u uranus-facetime -f
StandardOutput=journal
StandardError=journal

# 2G 内存的小机器上，Chrome 是大头。超了先杀节点，别让系统去杀 Uranus
MemoryMax=1400M

Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now uranus-facetime

sleep 2
if systemctl is-active --quiet uranus-facetime; then
  say "装好了，节点已经挂上"
  printf '\n看日志：  journalctl -u uranus-facetime -f\n'
  printf '重启：    sudo systemctl restart uranus-facetime\n'
  printf '停掉：    sudo systemctl stop uranus-facetime\n\n'
  printf '现在在 iPhone 的 FaceTime 里创建一条链接，用 iMessage 发给角色试试。\n\n'
else
  die "没起来，看日志：journalctl -u uranus-facetime -n 50 --no-pager"
fi
