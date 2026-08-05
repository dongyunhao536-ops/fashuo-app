import { describe, expect, it } from "vitest";
import { KINDS, clip, formatMaterialBlocks, grep } from "./cuoti.mjs";

describe("cuoti material sources", () => {
  it("给每类来源独立正配额，并把原始真题与二次总结分开", () => {
    const byKind = new Map(KINDS.map(([kind, label, quota]) => [kind, { label, quota }]));

    expect(byKind.size).toBe(KINDS.length);
    expect([...byKind.values()].every(({ quota }) => quota > 0)).toBe(true);
    expect(byKind.get("exam")).toEqual({ label: "真题原卷/随卷参考答案解析", quota: 4000 });
    expect(byKind.get("zhenti")?.label).toContain("二次总结");
  });
});

describe("cuoti grep", () => {
  it("保留真实行号、合并相邻命中，并过滤目录点线", () => {
    const rows = [{
      path: "教材/测试.txt",
      start_line: 20,
      content: ["前文", "正当防卫", "正当防卫......99", "说明", "正当防卫", "后文"].join("\n"),
    }];

    const result = grep(rows, "正当防卫");

    expect(result.totalHits).toBe(2);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toEqual([21, 24]);
    expect(result.blocks[0].text).toContain("21► 正当防卫");
    expect(result.blocks[0].text).toContain("24► 正当防卫");
  });

  it("超长命中行围绕关键词截取，不再只显示行首", () => {
    const prefix = "甲".repeat(240);
    const suffix = "乙".repeat(240);
    const { blocks } = grep([{ path: "真题/长行.txt", start_line: 1, content: `${prefix}想象竞合${suffix}` }], "想象竞合");

    expect(blocks[0].text).toContain("想象竞合");
    expect(blocks[0].text).not.toContain("甲".repeat(200));
    expect(clip(`${prefix}想象竞合${suffix}`, "想象竞合")).toMatch(/^….*想象竞合.*…$/);
  });

  it("有命中时即使首片段超出配额也至少输出一块", () => {
    const blocks = [{ path: "真题/_文本/2024.txt", text: "命中内容".repeat(1000) }];
    const { segments, shown } = formatMaterialBlocks(blocks, 100);

    expect(shown).toBe(1);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toContain("真题/_文本/2024.txt");
    expect(segments[0]).toContain("本片段过长已截断");
  });
});
