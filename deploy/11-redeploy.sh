#!/usr/bin/env bash
# 日常重部署（代码更新）：build → pm2 reload → 自检。幂等。
# 设计为「Claude 远程一键」调用：调用方先 git pull，再 nohup 跑本脚本（脱离 SSH 会话防 SIGHUP）。
#   ssh root@ECS 'cd /opt/fashuo-app && git pull --ff-only && \
#     nohup bash deploy/11-redeploy.sh > /tmp/deploy.log 2>&1 & echo LAUNCHED'
# 改了依赖（package.json/lock）时传 --deps 触发 npm ci；否则跳过省时间。
set -euo pipefail

REPO_ROOT=/opt/fashuo-app
cd "$REPO_ROOT"

if [[ "${1:-}" == "--deps" ]]; then
  echo "==> npm ci（依赖有变）"
  npm ci
fi

echo "==> next build"
NODE_ENV=production NODE_OPTIONS="--max-old-space-size=1536" npm run build

echo "==> pm2 reload"
pm2 reload deploy/ecosystem.config.cjs --update-env || pm2 start deploy/ecosystem.config.cjs
pm2 save

echo "==> 自检"
sleep 2
curl -k -s -o /dev/null -w "nginx :8443 = %{http_code}\n" https://127.0.0.1:8443/ || true

echo "✓ REDEPLOY_DONE $(git rev-parse --short HEAD)"
