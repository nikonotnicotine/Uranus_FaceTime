#!/usr/bin/env bash
#
# 配对：把 Uranus 的地址和密钥存进 config.json。
#
# 用法（在 facetime-node 目录下）：
#   sudo bash pair.sh
#
# ── 为什么要这个壳，不直接 node src/index.mjs --pair ──
#
# 两个坑，实测都踩过：
#
#  1. **node 不在 root 的 PATH 里**。Uranus 的 Node 常常是 nvm 装在某个普通
#     用户家目录下的，root 跑 `node` 直接「command not found」，而那条提示
#     （「apt install nodejs」）会把人带到装第二个 Node 的歪路上去。
#  2. **用 root 配对会把 config.json 变成 root 的**，而服务是用仓库属主那个
#     身份跑的 —— 之后节点读不了自己的配置，报的错还和配对这件事离得很远。
#
# 这个脚本自己把 node 找出来、自己切到对的身份。
set -euo pipefail

cd "$(dirname "$0")"
NODE_DIR="$(pwd)"

die() { printf '\n\033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

# ── 找 node：先问正在跑的 uranus 服务，它写的那个路径一定是对的 ──
NODE_BIN=""
EXEC="$(systemctl show uranus -p ExecStart --value 2>/dev/null || true)"
CAND="$(printf '%s' "$EXEC" | grep -oE '/[^ ;]*/bin/node' | head -1 || true)"
[ -x "$CAND" ] && NODE_BIN="$CAND"
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || die "找不到 node。Uranus 跑着的话这里本该能问出来 —— 先确认服务是不是开着：
  systemctl status uranus"

VER="$("$NODE_BIN" -v)"
case "$VER" in
  v2[2-9].*|v[3-9][0-9].*) ;;
  *) die "Node 版本太低（$VER），要 22 以上 —— 节点用的是内置的 WebSocket" ;;
esac

# ── 用谁的身份跑：跟着目录属主走，和 Uranus 本体一致 ──
OWNER="$(stat -c '%U' "$NODE_DIR")"

printf '\nNode：%s（%s）\n身份：%s\n' "$VER" "$NODE_BIN" "$OWNER"

if [ "$(id -un)" = "$OWNER" ]; then
  "$NODE_BIN" "$NODE_DIR/src/index.mjs" --pair
elif [ "$(id -u)" -eq 0 ]; then
  sudo -u "$OWNER" "$NODE_BIN" "$NODE_DIR/src/index.mjs" --pair
else
  die "这个目录是 $OWNER 的，用 sudo 跑：sudo bash pair.sh"
fi

printf '\n接下来装成后台服务（开机自启、崩了自己重启）：\n  sudo bash install-service.sh\n\n'
