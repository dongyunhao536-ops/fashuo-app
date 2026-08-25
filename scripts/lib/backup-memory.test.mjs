// [gpt] 2026-08-24：锁定 Claude 记忆缺失/空目录不得再被 dry-run 假绿放行。
// [gpt] 2026-08-25：Claude 现役 Skills 是第七个必需源，不得只留在单机用户目录。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../backup-memory.mjs", import.meta.url));
const REQUIRED_ARCHIVE_ASSETS = [
  "教材/带背/_文本/法理学_带背_文本.txt",
  "教材/带背/_文本/法制史_带背_文本.txt",
  "教材/带背/_文本/刑法_带背_文本.txt",
];

function writeFixture(file, value = "fixture") {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

describe("backup-memory dry-run", () => {
  let root;
  let appRoot;
  let archiveRoot;
  let codexHome;
  let claudeMemoryRoot;
  let claudeSkillsRoot;
  let claudeHooksRoot;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fashuo-backup-"));
    appRoot = join(root, "fashuo-app");
    archiveRoot = join(root, "fashuo");
    codexHome = join(root, ".codex");
    claudeMemoryRoot = join(root, ".claude", "memory");
    claudeSkillsRoot = join(root, ".claude", "skills");
    claudeHooksRoot = join(root, ".claude", "hooks");

    // 白名单之外的两个文件必须始终存在：settings 含权限/代理配置，绝不能进档案。
    writeFixture(join(claudeHooksRoot, "fashuo-claude-observe.mjs"), "// guard");
    writeFixture(join(claudeHooksRoot, "settings.local.json"), "{}");
    writeFixture(join(claudeHooksRoot, "unrelated-hook.mjs"), "// other");
    writeFixture(join(appRoot, ".agents", "skills", "fixture.md"));
    writeFixture(join(appRoot, ".codex", "hooks.json"), "{}");
    writeFixture(join(appRoot, "AGENTS.md"));
    writeFixture(join(codexHome, "memories", "fixture.md"));
    writeFixture(join(appRoot, ".local", "ledger.md"));
    writeFixture(join(claudeSkillsRoot, "ask-pc", "SKILL.md"));
    mkdirSync(join(archiveRoot, ".git"), { recursive: true });
    for (const asset of REQUIRED_ARCHIVE_ASSETS) writeFixture(join(archiveRoot, asset));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(memoryRoot = claudeMemoryRoot) {
    const env = {
      ...process.env,
      FASHUO_APP_ROOT: appRoot,
      FASHUO_ARCHIVE_ROOT: archiveRoot,
      FASHUO_CLAUDE_MEMORY_ROOT: memoryRoot,
      FASHUO_CLAUDE_SKILLS_ROOT: claudeSkillsRoot,
      FASHUO_CLAUDE_HOOKS_ROOT: claudeHooksRoot,
      CODEX_HOME: codexHome,
    };
    delete env.FASHUO_LEGACY_MEMORY_ROOT;
    return spawnSync(process.execPath, [SCRIPT, "--dry-run"], { env, encoding: "utf8" });
  }

  it("Claude 记忆源不存在时退出 1，不能先警告再宣告全部可用", () => {
    const result = run(join(root, "missing-memory"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 项目记忆源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");
  });

  it("Claude 记忆源为空时退出 1", () => {
    mkdirSync(claudeMemoryRoot, { recursive: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 项目记忆源为空");
  });

  it("Claude 现役 Skills 缺失或为空时退出 1", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    rmSync(claudeSkillsRoot, { recursive: true, force: true });
    let result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Skills源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");

    mkdirSync(claudeSkillsRoot, { recursive: true });
    result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Skills源为空");
  });

  it("八个必需源均非空时才返回成功，并报告实际文件数", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    writeFixture(join(claudeMemoryRoot, "rule.md"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude 项目记忆");
    expect(result.stdout).toContain("（2 个文件）");
    expect(result.stdout).toContain("Claude 现役 Skills");
    expect(result.stdout).toContain("全部 8 个必需备份源均存在且非空");
  });

  // [claude] 2026-08-25：守卫 handler 是生产件却不在 Git 也不在灾备；补第八源。
  // 白名单必须真的只放行 fashuo-*.mjs，否则会把 settings 里的权限/代理配置带进档案仓。
  it("Claude 现役 Hooks 只备份 fashuo-*.mjs，settings 与无关 hook 不计入", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude 现役 Hooks");
    // 目录里放了 3 个文件，只有 1 个命中白名单。
    expect(result.stdout).toMatch(/Claude 现役 Hooks[^\n]*（1 个文件）/u);
  });

  it("Hooks 源缺失、或存在但白名单一个都没命中时退出 1", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    rmSync(claudeHooksRoot, { recursive: true, force: true });
    let result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Hooks源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");

    // 目录非空但全是白名单外的文件：不得当成"有备份"放行。
    writeFixture(join(claudeHooksRoot, "settings.local.json"), "{}");
    result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Hooks源为空");
  });
});
