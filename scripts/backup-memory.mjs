#!/usr/bin/env node
// [gpt] 2026-08-23：跨平台连续性备份；支持 Windows/macOS、dry-run 与不推送模式。
// [gpt] 2026-08-24：Claude 当前项目记忆改为必需源，并对空源与复制完整性 fail-closed。
//
// 默认仍保持既有定时任务语义：复制 → 精确暂存 → commit → push 当前分支。
// 迁移预检：node scripts/backup-memory.mjs --dry-run
// 本地留档但不推送：node scripts/backup-memory.mjs --no-push
//
// 注意：.env.local 与 _raw 原始 PDF 不进入 Git 灾备；它们应进入私有迁移包，通过受信任局域网或加密介质转移。
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolveAppRoot,
  resolveArchiveRoot,
  resolveClaudeHooksRoot,
  resolveClaudeSkillsRoot,
  resolveCodexHome,
  resolveLegacyMemoryRoot,
} from "./lib/workspace-paths.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const noPush = args.has("--no-push");
const help = args.has("--help") || args.has("-h");
const knownArgs = new Set(["--dry-run", "--no-push", "--help", "-h"]);
const unknownArgs = [...args].filter((argument) => !knownArgs.has(argument));

if (help) {
  console.log([
    "用法：node scripts/backup-memory.mjs [--dry-run] [--no-push]",
    "",
    "  --dry-run  只验证根目录、备份源和必需档案，不复制、不提交、不推送",
    "  --no-push  正常复制并提交，但不推送远端",
  ].join("\n"));
  process.exit(0);
}
if (unknownArgs.length) {
  console.error(`未知参数：${unknownArgs.join(", ")}`);
  process.exit(1);
}

const APP_ROOT = resolveAppRoot();
const REPO = resolveArchiveRoot({ appRoot: APP_ROOT });
const CODEX_HOME = resolveCodexHome();
const LEGACY_MEMORY_ROOT = resolveLegacyMemoryRoot();
const CLAUDE_SKILLS_ROOT = resolveClaudeSkillsRoot();
const CLAUDE_HOOKS_ROOT = resolveClaudeHooksRoot();
const RAW_DIR_RE = /(?:^|[\\/])_raw(?:[\\/]|$)/u;
const GIT_DIR_RE = /(?:^|[\\/])\.git(?:[\\/]|$)/u;

const JOBS = [
  {
    label: "Claude 项目记忆",
    src: LEGACY_MEMORY_ROOT,
    dest: "Claude记忆备份",
  },
  // [gpt] 2026-08-25：九个 Claude 现役入口只存在于用户目录；缺失或为空必须 fail-closed。
  {
    label: "Claude 现役 Skills",
    src: CLAUDE_SKILLS_ROOT,
    dest: "Claude现役Skills备份",
  },
  // [claude] 2026-08-25：Claude 宿主守卫 handler 是生产件（本机已在 enforce 档运行），
  // 却既不在 Git 也不在灾备链，丢了无从恢复。只白名单 fashuo-*.mjs——同目录下的
  // 其他 hook 与任何 settings 都不进档案，后者含权限与代理配置。
  {
    label: "Claude 现役 Hooks",
    src: CLAUDE_HOOKS_ROOT,
    dest: "Claude现役Hooks备份",
    include: /^fashuo-.*\.mjs$/u,
  },
  {
    label: "Codex 现役 Skills",
    src: join(APP_ROOT, ".agents"),
    dest: "Codex规则备份",
  },
  {
    label: "Codex 项目配置",
    src: join(APP_ROOT, ".codex"),
    dest: "Codex项目配置备份/.codex",
  },
  {
    label: "项目 AGENTS.md",
    src: join(APP_ROOT, "AGENTS.md"),
    dest: "Codex项目配置备份/AGENTS.md",
  },
  {
    label: "Codex 现役记忆",
    src: join(CODEX_HOME, "memories"),
    dest: "Codex记忆备份",
    exclude: GIT_DIR_RE,
  },
  {
    label: "PC 工作区",
    src: join(APP_ROOT, ".local"),
    dest: "PC工作区备份",
    exclude: RAW_DIR_RE,
  },
];

const REQUIRED_ARCHIVE_ASSETS = [
  "教材/带背/_文本/法理学_带背_文本.txt",
  "教材/带背/_文本/法制史_带背_文本.txt",
  "教材/带背/_文本/刑法_带背_文本.txt",
];

function assertInsideArchive(target) {
  const absolute = resolve(target);
  const rel = relative(REPO, absolute);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`备份目标越界：${absolute}`);
  }
  return absolute;
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: REPO, encoding: "utf8" }).trim();
}

// [claude] 2026-08-25：include 是文件名白名单，只用于 Hook 这类"同目录下混着
// 无关或含敏感配置的文件、只能挑指定几个走灾备"的源；目录本身不受白名单限制，
// 否则递归进不去。exclude 仍按整路径匹配，两者可叠加。
function inventory(root, exclude = null, include = null) {
  const items = [];
  function visit(current, relativePath = "") {
    if (exclude?.test(current)) return;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      if (include && !include.test(basename(current))) return;
      items.push({ path: relativePath || ".", kind: "symlink", size: stats.size });
      return;
    }
    if (!stats.isDirectory()) {
      if (include && !include.test(basename(current))) return;
      items.push({ path: relativePath || ".", kind: "file", size: stats.size });
      return;
    }
    for (const name of readdirSync(current).sort()) {
      visit(join(current, name), relativePath ? join(relativePath, name) : name);
    }
  }
  visit(root);
  return items;
}

function assertNonEmptySource(job) {
  const items = inventory(job.src, job.exclude, job.include);
  if (!items.length) {
    const scope = job.include ? `，白名单 ${job.include.source} 未匹配到任何文件` : "";
    throw new Error(`${job.label}源为空，拒绝把空目录当成可用备份：${job.src}${scope}`);
  }
  return items;
}

function copyAtomically(job) {
  const destination = assertInsideArchive(join(REPO, job.dest));
  const staging = assertInsideArchive(`${destination}.next-${process.pid}`);
  const sourceInventory = assertNonEmptySource(job);
  mkdirSync(dirname(staging), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(job.src, staging, {
    recursive: statSync(job.src).isDirectory(),
    filter: job.exclude || job.include
      ? (source) => {
        if (job.exclude?.test(source)) return false;
        if (!job.include) return true;
        // 目录一律放行，否则递归到不了里面的白名单文件；筛选只作用于叶子。
        return lstatSync(source).isDirectory() || job.include.test(basename(source));
      }
      : undefined,
  });
  const stagingInventory = inventory(staging, null, job.include);
  if (JSON.stringify(stagingInventory) !== JSON.stringify(sourceInventory)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${job.label}复制完整性校验失败；保留上一版备份，拒绝替换`);
  }
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
}

if (!existsSync(REPO)) {
  console.error(`档案根不存在：${REPO}`);
  process.exit(1);
}
if (!existsSync(join(REPO, ".git"))) {
  console.error(`档案根不是 Git 仓库：${REPO}`);
  process.exit(1);
}

const missingRequiredAssets = REQUIRED_ARCHIVE_ASSETS.filter((asset) => !existsSync(join(REPO, asset)));
if (missingRequiredAssets.length) {
  console.error(`必需档案资产缺失，拒绝备份：\n${missingRequiredAssets.map((asset) => `- ${asset}`).join("\n")}`);
  process.exit(1);
}

const availableJobs = [];
const sourceCounts = new Map();
for (const job of JOBS) {
  if (!existsSync(job.src)) {
    const message = `${job.label}源不存在：${job.src}`;
    console.error(message);
    process.exitCode = 1;
    continue;
  }
  try {
    sourceCounts.set(job.label, assertNonEmptySource(job).length);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    continue;
  }
  availableJobs.push(job);
}
if (process.exitCode) process.exit(process.exitCode);

console.log(`应用根：${APP_ROOT}`);
console.log(`档案根：${REPO}`);
console.log(`Codex 根：${CODEX_HOME}`);
console.log(`Claude Skills 根：${CLAUDE_SKILLS_ROOT}`);
console.log(`Claude Hooks 根：${CLAUDE_HOOKS_ROOT}`);
for (const job of availableJobs) {
  console.log(`- ${job.label}: ${job.src} → ${job.dest}（${sourceCounts.get(job.label)} 个文件）`);
}

if (dryRun) {
  console.log(`✓ dry-run 通过：全部 ${JOBS.length} 个必需备份源均存在且非空，${REQUIRED_ARCHIVE_ASSETS.length} 个必需档案均可用；未写文件、未执行 Git。`);
  process.exit(0);
}

const preexistingStaged = git("diff", "--cached", "--name-only");
if (preexistingStaged) {
  console.error(`档案仓已有暂存改动，拒绝混入自动备份提交：\n${preexistingStaged}`);
  process.exit(1);
}

for (const job of availableJobs) copyAtomically(job);

const stagedPaths = [...new Set([
  ...availableJobs.map((job) => job.dest),
  ...REQUIRED_ARCHIVE_ASSETS,
])];
git("add", "-A", "--", ...stagedPaths);

const staged = git("diff", "--cached", "--name-only");
if (!staged) {
  console.log("连续性资产无变化，跳过提交。");
  process.exit(0);
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
git("commit", "-m", `[gpt] 跨平台连续性资产自动备份 ${today}`);

if (noPush) {
  console.log(`✓ 已提交 ${staged.split(/\r?\n/u).length} 个文件，按 --no-push 未推送。`);
  process.exit(0);
}

const branch = git("branch", "--show-current");
if (!branch) {
  console.error("当前处于 detached HEAD，已提交但拒绝自动推送。");
  process.exit(2);
}
try {
  git("push", "origin", branch);
  console.log(`✓ 已备份并推送 ${staged.split(/\r?\n/u).length} 个文件到 origin/${branch}。`);
} catch (error) {
  console.error(`本地已提交但推送失败（下次运行会重推）：${error.message}`);
  process.exit(2);
}
