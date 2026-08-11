import { describe, expect, it } from "vitest";
import { inferMirrorSourceLevel, prepareMirrorGeneration } from "./mirror-generation.mjs";

describe("mirror generation", () => {
  it("按来源性质保守标级，不把混合文本冒充纯考试分析", () => {
    expect(inferMirrorSourceLevel("exam", "真题/_文本/2019.txt")).toBe("mixed");
    expect(inferMirrorSourceLevel("textbook", "法律更新档案/01_刑法相关更新.md")).toBe("S1");
    expect(inferMirrorSourceLevel("textbook", "教材/刑法讲义_文本.txt")).toBe("S2");
    expect(inferMirrorSourceLevel("textbook", "教材/考试分析_文本.txt")).toBe("mixed");
    expect(inferMirrorSourceLevel("xinde", "真题分析/_刑法做题心得.md")).toBe("S3");
  });

  it("同一 scope 和内容产生稳定指纹，内容变化只改变内容指纹", () => {
    const files = [
      { abs: "a", rel: "教材/a.txt", kind: "textbook", sourceLevel: "S2" },
      { abs: "b", rel: "真题分析/b.md", kind: "xinde" },
    ];
    const values = new Map([["a", "甲"], ["b", "乙"]]);
    const options = {
      configBytes: Buffer.from("{}"),
      generationId: "g1",
      readBytes: (path) => Buffer.from(values.get(path)),
    };
    const first = prepareMirrorGeneration(files, options);
    const reordered = prepareMirrorGeneration([...files].reverse(), { ...options, generationId: "g2" });
    expect(first.scopeSha256).toBe(reordered.scopeSha256);
    expect(first.contentSha256).toBe(reordered.contentSha256);
    values.set("b", "乙改");
    const changed = prepareMirrorGeneration(files, { ...options, generationId: "g3" });
    expect(changed.scopeSha256).toBe(first.scopeSha256);
    expect(changed.contentSha256).not.toBe(first.contentSha256);
  });

  it("重复路径在写库前失败", () => {
    const files = [
      { abs: "a", rel: "same.md", kind: "xinde" },
      { abs: "b", rel: "same.md", kind: "xinde" },
    ];
    expect(() => prepareMirrorGeneration(files, {
      configBytes: Buffer.from("{}"),
      readBytes: () => Buffer.from("x"),
    })).toThrow(/重复命中/);
  });
});
