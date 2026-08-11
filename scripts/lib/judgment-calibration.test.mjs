import { describe, expect, it } from "vitest";
import { calibrateJudgments, formatCalibrationReport } from "./judgment-calibration.mjs";

const TODAY = "2026-08-07";

// [gpt] 2026-08-10：验证任务量校准只依据兑现不足减量，不臆测低估。
function item(overrides = {}) {
  return {
    id: "J0001", date: "2026-08-01", type: "排期", subject: "", ref: "",
    prediction: "", basis: "", verifyDate: "2026-08-02", result: "pending",
    resolvedDate: null, seed: 0, note: "", line: 1,
    ...overrides,
  };
}

describe("judgment calibration", () => {
  it("任务量乐观偏差给出减量建议与执行量系数", () => {
    const items = [
      item({ id: "J0001", type: "排期", result: "miss", resolvedDate: "2026-08-02" }),
      item({ id: "J0002", type: "排期", result: "miss", resolvedDate: "2026-08-03" }),
      item({ id: "J0003", type: "排期", result: "miss", resolvedDate: "2026-08-04" }),
      item({ id: "J0004", type: "排期", result: "hit", resolvedDate: "2026-08-05" }),
      item({ id: "J0005", type: "排期", result: "hit", resolvedDate: "2026-08-06" }),
    ];
    const report = calibrateJudgments({ items }, { referenceDate: TODAY });
    expect(report.groups.任务量.hitRate).toBe(40);
    expect(report.groups.任务量.deviation).toMatchObject({ direction: "optimistic", percent: 60, reductionPct: 30 });
    expect(report.groups.任务量.advice).toContain("减少");
    expect(report.executionFactor.value).toBe(0.7);
    expect(report.executionFactor.basis).toContain("高估");
  });

  it("样本不足不给建议也不出执行量系数", () => {
    const report = calibrateJudgments({ items: [item({ result: "hit", resolvedDate: "2026-08-02" }), item({ result: "miss", resolvedDate: "2026-08-03" })] }, { referenceDate: TODAY });
    expect(report.groups.任务量.hitRate).toBe(50);
    expect(report.groups.任务量.deviation).toBeNull();
    expect(report.groups.任务量.advice).toContain("N<5");
    expect(report.executionFactor).toBeNull();
  });

  it("窗口只统计最近 30 天，窗口外与种子不计", () => {
    const items = [
      item({ id: "J0001", type: "事实", result: "hit", resolvedDate: "2026-07-01" }),
      item({ id: "J0002", type: "事实", result: "hit", resolvedDate: "2026-08-01" }),
      item({ id: "J0003", type: "事实", result: "miss", resolvedDate: "2026-08-02", seed: 1 }),
      item({ id: "J0004", type: "事实", result: "hit", resolvedDate: "2026-08-03" }),
    ];
    const report = calibrateJudgments({ items }, { referenceDate: TODAY });
    expect(report.window.from).toBe("2026-07-09");
    expect(report.overall.countable).toBe(2);
    expect(report.groups.事实.hitRate).toBe(100);
  });

  it("高兑现率给出保持建议，无偏差时执行量系数为空", () => {
    const items = [
      item({ id: "J0001", type: "栽点", result: "hit", resolvedDate: "2026-08-02" }),
      item({ id: "J0002", type: "栽点", result: "hit", resolvedDate: "2026-08-03" }),
      item({ id: "J0003", type: "栽点", result: "hit", resolvedDate: "2026-08-04" }),
      item({ id: "J0004", type: "栽点", result: "hit", resolvedDate: "2026-08-05" }),
      item({ id: "J0005", type: "栽点", result: "hit", resolvedDate: "2026-08-06" }),
    ];
    const report = calibrateJudgments({ items }, { referenceDate: TODAY });
    expect(report.groups.栽点.advice).toContain("保持");
    expect(report.executionFactor).toBeNull();
  });

  it("栽点预测按科目校准，低样本不改策略", () => {
    const items = [
      item({ id: "J0001", type: "栽点", subject: "刑法", result: "hit", resolvedDate: "2026-08-01" }),
      item({ id: "J0002", type: "栽点", subject: "刑法", result: "hit", resolvedDate: "2026-08-02" }),
      item({ id: "J0003", type: "病根候选", subject: "刑法", result: "hit", resolvedDate: "2026-08-03" }),
      item({ id: "J0004", type: "栽点", subject: "刑法", result: "miss", resolvedDate: "2026-08-04" }),
      item({ id: "J0005", type: "栽点", subject: "刑法", result: "miss", resolvedDate: "2026-08-05" }),
      item({ id: "J0006", type: "栽点", subject: "民法", result: "hit", resolvedDate: "2026-08-06" }),
      item({ id: "J0007", type: "栽点", subject: "民法", result: "miss", resolvedDate: "2026-08-07" }),
    ];
    const report = calibrateJudgments({ items }, { referenceDate: TODAY });
    expect(report.stumblePredictionBySubject.刑法).toMatchObject({ countable: 5, hitRate: 60, sufficient: true });
    expect(report.stumblePredictionBySubject.刑法.advice).toContain("降低诊断置信度");
    expect(report.stumblePredictionBySubject.民法).toMatchObject({ countable: 2, sufficient: false });
    expect(report.stumblePredictionBySubject.民法.advice).toContain("不据此改变训练策略");

    const text = formatCalibrationReport(report);
    expect(text).toContain("栽点预测·分科校准");
    expect(text).toContain("不是学生掌握率");
    expect(text).toContain("民法：兑现率 50%｜2 条");
  });

  it("任务量全部命中时保持原量，不从二元结果臆测低估并加量", () => {
    const items = [
      item({ id: "J0001", type: "排期", result: "hit", resolvedDate: "2026-08-02" }),
      item({ id: "J0002", type: "排期", result: "hit", resolvedDate: "2026-08-03" }),
      item({ id: "J0003", type: "排期", result: "hit", resolvedDate: "2026-08-04" }),
      item({ id: "J0004", type: "排期", result: "hit", resolvedDate: "2026-08-05" }),
      item({ id: "J0005", type: "排期", result: "hit", resolvedDate: "2026-08-06" }),
    ];
    const report = calibrateJudgments({ items }, { referenceDate: TODAY });
    expect(report.groups.任务量.deviation).toBeNull();
    expect(report.groups.任务量.advice).toContain("保持");
    expect(report.executionFactor).toBeNull();
  });

  it("报告可格式化输出（含自纠偏闭环说明）", () => {
    const items = [
      item({ id: "J0001", type: "排期", result: "miss", resolvedDate: "2026-08-02" }),
      item({ id: "J0002", type: "排期", result: "miss", resolvedDate: "2026-08-03" }),
      item({ id: "J0003", type: "排期", result: "partial", resolvedDate: "2026-08-04" }),
      item({ id: "J0004", type: "排期", result: "partial", resolvedDate: "2026-08-05" }),
      item({ id: "J0005", type: "排期", result: "hit", resolvedDate: "2026-08-06" }),
    ];
    const text = formatCalibrationReport(calibrateJudgments({ items }, { referenceDate: TODAY }));
    expect(text).toContain("=== 教练判断校准 ===");
    expect(text).toContain("任务量预测");
    expect(text).toContain("自纠偏闭环");
    expect(text).toContain("执行量系数");
  });
});
