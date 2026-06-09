#!/usr/bin/env bash
# 阿里云 ECS Ubuntu 22.04 一次性系统底座初始化。
# 幂等：重跑安全。以 root 运行。
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: 请以 root 运行（sudo bash $0）" >&2
  exit 1
fi

echo "==> 1/6 更新 apt 源 + 升级"
apt-get update -y
apt-get upgrade -y

echo "==> 2/6 装基础工具（curl/git/jq/nginx/ufw/cron/build-essential）"
apt-get install -y curl wget git jq nginx ufw cron build-essential ca-certificates gnupg

echo "==> 3/6 装 PostgreSQL 15"
# Ubuntu 22.04 默认源 = PG 14；用 PG 官方源装 PG 15
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -y
apt-get install -y postgresql-15 postgresql-client-15
systemctl enable --now postgresql

echo "==> 4/6 装 Node.js 22 LTS（NodeSource 源）"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
npm --version

echo "==> 5/6 装 pm2 全局"
npm install -g pm2
pm2 startup systemd -u root --hp /root >/dev/null || true

echo "==> 6/6 PG 调小内存（2GB 机器同跑 Node + PG）"
PG_CONF=/etc/postgresql/15/main/postgresql.conf
sed -i \
  -e "s/^#\?shared_buffers.*/shared_buffers = 128MB/" \
  -e "s/^#\?work_mem.*/work_mem = 4MB/" \
  -e "s/^#\?maintenance_work_mem.*/maintenance_work_mem = 32MB/" \
  -e "s/^#\?effective_cache_size.*/effective_cache_size = 512MB/" \
  -e "s/^#\?max_connections.*/max_connections = 25/" \
  "$PG_CONF"
# 仅监听 localhost，绝不对公网开放 5432
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$PG_CONF"
systemctl restart postgresql

echo ""
echo "✓ 底座装好。下一步：bash deploy/02-postgres-setup.sh"
