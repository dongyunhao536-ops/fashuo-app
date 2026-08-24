// [gpt] 2026-08-11：PC 单用户检索直接读取本地权威档案；范围、排除与完整性规则和线上镜像一致。
import { readFileSync } from "node:fs";
import { expandMirrorScope } from "./mirror-scope.mjs";
import { prepareMirrorGeneration } from "./mirror-generation.mjs";
import { resolveArchiveRoot } from "./workspace-paths.mjs";

export const DEFAULT_MIRROR_SCOPE = "config/mirror-scope.json";

export function sortMaterialRows(rows) {
  return [...(rows ?? [])].sort((left, right) => {
    const leftPath = String(left.path ?? "");
    const rightPath = String(right.path ?? "");
    if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
    return Number(left.start_line ?? 1) - Number(right.start_line ?? 1);
  });
}

export function groupMaterialRows(rows) {
  const corpus = new Map();
  for (const row of rows ?? []) {
    if (!corpus.has(row.kind)) corpus.set(row.kind, []);
    corpus.get(row.kind).push({
      path: row.path,
      content: row.content,
      start_line: row.start_line ?? 1,
    });
  }
  for (const [kind, materialRows] of corpus) {
    corpus.set(kind, sortMaterialRows(materialRows));
  }
  return corpus;
}

export async function loadLocalMaterialCorpus({
  configPath = DEFAULT_MIRROR_SCOPE,
  archiveRoot,
} = {}) {
  const configBytes = readFileSync(configPath);
  const config = JSON.parse(configBytes.toString("utf8"));
  // [gpt] 2026-08-23：本地五源检索与同步链共享跨平台档案根解析。
  const root = archiveRoot ?? resolveArchiveRoot({ configRoot: config.root });
  const scope = await expandMirrorScope(config, { root });
  if (scope.files.length === 0) {
    throw new Error(`本地材料范围为空：${root}`);
  }

  // 复用镜像世代构建：重复路径、原始 UTF-8 内容和每文件完整读取均与 sync-content 一致。
  const generation = prepareMirrorGeneration(scope.files, {
    configBytes,
    generationId: "local-material",
  });
  return {
    corpus: groupMaterialRows(generation.rows),
    root,
    fileCount: generation.expectedFileCount,
    totalBytes: generation.totalBytes,
    excludedCount: scope.excluded.length,
    verifiedCount: scope.verified.length,
  };
}
