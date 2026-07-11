// node scripts/backup-memory.mjs
// 灾备：把 Claude Code 的记忆目录（云的能力画像/弱点模式/项目决策）备份进 fashuo-archive git 仓。
// 为什么：记忆目录在 ~/.claude/ 下、不在任何 git 仓里，是换 harness（Codex/OpenCode/网页版）时
// 唯一会丢的资产（skills/scripts 都已在 fashuo-app 仓内）。见 docs/备用方案启动手册.md。
// 触发：Windows 计划任务 ClaudeMemoryBackup 每日 22:30 + 大段写记忆后手动跑。
// 不污染同步链：content_mirror 只按 config/mirror-scope.json 白名单同步，本目录不在白名单。
import { execFileSync } from "node:child_process";
import { rmSync, cpSync, existsSync } from "node:fs";

const SRC = "C:/Users/Administrator/.claude/projects/D--fashuo-app/memory";
const REPO = "D:/fashuo";
const DEST_NAME = "Claude记忆备份";
const DEST = `${REPO}/${DEST_NAME}`;

if (!existsSync(SRC)) {
  console.error(`记忆目录不存在: ${SRC}`);
  process.exit(1);
}

// 镜像式覆盖：先删后拷，源里删掉的记忆在备份里也消失（git 历史仍可找回）
rmSync(DEST, { recursive: true, force: true });
cpSync(SRC, DEST, { recursive: true });

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

git("add", "-A", "--", DEST_NAME);
const staged = git("diff", "--cached", "--name-only");
if (!staged) {
  console.log("记忆无变化，跳过提交。");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
git("commit", "-m", `Claude记忆自动备份 ${today}`);
try {
  git("push", "origin", "master");
  console.log(`已备份并推送 ${staged.split("\n").length} 个文件:\n${staged}`);
} catch (e) {
  // 推送失败（断网/SSH 问题）不致命：本地已提交，下次推送会带上
  console.error(`本地已提交但推送失败（下次运行会重推）: ${e.message}`);
  process.exit(2);
}
