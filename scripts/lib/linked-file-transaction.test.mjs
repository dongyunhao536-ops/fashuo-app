import { describe, expect, it } from "vitest";
import { commitLinkedTextFiles } from "./linked-file-transaction.mjs";

// [gpt] 2026-08-10：覆盖联动写入失败回滚和重复路径防护。
describe("linked file transaction", () => {
  it("第二个文件写入失败时恢复两个文件的原文", () => {
    const state = new Map([["a.md", "old-a"], ["b.md", "old-b"]]);
    let calls = 0;
    const writeText = (path, content) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated write failure");
      state.set(path, content);
    };

    expect(() => commitLinkedTextFiles([
      { path: "a.md", previous: "old-a", next: "new-a" },
      { path: "b.md", previous: "old-b", next: "new-b" },
    ], { writeText })).toThrow(/simulated write failure/);
    expect(Object.fromEntries(state)).toEqual({ "a.md": "old-a", "b.md": "old-b" });
  });

  it("拒绝把同一个文件当成两个事实源写两次", () => {
    expect(() => commitLinkedTextFiles([
      { path: "same.md", previous: "a", next: "b" },
      { path: "./same.md", previous: "a", next: "c" },
    ])).toThrow(/路径不能重复/);
  });
});
