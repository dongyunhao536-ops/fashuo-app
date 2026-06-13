// node --env-file=.env.local scripts/register-full.mjs
//
// 一条龙：登记员 → 镜像同步 → 档案 git commit。
//   1. register-events.mjs  把 events.confirmed → D:\fashuo 下的 md（红线 #3 唯一去重处）。
//   2. sync-content.mjs     把档案 md 全量同步进 content_mirror（grep 镜像表）。
//   3. 档案 git commit      记录这一批新写入；不是 git 仓库则跳过。
//
// 任一步失败立刻中止——后续步骤可能依赖前一步的产物，跑半截更糟。
// 演练（不写文件、不进库）请直接：npm run register -- --dry-run

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ARCHIVE = process.env.ARCHIVE_DIR || path.resolve(process.cwd(), "..", "fashuo");

function run(label, cmd, args, opts = {}) {
  console.log(`\n━━━━ ${label} ━━━━`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${r.status}），中止流水线`);
    process.exit(r.status ?? 1);
  }
}

// 1) events.confirmed → md
run("登记 events → 档案 md", process.execPath, [
  "--env-file=.env.local",
  "scripts/register-events.mjs",
]);

// 2) md → content_mirror（grep 走的是镜像表，不同步等于答疑搜不到新沉淀）
run("同步档案 md → content_mirror", process.execPath, [
  "--env-file=.env.local",
  "scripts/sync-content.mjs",
]);

// 3) 档案 git commit（仓库存在才提交）
console.log(`\n━━━━ git commit 档案改动 ━━━━`);
if (!existsSync(path.join(ARCHIVE, ".git"))) {
  console.log(`↷ ${ARCHIVE} 不是 git 仓库，跳过 commit。`);
  console.log(`  如想启用追溯：cd ${ARCHIVE}; git init; git add .; git commit -m "init archive"`);
  process.exit(0);
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: ARCHIVE, encoding: "utf8" });
if (status.status !== 0) {
  console.error(`✗ git status 失败：${status.stderr}`);
  process.exit(status.status ?? 1);
}
if (!status.stdout.trim()) {
  console.log("档案无改动（register 可能命中已有行只做 dry 修改/或本轮无新 confirmed），跳过 commit。");
  process.exit(0);
}
console.log(status.stdout);

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace("T", " ");
const msg = `档案登记 ${stamp}（register-full）`;

// 只 add register 会动到的两个子目录，避免误 add 临时文件
run("git add", "git", ["add", "薄弱知识点", "真题分析"], { cwd: ARCHIVE });
run("git commit", "git", ["commit", "-m", msg], { cwd: ARCHIVE });

console.log(`\n✓ 全流程完成（登记 + 镜像同步 + 档案提交）。`);
