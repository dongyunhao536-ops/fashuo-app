// [gpt] 2026-08-20：Skill 遥测统一写入主仓库，同时只读兼容 Codex 工作树遗留流水。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function normalizedPath(value) {
  return resolve(value).replaceAll("\\", "/").toLowerCase();
}

function gitDirectoryFromMarker(repoRoot) {
  const marker = join(repoRoot, ".git");
  if (!existsSync(marker)) return null;
  try {
    const raw = readFileSync(marker, "utf8").trim();
    const match = raw.match(/^gitdir:\s*(.+)$/iu);
    return match ? resolve(repoRoot, match[1]) : marker;
  } catch {
    return marker;
  }
}

function canonicalRootFromGitDirectory(gitDirectory) {
  let current = resolve(gitDirectory);
  while (dirname(current) !== current) {
    if (basename(current).toLowerCase() === ".git") return dirname(current);
    current = dirname(current);
  }
  return null;
}

export function findRepositoryRoot(startPath = fileURLToPath(import.meta.url)) {
  let current = existsSync(startPath) && statSync(startPath).isDirectory() ? resolve(startPath) : dirname(resolve(startPath));
  while (dirname(current) !== current) {
    const gitDirectory = gitDirectoryFromMarker(current);
    if (gitDirectory) return canonicalRootFromGitDirectory(gitDirectory) ?? current;
    current = dirname(current);
  }
  return null;
}

export function canonicalObservabilityFile(filename, {
  moduleUrl = import.meta.url,
  envRoot = process.env.FASHUO_OBSERVABILITY_ROOT,
} = {}) {
  const repositoryRoot = envRoot ? resolve(envRoot) : findRepositoryRoot(fileURLToPath(moduleUrl));
  if (!repositoryRoot) throw new Error("无法定位 Skill 遥测主仓库；请设置 FASHUO_OBSERVABILITY_ROOT");
  return join(repositoryRoot, ".local", "system-observability", filename);
}

function codexHome() {
  return process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : process.env.USERPROFILE
      ? join(process.env.USERPROFILE, ".codex")
      : null;
}

export function discoverObservabilityFiles(filename, {
  canonicalFile = canonicalObservabilityFile(filename),
  codexHomePath = codexHome(),
} = {}) {
  const files = [canonicalFile];
  const home = codexHomePath;
  if (!home) return files;
  const worktreesRoot = join(home, "worktrees");
  if (!existsSync(worktreesRoot)) return files;
  const canonicalRoot = dirname(dirname(dirname(canonicalFile)));
  const repositoryName = basename(canonicalRoot);
  for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateRoot = join(worktreesRoot, entry.name, repositoryName);
    const candidateGitDirectory = gitDirectoryFromMarker(candidateRoot);
    if (!candidateGitDirectory) continue;
    const candidateCanonicalRoot = canonicalRootFromGitDirectory(candidateGitDirectory);
    if (!candidateCanonicalRoot || normalizedPath(candidateCanonicalRoot) !== normalizedPath(canonicalRoot)) continue;
    const candidate = join(candidateRoot, ".local", "system-observability", filename);
    if (existsSync(candidate) && normalizedPath(candidate) !== normalizedPath(canonicalFile)) files.push(candidate);
  }
  return files;
}
