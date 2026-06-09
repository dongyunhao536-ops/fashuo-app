#!/usr/bin/env bash
# 装日备份 cron job：每日凌晨 pg_dump → /backups/，保留 7 天。
# 幂等：再次跑只覆盖 cron 脚本。
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: 请以 root 运行" >&2
  exit 1
fi

mkdir -p /backups /var/log/fashuo
chmod 700 /backups

cat > /etc/cron.daily/fashuo-backup <<'CRON'
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
OUT=/backups/fashuo-$TS.dump
LOG=/var/log/fashuo/backup.log

echo "[$TS] start" >> "$LOG"
# custom format（-Fc），便于 pg_restore --list 抽查 + 选择性恢复
sudo -u postgres pg_dump --format=c --no-owner --no-privileges fashuo > "$OUT" 2>>"$LOG"
echo "[$TS] done: $(ls -lh $OUT | awk '{print $5}')" >> "$LOG"

# 保留 7 天
find /backups -name 'fashuo-*.dump' -mtime +7 -delete

# 留一个 latest 软链，便于手动 pg_restore --list
ln -sf "$OUT" /backups/latest.dump
CRON

chmod 755 /etc/cron.daily/fashuo-backup

echo "==> 装好。立即手动跑一次验证："
/etc/cron.daily/fashuo-backup
ls -lh /backups/
echo ""
echo "✓ cron 装好。日均运行时间：凌晨（cron.daily 默认）"
