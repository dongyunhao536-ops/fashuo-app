#!/usr/bin/env bash
# deploy/08-archive-autosync.sh — 档案每天自动登记 + 双向 git 同步（云不再手动 npm run register）
#
# 每天一次自动完成：
#   1. git pull  档案仓库  —— 先拉云在 PC 上的手工编辑（补"错误表现/锚点"列），避免被覆盖
#   2. register-events.mjs —— confirmed events → 档案 md（弱项/心得/已强化；红线#3 唯一去重处）
#   3. sync-content.mjs    —— 档案 md → content_mirror（grep 镜像跟上新沉淀）
#   4. git commit + push   —— 档案改动推回 GitHub；云在 PC `git pull` 即见最新
#
# 复验请求不在此处（检测完成后 APP 侧已自动消费）。本脚本只碰档案 markdown，红线#3 不破。
#
# 健壮性：git pull 冲突不硬停（云 PC 手编与自动登记同时改同一行时）——保留本地、告警、
#   跳过本次（不再 register/push 以免越搅越乱），confirmed events 安全留库等下次。
#
# ── 一次性安装见 deploy/fashuo-ops.cron ──
set -uo pipefail
source "$(dirname "$0")/lib-notify.sh"

APP_DIR="${APP_DIR:-/opt/fashuo-app}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/opt/fashuo-archive}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production}"
BRANCH="${ARCHIVE_BRANCH:-master}"

export ARCHIVE_DIR
export NODE_TLS_REJECT_UNAUTHORIZED=0   # 本机 PostgREST 自签证书

echo "===== $(date '+%F %T') archive autosync 开始 ====="

# 1) 先拉云在 PC 上的手工编辑；冲突则保留本地、跳过本轮（不破坏数据）
if ! git -C "$ARCHIVE_DIR" pull --rebase --autostash origin "$BRANCH"; then
  git -C "$ARCHIVE_DIR" rebase --abort 2>/dev/null || true
  git -C "$ARCHIVE_DIR" merge --abort 2>/dev/null || true
  notify warn "档案同步暂停" "git pull 与本地冲突，已回滚保留本地、跳过本次登记。confirmed 候选仍在库里，解决冲突后会自动补上。"
  exit 0
fi

# 2)+3) 登记 + 镜像同步（cwd=APP_DIR：sync-content 读相对路径 config/mirror-scope.json）
cd "$APP_DIR" || { notify fail "autosync 异常" "进不去 $APP_DIR"; exit 1; }
if ! node --env-file="$ENV_FILE" scripts/register-events.mjs; then
  notify fail "档案登记失败" "register-events.mjs 非零退出，见 /var/log/fashuo-autosync.log。"
  exit 1
fi
if ! node --env-file="$ENV_FILE" scripts/sync-content.mjs; then
  notify fail "镜像同步失败" "sync-content.mjs 非零退出，答疑可能搜不到本批新沉淀。"
  exit 1
fi

# 4) 档案有改动才 commit + push
cd "$ARCHIVE_DIR" || exit 1
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "档案自动登记 $(date '+%F %T')（ECS autosync）" >/dev/null
  if ! git push origin "$BRANCH"; then
    notify fail "档案推送失败" "已本地 commit 但 push GitHub 失败，下次会重试（不丢数据）。"
    exit 1
  fi
  notify ok "档案同步完成" "已登记并推送本批 confirmed 候选。"
else
  echo "本轮无新 confirmed，档案无改动，跳过 commit。"
fi
echo "===== $(date '+%F %T') archive autosync 完成 ====="
