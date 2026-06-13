#!/usr/bin/env bash
# 日常重部署（代码更新）：保 swap → build → pm2 reload → 自检。幂等。
# 设计为「Claude 远程一键」调用：调用方先 git pull，再 nohup 跑本脚本（脱离 SSH 会话防 SIGHUP）。
#   ssh root@ECS 'cd /opt/fashuo-app && git pull --ff-only && \
#     nohup bash deploy/11-redeploy.sh > /tmp/deploy.log 2>&1 & echo LAUNCHED'
# 改了依赖（package.json/lock）时传 --deps 触发 npm ci；否则跳过省时间。
#
# 2026-06-13 加固（一次 2核2G OOM 抖死全机的教训）：
#   ① build 前强制保证 ≥1.5G swap（裸 2G 内存 build Next 必爆）——swap 丢了直接中止，不硬冲
#   ② nice 降优先级，让 sshd/nginx 始终能响应（OOM 时还能 SSH 进来看）
#   ③ heap 上限收到 1024，配 swap 兜底
#   ④ app 全程不停（旧 .next 继续服务），build 完才 pm2 reload 切换
set -euo pipefail

REPO_ROOT=/opt/fashuo-app
cd "$REPO_ROOT"

echo "==> 0/4 保证 swap（防 OOM 抖死全机）"
ensure_swap() {
  local sw
  sw=$(free -m | awk '/Swap/{print $2}')
  if [ "${sw:-0}" -lt 1500 ]; then
    echo "    当前 swap 仅 ${sw:-0}MB → 创建 /swapfile 2G"
    if [ ! -f /swapfile ]; then
      fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile 2>/dev/null || true
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sw=$(free -m | awk '/Swap/{print $2}')
  fi
  echo "    swap = ${sw:-0}MB"
  if [ "${sw:-0}" -lt 1500 ]; then
    echo "✗ swap 仍 <1500MB（磁盘满？）——为防再次 OOM 抖死全机，中止部署。" >&2
    exit 3
  fi
}
ensure_swap
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
echo "    部署前内存："; free -m | awk 'NR==1||/Mem|Swap/'

# 2核2G 关键：build 前停 app 腾内存。app(~300MB)+build 并发会挤爆内存→swap 重度抖→
# 连 SSH 都没响应（2026-06-13 实测）。代价＝build 期间 ~1-2 分钟不可用，值得。
# trap 保证无论 build 成败，退出时都把 app 拉回来（防停了起不来）。
echo "==> 1/4 停 app 腾内存（build 期间短暂不可用 ~1-2 分钟）"
pm2 stop fashuo >/dev/null 2>&1 || true
trap 'pm2 start deploy/ecosystem.config.cjs --update-env 2>/dev/null || pm2 restart fashuo 2>/dev/null || true; pm2 save 2>/dev/null || true' EXIT

if [[ "${1:-}" == "--deps" ]]; then
  echo "==> npm ci（依赖有变）"
  nice -n 15 npm ci
fi

echo "==> 2/4 next build（app 已停 + nice + swap 兜底）"
NODE_ENV=production NODE_OPTIONS="--max-old-space-size=1024" nice -n 15 npm run build

echo "==> 3/4 pm2 reload"
pm2 reload deploy/ecosystem.config.cjs --update-env || pm2 start deploy/ecosystem.config.cjs
pm2 save
trap - EXIT  # 成功收尾，撤掉兜底 trap（避免重复 start）

echo "==> 4/4 自检"
sleep 2
free -m | awk '/Mem|Swap/'
curl -k -s -o /dev/null -w "nginx :8443 = %{http_code}\n" https://127.0.0.1:8443/ || true

echo "✓ REDEPLOY_DONE $(git rev-parse --short HEAD)"
