#!/usr/bin/env bash
# stop.sh 自测：在不碰真实桥接的前提下，验证「监督循环 + 桥接进程」能被 stop.sh 干净停掉。
#
# 用法：
#   bash test/stop-selftest.sh
#
# 原理：拉起一个假的 start.sh 监督循环（.stop-selftest/start.sh），它会不断拉起
# 一个命令行形如 "node src/bridge.js" 的假进程；然后执行 ../stop.sh，
# 最后断言这些假进程全部消失。
#
# 注意：stop.sh 按 cwd 校验进程归属，因此必须在项目根目录执行本脚本。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
FIXTURE="$ROOT/.stop-selftest"
STOP_SH="$ROOT/stop.sh"

if [ ! -f "$FIXTURE/start.sh" ]; then
  echo "缺少夹具 $FIXTURE/start.sh"
  exit 1
fi

count_fixture_procs() {
  local n=0 d c
  for d in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$c" in
      *start.sh*|*src/bridge.js*) n=$((n + 1)) ;;
    esac
  done
  echo "$n"
}

echo "=== stop.sh 自测 ==="

# 1) 拉起假监督循环
nohup bash "$FIXTURE/start.sh" > "$FIXTURE/sup.log" 2>&1 &
SUP_PID=$!
sleep 2

before=$(count_fixture_procs)
echo "拉起后可见的夹具进程数：$before"
if [ "$before" -lt 2 ]; then
  echo "✗ 夹具没起来（无法在 /proc 里看到），自测结论不可信——请确认 /proc 可读"
  kill -KILL "$SUP_PID" 2>/dev/null
  exit 2
fi

# 2) 执行 stop.sh
STOP_WAIT_SECONDS=6 bash "$STOP_SH" > "$FIXTURE/stop.out" 2>&1
echo "--- stop.sh 输出 ---"
cat "$FIXTURE/stop.out"

# 3) 断言
sleep 2
after=$(count_fixture_procs)
echo
if [ "$after" -eq 0 ]; then
  echo "✓ 自测通过：夹具进程已全部清除（$before → $after）"
  exit 0
fi
echo "✗ 自测失败：仍有 $after 个夹具进程残留"
for d in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$c" in
    *start.sh*|*src/bridge.js*) echo "  残留 ${d#/proc/} :: $c" ;;
  esac
done
kill -KILL "$SUP_PID" 2>/dev/null
exit 1
