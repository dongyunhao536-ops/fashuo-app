# shellcheck shell=bash
# deploy/lib-notify.sh — 运维脚本共用的告警函数。source 进来用：notify <level> <title> <body>
#
# 推送渠道：Bark（iOS 开源推送，云 iPhone 装 App 后得到个人 key）。
#   在 .env.production 或 cron 环境里设 NOTIFY_URL=https://api.day.app/<你的key> 即启用。
#   未设 NOTIFY_URL → 仅写脚本日志，不推送（不阻塞）。
#
# level：ok（健康，默认只记日志不推）/ warn（需留意，推普通）/ fail（出事了，推时效性高+响铃）。
#   想连 ok 也推：设 NOTIFY_ALL=1。
notify() {
  local lvl="$1" title="$2" body="$3"
  echo "[$(date '+%F %T')] [$lvl] $title — $body"

  [[ "$lvl" == "ok" && "${NOTIFY_ALL:-0}" != "1" ]] && return 0
  [[ -z "${NOTIFY_URL:-}" ]] && return 0

  local barklevel="active"
  [[ "$lvl" == "fail" ]] && barklevel="timeSensitive"

  curl -s -m 10 -X POST "$NOTIFY_URL" \
    --data-urlencode "title=法硕·$title" \
    --data-urlencode "body=$body" \
    --data-urlencode "group=fashuo运维" \
    --data-urlencode "level=$barklevel" >/dev/null 2>&1 \
    || echo "  （通知推送失败，已忽略——不影响主流程）"
}

# 心跳（死人开关）——治"健康的沉默 == 死亡的沉默"。
# 巡检全绿时默认不推送（notify ok 静默），于是你收不到消息既可能是"一切正常"，也可能是
# 机器宕了/cron 没跑/Bark 挂了/NOTIFY_URL 配错——这两种沉默长得一模一样，没人替你区分。
# 解法反过来：每次巡检跑完【无条件】ping 一下 HEARTBEAT_URL（healthchecks.io 之类，免费），
# 由对端定时校验：ping 按时来=监控活着；ping 断了=对端反过来告警你。
#   一次性：healthchecks.io 建一个 daily 检查，把它给的 ping URL 写进
#   /etc/default/fashuo-ops 的 HEARTBEAT_URL=https://hc-ping.com/<uuid>
# 未设 HEARTBEAT_URL → 跳过（不阻塞，不影响主流程）。
heartbeat() {
  [[ -z "${HEARTBEAT_URL:-}" ]] && return 0
  curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1 \
    || echo "  （心跳 ping 失败，已忽略——不影响主流程）"
}
