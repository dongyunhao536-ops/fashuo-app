#!/usr/bin/env bash
# deploy/10-healthcheck.sh — 每天巡检，异常主动告警（而非云用时才发现）。
#
# 查五件事：① Next.js(pm2 fashuo) 在线？② 最近备份是否新鲜(<36h)？
#   ③ 档案自动同步是否近期跑过(<36h)？④ PostgREST(本机 REST) 是否应答？⑤ 磁盘水位是否安全？
# 全绿 → ok（默认只记日志）；有异常 → warn 推送一条汇总。
# 跑完无条件打一次心跳（死人开关）——cron/机器/告警管线整条死掉时，由对端反过来告警你。
#
# 一次性安装见 deploy/fashuo-ops.cron。
set -uo pipefail
source "$(dirname "$0")/lib-notify.sh"

BACKUP_REPO="${BACKUP_REPO:-/opt/fashuo-backups}"
AUTOSYNC_LOG="${AUTOSYNC_LOG:-/var/log/fashuo-autosync.log}"
REST_URL="${REST_HEALTH_URL:-http://127.0.0.1:3001/}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"   # 根分区使用率超此值告警（小盘上 pg_dump+git 仓最易慢性撑爆）
STALE=$((36 * 3600))
now=$(date +%s)
issues=()

age_of() { [[ -e "$1" ]] && echo $(( now - $(stat -c %Y "$1") )) || echo -1; }

# ① pm2 app 在线（用 pm2 pid 拿 PID + kill -0 探活；
#    原版 jlist+grep 误报：jlist 是单行 JSON，name 与 status 字段距离太远，-A2 拿不到 status）
if command -v pm2 >/dev/null 2>&1; then
  pid=$(pm2 pid fashuo 2>/dev/null | tail -1)
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    issues+=("pm2 里没有 fashuo 进程")
  elif ! kill -0 "$pid" 2>/dev/null; then
    issues+=("Next.js(pm2 fashuo) 进程 $pid 不存活")
  fi
fi

# ② 最近备份新鲜度
LATEST=$(ls -t "$BACKUP_REPO"/daily/*.sql.gz 2>/dev/null | head -1)
if [[ -z "$LATEST" ]]; then
  issues+=("没有任何数据库备份")
else
  a=$(age_of "$LATEST"); [[ "$a" -gt "$STALE" ]] && issues+=("最近备份超 36h 未更新")
fi

# ③ 档案自动同步新鲜度
if [[ -f "$AUTOSYNC_LOG" ]]; then
  a=$(age_of "$AUTOSYNC_LOG"); [[ "$a" -gt "$STALE" ]] && issues+=("档案自动同步超 36h 未运行")
fi

# ④ PostgREST 应答（HTTP 状态非空即视为活）
if ! curl -s -m 8 -o /dev/null -w '%{http_code}' "$REST_URL" | grep -qE '^[2-4][0-9][0-9]$'; then
  issues+=("PostgREST($REST_URL) 无应答")
fi

# ⑤ 磁盘水位（df --output 是 GNU coreutils，Ubuntu 自带）。撑爆=pg_dump/写库/build 全失败。
DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
if [[ -n "$DISK_PCT" && "$DISK_PCT" -ge "$DISK_WARN_PCT" ]]; then
  issues+=("根分区磁盘使用率 ${DISK_PCT}%（超 ${DISK_WARN_PCT}% 阈值）")
fi

if [[ ${#issues[@]} -eq 0 ]]; then
  notify ok "巡检正常" "pm2 / 备份 / 自动同步 / REST / 磁盘(${DISK_PCT}%) 均健康。"
else
  notify warn "巡检发现 ${#issues[@]} 项异常" "$(printf '%s；' "${issues[@]}")"
fi

# 跑到这里就证明 cron+机器+脚本都活着 → 无条件打心跳（无论上面有没有异常；异常已走 Bark warn）。
heartbeat
