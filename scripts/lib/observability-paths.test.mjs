// [gpt] 2026-08-20：统一遥测路径回归，覆盖 Codex 工作树识别和遗留流水发现。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverObservabilityFiles, findRepositoryRoot } from "./observability-paths.mjs";

describe("Skill 遥测路径", () => {
  it("工作树解析回主仓库，并发现同仓库遗留流水", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "observability-paths-"));
    const canonicalRoot = join(sandbox, "repo");
    const codexHome = join(sandbox, ".codex");
    const worktreeRoot = join(codexHome, "worktrees", "abcd", "repo");
    mkdirSync(join(canonicalRoot, ".git", "worktrees", "repo2"), { recursive: true });
    mkdirSync(join(worktreeRoot, "scripts"), { recursive: true });
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${join(canonicalRoot, ".git", "worktrees", "repo2")}\n`, "utf8");
    const moduleFile = join(worktreeRoot, "scripts", "guard.mjs");
    writeFileSync(moduleFile, "", "utf8");
    const canonicalFile = join(canonicalRoot, ".local", "system-observability", "skill-runs.jsonl");
    const legacyFile = join(worktreeRoot, ".local", "system-observability", "skill-runs.jsonl");
    mkdirSync(join(worktreeRoot, ".local", "system-observability"), { recursive: true });
    writeFileSync(legacyFile, "{}\n", "utf8");

    expect(findRepositoryRoot(moduleFile)).toBe(canonicalRoot);
    expect(discoverObservabilityFiles("skill-runs.jsonl", { canonicalFile, codexHomePath: codexHome })).toEqual([canonicalFile, legacyFile]);
  });
});
