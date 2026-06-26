# RUNBOOK — 日常运维命令速查

> 这是"打开就能跑"的命令清单。每条命令前面一句话说**什么时候用**。
> 设计原理见 [BUILD_PLAN.md](BUILD_PLAN.md)；这里只列操作。
>
> 工作目录约定：所有 `npm run XXX` 都在 **PC 的 `D:\fashuo-app\`** 跑。
> 部署/查日志在 **ECS 的 `/opt/fashuo-app/`** 跑（先 SSH 进去）。

---

## 0. 一次性准备（只做一次）

### 0.1 给档案库做版本追溯

```powershell
cd D:\fashuo
@'
node_modules/
*.apkg
*.log
.DS_Store
Thumbs.db
'@ | Out-File -Encoding utf8 .gitignore

git init
git add .
git status   # ⚠ 看清楚清单，不能有 node_modules/ 几千个文件，只能看到教材/真题分析/易混概念库/薄弱知识点
git commit -m "init archive"
```

完了不需要 `git remote add`、不需要 push。这是纯本地保险库，**服务器不读 D:\fashuo**。

---

## 1. 学习沉淀回灌（最高频，建议每天或睡前跑一次）

**触发条件**：你在 PWA 上对一些答疑结果/检测结果点了"收下"（events.status = confirmed）后。

### 1.1 一条龙（推荐）

```powershell
cd D:\fashuo-app
npm run register:full
```

会自动串行执行：
1. `register-events.mjs` — events.confirmed → `D:\fashuo` 下的 md（红线 #3 唯一去重处）
2. `sync-content.mjs` — md → `content_mirror` 表（答疑 grep 读这里）
3. `git commit` — 档案库自动留追溯（D:\fashuo 不是 git 仓库则跳过）

### 1.2 演练（首次用 / 不放心时）

```powershell
cd D:\fashuo-app
npm run register -- --dry-run
```

只打印"将要做什么"，**不写文件、不改库**。看清楚再决定要不要真跑 `register:full`。

### 1.4 出错时的兜底

| 现象 | 怎么办 |
|------|--------|
| 自动同步没生效（档案没更新） | ECS 上 `tail -50 /var/log/fashuo-autosync.log` 看哪步挂了；cron 没装看 §1.1 一次性安装 |
| ECS push 报权限/认证失败 | ECS 对 `fashuo-archive` 私库无写权限——配 deploy key（勾 write access）或账号级凭证 |
| register 步报 `找不到 _XX做题心得.md` | 档案少建了一科心得文件，看 `scripts/register-events.mjs:28` 的 `XINDE_FILE` map 对照 D:\fashuo\真题分析\ 缺哪个 |
| register 步报 `⚠ 暂无心得文件，跳过未消费` | events 没消费，下次再跑会重复出现；要么补建档案文件 + 改 `XINDE_FILE` map + 改 `config/mirror-scope.json`，要么在 PWA 待办筐驳回那条 |
| sync 步报 fetch failed / ETIMEDOUT | 家宽抖断，脚本自带 5 次指数退避；如全部失败，换网 / 挂代理重跑 |
| git commit 步报"档案无改动" | 正常，可能是 register 命中已有行只做了"频率+1"（这种情况脚本不真改 md），或本轮无新 confirmed |
| 已 `consumed` 但发现 md 内容写错 | `D:\fashuo` 下 `git revert HEAD`；再去 Supabase 把对应 events 改回 `confirmed` 然后修脚本逻辑后重跑 |

---

## 2. 手动改了档案 md（不常见）

如果你不通过 PWA、直接在 D:\fashuo 下手改了教材/心得/易混任何一份 md：

```powershell
cd D:\fashuo-app
npm run sync          # 把改动灌进 content_mirror

cd D:\fashuo
git add .
git commit -m "手改 XXX：YYY"
```

⚠ **避免手改"待观察"表格**——它是 register 唯一写入区，手改会让重复检测失效。规律级沉淀应该走"PWA 沉淀候选 → 待办筐收下 → register" 流程。

---

## 3. 改了应用代码 → 部署 ECS

> 🚫 **不要在 ECS 上 `npm run build`。** 2026-06-13 起已是全自动 CD：**`git push origin main` 就会自动部署**。
> ECS（2 核 2G）裸跑 `next build` 会 OOM 抖死全机（连 SSH 都连不上、要重启实例才恢复——2026-06-13 与 2026-06-25 各实测一次）。
> 完整流程与原理见 [deploy/CD-SETUP.md](deploy/CD-SETUP.md)；这里只列日常操作。

### 3.1 PC 侧：提交并推送（这就够了）

```powershell
cd D:\fashuo-app
git add <改动的文件>
git commit -m "改动说明"
git push origin main
```

push 后 **GitHub Actions 自动**：云端 `npm ci` + `next build`（standalone）→ scp 产物到 ECS → `12-activate-standalone.sh` 切 `current` 软链 + `pm2 reload` + 自检 200（**非 200 自动回滚上一版**）。ECS 全程不编译。

- 看进度：GitHub → **Actions** → `build-and-deploy`。手动触发：Run workflow（`workflow_dispatch`）。
- **不触发部署的改动**：`**/*.md`、`memory/**`、`scripts/**`（workflow 的 `paths-ignore`——改文档/运维脚本不会重部署）。

### 3.2 ⚠ 改了 `db/schema.sql`？CD 不管 schema，手动落库一次

CD 只推代码、**不跑迁移**。新增列/表后，SSH 上 ECS 跑一次（幂等、轻量、不编译、不会 OOM）：

```bash
ssh root@47.103.148.124
cd /opt/fashuo-app && git pull --ff-only      # 取到含新 schema.sql 的版本（CD 已 pull 则 already up to date）
bash deploy/02-postgres-setup.sh              # 应用 schema.sql + migrations + 重授权 + NOTIFY pgrst 重读
```

CD 推代码与这步互不依赖，先后都行；新列缺失时应用侧已设计为优雅降级，不会崩。

### 3.3 烟测（CD 自检已跑过，这里二次确认）

```bash
curl -k -sI https://47.103.148.124:8443/ask | head -3
readlink /opt/fashuo-app/current               # 确认上线版本 → releases/<sha>
```

- 期望 `HTTP/2 307`（鉴权网关跳 /login，证明 app 已起）。
- `502` = standalone server 没起（`pm2 logs fashuo --lines 50`）。
- `Connection refused` = nginx 没起（`systemctl status nginx`）。

然后手机 PWA 打开 `https://47.103.148.124:8443`，登录，问一题验证。

### 3.4 应急：仅当 CD 挂了才在 ECS 本地 build

GitHub Actions 不可用时，用加固版 [deploy/11-redeploy.sh](deploy/11-redeploy.sh)（保 swap + build 前 `pm2 stop` 腾内存 + nice）。**别手敲 `npm run build`**——会复现 OOM。回滚：切 `current` 软链到上一个 `releases/<sha>` 再 `pm2 reload`（见 CD-SETUP.md）。

---

## 4. 查日志/状态

```bash
# 在 ECS 上
pm2 logs fashuo --lines 100      # 应用日志（含答疑 grep 命中、cost、错误堆栈）
pm2 status                       # 进程状态
pm2 restart fashuo               # 改 .env 或确诊内存泄漏后重启
journalctl -u nginx --since "10 min ago"   # nginx 日志
free -h                          # 内存
df -h                            # 磁盘（/tmp 别让 build.log 占满）
```

---

## 5. 成本核算（按需，建议每周一次）

```powershell
cd D:\fashuo-app
npm run cost            # 默认看本月
npm run cost -- 7       # 看最近 7 天

# 或在 ECS 上看也行（用同一份 Supabase）
node --env-file=.env.local scripts/cost-report.mjs | tail -30
```

关注：
- `ask:plan` 这条 route 应远低于 `ask:answer`（规划 Sonnet 4，作答 Opus 4.8）
- 单题答疑均价应在 ¥0.05~0.20 区间，超过 ¥0.30 看是不是 grep 块太大喂太多 token

---

## 6. schema 验证（只在改了 db/schema.sql 后跑）

```powershell
cd D:\fashuo-app
npm run verify-schema
```

会对比 Supabase 实际表结构 vs 本地 `db/schema.sql`，列出 diff。**不会自动迁移**——发现差异手工到 Supabase SQL editor 执行迁移。

---

## 7. 探针脚本（怀疑模型/参数失效时按需用）

```powershell
cd D:\fashuo-app
node --env-file=.env.local scripts/probe-model.mjs claude-sonnet-4-20250514
node --env-file=.env.local scripts/probe-plan.mjs       # 真实题塞规划器，验 JSON 输出
node --env-file=.env.local scripts/probe-effort.mjs     # 探 effort/budget_tokens 参数
node --env-file=.env.local scripts/probe-thinking.mjs   # 答疑 Opus 4.8 + thinking ROI
```

结果会沉淀到 [src/lib/models.ts](src/lib/models.ts) 头部注释，下次免重复探。

---

## 8. 安全边界（别动）

- `D:\fashuo-app\.env.local` **不可 commit**（已在 `.gitignore`），里面有 `LLM_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- ECS 安全组常开**只**: 22 (SSH) + 8443 (HTTPS)；PostgREST(3001)/Postgres(5432) 只 localhost
- 装 iOS CA 时临时开 8888 → 装完**立即删 8888 规则 + Ctrl+C 关 python http.server**
- `APP_PASSWORD` 上线后**不能**留 `change-me`，否则未登录就能进
- 红线 #3：markdown 唯一登记员 = `scripts/register-events.mjs` —— 任何脚本/Agent **不准**直接写 markdown 档案

---

## 9. 常见故障速查

| 症状 | 第一反应 |
|------|---------|
| 答疑"Load failed"（手机蜂窝） | 已修，是心跳流；如再现看 [stream-response.ts](src/lib/stream-response.ts) 心跳间隔 |
| 答疑慢且无字流出 >15s | `pm2 logs fashuo --lines 50` 看是不是规划器 Sonnet 4 渠道挂了（兜底应自动回退 Opus） |
| 答疑证据卡无教材引用 | `npm run sync` 是否跑过；`content_mirror` 表行数 `select count(*) from content_mirror;` |
| 待办筐"收下"按钮没反应 | F12 看 `/api/events/action` 返回；可能 APP_PASSWORD cookie 过期，重登 |
| 部署后 PM2 反复重启 | `pm2 logs --err --lines 100`；常见是 `.env.production` 缺/错变量，或 CD 自检非 200 已回滚（看 Actions 日志 + `readlink /opt/fashuo-app/current`） |
| PM2 内存涨到 800M+ 不降 | `pm2 restart fashuo`；ecosystem 已设 `max_memory_restart=1G` 自动兜底（CD 在云端 build，ECS 不再因 build 吃内存） |
