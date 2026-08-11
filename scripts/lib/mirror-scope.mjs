// [gpt] 2026-08-11：同步与 PC 本地检索共用同一套镜像范围展开，避免材料边界漂移。
import { glob } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  isExcludedArchivePath,
  isSealedExamArchivePath,
  normalizeArchivePath,
} from "./knowledge-baseline.mjs";
import { inferMirrorSourceLevel } from "./mirror-generation.mjs";
import { verifyMirrorRuleMatches } from "./mirror-integrity.mjs";

/** 展开 mirror-scope rules，返回可进入镜像的文件、被排除文件与哈希校验结果。 */
export async function expandMirrorScope(config, {
  root = config?.root,
  globFiles = glob,
  readBytes,
} = {}) {
  if (!config || !Array.isArray(config.rules)) {
    throw new Error("mirror-scope.rules 必须是数组");
  }
  if (!root) throw new Error("mirror-scope 缺少档案根目录");

  const files = [];
  const excluded = [];
  const verified = [];
  const excludedPatterns = config.excludedPatterns ?? [];

  for (const rule of config.rules) {
    const pattern = normalizeArchivePath(rule.pattern);
    const matched = [];
    for await (const entry of globFiles(pattern, { cwd: root })) {
      const abs = join(root, entry);
      const rel = normalizeArchivePath(relative(root, abs));
      const file = {
        abs,
        rel,
        kind: rule.kind,
        sourceLevel: inferMirrorSourceLevel(rule.kind, rel, rule.sourceLevel),
        sourceVersion: rule.sourceVersion ?? null,
      };
      matched.push(file);
      if (
        isExcludedArchivePath(rel, excludedPatterns) ||
        (rule.kind === "exam" && isSealedExamArchivePath(rel, config.sealedExamFromYear))
      ) {
        excluded.push(file);
      } else {
        files.push(file);
      }
    }

    const verification = verifyMirrorRuleMatches(rule, matched, {
      ...(readBytes ? { readBytes } : {}),
    });
    if (verification.verified) verified.push(verification);
  }

  const byPath = (left, right) => left.rel.localeCompare(right.rel, "zh-CN");
  files.sort(byPath);
  excluded.sort(byPath);
  return { files, excluded, verified };
}
