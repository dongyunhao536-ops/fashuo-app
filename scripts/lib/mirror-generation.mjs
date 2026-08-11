// [gpt] 2026-08-10：把本地白名单构造成可指纹化的完整镜像世代，供数据库原子切换。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const SOURCE_LEVELS = new Set(["S0", "S1", "S2", "S3", "S4", "mixed", "unclassified"]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function inferMirrorSourceLevel(kind, path, explicit = null) {
  if (explicit != null) {
    const level = String(explicit);
    if (!SOURCE_LEVELS.has(level)) throw new Error(`镜像 sourceLevel 不合法：${level}`);
    return level;
  }
  const normalized = String(path ?? "").replaceAll("\\", "/");
  if (kind === "xinde" || kind === "yixiao" || normalized.includes("/带背/")) return "S3";
  if (kind === "zhenti") return "S4";
  if (kind === "exam") return "mixed";
  if (normalized.startsWith("法律更新档案/")) return "S1";
  if (/讲义|民法学_|法理学_|宪法学_|法制史_/.test(normalized)) return "S2";
  if (normalized.includes("考试分析")) return "mixed";
  return "unclassified";
}

export function prepareMirrorGeneration(files, {
  configBytes,
  readBytes = readFileSync,
  generationId = `mirror-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`,
  sourceCommit = null,
} = {}) {
  const sorted = [...(files ?? [])].sort((a, b) => a.rel.localeCompare(b.rel));
  if (!sorted.length) throw new Error("镜像世代不能为空");
  const seen = new Set();
  const rows = [];
  let totalBytes = 0;

  for (const file of sorted) {
    const path = String(file.rel ?? "").replaceAll("\\", "/");
    if (!path) throw new Error("镜像文件缺相对路径");
    if (seen.has(path)) throw new Error(`镜像 scope 重复命中同一路径：${path}`);
    seen.add(path);
    const bytes = readBytes(file.abs);
    const content = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
    const byteLength = Buffer.byteLength(content, "utf8");
    const contentSha256 = digest(Buffer.from(content, "utf8"));
    const sourceLevel = inferMirrorSourceLevel(file.kind, path, file.sourceLevel);
    totalBytes += byteLength;
    rows.push({
      generation_id: generationId,
      kind: file.kind,
      path,
      chunk_no: 0,
      start_line: 1,
      content,
      content_sha256: contentSha256,
      source_level: sourceLevel,
      source_version: file.sourceVersion ?? null,
      metadata: file.metadata ?? {},
    });
  }

  const scopeCanonical = rows
    .map((row) => `${row.kind}\0${row.path}\0${row.source_level}\0${row.source_version ?? ""}\n`)
    .join("");
  const contentCanonical = rows
    .map((row) => `${row.path}\0${row.content_sha256}\n`)
    .join("");

  return {
    generationId,
    sourceCommit,
    rows,
    expectedFileCount: seen.size,
    expectedRowCount: rows.length,
    totalBytes,
    configSha256: digest(configBytes ?? Buffer.alloc(0)),
    scopeSha256: digest(scopeCanonical),
    contentSha256: digest(contentCanonical),
  };
}
