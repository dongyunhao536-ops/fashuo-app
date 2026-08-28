#!/usr/bin/env node
// [claude] 2026-08-25：对真实现役 Claude 入口跑路由契约审计，fail-closed。
// 与 `npm test` 里的 fixture 测试分开：那边保证判定逻辑可移植、CI 能跑；
// 这边保证本机现役目录真的合规。目录不存在即退出码 1，不静默通过。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { auditLiveSkillEntries, CLAUDE_SKILL_NAMES, formatViolations } from "./lib/claude-live-skills.mjs";
import { resolveClaudeSkillsRoot } from "./lib/workspace-paths.mjs";

// [claude] 2026-08-25：静态规则查不出"这条命令到底跑不跑得起来"。
// 事故：26 处续行写成了双反斜杠，命令全不可运行，而当时的静态检查照样报绿。
// 这里把每个 ```bash 块交给真实 `bash -n` 做语法检查——占位符先替成实值，
// 否则 <科目> 会被 bash 当成重定向。这是可观察行为，不是措辞匹配。
function shellSyntaxViolations(root) {
  const out = [];
  for (const name of CLAUDE_SKILL_NAMES) {
    const file = join(root, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const blocks = String(readFileSync(file, "utf8")).match(/```bash\n[\s\S]*?```/gu) ?? [];
    blocks.forEach((block, index) => {
      const script = block.replace(/```bash\n/u, "").replace(/```$/u, "")
        .replace(/<[^>\n]+>/gu, "PLACEHOLDER")
        .replace(/\[[^\]\n]+\]/gu, "PLACEHOLDER");
      try {
        execFileSync("bash", ["-n"], { input: script, stdio: ["pipe", "ignore", "pipe"] });
      } catch (error) {
        const message = String(error.stderr ?? error.message).trim().split("\n")[0];
        out.push({ code: "shell_block_unrunnable", skill: name, detail: `第 ${index + 1} 个命令块 bash -n 失败：${message}`, line: null });
      }
    });
  }
  return out;
}

export function main() {
  const root = resolveClaudeSkillsRoot();
  const violations = auditLiveSkillEntries({ root });
  if (existsSync(root)) violations.push(...shellSyntaxViolations(root));
  console.log(`现役 Claude 入口根目录：${root}`);
  console.log(formatViolations(violations));
  if (violations.length) {
    console.error(`\n✗ ${violations.length} 项不合规。修复现役入口后重跑；跨机运行请设 FASHUO_CLAUDE_SKILLS_ROOT。`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
