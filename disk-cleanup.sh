#!/usr/bin/env bash
# LismQQ-bot 存储回收脚本（3.3G 小盘设备专用，openstick / WiFi 棒）
#
# 用法：
#   ./disk-cleanup.sh            # 交互模式：先预览，逐项确认
#   ./disk-cleanup.sh --auto     # 自动模式：只做零风险项（apt/journal/QQ日志）
#   ./disk-cleanup.sh --full --auto   # 全量自动：含媒体缓存（需先停 QQ/NapCat）
#   ./disk-cleanup.sh --status   # 只看占用报告，不删任何东西
#
# 安全设计：
#   - 永不触碰：nt_db（聊天记录）、/opt/QQ、estrella-napcat、qq-pi、/usr
#   - QQ 缓存清理要求 QQ 已停止（检测到 QQ 进程时拒绝执行第 3 类）
#   - 每次清理写入 state/disk-cleanup.log，可追溯

set -u

MODE="interactive"
FULL=0
[ "${1:-}" = "--status" ] && MODE="status"
[ "${1:-}" = "--auto" ] && MODE="auto"
[ "${1:-}" = "--full" ] && { FULL=1; shift 2>/dev/null || true; }
[ "${1:-}" = "--full" ] && FULL=1
[ "${2:-}" = "--auto" ] && MODE="auto"

# 项目根目录（脚本在 qq-pi 内）；state 日志目录可能不存在则退回 /tmp
if [ -d ./state ]; then LOGDIR=./state; else LOGDIR=/tmp; fi
LOGFILE="$LOGDIR/disk-cleanup.log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOGFILE"; }
HR() { echo "────────────────────────────────────────────"; }

FREED_START=$(df / --output=used -B1 2>/dev/null | tail -1)

# ── 状态报告 ─────────────────────────────────────────────────────────────────
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

report
[ "$MODE" = "status" ] && exit 0

# ── 确认工具 ─────────────────────────────────────────────────────────────────
ask() {
  [ "$MODE" = "auto" ] && return 0
  read -r -p "$1 [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

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

# ── 第 3 类：QQ 缓存（需 QQ 已停止；--full 或确认）──────────────────────────
qq_running() {
  pgrep -f 'opt/QQ/qq' >/dev/null 2>&1 && return 0
  pgrep -f estrella-napcat >/dev/null 2>&1 && return 0
  return 1
}

if [ "$FULL" -eq 1 ] || ask "清理 QQ 缓存（表情/日志/媒体，约 490M）？"; then
  if qq_running; then
    echo "⚠️  检测到 QQ/NapCat 正在运行——缓存清理已跳过（防止写坏缓存）。"
    echo "    先停 QQ/NapCat，再跑：./disk-cleanup.sh --full --auto"
    log "QQ 缓存清理跳过（QQ 运行中）"
  else
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
