// [gpt] 2026-08-11：本地与数据库回退必须使用相同的确定性材料顺序。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupMaterialRows, loadLocalMaterialCorpus, sortMaterialRows } from "./material-corpus.mjs";

describe("material corpus", () => {
  it("按路径和起始行稳定排序，不依赖文件系统或数据库返回顺序", () => {
    const rows = [
      { kind: "textbook", path: "教材/乙.txt", start_line: 1, content: "乙" },
      { kind: "textbook", path: "教材/甲.txt", start_line: 20, content: "甲二" },
      { kind: "textbook", path: "教材/甲.txt", start_line: 1, content: "甲一" },
    ];

    expect(sortMaterialRows(rows).map((row) => `${row.path}:${row.start_line}`)).toEqual([
      "教材/乙.txt:1",
      "教材/甲.txt:1",
      "教材/甲.txt:20",
    ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    expect(groupMaterialRows(rows).get("textbook").map((row) => row.content)).toEqual([
      ...sortMaterialRows(rows).map((row) => row.content),
    ]);
  });

  // [claude] 2026-08-24：档案根找不到时曾退化成"必需镜像资产未匹配：教材/带背/..."，
  // 看起来像少同步一个文件，实际整个根都不在——macOS 上漏 --env-file 就是这个症状。
  it("档案根不存在时直接点名根目录并给出补法，不伪装成缺单个资产", async () => {
    const dir = mkdtempSync(join(tmpdir(), "material-root-"));
    const configPath = join(dir, "mirror-scope.json");
    writeFileSync(configPath, JSON.stringify({ root: "D:\\fashuo", rules: [] }), "utf8");

    await expect(loadLocalMaterialCorpus({
      configPath,
      archiveRoot: join(dir, "并不存在的档案根"),
    })).rejects.toThrow(/档案根不存在/);

    await expect(loadLocalMaterialCorpus({
      configPath,
      archiveRoot: join(dir, "并不存在的档案根"),
    })).rejects.toThrow(/--env-file=\.env\.local/);
  });
});
