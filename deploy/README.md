# 阿里云 ECS 部署资产

完整的 SOP 看根目录 `BUILD_PLAN.md` 的「部署 SOP」节。本目录是配套脚本与配置模板。

## 架构回顾

```
INTERNET
  │ https://<ECS-IP>:8443  （自签 TLS，iPhone 需信任 CA 一次）
  ▼
ECS (Ubuntu 22.04, 2 核 2 G)
  ├─ nginx :8443 → 反代两路：
  │    ├─ /rest/v1/* → PostgREST :3001
  │    └─ /*         → Next.js   :3000
  ├─ Next.js production (pm2)
  ├─ PostgREST (systemd)
  └─ PostgreSQL 15 (systemd)
```

## 文件清单

| 文件 | 作用 |
|---|---|
| `01-system-setup.sh` | apt 装 PostgreSQL/nginx/Node/pm2，系统基本调优 |
| `02-postgres-setup.sh` | 建库、角色（authenticator/anon/service_role），应用 `db/schema.sql` |
| `03-postgrest-install.sh` | 下载 PostgREST 二进制 + 写 systemd unit |
| `postgrest.conf.tmpl` | PostgREST 配置模板（jwt-secret 占位） |
| `04-mint-jwt.mjs` | 生成 service_role / anon JWT（凑 supabase-js 的 apikey 头） |
| `05-self-signed-cert.sh` | 自签 CA + 服务器证书（10 年有效期，IP 作为 SAN） |
| `nginx-fashuo.conf.tmpl` | nginx :8443 反代配置（含 `<ECS-IP>` 占位符） |
| `06-app-deploy.sh` | `npm ci` → `npm run build` → `pm2 start` |
| `ecosystem.config.cjs` | pm2 进程配置 |
| `07-backup-cron.sh` | 装日备份 cron job（pg_dump → /backups/，保留 7 天） |
| `env.example` | `.env.production` 模板 |
| `INSTALL-CA-iPhone.md` | iPhone 信任自签 CA 的步骤（一次性） |

## 执行顺序

按 BUILD_PLAN「云需要做的事」的 0-9 步走。脚本文件名前缀 0X 已标顺序。

## 都要在 ECS 上以 root 跑

除了 `04-mint-jwt.mjs`（Node 脚本）和 `05-self-signed-cert.sh`（需要 ECS 公网 IP 作参数），其余无参数。所有脚本 **幂等**：重跑安全，不会破坏已就位的配置。

## 应急

- **PostgREST 起不来**：`journalctl -u postgrest -n 30` 看报错；最常见是 `jwt-secret` 没填或 `db-uri` 密码错。
- **nginx 起不来**：`nginx -t` 看语法；最常见是 `<ECS-IP>` 占位符没 sed 替换。
- **Next 起不来**：`pm2 logs fashuo` 看；最常见是 `.env.production` 缺变量或 `NEXT_PUBLIC_SUPABASE_URL` 协议错（必须 https 含端口）。
- **iPhone 不信任**：`INSTALL-CA-iPhone.md` 重做一次"启用对该根证书的完全信任"——这一步最容易漏。
