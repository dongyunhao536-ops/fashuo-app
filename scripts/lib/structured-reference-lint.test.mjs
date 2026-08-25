import { describe, expect, it } from "vitest";
import { assertStructuredReferencesHaveSummary, findBareStructuredReferences } from "./structured-reference-lint.mjs";

describe("F6 structured bare reference lint", () => {
  it("拦住新增孤立裸编号，但不回猜编号本身的含义", () => {
    for (const value of ["入账 #72。", "已入账 #64（--recur-of 52）", "→ 新挂 L10", "法理5主题(#79#80#83#84#86)首发验"]) {
      expect(() => assertStructuredReferencesHaveSummary(value, { field: "fixture" }))
        .toThrow(/BARE_REFERENCE_SUMMARY_REQUIRED/);
    }
  });

  it("内容摘要和并列编号串放行，T# 机器稳定引用不属于 F6 裸编号", () => {
    expect(findBareStructuredReferences("#72：监护顺位；L10 刑法主观要件；T3 处分行为")).toEqual([]);
    expect(findBareStructuredReferences("L28／L29／L30")).toEqual([]);
    expect(findBareStructuredReferences("X23／L2（07-27）＋L10（07-29）")).toEqual([]);
    expect(findBareStructuredReferences("T#10/E#25")).toEqual([]);
  });
});
