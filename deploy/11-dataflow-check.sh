#!/usr/bin/env bash
# deploy/11-dataflow-check.sh — 数据流「闭环」巡检：不只看进程活着，看【数据真在流动/被吸收】。
#
# 10-healthcheck 查的是基础设施（pm2/备份/同步日志/REST 活着）；本脚本查应用数据的回流闭环：
# 待办筐里的候选有没有被收下/登记、答疑澄清的复验有没有被实际处理、教练错题有没有被吸收、
# PC 主系统的共享学习账本是否还在写库、沉淀有没有进搜索镜像。回答两件事：①数据流正常更新同步？②更新后被实际运用？
#
# 数据全部本机 psql（postgres 用户 peer 认证，与 09-backup 同口径，不走 PostgREST/JWT）。
# 全绿 → ok（默认只记日志）；任一越线 → warn 推一条汇总。阈值全可在 /etc/default/fashuo-ops 覆盖。
#
# 一次性安装见 deploy/fashuo-ops.cron。
set -uo pipefail
source "$(dirname "$0")/lib-notify.sh"

DB="${PGDATABASE:-fashuo}"
export PGCLIENTENCODING=UTF8

# 阈值（天）——按各回路应有的兑现速度分别设；越快该兑现的卡越紧。
REVIEW_STALE_DAYS="${REVIEW_STALE_DAYS:-3}"    # 复验请求：清单最高优先，正常 1-2 天就背到
CONFIRM_STALE_DAYS="${CONFIRM_STALE_DAYS:-7}"  # 弱项/心得/已强化：等云在 APP 里收下再 PC 登记
ERROR_STALE_DAYS="${ERROR_STALE_DAYS:-21}"     # 教练错题：靠背诵掌握/云说懂了慢慢吸收
LEDGER_STALE_DAYS="${LEDGER_STALE_DAYS:-${RECITE_STALE_DAYS:-7}}" # 共享学习账本：多久没有新增流水；兼容旧变量名
MIRROR_STALE_DAYS="${MIRROR_STALE_DAYS:-7}"    # 内容镜像：沉淀进 content_mirror 的新鲜度

# 一次查清所有信号（9 个标量，| 分隔）。age 列：-1=该队列为空（不算异常）；max 列空表 →9999。
SQL=$(cat <<'SQL'
select
  (select coalesce(floor(extract(epoch from (now()-min(created_at)))/86400)::int,-1)
     from events where status='pending' and type='复验请求'),
  (select count(*) from events e where e.status='pending' and e.type='复验请求'
     and not exists (select 1 from kp_state k where k.kp_id=e.kp_id)),
  (select coalesce(floor(extract(epoch from (now()-min(created_at)))/86400)::int,-1)
     from events where status='pending' and type in ('弱项候选','心得候选','已强化')),
  (select count(*) from events where status='pending' and type in ('弱项候选','心得候选','已强化')),
  (select count(*) from events where status='pending' and subject is not null
     and subject not in ('刑法','民法','法理','宪法','法制史')),
  (select coalesce(floor(extract(epoch from (now()-min(created_at)))/86400)::int,-1)
     from study_error where status='open'),
  (select count(*) from study_error where status='open'),
  (select coalesce(floor(extract(epoch from (now()-max(created_at)))/86400)::int,9999) from study_log),
  (select coalesce(floor(extract(epoch from (now()-max(updated_at)))/86400)::int,9999) from content_mirror)
;
SQL
)

row=$(sudo -u postgres psql -d "$DB" -X -tA -F'|' -c "$SQL" 2>/dev/null)
if [[ -z "$row" ]]; then
  notify fail "数据流巡检无法连库" "sudo -u postgres psql -d $DB 查询失败——库可能没起来，或权限/编码异常。见 /var/log/fashuo-dataflow.log。"
  exit 1
fi

IFS='|' read -r review_age review_badkp confirm_age confirm_cnt drift_cnt err_age err_cnt ledger_age mirror_age <<<"$row"

issues=()

# ① 复验请求·闭环时延：答疑澄清后该优先复测的考点，迟迟没被背到
[[ "$review_age" -ge "$REVIEW_STALE_DAYS" ]] && \
  issues+=("复验请求积压：澄清后该复测的考点已 ${review_age} 天没被背到（>${REVIEW_STALE_DAYS}d）")

# ② 复验请求·坏指向：kp_id 为空或考点已不存在 → 永远无法兑现，白占清单最高优先桶
[[ "$review_badkp" -gt 0 ]] && \
  issues+=("${review_badkp} 条复验请求指向不存在的考点（kp_id 空/失效），永远无法兑现")

# ③ 待云收下积压：弱项/心得/已强化候选迟迟没被收下登记（云没开 APP，或登记静默跳过）
[[ "$confirm_age" -ge "$CONFIRM_STALE_DAYS" ]] && \
  issues+=("待办筐 ${confirm_cnt} 条候选最老一条已 ${confirm_age} 天没被收下/登记（>${CONFIRM_STALE_DAYS}d）")

# ④ 科目漂移哨兵：pending 候选科目名非规范名（如 法理学≠法理）→ PC 登记会静默跳过、永久卡筐
[[ "$drift_cnt" -gt 0 ]] && \
  issues+=("${drift_cnt} 条 pending 候选科目名异常（非五科规范名），会被登记静默跳过")

# ⑤ 教练错题吸收：study_error 长期 open（既没背诵掌握、也没标记云已懂）
[[ "$err_age" -ge "$ERROR_STALE_DAYS" ]] && \
  issues+=("教练错题 ${err_cnt} 条 open，最老一条已 ${err_age} 天未吸收（>${ERROR_STALE_DAYS}d）")

# ⑥ PC 主回路活性：study_log 是现役共享学习账本；detection_log 已随 APP 背诵检测模块冻结。
# 用 created_at 而不是可回填的 log_date，检查的是“最近有没有成功写库”，不是学习发生在哪一天。
[[ "$ledger_age" -ge "$LEDGER_STALE_DAYS" ]] && \
  issues+=("共享学习账本已 ${ledger_age} 天没有新增流水（PC 写入链停摆或这阵子没记学习，>${LEDGER_STALE_DAYS}d）")

# ⑦ 内容镜像新鲜度：content_mirror 太久没更新（沉淀没进搜索语料，答疑/教练检索不到新内容）
[[ "$mirror_age" -ge "$MIRROR_STALE_DAYS" ]] && \
  issues+=("content_mirror 已 ${mirror_age} 天未更新（新沉淀没进搜索镜像）")

# 友好渲染天龄（-1=空队列显示「无」）
ageday() { [[ "$1" -lt 0 ]] && echo "无" || echo "${1}d"; }

summary="待收下 ${confirm_cnt} 条/最老 $(ageday "$confirm_age")｜复验最老 $(ageday "$review_age")｜教练错题 ${err_cnt} 条｜账本最近 $(ageday "$ledger_age") 前｜镜像 $(ageday "$mirror_age")"

if [[ ${#issues[@]} -eq 0 ]]; then
  notify ok "数据流闭环正常" "$summary"
else
  notify warn "数据流发现 ${#issues[@]} 项异常" "$(printf '%s；' "${issues[@]}")｜全量：$summary"
fi
