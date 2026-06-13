#!/usr/bin/env bash
# deploy/10-healthcheck.sh — 每天巡检，异常主动告警（而非云用时才发现）。
#
# 查四件事：① Next.js(pm2 fashuo) 在线？② 最近备份是否新鲜(<36h)？
#   ③ 档案自动同步是否近期跑过(<36h)？④ PostgREST(本机 REST) 是否应答？
# 全绿 → ok（默认只记日志）；有异常 → warn 推送一条汇总。
#
# 一次性安装见 deploy/fashuo-ops.cron。
set -uo pipefail
source "$(dirname "$0")/lib-notify.sh"

BACKUP_REPO="${BACKUP_REPO:-/opt/fashuo-backups}"
AUTOSYNC_LOG="${AUTOSYNC_LOG:-/var/log/fashuo-autosync.log}"
REST_URL="${REST_HEALTH_URL:-http://127.0.0.1:3001/}"
STALE=$((36 * 3600))
now=$(date +%s)
issues=()

age_of() { [[ -e "$1" ]] && echo $(( now - $(stat -c %Y "$1") )) || echo -1; }

# ① pm2 app 在线
if command -v pm2 >/dev/null 2>&1; then
  if ! pm2 jlist 2>/dev/null | grep -q '"name":"fashuo"'; then
    issues+=("pm2 里没有 fashuo 进程")
  elif ! pm2 jlist 2>/dev/null | tr ',' '\n' | grep -A2 '"name":"fashuo"' | grep -q '"status":"online"'; then
    issues+=("Next.js(pm2 fashuo) 不在线")
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

if [[ ${#issues[@]} -eq 0 ]]; then
  notify ok "巡检正常" "pm2 / 备份 / 自动同步 / REST 均健康。"
else
  notify warn "巡检发现 ${#issues[@]} 项异常" "$(printf '%s；' "${issues[@]}")"
fi
