// [gpt] 2026-08-10：多文件联动写入先完成全量预计算，进程内失败时回滚原文。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 顺序写入一组已经预校验的文本，并在任一写入抛错时恢复全部原文。
 * 这提供进程内一致性保护；跨文件系统写入不冒充操作系统级原子事务。
 */
export function commitLinkedTextFiles(entries, { writeText = writeFileSync } = {}) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error("联动写入至少需要两个文件");
  }
  const normalized = entries.map((entry) => ({
    path: String(entry.path),
    absolutePath: resolve(String(entry.path)),
    previous: String(entry.previous),
    next: String(entry.next),
  }));
  const uniquePaths = new Set(normalized.map((entry) => process.platform === "win32" ? entry.absolutePath.toLowerCase() : entry.absolutePath));
  if (uniquePaths.size !== normalized.length) throw new Error("联动写入的文件路径不能重复");

  try {
    for (const entry of normalized) writeText(entry.path, entry.next, "utf8");
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...normalized].reverse()) {
      try {
        // 即使失败发生在 writeFileSync 中途，也恢复该文件，不能只回滚已返回成功的项。
        writeText(entry.path, entry.previous, "utf8");
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(
        `联动写入失败且回滚不完整：${error instanceof Error ? error.message : String(error)}；回滚失败：${rollbackErrors.join("；")}`,
        { cause: error },
      );
    }
    throw error;
  }
}
