// [gpt] 2026-08-15：回归英语阅读别名与非法活动硬失败，避免周流水再次被“其他”过滤。
import { describe, expect, it } from "vitest";
import {
  normalizeStudyActivity,
  recitationModeFromActivity,
  withRecitationModeMarker,
} from "./study-activity.mjs";

describe("normalizeStudyActivity", () => {
  it("保留规范活动", () => {
    expect(normalizeStudyActivity("做题")).toBe("做题");
  });

  it("把英语阅读精刷归入做题", () => {
    expect(normalizeStudyActivity("阅读精刷")).toBe("做题");
  });

  it("把带背和自背统一归入背诵，并保留方式详情", () => {
    expect(normalizeStudyActivity("带背")).toBe("背诵");
    expect(normalizeStudyActivity("自背")).toBe("背诵");
    expect(recitationModeFromActivity("带背")).toBe("带背");
    expect(recitationModeFromActivity("自背")).toBe("自背");
    expect(withRecitationModeMarker("第一轮完成", "自背")).toBe("[背诵方式=自背] 第一轮完成");
    expect(withRecitationModeMarker("[背诵方式=带背] 整节收官", "自背")).toBe("[背诵方式=自背] 整节收官");
  });

  it("未提供活动时保留既有其他兜底", () => {
    expect(normalizeStudyActivity(undefined)).toBe("其他");
  });

  it("拒绝未知显式活动而不是静默降级", () => {
    expect(() => normalizeStudyActivity("刷题打卡")).toThrow(/activity 不合法/);
  });
});
