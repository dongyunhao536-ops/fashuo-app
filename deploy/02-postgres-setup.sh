#!/usr/bin/env bash
# 建 fashuo DB + PostgREST 三个角色（authenticator/anon/service_role）+ 应用 schema.sql。
# 幂等：重跑只补缺失项。以 root 运行（会切到 postgres OS user 执行 psql）。
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: 请以 root 运行" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$REPO_ROOT/db/schema.sql"
[[ -f "$SCHEMA" ]] || { echo "ERROR: $SCHEMA 不存在" >&2; exit 1; }

# 生成一个随机的 authenticator 密码（仅 PostgREST 进程读，存到 /etc/postgrest.env）
AUTH_PW_FILE=/etc/fashuo-pg-authenticator.pw
if [[ -f "$AUTH_PW_FILE" ]]; then
  AUTH_PW="$(cat "$AUTH_PW_FILE")"
  echo "==> 复用已有的 authenticator 密码：$AUTH_PW_FILE"
else
  AUTH_PW="$(openssl rand -hex 24)"
  printf '%s' "$AUTH_PW" > "$AUTH_PW_FILE"
  chmod 600 "$AUTH_PW_FILE"
  echo "==> 生成新的 authenticator 密码 → $AUTH_PW_FILE"
fi

echo "==> 建 fashuo 库（若已有则跳过）"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='fashuo'" | grep -q 1 \
  || sudo -u postgres createdb fashuo

echo "==> 建/更新 PostgREST 三个角色"
sudo -u postgres psql -d fashuo <<SQL
-- 三个 PostgREST 约定角色
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '$AUTH_PW';
  ELSE
    -- 已存在则改密（与 /etc/fashuo-pg-authenticator.pw 对齐）
    ALTER ROLE authenticator WITH PASSWORD '$AUTH_PW';
  END IF;
END \$\$;

-- authenticator 能在请求时切换到 anon / service_role
GRANT anon, service_role TO authenticator;

-- service_role 实际执行表操作的权限（设计上 BYPASSRLS + 全权访问）
GRANT USAGE ON SCHEMA public TO anon, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- 新建表自动授权
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
SQL

echo "==> 应用 db/schema.sql"
sudo -u postgres psql -d fashuo -f "$SCHEMA" >/dev/null

# schema 应用后再补一次默认权限（schema.sql 里 CREATE TABLE 时角色已就位）
sudo -u postgres psql -d fashuo <<SQL
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
SQL

echo "==> 验证表已建（应 ≥ 7 张）"
TBL_COUNT=$(sudo -u postgres psql -d fashuo -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "    表数：$TBL_COUNT"

echo ""
echo "✓ Postgres 配置完成。"
echo "  - DB: fashuo"
echo "  - authenticator 密码：$AUTH_PW_FILE（PostgREST 配置会读）"
echo "  - 下一步：bash deploy/03-postgrest-install.sh"
