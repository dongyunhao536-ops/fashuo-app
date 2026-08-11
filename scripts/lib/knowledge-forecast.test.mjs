import { describe, expect, it } from "vitest";
import { buildExamLossForecast, buildMockScoreCalibration } from "./knowledge-forecast.mjs";

function point(kpId, overrides = {}) {
  return {
    kpId,
    subject: "刑法",
    name: kpId,
    activated: true,
    stage: "recall",
    stageLabel: "能复述",
    demonstratedStage: "recall",
    demonstratedStageLabel: "能复述",
    decayedFrom: null,
    riskScore: 60,
    importanceScore: 80,
    dueDate: "2026-08-10",
    evidence: [],
    decay: {
      dimensions: {
        recall: { supported: true, latestCleanPassDate: "2026-08-10", halfLifeDays: 14 },
        application: { supported: false },
      },
    },
    ...overrides,
  };
}

describe("exam loss forecast", () => {
  it("把长期未复检的历史会做投影成考试日高失分压力", () => {
    const old = point("XF-0001", {
      stage: "exposed",
      stageLabel: "已接触（理解待证）",
      demonstratedStage: "application",
      demonstratedStageLabel: "能应用",
      decayedFrom: "application",
      decay: {
        dimensions: {
          recall: { supported: true, latestCleanPassDate: "2026-02-01", halfLifeDays: 14 },
          application: { supported: true, latestCleanPassDate: "2026-02-01", halfLifeDays: 21 },
        },
      },
    });
    const result = buildExamLossForecast({
      referenceDate: "2026-08-10",
      examDate: "2026-12-19",
      knowledgeStates: { items: [old] },
      knowledgeGraph: { byKnowledgePoint: [] },
      failurePortrait: { byKnowledgePoint: [] },
    });
    expect(result.hotspots[0].riskBand).toBe("critical");
    expect(result.hotspots[0].drivers[0]).toContain("已衰减");
    expect(result.calibration).toMatchObject({ canProjectScore: false, rankingConfidence: "low" });
  });

  it("前置缺口进入失分驱动项，但不被写成概率", () => {
    const result = buildExamLossForecast({
      referenceDate: "2026-08-10",
      examDate: "2026-12-19",
      knowledgeStates: { items: [point("XF-0002")] },
      knowledgeGraph: { byKnowledgePoint: [{ kpId: "XF-0002", blockers: [{ kpId: "XF-0001", requiredStage: "understanding", stage: "unseen", root: true, path: ["XF-0001", "XF-0002"] }] }] },
      failurePortrait: { byKnowledgePoint: [] },
    });
    expect(result.hotspots[0].drivers.join(" ")).toContain("未满足前置");
    expect(result.policy).toContain("不是丢分概率");
  });

  it("未激活高重要度点只列观测盲区，不判不会", () => {
    const result = buildExamLossForecast({
      referenceDate: "2026-08-10",
      examDate: "2026-12-19",
      knowledgeStates: { items: [point("XF-0001"), point("XF-0002", { activated: false, importanceScore: 90 })] },
      knowledgeGraph: { byKnowledgePoint: [] },
      failurePortrait: { byKnowledgePoint: [] },
    });
    expect(result.coverageBlindSpots).toEqual([expect.objectContaining({ kpId: "XF-0002", status: "unobserved-not-proven-weak" })]);
  });

  it("至少三个同口径科目拆分模考才开启经验分数投影", () => {
    const targets = { "科目拆分": { "刑法": 75 } };
    const two = buildMockScoreCalibration([
      { 日期: "2026-09-01", 科目拆分: { 刑法: 50 } },
      { 日期: "2026-10-01", 科目拆分: { 刑法: 55 } },
    ], targets, "2026-12-19");
    expect(two.canProjectScore).toBe(false);
    const three = buildMockScoreCalibration([
      { 日期: "2026-09-01", 科目拆分: { 刑法: 50 } },
      { 日期: "2026-10-01", 科目拆分: { 刑法: 55 } },
      { 日期: "2026-11-01", 科目拆分: { 刑法: 60 } },
    ], targets, "2026-12-19");
    expect(three).toMatchObject({ canProjectScore: true, eligibleRecords: 3 });
    expect(three.canProjectProbability).toBe(false);
    expect(three.subjects[0]).toMatchObject({ forecastTier: "trend-band", projection: { attainmentProbability: null } });
    expect(three.subjects[0].projection.projected).toBeGreaterThan(60);
  });

  it("至少六个同口径完整模考才允许输出带区间的达标概率", () => {
    const result = buildMockScoreCalibration([
      { 日期: "2026-06-01", 科目拆分: { 刑法: 46 } },
      { 日期: "2026-07-01", 科目拆分: { 刑法: 49 } },
      { 日期: "2026-08-01", 科目拆分: { 刑法: 52 } },
      { 日期: "2026-09-01", 科目拆分: { 刑法: 55 } },
      { 日期: "2026-10-01", 科目拆分: { 刑法: 58 } },
      { 日期: "2026-11-01", 科目拆分: { 刑法: 61 } },
    ], { 科目拆分: { 刑法: 62 } }, "2026-12-19");
    expect(result).toMatchObject({
      eligibleRecords: 6,
      canProjectScore: true,
      canProjectProbability: true,
      subjects: [{
        subject: "刑法",
        samples: 6,
        forecastTier: "probability",
        projection: { probabilityConfidence: "low", modelVersion: "ols-normal-v1" },
      }],
    });
    expect(result.subjects[0].projection.attainmentProbability).toBeGreaterThanOrEqual(2);
    expect(result.subjects[0].projection.attainmentProbability).toBeLessThanOrEqual(98);
    expect(result.subjects[0].projection.probabilityBand).toHaveLength(2);
  });

  it("零散单科成绩不能拼成完整模考，趋势也不会被目标分截断", () => {
    const targets = { "科目拆分": { 刑法: 62, 民法: 53 } };
    const incomplete = buildMockScoreCalibration([
      { 日期: "2026-09-01", 科目拆分: { 刑法: 58 } },
      { 日期: "2026-10-01", 科目拆分: { 民法: 48 } },
      { 日期: "2026-11-01", 科目拆分: { 刑法: 64, 民法: 50 } },
    ], targets, "2026-12-19");
    expect(incomplete).toMatchObject({ canProjectScore: false, eligibleRecords: 1, observedRecords: 3 });

    const complete = buildMockScoreCalibration([
      { 日期: "2026-09-01", 科目拆分: { 刑法: 58, 民法: 45 } },
      { 日期: "2026-10-01", 科目拆分: { 刑法: 61, 民法: 48 } },
      { 日期: "2026-11-01", 科目拆分: { 刑法: 64, 民法: 51 } },
    ], targets, "2026-12-19");
    expect(complete.canProjectScore).toBe(true);
    expect(complete.subjects[0]).toMatchObject({ targetScore: 62, maximumScore: 75 });
    expect(complete.subjects[0].projection.projected).toBeGreaterThan(62);
  });
});
