# 云端构建 + 自动部署（CD）一次性配置

**为什么**：ECS 2核2G 裸跑 `next build` 会 OOM 抖死全机（连 SSH/网站都没响应，2026-06-13 实测两次）。
改为 **GitHub Actions 在云端编译 standalone 产物 → scp 推到 ECS → 激活**，ECS 彻底不参与编译。

```
push main ─▶ GitHub runner: npm ci + next build(standalone) ─▶ tar ─▶ scp 到 ECS:/tmp
          ─▶ ssh ECS: git pull(仅 ops 文件) + 12-activate-standalone.sh
                       └─ 解包 releases/<sha> ─▶ 切 current 软链 ─▶ pm2 reload ─▶ 自检(200?) ─▶ 留最近3版
```

工作流：[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)。运行时入口：standalone 的 `server.js`，由 [ecosystem.config.cjs](ecosystem.config.cjs) 拉起（手动读 `.env.production` 注入 env，因为 server.js 不像 `next start` 那样自动加载）。

---

## 一次性要做的 3 件事

### 1. 生成 CI 部署密钥，公钥加到 ECS

PC 上（已生成则跳过）：
```bash
ssh-keygen -t ed25519 -f ~/.ssh/fashuo-ci -N "" -C github-actions-fashuo
```
ECS 上（root）把**公钥**加进信任：
```bash
cat >> /root/.ssh/authorized_keys   # 粘贴 ~/.ssh/fashuo-ci.pub 的内容，回车后 Ctrl+D
```

### 2. GitHub 仓库 Secrets（Settings → Secrets and variables → Actions → New repository secret）

| Secret | 值 |
|--------|----|
| `ECS_HOST` | `47.103.148.124` |
| `ECS_USER` | `root` |
| `ECS_SSH_KEY` | `~/.ssh/fashuo-ci` **私钥**全文（`cat ~/.ssh/fashuo-ci`，含 BEGIN/END 行） |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://47.103.148.124:8443`（与 .env.production 同值） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | .env.production 里的 anon JWT |

> 只有 `NEXT_PUBLIC_*` 进 build（会内联进客户端 bundle，本就公开）。
> SERVICE_ROLE / LLM_API_KEY / APP_PASSWORD 等**服务端密钥不进 CI**——它们在 ECS 的 `.env.production` 里，运行时由 ecosystem 注入。

### 3. ECS 准备（root，一次）

```bash
mkdir -p /opt/fashuo-app/releases
# 确认 git 工作区干净，能 ff 拉取（CD 会 git pull 仅取 ops 文件，不编译）
cd /opt/fashuo-app && git fetch && git status
```

安全组：22 端口已对外开放（key-only 登录），GitHub runner 直接 SSH 即可，**无需改安全组**。

---

## 日常使用

- **改完代码 → `git push` 到 main，自动构建+部署**，去 GitHub → Actions 看进度/日志。
- 想手动触发：Actions → build-and-deploy → Run workflow。
- 不触发部署的改动：`*.md`、`memory/**`（见 workflow 的 `paths-ignore`）。

## 回滚

激活脚本自检非 200 会**自动回滚**到上一版。手动回滚：
```bash
cd /opt/fashuo-app
ls -1dt releases/*/        # 看历史版本（留最近 3）
ln -sfn releases/<上一个sha> current
pm2 reload deploy/ecosystem.config.cjs --update-env
```

## 应急（CD 不可用时）的旧路子

`deploy/11-redeploy.sh` 仍在——在 ECS 本地编译（已加固：保 swap + build 前停 app + nice）。仅当 GitHub Actions 挂了才用。
