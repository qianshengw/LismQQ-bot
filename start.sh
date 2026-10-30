#!/usr/bin/env bash
# LismQQ-bot 启动守护（无 systemd 环境用）：进程退出后 5 秒重启。
#
# 用法：
#   ./start.sh              # 后台脱离运行（默认）：关闭 SSH / 断开终端都继续跑
#   ./start.sh --foreground # 前台运行（调试用，日志直接打在终端）
#   ./start.sh --help       # 本说明
#
# 后台模式做了什么：
#   1) setsid —— 新建会话，脱离控制终端，SSH 断开时不会收到 SIGHUP
#   2) stdio 重定向到 state/bridge.log
#   3) 信号处理：收到 TERM/INT/HUP 立刻把子进程（node bridge.js）一起停掉
#
# 配套：./stop.sh 停止（会先杀本脚本的监督循环，再杀桥接进程）
#
# systemd 用户请用 lismqq-bot.service（开机自启更稳）。

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd -P)"
STATE_DIR="$ROOT/state"
LOG_FILE="$STATE_DIR/bridge.log"
PID_FILE="$STATE_DIR/start.pid"

FOREGROUND=0
case "${1:-}" in
  --foreground|-f) FOREGROUND=1 ;;
  --help|-h)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

# ── 前置检查（只警告不阻塞，除非致命）────────────────────────────────────────
# Node 版本 ≥ 22.19（pi 与全局 WebSocket 需要）
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null)
if [ -z "$NODE_MAJOR" ]; then
  echo "[start.sh] 未找到 node，请安装 Node.js >= 22.19"
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" = "22" ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  echo "[start.sh] Node 版本过低（$(node -v)），需要 >= 22.19"
  exit 1
fi

# config.json 存在性
if [ ! -f config.json ]; then
  echo "[start.sh] 缺少 config.json——复制 config.example.jsonc 为 config.json 后编辑"
  exit 1
fi

# state/ 可写（单实例锁/账本/记忆落盘都在这里）
if ! mkdir -p state 2>/dev/null || [ ! -w state ]; then
  echo "[start.sh] state/ 目录不可写——检查权限"
  exit 1
fi

# node_modules 存在性（提示但不阻塞——代码里缺依赖会自己报）
if [ ! -d node_modules ]; then
  echo "[start.sh] 提示：node_modules 不存在，先运行 npm install"
fi

# natcat/NapCat 预检（从 config.json 抽 wsUrl 的 host:port，TCP 探活）
# 失败只警告：桥接自身会持续重连，协议端起来后自动接上。
# 注意：config.json 可能是带注释的 JSONC，require() 不认注释，故这里自己剥注释。
NAPCAT_HOST=$(node -e '
const fs = require("fs");
try {
  const raw = fs.readFileSync("config.json", "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  const c = JSON.parse(raw);
  process.stdout.write(new URL(c.qq.wsUrl).host);
} catch { }
' 2>/dev/null)
if [ -n "$NAPCAT_HOST" ]; then
  NAPCAT_ADDR="${NAPCAT_HOST%%:*}"
  NAPCAT_PORT="${NAPCAT_HOST##*:}"
  if command -v timeout >/dev/null 2>&1; then
    if ! timeout 3 bash -c "echo > /dev/tcp/$NAPCAT_ADDR/$NAPCAT_PORT" 2>/dev/null; then
      echo "[start.sh] 提示：协议端 $NAPCAT_HOST 暂不可达（natcat/NapCat 可能未启动）——桥接将等待其上线"
    fi
  fi
fi

# ── 后台脱离 ─────────────────────────────────────────────────────────────────
# setsid 新建会话：进程不再有控制终端，SSH 断开不会触发 SIGHUP，桥接继续跑。
# 无 setsid 的环境退化为 nohup（仍能扛住大部分断连场景）。
if [ "$FOREGROUND" -eq 0 ] && [ -z "${QQB_DETACHED:-}" ]; then
  export QQB_DETACHED=1
  mkdir -p "$STATE_DIR"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$SCRIPT_PATH" "$@" < /dev/null >> "$LOG_FILE" 2>&1 &
  else
    nohup "$SCRIPT_PATH" "$@" < /dev/null >> "$LOG_FILE" 2>&1 &
  fi
  echo "[start.sh] 已后台启动（已脱离控制终端，关闭 SSH 不受影响）"
  echo "[start.sh] 日志：$LOG_FILE"
  echo "[start.sh] 停止：./stop.sh"
  exit 0
fi

# ── 信号处理 ─────────────────────────────────────────────────────────────────
# 用 `node &` + `wait` 而不是前台直接跑：这样 trap 能在 wait 期间立刻触发，
# 收到 TERM 时马上把子进程一并停掉（前台跑时 bash 会把信号推迟到子进程结束，
# 表现为「kill 不掉监督循环」）。
CHILD_PID=""
shutdown() {
  echo "[start.sh] 收到退出信号，正在停止桥接…"
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null
    for _ in $(seq 1 10); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$CHILD_PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  echo "[start.sh] 已退出"
  exit 0
}
trap shutdown TERM INT HUP

# ── 主循环 ───────────────────────────────────────────────────────────────────
echo $$ > "$PID_FILE"
echo "[start.sh] 监督进程 PID=$$ （$(date '+%F %T')）"

while true; do
  node src/bridge.js &
  CHILD_PID=$!
  wait "$CHILD_PID"
  code=$?
  CHILD_PID=""
  if [ "$code" = "2" ]; then
    echo "[start.sh] 已有实例在运行（单实例锁）。退出。"
    rm -f "$PID_FILE"
    exit 2
  fi
  # 日志轮转：超过 5MB 就清空重来（单文件，简单粗暴但够用）
  if [ -f "$LOG_FILE" ]; then
    log_size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$log_size" -gt 5242880 ] 2>/dev/null; then
      echo "[start.sh] 日志超过 5MB，已清空"
      : > "$LOG_FILE"
    fi
  fi
  echo "[start.sh] bridge 退出（code=$code），5 秒后重启…"
  sleep 5 &
  wait $!
done
