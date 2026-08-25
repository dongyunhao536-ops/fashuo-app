// [gpt] 2026-08-23：锁定跨平台根目录优先级和 Windows 路径降级行为。
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  claudeProjectPathKey,
  isUsableLocalPath,
  resolveAppRoot,
  resolveArchiveRoot,
  resolveClaudeMemoryRoot,
  resolveExamTextRoot,
} from "./workspace-paths.mjs";

describe("workspace paths", () => {
  it("显式 FASHUO_ARCHIVE_ROOT 优先于兼容变量和配置", () => {
    const explicitRoot = resolve("tmp", "portable-fashuo");
    const root = resolveArchiveRoot({
      env: {
        FASHUO_ARCHIVE_ROOT: explicitRoot,
        ARCHIVE_DIR: resolve("tmp", "legacy-fashuo"),
      },
      appRoot: resolve("tmp", "fashuo-app"),
      configRoot: "D:\\fashuo",
    });

    expect(root).toBe(explicitRoot);
  });

  it("macOS 忽略配置中的 Windows 绝对路径并回退到同级档案仓", () => {
    const appRoot = resolve("tmp", "migration", "fashuo-app");
    const root = resolveArchiveRoot({
      env: {},
      appRoot,
      configRoot: "D:\\fashuo",
      platform: "darwin",
    });

    expect(root).toBe(resolve(appRoot, "..", "fashuo"));
    expect(isUsableLocalPath("D:\\fashuo", "darwin")).toBe(false);
  });

  it("从应用根稳定推导真题文本目录", () => {
    const appRoot = resolve("tmp", "fashuo-app");
    const archiveRoot = resolve("tmp", "fashuo");
    const env = {
      FASHUO_APP_ROOT: appRoot,
      FASHUO_ARCHIVE_ROOT: archiveRoot,
    };

    expect(resolveAppRoot({ env })).toBe(appRoot);
    expect(resolveExamTextRoot({ env })).toBe(join(archiveRoot, "真题", "_文本"));
  });

  it("按当前 macOS 项目路径推导 Claude 项目记忆键", () => {
    const appRoot = "/Users/dyh/Projects/fashuo-app";
    expect(claudeProjectPathKey(appRoot)).toBe("-Users-dyh-Projects-fashuo-app");
    expect(resolveClaudeMemoryRoot({ env: {}, appRoot, userHome: "/Users/dyh" })).toBe(
      "/Users/dyh/.claude/projects/-Users-dyh-Projects-fashuo-app/memory",
    );
  });

  it("保持 Windows 项目键格式并允许显式覆盖", () => {
    expect(claudeProjectPathKey("D:\\fashuo-app")).toBe("D--fashuo-app");
    expect(resolveClaudeMemoryRoot({
      env: { FASHUO_CLAUDE_MEMORY_ROOT: "/tmp/claude-memory" },
      appRoot: "/Users/dyh/Projects/fashuo-app",
      userHome: "/Users/dyh",
    })).toBe(resolve("/tmp/claude-memory"));
  });
});
