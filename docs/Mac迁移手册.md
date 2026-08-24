# Windows → macOS 完整迁移手册

<!-- [gpt] 2026-08-23：建立代码、档案、学习台账、密钥与 Codex 资产的局域网直传及可校验迁移流程。 -->

## 1. 迁移原则

- GitHub 保存代码历史，但不能替代 `.local`、`.env.local`、未跟踪教材和未推送提交。
- 默认在 Windows 本机生成私有临时迁移包，再通过两台电脑的受信任局域网端到端传给 Mac；不需要把迁移内容提交到 GitHub。
- 迁移包含真实密钥，临时目录和 SMB 共享只能由本人账户访问；禁止上传公共网盘、提交 Git 或长期开放共享。加密移动硬盘只是没有局域网时的可选备用。
- Windows 与 Mac 不能同时写学习台账。Mac 验收前 Windows 是唯一写端；切换后 Windows 只读保留 30 天。
- `node_modules`、`.next`、coverage 和缓存不迁移，在 Mac 重新生成。
- ECS、PostgreSQL/PostgREST 和 APP 不搬机器，但切换前必须确认云端数据库备份新鲜。

## 2. Windows 侧预检

在 `D:\fashuo-app` 执行：

```powershell
node --version
git status --short --branch
node scripts/backup-memory.mjs --dry-run
npm.cmd run migration:plan
```

`migration:plan` 会读取并计算哈希，范围包括：

- `fashuo-app` 完整工作树（含 `.git`、`.local`、`.env.local`、未提交和未跟踪文件；排除可重建产物）；
- `fashuo` 完整档案仓（含 `.git` 和未跟踪教材）；
- Codex 的 `AGENTS.md`、`config.toml`、`memories`、`rules`、`skills`；明确排除登录令牌、日志、缓存、sandbox，以及可能并发变化的内部 `.git` 对象库（记忆正文仍完整迁移）。

先生成独立清单：

```powershell
npm.cmd run migration:snapshot
```

清单默认写入 `.local/migration/manifest-*.json`，仅含路径、大小和 SHA-256，不含密钥值。

## 3. 创建 Windows 本机临时迁移包

先在三个源目录之外准备一个全新的空目录。默认使用 Windows 本机 `D:\fashuo-migration-2026-08-23`；磁盘可用空间至少应比 `migration:plan` 显示的总量多 1 GiB：

```powershell
node scripts/migration-audit.mjs bundle `
  --destination D:\fashuo-migration-2026-08-23 `
  --acknowledge-secrets
```

`--acknowledge-secrets` 表示确认目标目录由本人控制且不会公开共享，不表示目录已自动加密。脚本有三道保护：目标不得位于任一源目录内、目标必须为空、复制完成后必须逐文件通过 SHA-256 复验。迁移包结构为：

```text
fashuo-migration-2026-08-23/
  app/                 # 应用工作树与本地台账、密钥
  archive/             # 教材/真题档案与 Git 历史
  codex/               # 允许迁移的 Codex 规则、配置、记忆和 Skills
  migration-manifest.json
```

不要直接共享正在使用的 `D:\fashuo-app` 或 `D:\fashuo`。固定迁移包能保证 Mac 收到的文件与同一份 SHA-256 清单对应。正式换机当天，在停止 Windows 端学习记录和项目写入后重新生成一次；之前生成的包只能作为演练副本。

## 4. 通过局域网直传 Mac

1. Windows 与 Mac 连接同一受信任路由器，优先使用有线网络或 5 GHz/6 GHz Wi-Fi。
2. 在 Windows 中只共享 `D:\fashuo-migration-2026-08-23`，给本人 Windows 账户只读权限；不要给 `Everyone` 写权限。
3. 在 Windows 运行 `ipconfig`，记下当前局域网 IPv4 地址。
4. 在 Mac Finder 选择“前往 → 连接服务器”，输入 `smb://<Windows局域网IPv4>`，使用本人 Windows 账户登录。
5. 将整个迁移包复制到 Mac 私有临时目录，例如 `~/Downloads/fashuo-migration-2026-08-23`。不要从 SMB 共享目录直接运行项目。
6. Mac 校验完成后关闭 Windows 共享；正式切换并观察稳定后，再删除两端临时迁移包。

如果路由器不受信任、两台电脑无法互访，才改用加密移动硬盘或两机直连网线。

连续性 Git 灾备另行预演：

```powershell
node scripts/backup-memory.mjs --dry-run
```

实际执行会复制、提交并推送档案仓，属于外部操作；执行前必须先检查 `D:\fashuo` 的暂存区和未跟踪教材，不能把迁移准备提交与用户资料混成一个提交。

## 5. Mac 侧目录与环境

建议目录：

```text
/Users/<用户名>/Projects/fashuo-app
/Users/<用户名>/Documents/fashuo
```

先安装 Xcode Command Line Tools、Git、与 Windows 一致的 Node 主版本。不要复制 Windows 的 `node_modules`。先验证 Mac 收到的临时迁移包没有因网络复制损坏：

```zsh
cd /Users/<用户名>/Downloads/fashuo-migration-2026-08-23/app
node scripts/migration-audit.mjs verify \
  --manifest ../migration-manifest.json \
  --bundle-root ..
```

通过后再恢复到全新空目录；`ditto` 会连同隐藏的 `.git`、`.local` 和 `.env.local` 一起复制：

```zsh
mkdir -p /Users/<用户名>/Projects/fashuo-app
mkdir -p /Users/<用户名>/Documents/fashuo
ditto /Users/<用户名>/Downloads/fashuo-migration-2026-08-23/app /Users/<用户名>/Projects/fashuo-app
ditto /Users/<用户名>/Downloads/fashuo-migration-2026-08-23/archive /Users/<用户名>/Documents/fashuo
```

## 6. Codex 恢复边界

1. 在 Mac 重新安装桌面应用/CLI并重新登录，禁止复制 Windows `auth.json`。
2. 先关闭 Codex，再把迁移包 `codex/` 合并到 `~/.codex/`；迁移清单已经排除登录令牌、日志、缓存和运行状态：

   ```zsh
   mkdir -p /Users/<用户名>/.codex
   ditto /Users/<用户名>/Downloads/fashuo-migration-2026-08-23/codex /Users/<用户名>/.codex
   ```

3. 完成下一节的恢复后 SHA-256 复验前，不要修改 `~/.codex/config.toml`；复验后再逐项替换其中的 Windows 路径。
4. 打开 `fashuo-app` 后将项目设为可信，确认仓库根 `AGENTS.md`、`.agents/skills` 和项目 `.codex` 配置已加载。[官方 OpenAI 配置文档](https://learn.chatgpt.com/docs/config-file/config-basic)规定用户配置位于 `~/.codex/config.toml`，项目配置可位于仓库 `.codex/config.toml`；[AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)说明仓库指令会按目录层级发现。

## 7. Mac 恢复后复验

```zsh
cd /Users/<用户名>/Projects/fashuo-app

node scripts/migration-audit.mjs verify \
  --manifest /Users/<用户名>/Downloads/fashuo-migration-2026-08-23/migration-manifest.json \
  --app-root /Users/<用户名>/Projects/fashuo-app \
  --archive-root /Users/<用户名>/Documents/fashuo \
  --codex-home /Users/<用户名>/.codex
```

复验通过后，再把 `.env.local` 中的根目录设置为：

```dotenv
FASHUO_APP_ROOT=/Users/<用户名>/Projects/fashuo-app
FASHUO_ARCHIVE_ROOT=/Users/<用户名>/Documents/fashuo
```

旧 `ARCHIVE_DIR` 仍兼容，但新机器统一使用 `FASHUO_ARCHIVE_ROOT`。如果 Supabase 走 ECS 8443 自签证书，在启动 Node 前设置：

```zsh
export NODE_OPTIONS='--import=file:///Users/<用户名>/Projects/fashuo-app/scripts/lib/trust-fashuo-ca.mjs'
```

不能依赖 `.env.local` 内的 `NODE_OPTIONS`，因为 Node 在读取 `--env-file` 之前就决定预加载模块；也不能关闭 TLS 校验。然后重新打开终端，执行项目验证：

```zsh

npm ci
npm test
npm run lint
npm run build
node scripts/backup-memory.mjs --dry-run
node --env-file=.env.local scripts/verify-schema.mjs
node --env-file=.env.local scripts/data-health.mjs
node --env-file=.env.local scripts/coach.mjs ledger
npm run skill:check
```

只有 SHA-256 全通过、两仓 Git 状态核对完成、真实账本可读、APP/数据库链路正常、备份 dry-run 正常后，才把 Mac 切为唯一写端。

## 8. 仍需人工授权的动作

- 整理并提交 `fashuo-app` 当前未提交改动；
- 合并本地与远端分叉提交并推送；
- 推送 `fashuo-archive` 的本地领先提交；
- 决定未跟踪 PDF 是否进入 Git LFS；
- 新建 GitHub/ECS SSH 密钥、修改服务器授权；
- 在 Mac 建立 `launchd` 22:30 连续性备份任务；
- 正式切换唯一写端并停用 Windows 计划任务。
