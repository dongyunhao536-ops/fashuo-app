#!/usr/bin/env node
// [gpt] 2026-08-23：Windows → macOS 迁移清单、局域网直传暂存与恢复后逐文件验收入口。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  copyMigrationBundle,
  createMigrationManifest,
  verifyMigrationManifest,
  writeMigrationManifest,
} from "./lib/migration-assets.mjs";
import {
  resolveAppRoot,
  resolveArchiveRoot,
  resolveCodexHome,
} from "./lib/workspace-paths.mjs";

function usage() {
  return [
    "用法：node scripts/migration-audit.mjs <plan|snapshot|bundle|verify> [选项]",
    "",
    "  plan                         只读扫描迁移范围并打印文件数/容量",
    "  snapshot [--out <file>]      生成 SHA-256 清单，默认写 .local/migration/",
    "  bundle --destination <dir> --acknowledge-secrets",
    "                               复制完整迁移包到空目录并立即复验",
    "  verify --manifest <file>     在恢复后的根目录逐文件复验",
    "",
    "根目录覆盖：",
    "  --app-root <dir> --archive-root <dir> --codex-home <dir>",
    "  --bundle-root <dir>          直接复验 bundle 下的 app/archive/codex",
    "",
    "安全：bundle 包含 .env 密钥文件，只能写入本人控制的私有目录，并通过受信任局域网直传或加密介质转移。",
  ].join("\n");
}

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = { command };
  const booleanOptions = new Set(["--acknowledge-secrets"]);
  const valueOptions = new Map([
    ["--out", "out"],
    ["--destination", "destination"],
    ["--manifest", "manifest"],
    ["--app-root", "appRoot"],
    ["--archive-root", "archiveRoot"],
    ["--codex-home", "codexHome"],
    ["--bundle-root", "bundleRoot"],
  ]);

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (booleanOptions.has(argument)) options.acknowledgeSecrets = true;
    else if (valueOptions.has(argument)) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
      options[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function rootsFromOptions(options) {
  const appRoot = resolve(options.appRoot ?? resolveAppRoot());
  return {
    app: appRoot,
    archive: resolve(options.archiveRoot ?? resolveArchiveRoot({ appRoot })),
    codex: resolve(options.codexHome ?? resolveCodexHome()),
  };
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function printManifestSummary(manifest) {
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [role, value] of Object.entries(manifest.roles)) {
    totalFiles += value.fileCount;
    totalBytes += value.totalBytes;
    console.log(`- ${role}: ${value.fileCount} files / ${formatBytes(value.totalBytes)} / ${value.root}`);
  }
  console.log(`合计：${totalFiles} files / ${formatBytes(totalBytes)}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!["plan", "snapshot", "bundle", "verify"].includes(options.command)) {
    throw new Error(`未知命令：${options.command}`);
  }

  if (options.command === "verify") {
    if (!options.manifest) throw new Error("verify 必须提供 --manifest <file>");
    const manifestPath = resolve(options.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const roots = options.bundleRoot
      ? {
          app: join(resolve(options.bundleRoot), "app"),
          archive: join(resolve(options.bundleRoot), "archive"),
          codex: join(resolve(options.bundleRoot), "codex"),
        }
      : rootsFromOptions(options);
    const result = verifyMigrationManifest(manifest, roots);
    console.log(`复验：checked=${result.checked}, missing=${result.missing.length}, mismatched=${result.mismatched.length}`);
    if (result.missing.length) console.error(`缺失：\n${result.missing.map((path) => `- ${path}`).join("\n")}`);
    if (result.mismatched.length) console.error(`不一致：\n${result.mismatched.map((path) => `- ${path}`).join("\n")}`);
    if (!result.ok) process.exitCode = 2;
  } else {
    const roots = rootsFromOptions(options);
    const manifest = createMigrationManifest({
      appRoot: roots.app,
      archiveRoot: roots.archive,
      codexHome: roots.codex,
    });
    printManifestSummary(manifest);

    if (options.command === "snapshot") {
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const output = options.out ?? join(roots.app, ".local", "migration", `manifest-${timestamp}.json`);
      console.log(`✓ 清单已写入：${writeMigrationManifest(manifest, output)}`);
    }

    if (options.command === "bundle") {
      if (!options.destination) throw new Error("bundle 必须提供 --destination <empty-dir>");
      if (!options.acknowledgeSecrets) {
        throw new Error("迁移包包含 .env 密钥文件；确认目标目录由本人控制且不会公开共享后加 --acknowledge-secrets");
      }
      const result = copyMigrationBundle(manifest, options.destination);
      console.log(`✓ 迁移包完成：${result.bundleRoot}`);
      console.log(`✓ 逐文件复验通过：${result.verification.checked} files`);
    }
  }
} catch (error) {
  console.error(`迁移审计失败：${error.message}`);
  process.exitCode = 1;
}
