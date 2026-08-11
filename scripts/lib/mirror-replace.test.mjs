import { describe, expect, it, vi } from "vitest";
import { replaceMirrorRows } from "./mirror-replace.mjs";

describe("mirror replace", () => {
  it("新内容插入失败时恢复旧内容", async () => {
    const old = [{ path: "a", content: "old" }];
    const restorePrevious = vi.fn(async () => ({ error: null }));
    await expect(replaceMirrorRows({
      path: "a",
      readPrevious: async () => ({ data: old, error: null }),
      deleteExisting: async () => ({ error: null }),
      insertNext: async () => ({ error: { message: "new insert failed" } }),
      restorePrevious,
    })).rejects.toThrow(/旧内容已恢复/);
    expect(restorePrevious).toHaveBeenCalledWith(old);
  });

  it("快照或删除失败时不进入后续破坏性步骤", async () => {
    const deleteExisting = vi.fn(async () => ({ error: null }));
    const insertNext = vi.fn(async () => ({ error: null }));
    await expect(replaceMirrorRows({
      path: "a",
      readPrevious: async () => ({ data: null, error: { message: "read failed" } }),
      deleteExisting,
      insertNext,
      restorePrevious: vi.fn(),
    })).rejects.toThrow(/snapshot: read failed/);
    expect(deleteExisting).not.toHaveBeenCalled();
    expect(insertNext).not.toHaveBeenCalled();
  });
});
