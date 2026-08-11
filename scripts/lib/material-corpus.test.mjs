// [gpt] 2026-08-11：本地与数据库回退必须使用相同的确定性材料顺序。
import { describe, expect, it } from "vitest";
import { groupMaterialRows, sortMaterialRows } from "./material-corpus.mjs";

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
});
