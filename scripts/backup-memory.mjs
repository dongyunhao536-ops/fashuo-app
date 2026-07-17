// node scripts/backup-memory.mjs
// 灾备：把换 harness/换机时会丢的资产备份进 fashuo-archive git 仓（两个源）：
//   ① Claude Code 记忆目录（云的能力画像/弱点模式/项目决策）→ Claude记忆备份/
//      记忆目录在 ~/.claude/ 下、不在任何 git 仓里。见 docs/备用方案启动手册.md。
//   ② fashuo-app/.local PC 工作区（带背挂账/评估报告/周报草稿/英语真题库）→ PC工作区备份/
//      .local 被 .gitignore 排除、此前不在任何备份链里（2026-07-17 反思补上的灾备空窗）。
//      排除 英语真题/_raw（29MB 原始 PDF，静态资产，别灌进 git）。
// 触发：Windows 计划任务 ClaudeMemoryBackup 每日 22:30 + 大段写记忆后手动跑。
// 不污染同步链：content_mirror 只按 config/mirror-scope.json 白名单同步，这两个目录不在白名单。
import { execFileSync } from "node:child_process";
import { rmSync, cpSync, existsSync } from "node:fs";

const REPO = "D:/fashuo";
const JOBS = [
  { src: "C:/Users/Administrator/.claude/projects/D--fashuo-app/memory", dest: "Claude记忆备份" },
  { src: "D:/fashuo-app/.local", dest: "PC工作区备份", exclude: /[\\/]_raw$/ },
];

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

let copied = 0;
for (const { src, dest, exclude } of JOBS) {
  if (!existsSync(src)) {
    console.error(`源目录不存在，跳过: ${src}`);
    continue;
  }
  // 镜像式覆盖：先删后拷，源里删掉的文件在备份里也消失（git 历史仍可找回）
  rmSync(`${REPO}/${dest}`, { recursive: true, force: true });
  cpSync(src, `${REPO}/${dest}`, {
    recursive: true,
    filter: exclude ? (p) => !exclude.test(p) : undefined,
  });
  git("add", "-A", "--", dest);
  copied++;
}
if (!copied) {
  console.error("所有源目录都不存在，未备份任何内容。");
  process.exit(1);
}

const staged = git("diff", "--cached", "--name-only");
if (!staged) {
  console.log("记忆/PC工作区无变化，跳过提交。");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
git("commit", "-m", `Claude记忆+PC工作区自动备份 ${today}`);
try {
  git("push", "origin", "master");
  console.log(`已备份并推送 ${staged.split("\n").length} 个文件:\n${staged}`);
} catch (e) {
  // 推送失败（断网/SSH 问题）不致命：本地已提交，下次推送会带上
  console.error(`本地已提交但推送失败（下次运行会重推）: ${e.message}`);
  process.exit(2);
}
