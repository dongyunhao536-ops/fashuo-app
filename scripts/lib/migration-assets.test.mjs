// [gpt] 2026-08-23：锁定迁移清单完整性、忽略构建产物、篡改检测和目标边界。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeEmptyDestination,
  copyMigrationBundle,
  createMigrationManifest,
  verifyMigrationManifest,
} from "./migration-assets.mjs";

const cleanup = [];

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "fashuo-migration-"));
  cleanup.push(base);
  const app = join(base, "fashuo-app");
  const archive = join(base, "fashuo");
  const codex = join(base, "codex-home");
  mkdirSync(join(app, ".local"), { recursive: true });
  mkdirSync(join(app, "node_modules", "ignored"), { recursive: true });
  mkdirSync(join(archive, "教材"), { recursive: true });
  mkdirSync(join(archive, "node_modules", "ignored"), { recursive: true });
  mkdirSync(join(codex, "memories"), { recursive: true });
  mkdirSync(join(codex, "memories", ".git", "objects"), { recursive: true });
  mkdirSync(join(codex, "cache"), { recursive: true });
  writeFileSync(join(app, "AGENTS.md"), "rules", "utf8");
  writeFileSync(join(app, ".env.local"), "SECRET=value", "utf8");
  writeFileSync(join(app, ".local", "台账.md"), "ledger", "utf8");
  writeFileSync(join(app, "node_modules", "ignored", "x.js"), "ignored", "utf8");
  writeFileSync(join(archive, "教材", "考试分析.txt"), "book", "utf8");
  writeFileSync(join(archive, "node_modules", "ignored", "x.js"), "ignored", "utf8");
  writeFileSync(join(codex, "AGENTS.md"), "global", "utf8");
  writeFileSync(join(codex, "config.toml"), "model='x'", "utf8");
  writeFileSync(join(codex, "memories", "MEMORY.md"), "memory", "utf8");
  writeFileSync(join(codex, "memories", ".git", "objects", "volatile"), "git-object", "utf8");
  writeFileSync(join(codex, "cache", "ignored.bin"), "ignored", "utf8");
  return { base, app, archive, codex };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("migration assets", () => {
  it("清单包含本地台账和密钥哈希，但排除可重建依赖与 Codex 缓存", () => {
    const roots = fixture();
    const manifest = createMigrationManifest({
      appRoot: roots.app,
      archiveRoot: roots.archive,
      codexHome: roots.codex,
    });
    const appPaths = manifest.roles.app.entries.map((entry) => entry.path);
    const codexPaths = manifest.roles.codex.entries.map((entry) => entry.path);

    expect(appPaths).toContain(".env.local");
    expect(appPaths).toContain(".local/台账.md");
    expect(appPaths).not.toContain("node_modules/ignored/x.js");
    expect(manifest.roles.archive.entries.map((entry) => entry.path)).not.toContain("node_modules/ignored/x.js");
    expect(codexPaths).toContain("memories/MEMORY.md");
    expect(codexPaths).not.toContain("memories/.git/objects/volatile");
    expect(codexPaths).not.toContain("cache/ignored.bin");
    expect(manifest.roles.app.entries.find((entry) => entry.path === ".env.local")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("复验能识别内容变化", () => {
    const roots = fixture();
    const manifest = createMigrationManifest({ appRoot: roots.app, archiveRoot: roots.archive, codexHome: roots.codex });
    expect(verifyMigrationManifest(manifest, {
      app: roots.app,
      archive: roots.archive,
      codex: roots.codex,
    }).ok).toBe(true);

    writeFileSync(join(roots.app, ".local", "台账.md"), "changed", "utf8");
    const result = verifyMigrationManifest(manifest, { app: roots.app, archive: roots.archive, codex: roots.codex });
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain("app/.local/台账.md");
  });

  it("只向源目录之外的空目录复制并在复制后逐文件复验", () => {
    const roots = fixture();
    const manifest = createMigrationManifest({ appRoot: roots.app, archiveRoot: roots.archive, codexHome: roots.codex });
    const destination = join(roots.base, "bundle");

    expect(() => assertSafeEmptyDestination(join(roots.app, "nested"), [roots.app])).toThrow(/源目录内部/u);
    const result = copyMigrationBundle(manifest, destination);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.checked).toBeGreaterThan(0);
  });
});
