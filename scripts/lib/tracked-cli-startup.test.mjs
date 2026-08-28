// [gpt] 2026-08-26：从 git ls-files 构造共享 CLI 的干净依赖闭包，防止“本机有未跟踪文件所以能跑”的假通过。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRYPOINTS = [
  { entrypoint: "scripts/skill-run.mjs", expectedStdout: "用法：" },
  { entrypoint: "scripts/judgment-result.mjs", expectedStdout: "用法：" },
  // [gpt] 2026-08-26：双宿主 handler 也是共享入口；Claude 使用 repo-root 动态 import，
  // 干净副本必须显式收集该闭包并真实跑一次 UserPromptSubmit。
  { entrypoint: "scripts/codex-skill-guard.mjs", expectedStdout: "{}", hook: "codex" },
  { entrypoint: "scripts/claude-skill-guard.mjs", expectedStdout: "{}", hook: "claude" },
];
const snapshots = [];

function repositoryPath(value) {
  return normalize(value).split(sep).join("/");
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`TRACKED_DEPENDENCY_AUDIT_ERROR|git ls-files failed|${result.stderr.trim()}`);
  }
  return new Set(result.stdout.split("\0").filter(Boolean));
}

function staticRelativeImports(source) {
  const imports = new Set();
  const fromPattern = /\b(?:import|export)\s+[^;]*?\bfrom\s*["'](\.[^"']+)["']/gsu;
  const sideEffectPattern = /\bimport\s*["'](\.[^"']+)["']/gu;
  for (const pattern of [fromPattern, sideEffectPattern]) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}

function repoRootDynamicImports(source) {
  return [...source.matchAll(/\blib\(["']([^"']+)["']\)/gu)]
    .map((match) => repositoryPath(join("scripts", match[1])));
}

function resolveTrackedImport(importer, specifier, tracked) {
  const unresolved = repositoryPath(join(dirname(importer), specifier));
  const candidates = extname(unresolved)
    ? [unresolved]
    : [`${unresolved}.mjs`, `${unresolved}.js`, join(unresolved, "index.mjs"), join(unresolved, "index.js")]
      .map(repositoryPath);
  const found = candidates.find((candidate) => tracked.has(candidate));
  if (!found) {
    throw new Error([
      "TRACKED_DEPENDENCY_MISSING",
      `importer=${importer}`,
      `specifier=${specifier}`,
      `candidates=${candidates.join(",")}`,
      "required=git ls-files must contain the complete static import closure",
    ].join("|"));
  }
  return found;
}

function collectTrackedClosure(entrypoint, tracked) {
  if (!tracked.has(entrypoint)) {
    throw new Error(`TRACKED_ENTRYPOINT_MISSING|entry=${entrypoint}|required=git ls-files`);
  }
  const pending = [entrypoint];
  const closure = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (closure.has(current)) continue;
    closure.add(current);
    const source = readFileSync(join(APP_ROOT, current), "utf8");
    for (const specifier of staticRelativeImports(source)) {
      const dependency = resolveTrackedImport(current, specifier, tracked);
      if (!closure.has(dependency)) pending.push(dependency);
    }
    for (const dependency of repoRootDynamicImports(source)) {
      if (!tracked.has(dependency)) {
        throw new Error(`TRACKED_DYNAMIC_DEPENDENCY_MISSING|importer=${current}|dependency=${dependency}|required=git ls-files`);
      }
      if (!closure.has(dependency)) pending.push(dependency);
    }
  }
  return [...closure].sort();
}

function copyClosure(closure) {
  const root = mkdtempSync(join(tmpdir(), "fashuo-tracked-cli-"));
  snapshots.push(root);
  for (const file of closure) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(APP_ROOT, file), destination);
  }
  return root;
}

afterEach(() => {
  while (snapshots.length) rmSync(snapshots.pop(), { recursive: true, force: true });
});

describe("共享 CLI 与双宿主守卫的 Git 跟踪依赖闭包", () => {
  for (const { entrypoint, expectedStdout, hook } of ENTRYPOINTS) {
    it(`${entrypoint} 可在仅含 git ls-files 依赖闭包的干净副本启动`, () => {
      const tracked = trackedFiles();
      const closure = collectTrackedClosure(entrypoint, tracked);
      const snapshot = copyClosure(closure);
      const result = spawnSync(process.execPath, [entrypoint], {
        cwd: snapshot,
        encoding: "utf8",
        env: {
          ...process.env,
          FASHUO_REPO_ROOT: snapshot,
          FASHUO_SESSION_ID: hook ? `${hook}-clean-session` : process.env.FASHUO_SESSION_ID,
          FASHUO_PRODUCER_HOST: hook ?? process.env.FASHUO_PRODUCER_HOST,
          FASHUO_SKILL_RUN_FILE: join(snapshot, ".local", "skill-runs.jsonl"),
          FASHUO_SKILL_TURN_FILE: join(snapshot, ".local", "skill-turns.jsonl"),
        },
        input: hook ? JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: `${hook}-clean-session`,
          ...(hook === "claude" ? { prompt_id: "clean-prompt" } : { turn_id: "clean-turn" }),
          prompt: "检查一下系统运行状态",
        }) : undefined,
      });
      expect(result.status, [
        `TRACKED_CLI_STARTUP_FAILED|entry=${entrypoint}|files=${closure.length}`,
        `stdout=${result.stdout.trim()}`,
        `stderr=${result.stderr.trim()}`,
      ].join("\n")).toBe(0);
      expect(result.stdout).toContain(expectedStdout);
      console.log(`TRACKED_CLI_STARTUP_PASS|entry=${entrypoint}|files=${closure.length}|closure=${closure.join(",")}`);
    });
  }
});
