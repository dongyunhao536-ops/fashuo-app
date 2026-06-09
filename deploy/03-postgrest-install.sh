#!/usr/bin/env bash
# 装 PostgREST 二进制（单文件 Haskell binary） + systemd unit。
# 幂等：版本未变跳过下载；配置已存在则备份。以 root 运行。
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: 请以 root 运行" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POSTGREST_VERSION="${POSTGREST_VERSION:-v12.2.3}"
BIN=/usr/local/bin/postgrest

if [[ -x "$BIN" ]] && "$BIN" --version 2>/dev/null | grep -q "$POSTGREST_VERSION"; then
  echo "==> PostgREST $POSTGREST_VERSION 已在 $BIN，跳过下载"
else
  echo "==> 下载 PostgREST $POSTGREST_VERSION"
  TMP=$(mktemp -d)
  trap "rm -rf $TMP" EXIT
  cd "$TMP"
  # GitHub releases 在国内有时慢；连不上的话试 ghproxy.com 镜像
  URL="https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x86-64.tar.xz"
  if ! wget --timeout=30 -qO postgrest.tar.xz "$URL"; then
    echo "    GitHub 直连失败，试 ghproxy 镜像"
    wget --timeout=60 -qO postgrest.tar.xz "https://ghproxy.com/$URL" \
      || { echo "ERROR: 都拿不到 PostgREST 二进制，手动下载放 $BIN" >&2; exit 1; }
  fi
  tar -xJf postgrest.tar.xz
  install -m 755 postgrest "$BIN"
  cd - >/dev/null
  "$BIN" --version
fi

# 生成 jwt-secret（如尚未生成）
JWT_SECRET_FILE=/etc/fashuo-jwt-secret
if [[ ! -f "$JWT_SECRET_FILE" ]]; then
  openssl rand -hex 32 > "$JWT_SECRET_FILE"
  chmod 600 "$JWT_SECRET_FILE"
  echo "==> 生成 jwt-secret → $JWT_SECRET_FILE（mint JWT 时 04 脚本会读它）"
else
  echo "==> jwt-secret 已存在：$JWT_SECRET_FILE"
fi

# 渲染配置（从 template 填变量，存 /etc/postgrest.conf）
AUTH_PW=$(cat /etc/fashuo-pg-authenticator.pw)
JWT_SECRET=$(cat "$JWT_SECRET_FILE")
CONF=/etc/postgrest.conf
TMPL="$REPO_ROOT/deploy/postgrest.conf.tmpl"

if [[ -f "$CONF" ]]; then
  cp "$CONF" "$CONF.bak.$(date +%s)"
  echo "==> 已备份现有 $CONF"
fi

sed -e "s|__AUTH_PW__|$AUTH_PW|g" \
    -e "s|__JWT_SECRET__|$JWT_SECRET|g" \
    "$TMPL" > "$CONF"
chmod 600 "$CONF"
echo "==> 写入 $CONF"

# systemd unit
cat > /etc/systemd/system/postgrest.service <<'UNIT'
[Unit]
Description=PostgREST API for fashuo
After=postgresql.service
Requires=postgresql.service

[Service]
ExecStart=/usr/local/bin/postgrest /etc/postgrest.conf
Restart=on-failure
RestartSec=3
User=root
# 让 PostgREST 仅监听 localhost（nginx 在前面反代）

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now postgrest
sleep 1
systemctl status postgrest --no-pager | head -15 || true

echo ""
echo "✓ PostgREST 装好。下一步：node deploy/04-mint-jwt.mjs（出 SERVICE_ROLE_KEY）"
