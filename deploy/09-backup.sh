#!/usr/bin/env bash
# deploy/09-backup.sh — 数据库异地备份：pg_dump → gzip → 推 fashuo-backups 私库。
#
# 为什么：备份与 DB 同在这台 ECS = 单点全损（盘坏/误删/被薅）。推到 GitHub 私库才是真异地容灾。
# 仓库内只留最近 BACKUP_KEEP_DAYS 天的 .sql.gz（工作区精简）；GitHub 历史保留全部版本。
# 单用户库每份 gzip <1MB，一年历史 <365MB，私库免费额度足够。
#
# 一次性安装见 deploy/fashuo-ops.cron。先手动跑一次验证：bash deploy/09-backup.sh
set -uo pipefail
source "$(dirname "$0")/lib-notify.sh"

DB_NAME="${PGDATABASE:-fashuo}"
DB_USER="${PGUSER:-fashuo}"
BACKUP_REPO="${BACKUP_REPO:-/opt/fashuo-backups}"
BRANCH="${BACKUP_BRANCH:-master}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date '+%Y%m%d-%H%M')"
OUT="$BACKUP_REPO/daily/fashuo-$STAMP.sql.gz"

echo "===== $(date '+%F %T') backup 开始 ====="

if [[ ! -d "$BACKUP_REPO/.git" ]]; then
  notify fail "备份未配置" "$BACKUP_REPO 不是 git 仓库，请先 clone fashuo-backups 私库。"
  exit 1
fi
mkdir -p "$BACKUP_REPO/daily"

# pg_dump（仅 localhost，免密 peer/ident 认证；如需密码走 ~/.pgpass）
if ! pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"; then
  notify fail "数据库备份失败" "pg_dump 出错，本次未生成备份。见 /var/log/fashuo-backup.log。"
  rm -f "$OUT"
  exit 1
fi
SIZE=$(du -h "$OUT" | cut -f1)

# rotate：删工作区里超过 KEEP_DAYS 天的（git 历史仍保留）
find "$BACKUP_REPO/daily" -name 'fashuo-*.sql.gz' -mtime +"$KEEP_DAYS" -delete

cd "$BACKUP_REPO" || exit 1
git pull --rebase --autostash origin "$BRANCH" >/dev/null 2>&1 || true
git add -A
if [[ -n "$(git status --porcelain)" ]]; then
  git commit -m "备份 $STAMP（$SIZE）" >/dev/null
  if ! git push origin "$BRANCH"; then
    notify fail "备份推送失败" "本地备份已生成（$SIZE）但 push GitHub 失败——异地副本未更新，请尽快查网络/凭证。"
    exit 1
  fi
fi
notify ok "备份完成" "$STAMP（$SIZE）已推送异地。"
echo "===== $(date '+%F %T') backup 完成 ====="
