#!/usr/bin/env bash
# 在 ECS 上激活云端构建好的 standalone 产物（由 GitHub Actions 推来后调用）。
#   用法：bash deploy/12-activate-standalone.sh <tarball路径> <sha>
# 零编译：解包 → 切 current 软链 → pm2 reload → 自检 → 留最近 3 版便于回滚。
set -euo pipefail

TARBALL="${1:?用法: 12-activate-standalone.sh <tarball> <sha>}"
SHA="${2:?缺 sha}"
ROOT=/opt/fashuo-app
REL_DIR="$ROOT/releases"
DEST="$REL_DIR/$SHA"

echo "==> 1/5 解包 → $DEST"
mkdir -p "$REL_DIR"
rm -rf "$DEST"; mkdir -p "$DEST"
tar -xzf "$TARBALL" -C "$DEST"
[[ -f "$DEST/server.js" ]] || { echo "✗ 产物缺 server.js，异常中止（不切软链）"; exit 2; }

echo "==> 2/5 切 current 软链 → $SHA"
PREV=$(readlink "$ROOT/current" 2>/dev/null || true)
ln -sfn "$DEST" "$ROOT/current"

echo "==> 3/5 pm2 reload"
cd "$ROOT"
pm2 reload deploy/ecosystem.config.cjs --update-env || pm2 start deploy/ecosystem.config.cjs
pm2 save

echo "==> 4/5 自检"
sleep 2
code=$(curl -k -s -o /dev/null -w "%{http_code}" --max-time 8 https://127.0.0.1:8443/login || echo 000)
echo "    nginx :8443 /login = $code"
if [[ "$code" != "200" ]]; then
  echo "✗ 自检非 200。回滚 current → ${PREV:-(无上一版)}"
  [[ -n "${PREV:-}" ]] && { ln -sfn "$PREV" "$ROOT/current"; pm2 reload deploy/ecosystem.config.cjs --update-env || true; }
  exit 3
fi

echo "==> 5/5 清理旧 release（留最近 3 个）+ 删 tarball"
ls -1dt "$REL_DIR"/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
rm -f "$TARBALL"

echo "✓ ACTIVATE_DONE $SHA"
