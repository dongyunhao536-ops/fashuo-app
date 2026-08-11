// [gpt] 2026-08-10：概率预测的留账、幂等、对账和校准门槛测试。
import { describe, expect, it } from "vitest";
import {
  appendMockCalibrationForecasts,
  appendProbabilityForecast,
  parseProbabilityForecastLedger,
  resolveProbabilityForecast,
  summarizeProbabilityForecastLedger,
  voidProbabilityForecast,
} from "./forecast-ledger.mjs";

const TODAY = "2026-08-10";

function fields(overrides = {}) {
  return {
    targetDate: "2026-12-19",
    subject: "刑法",
    event: "刑法卷面分≥62",
    probability: 62,
    lower: 45,
    upper: 76,
    confidence: "low",
    model: "ols-normal-v1",
    evidenceRef: "complete-mock-dates:1,2,3,4,5,6",
    ...overrides,
  };
}

describe("probability forecast ledger", () => {
  it("空账可初始化，且同一证据版本幂等", () => {
    const first = appendProbabilityForecast("", fields(), { referenceDate: TODAY });
    expect(first).toMatchObject({ added: true, id: "F0001" });
    expect(parseProbabilityForecastLedger(first.markdown).counts.errors).toBe(0);
    const again = appendProbabilityForecast(first.markdown, fields({ probability: 70 }), { referenceDate: "2026-08-11" });
    expect(again).toMatchObject({ added: false, id: "F0001", reason: "same-evidence-version" });
  });

  it("禁止没有区间、模型或证据版本的裸概率", () => {
    expect(() => appendProbabilityForecast("", fields({ evidenceRef: "" }), { referenceDate: TODAY })).toThrow("禁止裸概率");
    expect(() => appendProbabilityForecast("", fields({ lower: 70 }), { referenceDate: TODAY })).toThrow("概率区间");
  });

  it("只能在目标日后用 0/1 对账，重复对账幂等", () => {
    const first = appendProbabilityForecast("", fields(), { referenceDate: TODAY });
    expect(() => resolveProbabilityForecast(first.markdown, "F0001", 1, { date: "2026-12-18" })).toThrow("目标日");
    const resolved = resolveProbabilityForecast(first.markdown, "F0001", 1, { date: "2026-12-19", actual: 64 });
    expect(parseProbabilityForecastLedger(resolved.markdown).items[0]).toMatchObject({ status: "resolved", outcome: 1, actual: 64 });
    expect(resolveProbabilityForecast(resolved.markdown, "F0001", 0, { date: "2026-12-20" }).changed).toBe(false);
  });

  it("Brier、偏差与分桶按二元结果计算，低样本保持 collecting", () => {
    let markdown = appendProbabilityForecast("", fields(), { referenceDate: TODAY }).markdown;
    markdown = appendProbabilityForecast(markdown, fields({ subject: "民法", event: "民法卷面分≥55", probability: 20, lower: 10, upper: 35, evidenceRef: "mock:v2" }), { referenceDate: TODAY }).markdown;
    markdown = resolveProbabilityForecast(markdown, "F0001", 1, { date: "2026-12-19", actual: 64 }).markdown;
    markdown = resolveProbabilityForecast(markdown, "F0002", 0, { date: "2026-12-19", actual: 52 }).markdown;
    const summary = summarizeProbabilityForecastLedger(parseProbabilityForecastLedger(markdown), { referenceDate: "2026-12-20" });
    expect(summary).toMatchObject({ calibrationStatus: "collecting", counts: { resolved: 2, dueUnresolved: 0 } });
    expect(summary.overall.brierScore).toBeCloseTo(((0.62 - 1) ** 2 + (0.2 - 0) ** 2) / 2, 4);
    expect(summary.buckets).toHaveLength(2);
  });

  it("取消事件以 void 结案，不进入 Brier 分母", () => {
    const first = appendProbabilityForecast("", fields(), { referenceDate: TODAY });
    const voided = voidProbabilityForecast(first.markdown, "F0001", { date: "2026-09-01", note: "目标口径变更" });
    const summary = summarizeProbabilityForecastLedger(parseProbabilityForecastLedger(voided.markdown), { referenceDate: "2026-12-20" });
    expect(summary).toMatchObject({ counts: { void: 1, resolved: 0 }, overall: { brierScore: null } });
  });

  it("模考概率批量落账，只有新证据日期集合才新增", () => {
    const calibration = {
      canProjectProbability: true,
      subjects: [{
        subject: "刑法",
        targetScore: 62,
        samples: 6,
        evidenceDates: ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"],
        projection: {
          attainmentProbability: 72,
          probabilityBand: [55, 84],
          probabilityConfidence: "low",
          modelVersion: "ols-normal-v1",
          projected: 65,
          band: [60, 70],
        },
      }],
    };
    const first = appendMockCalibrationForecasts("", calibration, { referenceDate: TODAY, targetDate: "2026-12-19" });
    expect(first.additions).toHaveLength(1);
    const second = appendMockCalibrationForecasts(first.markdown, calibration, { referenceDate: "2026-08-11", targetDate: "2026-12-19" });
    expect(second.additions).toHaveLength(0);
  });
});
