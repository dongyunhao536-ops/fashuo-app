import { describe, expect, it } from "vitest";
import { buildKnowledgeDecayProfile, calculateDimensionDecay, projectDecayIndex } from "./knowledge-decay.mjs";

const ev = (date, result = "pass", overrides = {}) => ({
  evidenceDate: date,
  dimension: "recall",
  result,
  promptIntegrity: "clean",
  cold: true,
  valid: true,
  ...overrides,
});

describe("knowledge time decay", () => {
  it("保留历史通过，但半年后不再把它当作今天仍可依赖", () => {
    const profile = buildKnowledgeDecayProfile([ev("2026-02-10")], "2026-08-10");
    expect(profile.dimensions.recall).toMatchObject({ supported: true, isCurrent: false, status: "decayed" });
    expect(profile.dimensions.recall.retentionIndex).toBeLessThan(5);
    expect(profile.policy).toContain("不是记忆概率");
  });

  it("提示后通过不建立可衰减的掌握基线", () => {
    const decay = calculateDimensionDecay([ev("2026-08-09", "pass", { promptIntegrity: "cued", cold: false })], "recall", "2026-08-10");
    expect(decay).toMatchObject({ supported: false, retentionIndex: 0, status: "not-demonstrated" });
  });

  it("真实通过到后来失败的间隔会校准半衰期", () => {
    const decay = calculateDimensionDecay([
      ev("2026-07-01"),
      ev("2026-07-09", "fail"),
      ev("2026-07-15"),
      ev("2026-07-25", "partial"),
      ev("2026-08-05"),
    ], "recall", "2026-08-10");
    expect(decay.halfLifeDays).toBe(9);
    expect(decay.calibration).toMatchObject({ source: "observed-pass-to-setback", confidence: "high", forgettingIntervals: [8, 10] });
  });

  it("可在不改写证据的情况下投影到未来日期", () => {
    const decay = calculateDimensionDecay([ev("2026-08-10")], "recall", "2026-08-10");
    expect(projectDecayIndex(decay, "2026-08-24")).toBe(50);
    expect(decay.nextReviewDate).toBe("2026-08-16");
  });
});
