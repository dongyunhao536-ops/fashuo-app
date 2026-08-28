// [claude] 2026-08-25：Skill 层 `[[记忆名]]` 引用的扫描与校验。
//
// 原先这条契约写死在 skill-contract.test.mjs 里，指向迁 macOS 前的
// `D:/fashuo/Claude记忆备份/`，且只扫六个 SKILL.md——而 SKILL.md 一个引用都没有，
// 循环体从不执行，测试常年"因为空转而通过"。引用实际全在参考层
// （完整运行参考.md / beisong-blueprint.md / xingfa-fenze-list.md 等）。
// 抽成模块是为了让"扫描"和"判悬空"两步都能被测试直接喂假数据验证。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "./observability-paths.mjs";
import { resolveAppRoot, resolveClaudeMemoryRoot } from "./workspace-paths.mjs";

// 单行内的 `[[名字]]`；名字不含方括号与换行，排除 `[[]]` 这种空引用。
const MEMORY_REF_RE = /\[\[([^[\]\n]+)\]\]/gu;

function markdownFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

/**
 * 递归扫描 Skill 目录树里的全部 `[[记忆名]]`。
 * @returns {Map<string, string[]>} 记忆名 → 出现该引用的文件（相对 root，POSIX 分隔符，已排序）
 */
export function collectMemoryRefs(root) {
  const index = new Map();
  for (const file of markdownFiles(root).sort()) {
    const where = relative(root, file).replaceAll("\\", "/");
    for (const match of readFileSync(file, "utf8").matchAll(MEMORY_REF_RE)) {
      const ref = match[1].trim();
      if (!ref) continue;
      const seen = index.get(ref) ?? [];
      if (!seen.includes(where)) seen.push(where);
      index.set(ref, seen);
    }
  }
  return index;
}

/**
 * 在给定记忆根下找不到 `<记忆名>.md` 的引用。
 * @returns {string[]} 悬空引用，已排序；全部命中时为空数组
 */
export function findDanglingMemoryRefs(refs, memoryRoot) {
  return [...refs]
    .filter((ref) => !existsSync(join(memoryRoot, `${ref}.md`)))
    .sort();
}

/**
 * `[[记忆名]]` 的现役解析根（AGENTS.md 口径）：
 * `~/.claude/projects/<项目路径键>/memory/`。
 *
 * 这里刻意不用 `resolveAppRoot()` 的默认值：在 git worktree 里跑时，模块位置会推出
 * worktree 自己的项目键（实测 `-Users-dyh-Projects-fashuo-app--claude-worktrees-<名>`），
 * 那个键下没有 memory 目录，校验会整体落空。引用是全项目共享的一个命名空间，
 * 因此先用 `findRepositoryRoot()` 折回主仓库根，worktree 与主树才会指向同一份记忆。
 */
export function resolveSkillMemoryRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const appRoot = findRepositoryRoot(fileURLToPath(moduleUrl)) ?? resolveAppRoot({ env });
  return resolveClaudeMemoryRoot({ env, appRoot });
}
