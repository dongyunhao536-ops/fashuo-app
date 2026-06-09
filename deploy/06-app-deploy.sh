#!/usr/bin/env bash
# 在 ECS 上：npm ci → next build → pm2 start。幂等：每次 git pull 后跑。
# 前提：/opt/fashuo-app/.env.production 已填好（用 env.example 作模板）。
set -euo pipefail

REPO_ROOT=/opt/fashuo-app
ENV_FILE=$REPO_ROOT/.env.production

[[ -f "$ENV_FILE" ]] || { echo "ERROR: 缺 $ENV_FILE，先 cp deploy/env.example 它再编辑" >&2; exit 1; }

cd "$REPO_ROOT"

echo "==> 1/4 npm ci"
npm ci --omit=dev=false  # 完整装：build 要 TS/eslint/postcss

echo "==> 2/4 next build"
# .env.production 在 production 模式自动加载（Next.js 内建）
NODE_ENV=production npm run build

echo "==> 3/4 pm2 启动 / 重启"
if pm2 describe fashuo >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --update-env
else
  pm2 start deploy/ecosystem.config.cjs
fi

pm2 save

echo "==> 4/4 自检"
sleep 2
curl -s -o /dev/null -w "本地直连 :3000 = %{http_code}\n" http://127.0.0.1:3000/api/login -X DELETE || true
curl -k -s -o /dev/null -w "本机 nginx :8443 = %{http_code}\n" https://127.0.0.1:8443/ || true

echo ""
echo "✓ 部署完成。tail 日志：pm2 logs fashuo --lines 30"
