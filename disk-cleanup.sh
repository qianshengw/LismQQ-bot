#!/usr/bin/env bash
# LismQQ-bot 存储回收脚本（3.3G 小盘设备专用，openstick / WiFi 棒）
#
# 用法：
#   ./disk-cleanup.sh                 # 交互模式：先预览，逐项确认
#   ./disk-cleanup.sh --auto          # 自动模式：只做零风险项（apt/journal/QQ日志）
#   ./disk-cleanup.sh --full          # 全量交互：含 QQ 缓存（QQ 运行中会询问是否停止）
#   ./disk-cleanup.sh --full --auto   # 全量自动：含 QQ 缓存（QQ 运行中自动停止并重启）
#   ./disk-cleanup.sh --status        # 只看占用报告，不删任何东西
#
# 安全设计：
#   - 永不触碰：nt_db（聊天记录）、/opt/QQ、estrella-napcat 运行时、qq-pi、/usr
#   - QQ 缓存清理前自动管理 QQ 生命周期：询问停止 → 验证真停 → 清理 → 重启 → 验证复活
#   - 脚本中途被打断（Ctrl+C/断线）时，若已停 QQ 会尝试自动重启（trap 守护）
#   - 每次清理写入 state/disk-cleanup.log，可追溯

set -u

MODE="interactive"
FULL=0
for arg in "$@"; do
  case "$arg" in
    --status) MODE="status" ;;
    --auto)   MODE="auto" ;;
    --full)   FULL=1 ;;
    *) echo "未知参数: $arg（支持 --status / --auto / --full）"; exit 1 ;;
  esac
done

# 项目根目录（脚本在 qq-pi 内）；state 日志目录可能不存在则退回 /tmp
if [ -d ./state ]; then LOGDIR=./state; else LOGDIR=/tmp; fi
LOGFILE="$LOGDIR/disk-cleanup.log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOGFILE"; }
HR() { echo "────────────────────────────────────────────"; }

FREED_START=$(df / --output=used -B1 2>/dev/null | tail -1)

# ── QQ 生命周期管理 ──────────────────────────────────────────────────────────
QQ_SERVICE=""          # 探测到的 systemd 服务名（可能为空 = 无 systemd 或未找到）
WAS_RUNNING=0          # 清理前 QQ 是否在跑（原状恢复用）
QQ_STOPPED_BY_US=0     # 是否由本脚本执行了停止（trap 恢复判断用）

qq_running() {
  pgrep -f 'opt/QQ/qq' >/dev/null 2>&1 && return 0
  pgrep -f estrella-napcat >/dev/null 2>&1 && return 0
  return 1
}

qq_detect_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    QQ_SERVICE=""
    return
  fi
  # 动态探测：优先 estrella-napcat，兜底任意 napcat/qq 相关的 running 服务
  QQ_SERVICE=$(systemctl list-units --type=service --no-legend 2>/dev/null \
    | awk '{print $1}' | grep -iE 'napcat' | head -1)
  [ -z "$QQ_SERVICE" ] && QQ_SERVICE=$(systemctl list-units --type=service --no-legend 2>/dev/null \
    | awk '{print $1}' | grep -iE '^qq|qq\.service' | head -1)
  [ -z "$QQ_SERVICE" ] && QQ_SERVICE=""
}

qq_stop() {
  qq_detect_service
  if [ -n "$QQ_SERVICE" ]; then
    log "停止 QQ：systemctl stop $QQ_SERVICE"
    systemctl stop "$QQ_SERVICE" 2>/dev/null
  else
    log "未找到 QQ systemd 服务，走 pkill 停止"
  fi
  pkill -f 'opt/QQ/qq' 2>/dev/null
  pkill -f estrella-napcat 2>/dev/null
  return 0
}

# 轮询验证真停；10s 宽限后 -9 强杀再验 5s；返回 0=已停 1=停不掉
qq_wait_stopped() {
  local i
  for i in $(seq 1 10); do
    qq_running || return 0
    sleep 1
  done
  echo "  宽限期未退出，强制杀（-9）…"
  log "QQ 宽限 10s 未退出，pkill -9 强杀"
  pkill -9 -f 'opt/QQ/qq' 2>/dev/null
  pkill -9 -f estrella-napcat 2>/dev/null
  for i in $(seq 1 5); do
    qq_running || return 0
    sleep 1
  done
  return 1
}

qq_start() {
  if [ -n "$QQ_SERVICE" ]; then
    log "重启 QQ：systemctl start $QQ_SERVICE"
    systemctl start "$QQ_SERVICE" 2>/dev/null
    sleep 3
    if systemctl is-active --quiet "$QQ_SERVICE" 2>/dev/null && qq_running; then
      log "QQ 已重启（$QQ_SERVICE active）"
      echo "✅ QQ 已重启"
      return 0
    fi
    # is-active 通过但进程还没起来：再等等
    sleep 5
    if qq_running; then
      log "QQ 已重启（进程已出现）"
      echo "✅ QQ 已重启"
      return 0
    fi
    echo "⚠️  systemctl start 已执行但进程未检出——请手动确认：systemctl status $QQ_SERVICE"
    log "QQ 重启验证失败（service=$QQ_SERVICE）"
    return 1
  fi
  echo "⚠️  无 systemd 服务名，请手动启动 QQ/NapCat（原启动命令）"
  log "QQ 需手动启动（未找到服务名）"
  return 1
}

# trap 守护：脚本在「已停 QQ、未重启」区间被打断时，退出前尝试拉起
qq_restore_on_exit() {
  if [ "$QQ_STOPPED_BY_US" -eq 1 ]; then
    QQ_STOPPED_BY_US=0
    echo ""
    echo "脚本中断——恢复 QQ…"
    qq_start
  fi
}
trap qq_restore_on_exit EXIT INT TERM

report() {
  HR
  echo "当前磁盘占用："
  df -h / | tail -1
  echo ""
  echo "可回收目标（估算）："
  APT_CACHE=$(du -sh /var/cache/apt 2>/dev/null | cut -f1); echo "  /var/cache/apt          ${APT_CACHE:-0}  （apt 下载缓存+索引）"
  JOURNAL=$(du -sh /var/log/journal 2>/dev/null | cut -f1); echo "  /var/log/journal        ${JOURNAL:-0}  （systemd 日志）"
  QQ_EMOJI=$(du -sh /root/.config/QQ/nt_qq/global/nt_data/Emoji 2>/dev/null | cut -f1); echo "  QQ global Emoji         ${QQ_EMOJI:-0}  （表情缓存）"
  QQ_LOG=$(du -sh /root/.config/QQ/nt_qq/global/nt_data/Log 2>/dev/null | cut -f1); echo "  QQ global Log           ${QQ_LOG:-0}  （QQ 内部日志）"
  QQ_PIC=$(du -sch /root/.config/QQ/nt_qq_*/nt_data/Pic 2>/dev/null | tail -1 | cut -f1); echo "  QQ 账号 Pic/Video/File  ${QQ_PIC:-0}  （聊天媒体缓存）"
  BOT_IMG=$(du -sh ./state/images 2>/dev/null | cut -f1); echo "  qq-pi state/images      ${BOT_IMG:-0}  （bot 图片落盘）"
  HR
}

# ── 确认工具 ─────────────────────────────────────────────────────────────────
ask() {
  [ "$MODE" = "auto" ] && return 0
  read -r -p "$1 [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

report
[ "$MODE" = "status" ] && exit 0

# ── 第 1 类：apt（零风险）───────────────────────────────────────────────────
if ask "清理 apt 缓存与索引（约 190M，零风险）？"; then
  apt clean 2>/dev/null && log "apt clean 完成"
  rm -rf /var/lib/apt/lists/*
  log "apt lists 已清"
fi

# ── 第 2 类：journald（零风险）──────────────────────────────────────────────
if ask "journald 收口到 50M（约回收 100M+，零风险）？"; then
  journalctl --vacuum-size=50M >/dev/null 2>&1 && log "journal vacuum 完成"
  # 永久限额防复发
  if ! grep -q '^SystemMaxUse=' /etc/systemd/journald.conf 2>/dev/null; then
    sed -i '/^\[Journal\]/a SystemMaxUse=100M' /etc/systemd/journald.conf 2>/dev/null
    systemctl restart systemd-journald 2>/dev/null
    log "journald 永久限额 SystemMaxUse=100M 已配置"
  fi
fi

# ── 第 3 类：QQ 缓存（自动管理 QQ 生命周期：停→清→启）───────────────────────
if [ "$FULL" -eq 1 ] || ask "清理 QQ 缓存（表情/日志/媒体，约 490M）？"; then
  if qq_running; then
    WAS_RUNNING=1
    # 询问是否停止（auto 模式下 ask 恒真 = 自动停止；交互模式由用户决定）
    if ask "QQ/NapCat 正在运行——停止它以清理缓存（结束后自动重启）？"; then
      QQ_STOPPED_BY_US=1
      qq_stop
      if qq_wait_stopped; then
        log "QQ 已确认停止，开始清理缓存"
        # global 层：表情缓存 + QQ 内部日志
        rm -rf /root/.config/QQ/nt_qq/global/nt_data/Emoji
        rm -rf /root/.config/QQ/nt_qq/global/nt_data/Log
        # 账号层：聊天媒体缓存（nt_db 数据库绝不触碰）
        rm -rf /root/.config/QQ/nt_qq_*/nt_data/Pic
        rm -rf /root/.config/QQ/nt_qq_*/nt_data/Video
        rm -rf /root/.config/QQ/nt_qq_*/nt_data/File
        rm -rf /root/.config/QQ/nt_qq_*/nt_data/Emoji
        rm -rf /root/.config/QQ/nt_qq_*/nt_temp
        rm -rf /root/.config/QQ/nt_qq/global/nt_temp
        log "QQ 缓存清理完成（Emoji/Log/Pic/Video/File/temp）"
        QQ_STOPPED_BY_US=0   # 清理完成，trap 不再重复拉起
        qq_start             # 恢复 QQ（清理前它在跑）
      else
        echo "⚠️  QQ 停不掉（-9 强杀后仍存活）——跳过 QQ 缓存清理，继续其他项。"
        log "QQ 停止失败，缓存清理跳过"
        QQ_STOPPED_BY_US=0   # 没停成功，无需恢复
      fi
    else
      echo "  已跳过 QQ 缓存清理（QQ 保持运行）。"
      log "QQ 缓存清理跳过（用户选择不停 QQ）"
    fi
  else
    log "QQ 未运行，直接清理缓存"
    # global 层：表情缓存 + QQ 内部日志
    rm -rf /root/.config/QQ/nt_qq/global/nt_data/Emoji
    rm -rf /root/.config/QQ/nt_qq/global/nt_data/Log
    # 账号层：聊天媒体缓存（nt_db 数据库绝不触碰）
    rm -rf /root/.config/QQ/nt_qq_*/nt_data/Pic
    rm -rf /root/.config/QQ/nt_qq_*/nt_data/Video
    rm -rf /root/.config/QQ/nt_qq_*/nt_data/File
    rm -rf /root/.config/QQ/nt_qq_*/nt_data/Emoji
    rm -rf /root/.config/QQ/nt_qq_*/nt_temp
    rm -rf /root/.config/QQ/nt_qq/global/nt_temp
    log "QQ 缓存清理完成（Emoji/Log/Pic/Video/File/temp）"
    # WAS_RUNNING=0：清理前就没跑，结束后不主动拉起（原状恢复原则）
  fi
fi

# ── 第 4 类：bot 图片落盘（30 天前）─────────────────────────────────────────
if [ -d ./state/images ]; then
  BOT_IMG_SIZE=$(du -sh ./state/images 2>/dev/null | cut -f1)
  if ask "清理 bot 30 天前的落盘图片（当前 ${BOT_IMG_SIZE:-0}）？"; then
    find ./state/images -type f -mtime +30 -delete 2>/dev/null
    log "bot 旧图片清理完成（保留 30 天内）"
  fi
fi

# ── 结果 ─────────────────────────────────────────────────────────────────────
FREED_END=$(df / --output=used -B1 2>/dev/null | tail -1)
if [ -n "$FREED_START" ] && [ -n "$FREED_END" ]; then
  FREED_MB=$(( (FREED_START - FREED_END) / 1024 / 1024 ))
  echo ""
  log "本次回收约 ${FREED_MB}MB"
  echo "本次回收约 ${FREED_MB}MB"
fi
df -h / | tail -1
