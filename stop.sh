#!/usr/bin/env bash
# LismQQ-bot 一键停止脚本
#
# 用法：
#   ./stop.sh            # 优雅停止：SIGTERM → 等待 → 必要时 SIGKILL
#   ./stop.sh --status   # 只看状态，不停
#   ./stop.sh --force    # 立刻 SIGKILL（不等优雅退出）
#
# 覆盖三种运行方式：
#   1) systemd             → systemctl stop lismqq-bot
#   2) nohup ./start.sh &  ← 重点：start.sh 是 while true 监督循环，
#                            不先干掉它，node 退出后会被它 5 秒后重新拉起
#   3) 直接 node src/bridge.js
#
# 顺带清理：
#   - 孤儿 MCP 子进程（qq-tools-server.mjs / web-search-server.mjs）
#   - 残留的 state/bridge.lock（桥接的 releaseInstanceLock 未被调用，
#     优雅退出后锁文件会留下；PID 被系统回收后可能导致下次启动误判「已有实例」）
#
# 安全约束：
#   - 命中进程后会用 /proc/<pid>/cwd 校验归属，只杀本目录下的实例，
#     避免误杀机器上别的同名程序；读不到 cwd 时按命令行模式放行。
#   - 要用与启动时相同的用户执行（无法 kill 别人的 root 进程）。
#   - 不会使用进程组 kill（setsid 的 PGID 可能是 SSH 会话组，会误杀自己的终端）。

cd "$(dirname "$0")" || exit 1
ROOT_ABS="$(pwd -P)"

STATE_DIR="$ROOT_ABS/state"
LOCK_FILE="$STATE_DIR/bridge.lock"
WAIT_SECONDS="${STOP_WAIT_SECONDS:-10}"

MODE="stop"
case "$1" in
  --status) MODE="status" ;;
  --force)  MODE="force" ;;
esac

# ── 进程发现 ────────────────────────────────────────────────────────────────
# start.sh 的命令行可能是 "./start.sh" / "bash start.sh" / "/opt/.../start.sh"，
# 三种都要覆盖：start.sh 前可能是行首、空格或斜杠。stop.sh 自身不受影响
# （其命令行含 "stop.sh" 不含 "start.sh"）。
#
# pgrep 来自 procps，精简容器（Alpine 等）可能没有；没有时回退读 /proc/*/cmdline。
find_by_proc() {
  local pattern="$1"
  local d pid cmd
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ "$pid" = "$$" ] && continue
    # 用 cat 而不是重定向读 cmdline：进程恰好退出时重定向会在 bash 层报错刷屏
    cmd=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ' 2>/dev/null)
    [ -n "$cmd" ] || continue
    printf '%s' "$cmd" | grep -Eq "$pattern" || continue
    echo "$pid"
  done
}

_find() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$1" 2>/dev/null
  else
    find_by_proc "$1"
  fi
}

# 归属校验：进程的 cwd 是否在本目录下（读不到 cwd 时放行）
_own() {
  local pid="$1" cwd
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || cwd=""
  [ -z "$cwd" ] && return 0
  case "$cwd" in
    "$ROOT_ABS"|"$ROOT_ABS"/*) return 0 ;;
    *) return 1 ;;
  esac
}

_filter_own() {
  local pid out=""
  for pid in $(_find "$1"); do
    if _own "$pid"; then out="$out $pid"; fi
  done
  echo $out
}

find_supervisors() { _filter_own '(^|[ /])start\.sh'; }
# node / node.exe / /usr/local/bin/node 都要匹配上，
# 所以用 node[^ ]* 而不是字面量 "node "（后者在 node.exe 下匹配不到）。
find_bridges()     { _filter_own 'node[^ ]*.*src/bridge\.js'; }
find_mcps() {
  { _find 'qq-tools-server\.mjs'; _find 'web-search-server\.mjs'; } | sort -u
}

# ── 状态展示 ────────────────────────────────────────────────────────────────
show_status() {
  local sup br mc
  sup=$(find_supervisors | tr '\n' ' ')
  br=$(find_bridges | tr '\n' ' ')
  mc=$(find_mcps | tr '\n' ' ')
  echo "监督进程 start.sh : ${sup:-无}"
  echo "桥接进程 bridge.js: ${br:-无}"
  echo "MCP 子进程        : ${mc:-无}"
  if [ -f "$LOCK_FILE" ]; then
    echo "实例锁            : 存在（$(tr -d '\n' < "$LOCK_FILE")）"
  else
    echo "实例锁            : 无"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    local act
    act=$(systemctl is-active lismqq-bot 2>/dev/null)
    echo "systemd 单元      : ${act:-unknown}"
  fi
}

if [ "$MODE" = "status" ]; then
  show_status
  exit 0
fi

echo "=== 停止 LismQQ-bot ==="
show_status
echo

# ── 第 1 步：systemd ────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 \
   && systemctl list-unit-files 2>/dev/null | grep -q '^lismqq-bot\.service'; then
  act=$(systemctl is-active lismqq-bot 2>/dev/null)
  if [ "$act" = "active" ] || [ "$act" = "activating" ]; then
    echo "[1/4] systemctl stop lismqq-bot …"
    systemctl stop lismqq-bot 2>&1 | sed 's/^/      /'
  else
    echo "[1/4] systemd 单元未运行（$act），跳过"
  fi
else
  echo "[1/4] 未检测到 systemd 单元，跳过"
fi

# ── 第 2 步：SIGTERM 监督循环 + 桥接进程 ───────────────────────────────────
# 顺序说明：bash 在等待前台子进程时不会立即处理 SIGTERM，所以先给监督循环发
# TERM（让它挂起待处理），再给 node 发 TERM（触发桥接的优雅退出：保存会话 /
# 记忆 / 账本、关闭 MCP、退出）。node 一退出，bash 就会处理挂起的 TERM 退出。
# 第 4 步会再扫一遍监督循环，兜住「bash 又续了一轮循环」的竞态。
echo "[2/4] 发送 SIGTERM …"
for p in $(find_supervisors); do kill -TERM "$p" 2>/dev/null && echo "      TERM → start.sh PID $p"; done
for p in $(find_bridges);     do kill -TERM "$p" 2>/dev/null && echo "      TERM → bridge.js PID $p"; done

# ── 第 3 步：等待优雅退出 ──────────────────────────────────────────────────
if [ "$MODE" = "force" ]; then
  echo "[3/4] --force：跳过等待"
else
  echo "[3/4] 等待优雅退出（最多 ${WAIT_SECONDS}s）…"
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    left=$(find_bridges | tr '\n' ' ')
    if [ -z "$left" ]; then
      echo "      桥接进程已退出"
      break
    fi
    sleep 1
    waited=$((waited + 1))
    printf '\r      %ss ' "$waited"
  done
  printf '\r'
fi

# ── 第 4 步：清理残留 ──────────────────────────────────────────────────────
echo "[4/4] 清理残留 …"

# 4a. 监督循环兜底：node 已退出但 bash 又续了一轮
for p in $(find_supervisors); do
  kill -TERM "$p" 2>/dev/null
done
sleep 1

# 4b. 仍存活的桥接进程 → SIGKILL
leftover=$(find_bridges | tr '\n' ' ')
if [ -n "$leftover" ]; then
  for p in $leftover; do
    kill -KILL "$p" 2>/dev/null && echo "      KILL → bridge.js PID $p"
  done
  sleep 1
fi

# 4c. 仍存活的监督循环 → SIGKILL
leftover=$(find_supervisors | tr '\n' ' ')
if [ -n "$leftover" ]; then
  for p in $leftover; do
    kill -KILL "$p" 2>/dev/null && echo "      KILL → start.sh PID $p"
  done
fi

# 4d. 孤儿 MCP 子进程（父进程被 SIGKILL 时不会自动收尸）
for p in $(find_mcps); do
  kill -TERM "$p" 2>/dev/null && echo "      TERM → MCP PID $p"
done
sleep 1
for p in $(find_mcps); do
  kill -KILL "$p" 2>/dev/null && echo "      KILL → MCP PID $p"
done

# 4e. 残留实例锁：看锁里记的 PID 还活着没有——活着就保留，死了就清掉。
#     （桥接的 releaseInstanceLock 未被调用，优雅退出后锁文件会留下；
#       而 PID 被系统回收后会导致下次启动误判「已有实例在运行」而 exit 2）
if [ -f "$LOCK_FILE" ]; then
  lock_pid=$(cut -d'|' -f1 < "$LOCK_FILE" 2>/dev/null | tr -dc '0-9')
  if [ -n "$lock_pid" ] && [ -d "/proc/$lock_pid" ]; then
    echo "      桥接进程仍在跑（PID $lock_pid），保留实例锁"
  else
    rm -f "$LOCK_FILE" && echo "      已清理 $LOCK_FILE（持有进程已不存在）"
  fi
fi

# 4f. 给 /proc 一点收尾时间，避免状态展示里出现刚死进程的残留条目
sleep 1

echo
echo "=== 已停止 ==="
show_status

# 端口占用检查（可选工具，缺了就跳过）
if command -v ss >/dev/null 2>&1; then
  port=$(grep -o '"internalPort"[[:space:]]*:[[:space:]]*[0-9]*' config.json 2>/dev/null | grep -o '[0-9]*$' | head -1)
  if [ -n "$port" ] && [ "$port" != "0" ]; then
    if ss -ltn 2>/dev/null | grep -q ":${port} "; then
      echo "⚠ 端口 ${port} 仍被占用——可能有别的进程或残留实例"
    else
      echo "✓ 端口 ${port} 已释放"
    fi
  fi
fi

exit 0
