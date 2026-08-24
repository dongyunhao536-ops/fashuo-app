// [gpt] 2026-08-23：生成可跨 Windows/macOS 复验的迁移资产清单，并安全复制到空目录。
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MIGRATION_MANIFEST_VERSION = 1;

const APP_EXCLUDED_PREFIXES = [
  "node_modules/",
  ".next/",
  "coverage/",
  "out/",
  "build/",
  "releases/",
  "current/",
  ".local/migration/",
];
const ARCHIVE_EXCLUDED_PREFIXES = [
  "node_modules/",
  ".claude/settings.local.json",
  ".DS_Store",
];
const CODEX_ALLOWED_PREFIXES = [
  "AGENTS.md",
  "config.toml",
  "memories/",
  "rules/",
  "skills/",
];

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function includeRelative(role, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (role === "app") {
    return !APP_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
  }
  if (role === "archive") {
    return !ARCHIVE_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized === prefix.replace(/\/$/u, "") || normalized.startsWith(prefix));
  }
  if (role === "codex") {
    const allowed = CODEX_ALLOWED_PREFIXES.some((prefix) => (
      normalized === prefix || normalized === prefix.replace(/\/$/u, "") || normalized.startsWith(prefix)
    ));
    // [gpt] 2026-08-23：Codex 记忆可能自身是活跃 Git 仓；迁移正文，不复制会并发变化的内部对象库。
    return allowed && !normalized.split("/").includes(".git");
  }
  return true;
}

function walk(root, role, relativeDir = "", entries = []) {
  const absoluteDir = relativeDir ? join(root, relativeDir) : root;
  for (const dirent of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = normalizeRelative(join(relativeDir, dirent.name));
    if (!includeRelative(role, relativePath)) continue;
    const absolutePath = join(root, relativePath);
    if (dirent.isDirectory()) {
      walk(root, role, relativePath, entries);
      continue;
    }
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      entries.push({
        path: relativePath,
        type: "symlink",
        size: Buffer.byteLength(target),
        sha256: createHash("sha256").update(target).digest("hex"),
        target,
      });
      continue;
    }
    if (!stats.isFile()) continue;
    entries.push({
      path: relativePath,
      type: "file",
      size: stats.size,
      sha256: sha256File(absolutePath),
    });
  }
  return entries;
}

export function collectMigrationRole(root, role) {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`${role} 根目录不存在或不是目录：${absoluteRoot}`);
  }
  const entries = walk(absoluteRoot, role).sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  return {
    root: absoluteRoot,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries,
  };
}

export function createMigrationManifest({ appRoot, archiveRoot, codexHome }) {
  return {
    schemaVersion: MIGRATION_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: process.platform,
    nodeVersion: process.version,
    security: {
      containsSecretHashes: true,
      secretValuesIncluded: false,
      note: "app 清单会记录 .env 文件的路径、大小与哈希，但绝不写入密钥值。迁移副本必须放在本人控制的私有目录，并仅通过受信任局域网或加密介质转移。",
    },
    roles: {
      app: collectMigrationRole(appRoot, "app"),
      archive: collectMigrationRole(archiveRoot, "archive"),
      codex: collectMigrationRole(codexHome, "codex"),
    },
  };
}

export function verifyMigrationManifest(manifest, roots) {
  if (manifest?.schemaVersion !== MIGRATION_MANIFEST_VERSION) {
    throw new Error(`不支持的迁移清单版本：${manifest?.schemaVersion ?? "missing"}`);
  }
  const missing = [];
  const mismatched = [];
  let checked = 0;

  for (const [role, roleManifest] of Object.entries(manifest.roles ?? {})) {
    const root = resolve(roots[role] ?? roleManifest.root);
    for (const entry of roleManifest.entries ?? []) {
      const absolutePath = join(root, entry.path);
      if (!existsSync(absolutePath)) {
        missing.push(`${role}/${entry.path}`);
        continue;
      }
      const stats = lstatSync(absolutePath);
      const actualType = stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "other";
      const actualHash = actualType === "symlink"
        ? createHash("sha256").update(readlinkSync(absolutePath)).digest("hex")
        : actualType === "file"
          ? sha256File(absolutePath)
          : null;
      if (actualType !== entry.type || actualHash !== entry.sha256) {
        mismatched.push(`${role}/${entry.path}`);
      }
      checked += 1;
    }
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    checked,
    missing,
    mismatched,
  };
}

export function assertSafeEmptyDestination(destination, sourceRoots = []) {
  const absoluteDestination = resolve(destination);
  for (const sourceRoot of sourceRoots) {
    const absoluteSource = resolve(sourceRoot);
    const rel = relative(absoluteSource, absoluteDestination);
    if (!rel || rel === "." || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      throw new Error(`迁移目标不能位于源目录内部：${absoluteDestination}`);
    }
  }
  if (existsSync(absoluteDestination) && readdirSync(absoluteDestination).length > 0) {
    throw new Error(`迁移目标必须为空目录：${absoluteDestination}`);
  }
  return absoluteDestination;
}

export function copyMigrationBundle(manifest, destination) {
  const sourceRoots = Object.values(manifest.roles).map((role) => role.root);
  const bundleRoot = assertSafeEmptyDestination(destination, sourceRoots);
  mkdirSync(bundleRoot, { recursive: true });

  for (const [role, roleManifest] of Object.entries(manifest.roles)) {
    const roleRoot = join(bundleRoot, role);
    for (const entry of roleManifest.entries) {
      const source = join(roleManifest.root, entry.path);
      const target = join(roleRoot, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { dereference: false, preserveTimestamps: true });
    }
  }

  const portableManifest = {
    ...manifest,
    roles: Object.fromEntries(Object.entries(manifest.roles).map(([role, value]) => [
      role,
      { ...value, root: role },
    ])),
  };
  const manifestPath = join(bundleRoot, "migration-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(portableManifest, null, 2)}\n`, "utf8");

  const verification = verifyMigrationManifest(portableManifest, {
    app: join(bundleRoot, "app"),
    archive: join(bundleRoot, "archive"),
    codex: join(bundleRoot, "codex"),
  });
  if (!verification.ok) {
    throw new Error(`迁移包复制后校验失败：missing=${verification.missing.length}, mismatched=${verification.mismatched.length}`);
  }
  return { bundleRoot, manifestPath, verification };
}

export function writeMigrationManifest(manifest, outputPath) {
  const absoluteOutput = resolve(outputPath);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return absoluteOutput;
}
