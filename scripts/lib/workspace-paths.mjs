// [gpt] 2026-08-23：统一 Windows/macOS 的应用、档案与 Codex 根目录解析。
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/u;

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

export function isUsableLocalPath(value, platform = process.platform) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (platform !== "win32" && WINDOWS_ABSOLUTE_RE.test(value.trim())) return false;
  return isAbsolute(value.trim());
}

export function resolveAppRoot({ env = process.env } = {}) {
  return resolve(firstNonEmpty(env.FASHUO_APP_ROOT) ?? MODULE_APP_ROOT);
}

export function resolveArchiveRoot({
  env = process.env,
  appRoot = resolveAppRoot({ env }),
  configRoot,
  platform = process.platform,
} = {}) {
  const explicit = firstNonEmpty(env.FASHUO_ARCHIVE_ROOT, env.ARCHIVE_DIR);
  if (explicit) return resolve(explicit);
  if (isUsableLocalPath(configRoot, platform)) return resolve(configRoot);
  return resolve(appRoot, "..", "fashuo");
}

export function resolveExamTextRoot(options = {}) {
  return join(resolveArchiveRoot(options), "真题", "_文本");
}

export function resolveCodexHome({ env = process.env } = {}) {
  return resolve(firstNonEmpty(env.CODEX_HOME) ?? join(homedir(), ".codex"));
}

export function resolveLegacyMemoryRoot({ env = process.env } = {}) {
  const explicit = firstNonEmpty(env.FASHUO_LEGACY_MEMORY_ROOT);
  if (explicit) return resolve(explicit);
  return join(homedir(), ".claude", "projects", "D--fashuo-app", "memory");
}

