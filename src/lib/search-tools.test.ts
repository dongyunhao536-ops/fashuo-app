import { describe, it, expect } from "vitest";
import { grepRows, rankBlocks } from "./search-tools";

/**
 * 争点共现加权（AND-boost）回归锁（2026-07-05）。
 * 事故：讲义作者标注框（提示/马工程）在库里、优先级也够，但答疑/教练实战引不到——
 * 单关键词子串检索表达不了"某概念(中止)下讲某争点(因果)那一条"，而这恰是唯一锁定它的条件；
 * 深页条目被浅页同词条目按文档序挤出返回窗口（实录：讲义"因果"命中18条、中止因果框P157排第14，截前10必丢）。
 * 修复：检索项可带 refine 特征词，原文同时命中 keyword+refine 的块无条件置顶。这些用例把它钉死。
 */
describe("争点共现加权 AND-boost（讲义提示/马工程被浅页挤掉的根治）", () => {
  // 仿真一整份讲义心得（一文件一行、页码序、条目间夹着其它主题条目）：
  // 浅页多条"因果"，深页 P157 才是"中止的因果"那条。中止条目间夹 filler，避免相邻块被合并。
  const jiangyiRows = [
    {
      path: "真题分析/_刑法讲义心得.md",
      start_line: 1,
      content: [
        "- 【讲义P76·提示】因果关系是结果犯的构成要件要素。", // 因果·无中止
        "- 【讲义P80·提示】介入因素的因果关系判断三步法，因果因果因果。", // 因果高频·无中止
        "- 【讲义P120·提示】正当防卫的限度不能明显超过必要。", // filler·两词都无
        "- 【讲义P143·提示】犯罪中止的时间性：在犯罪过程中放弃。", // 中止·无因果
        "- 【讲义P150·提示】共同犯罪的成立要件与分类。", // filler·隔开两条中止防合并
        "- 【讲义P157·马工程】如果中止行为与结果之间没有因果关系，就不符合犯罪中止的有效性特征。", // 中止+因果
      ].join("\n"),
    },
  ];

  it("keyword=中止 + refine=因果：原文同时含两词的深页条目排到最前", () => {
    const { blocks } = grepRows(
      jiangyiRows,
      (ln) => ln.includes("中止") && !/\.{6,}/.test(ln),
      "中止",
      0, // xinde 条目库：0 行上下文
      "因果",
    );
    // 命中"中止"的两条：P143（无因果）、P157（有因果）；refineHit 分别 false/true
    expect(blocks.map((b) => b.refineHit)).toEqual([false, true]);
    const ranked = rankBlocks(blocks, { refine: "因果" });
    expect(ranked[0].refineHit).toBe(true);
    expect(ranked[0].text).toContain("P157");
  });

  it("无 refine：退回稳定文档序（深页 P157 排在浅页 P143 之后 → 会被截窗）", () => {
    const { blocks } = grepRows(jiangyiRows, (ln) => ln.includes("中止"), "中止", 0);
    const ranked = rankBlocks(blocks, {});
    expect(ranked[0].text).toContain("P143"); // 平局→文档序，深页条目沉底
  });

  it("refine 用【原始整行】判定，不受 clipLine 裁剪影响（特征词被切出显示也照样置顶）", () => {
    // 超长行：主词在头、特征词甩到 160 字裁剪窗之外
    const longLine = "- 【讲义P200·提示】犯罪中止的成立" + "补充说明".repeat(60) + "最终落在因果关系上。";
    const rows = [{ path: "x.md", start_line: 1, content: longLine }];
    const { blocks } = grepRows(rows, (ln) => ln.includes("中止"), "中止", 0, "因果");
    expect(blocks[0].refineHit).toBe(true); // 尾部"因果"被裁出显示，但排序仍认它在原文里
    expect(blocks[0].text).not.toContain("因果"); // 证明显示确实被裁掉了
  });

  it("refine 无人同时命中时不误伤：退化为纯主词排序（都不含特征词→保持文档序）", () => {
    const { blocks } = grepRows(
      jiangyiRows,
      (ln) => ln.includes("正当防卫"),
      "正当防卫",
      0,
      "因果", // P120 那条正当防卫不含因果
    );
    expect(blocks.every((b) => !b.refineHit)).toBe(true);
    const ranked = rankBlocks(blocks, { refine: "因果" });
    expect(ranked[0].text).toContain("P120"); // 稳定序不变
  });

  it("docOrder=true（真题）不参与加权：原样返回", () => {
    const blocks = [
      { path: "z.md", hitLines: [2], text: "b", refineHit: false },
      { path: "z.md", hitLines: [1], text: "a", refineHit: true },
    ];
    const ranked = rankBlocks(blocks, { refine: "x", docOrder: true });
    expect(ranked.map((b) => b.text)).toEqual(["b", "a"]); // 未重排
  });
});
