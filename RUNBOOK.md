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

⚠ **服务器只有 2G 内存**，build 容易 OOM。务必照流程走。

### 3.1 PC 侧：提交代码

```powershell
cd D:\fashuo-app
git status
git add <改动的文件>
git commit -m "改动说明"
git push origin main
```

### 3.2 SSH 上 ECS

```bash
ssh root@47.103.148.124
# 或用阿里云 Workbench 网页 SSH（不容易掉线）
cd /opt/fashuo-app
git pull
```

### 3.3 后台 build（关键：必须 nohup）

```bash
nohup env NODE_OPTIONS="--max-old-space-size=1536" npm run build > /tmp/build.log 2>&1 &
tail -f /tmp/build.log
```

- ⚠ **不能前台跑 `npm run build`**：SSH/Workbench 一掉线就 SIGHUP 杀进程，看起来像 OOM 其实是掉线
- `--max-old-space-size=1536` 限制 Node 堆，给系统留 500M 防 OOM kill
- 等到 `tail -f` 看到 `✓ Compiled successfully` / `Build completed` 再 Ctrl+C

### 3.4 重启 PM2

```bash
pm2 stop fashuo
free -h                       # 看下内存，<200M 可用就先 pm2 delete fashuo 再 start
pm2 start ecosystem.config.js # 或 pm2 start fashuo（已经在 pm2 list 里时）
pm2 status                    # 应看到 online，pid 有值
```

### 3.5 烟测

```bash
curl -sI https://localhost:8443/ask -k | head -3
```

- 期望 `HTTP/2 307`（auth 中间件跳转到 /login，证明 Next.js 已起）
- `HTTP/2 502` = 上游 Next.js 没起（看 `pm2 logs fashuo --lines 50`）
- `Connection refused` = nginx 没起（`systemctl status nginx`）

然后手机 PWA 打开 `https://47.103.148.124:8443`，登录，问一题验证。

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
| 部署后 PM2 反复重启 | `pm2 logs --err --lines 100`；常见是 `.env.local` 没在 ECS 上更新 |
| PM2 内存涨到 800M+ 不降 | `pm2 restart fashuo`；下次 build 前先 `pm2 stop` 腾内存 |
