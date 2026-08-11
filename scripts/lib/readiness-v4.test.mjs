import { describe, expect, it } from "vitest";
import { buildTargetReadinessV4 } from "../../src/lib/readiness-v4.mjs";

// [gpt] 2026-08-10：v4 测试钉住“目标分、真实卷、零证据政治、三次模考闸门”四条新不变量。
const lawNames = ["刑法", "民法", "法理", "宪法", "法制史"];

function law(subject, overrides = {}) {
  return {
    subject,
    weight: { 刑法: 75, 民法: 75, 法理: 60, 宪法: 50, 法制史: 40 }[subject],
    total: { 刑法: 21, 民法: 21, 法理: 13, 宪法: 5, 法制史: 7 }[subject],
    covered: 0,
    progress: 0,
    depth: 0,
    recitePct: 0,
    open: 0,
    absorbed: 0,
    repeat: 0,
    closure: null,
    quality: 50,
    ability: 0,
    ...overrides,
  };
}

function quant(subjectOverrides = {}, englishOverrides = {}) {
  return {
    subjects: lawNames.map((subject) => law(subject, subjectOverrides[subject])),
    overall: {
      english: {
        ability: 0,
        reading: null,
        papers14d: 0,
        essays30d: 0,
        open: 0,
        absorbed: 0,
        repeat: 0,
        closure: null,
        ...englishOverrides,
      },
    },
  };
}

function build({ snapshot = quant(), logs = [], topicRows = [], mockRecords = [] } = {}) {
  return buildTargetReadinessV4({
    quantV3: snapshot,
    logs,
    topicRows,
    mockRecords,
    referenceDate: "2026-08-10",
    targets: {
      总分: 378,
      拆分: { 政治: 65, 英语一: 75, 专业基础: 115, 综合: 123 },
      科目拆分: { 刑法: 62, 民法: 53, 法理: 50, 宪法: 40, 法制史: 33 },
    },
  });
}

function accuracyLogs(subject, values) {
  return values.map((accuracy, index) => ({ subject, accuracy, activity: "做题", chapter: "测试", log_date: `2026-08-${String(10 - index).padStart(2, "0")}` }));
}

describe("目标达成指数 v4", () => {
  it("零证据就是 0，政治 65 分不会被 313 分口径偷偷抹掉", () => {
    const result = build();
    expect(result.overall).toMatchObject({ index: 0, trackedTargetPoints: 313, fullTarget: 378, untrackedTargetPoints: 65 });
    expect(result.overall.untrackedSubjects).toEqual([{ subject: "政治", target: 65, treatment: "zero-evidence" }]);
  });

  it("即使已追踪科目过程证据全部拉满，模考前也最多覆盖 313/378≈83", () => {
    const full = Object.fromEntries(lawNames.map((subject) => [subject, { covered: 99, progress: 100, depth: 100, recitePct: 100 }]));
    const logs = lawNames.flatMap((subject) => accuracyLogs(subject, Array(8).fill(100))).concat(accuracyLogs("英语", Array(8).fill(100)));
    const result = build({ snapshot: quant(full, { papers14d: 4, essays30d: 2 }), logs });
    expect(result.overall.index).toBe(83);
    expect(result.overall.trackedIndex).toBe(100);
  });

  it("销账只消除风险，不会比从未出现错题的同一学习证据获得额外奖励", () => {
    const base = { covered: 10, progress: 50, depth: 40, recitePct: 30 };
    const clean = build({ snapshot: quant({ 刑法: base }) }).subjects[0];
    const absorbedOnly = build({ snapshot: quant({ 刑法: { ...base, absorbed: 20 } }) }).subjects[0];
    expect(absorbedOnly.readiness).toBe(clean.readiness);
    expect(absorbedOnly.targetAttainment).toBe(clean.targetAttainment);
  });

  it("同量证据下未闭环和重犯会降分，open 转 absorbed 会回升", () => {
    const base = { covered: 10, progress: 50, depth: 40, recitePct: 30 };
    const open = build({ snapshot: quant({ 刑法: { ...base, open: 8, absorbed: 2, repeat: 3 } }) }).subjects[0];
    const closed = build({ snapshot: quant({ 刑法: { ...base, open: 2, absorbed: 8, repeat: 1 } }) }).subjects[0];
    expect(closed.riskPenalty).toBeLessThan(open.riskPenalty);
    expect(closed.readiness).toBeGreaterThan(open.readiness);
  });

  it("新增 open 不会靠稀释重犯率让风险下降", () => {
    const base = { covered: 10, progress: 50, depth: 40, recitePct: 30, absorbed: 0, repeat: 10 };
    const before = build({ snapshot: quant({ 刑法: { ...base, open: 10 } }) }).subjects[0];
    const after = build({ snapshot: quant({ 刑法: { ...base, open: 11 } }) }).subjects[0];
    expect(after.riskPenalty).toBeGreaterThanOrEqual(before.riskPenalty);
    expect(after.readiness).toBeLessThanOrEqual(before.readiness);
  });

  it("训练正确率是校准证据：低正确率可以推低只看动作的先验", () => {
    const base = { covered: 21, progress: 100, depth: 100, recitePct: 100 };
    const noTest = build({ snapshot: quant({ 刑法: base }) }).subjects[0];
    const failedTests = build({ snapshot: quant({ 刑法: base }), logs: accuracyLogs("刑法", Array(8).fill(0)) }).subjects[0];
    expect(failedTests.performanceSamples).toBe(8);
    expect(failedTests.readiness).toBeLessThan(noTest.readiness);
  });

  it("没有正确率的普通流水不是 0 分作答，不能挤掉真实训练样本", () => {
    const logs = [
      ...Array.from({ length: 12 }, (_, index) => ({ subject: "刑法", accuracy: null, activity: "背诵", chapter: "普通流水", log_date: `2026-08-${String(10 - Math.min(index, 9)).padStart(2, "0")}` })),
      ...accuracyLogs("刑法", [90, 80]),
    ];
    const result = build({ snapshot: quant({ 刑法: { progress: 50, depth: 40, recitePct: 30 } }), logs }).subjects[0];
    expect(result.performanceSamples).toBe(2);
    expect(result.performance).toBe(85);
  });

  it("短板按真实试卷聚合，不把某一内部学科直接冒充单科线", () => {
    const result = build({ snapshot: quant({
      刑法: { progress: 100, depth: 100, recitePct: 100 },
      民法: { progress: 100, depth: 100, recitePct: 100 },
      法理: { progress: 50, depth: 40, recitePct: 30 },
      宪法: { progress: 0, depth: 0, recitePct: 0 },
      法制史: { progress: 50, depth: 40, recitePct: 30 },
    }, { papers14d: 4 }) });
    expect(result.overall.weakestPaper.paper).toBe("英语");
    expect(result.papers.map((paper) => paper.paper)).toEqual(["专业基础", "专业综合", "英语"]);
  });

  it("不足 3 次完整模考不污染主数，第 3 次起才按样本量校准", () => {
    const two = [
      { 日期: "2026-09-01", 总分: 300, 拆分: { 政治: 60, 英语: 65, 专业基础: 85, 专业综合: 90 } },
      { 日期: "2026-09-08", 总分: 315, 拆分: { 政治: 62, 英语: 68, 专业基础: 90, 专业综合: 95 } },
    ];
    const structural = build({ mockRecords: two });
    const calibrated = build({ mockRecords: [...two, { 日期: "2026-09-15", 总分: 330, 拆分: { 政治: 65, 英语: 70, 专业基础: 95, 专业综合: 100 } }] });
    expect(structural.overall.calibration).toMatchObject({ tier: "structural-only", completeMocks: 2, mockWeight: 0 });
    expect(structural.overall.index).toBe(structural.overall.processIndex);
    expect(calibrated.overall.calibration).toMatchObject({ tier: "trend-calibrated", completeMocks: 3, mockWeight: 0.5 });
    expect(calibrated.overall.index).toBeGreaterThan(calibrated.overall.processIndex);
  });

  it("只有总分、没有四张卷完整拆分的记录不能越过模考闸门", () => {
    const result = build({ mockRecords: [
      { 日期: "2026-09-01", 总分: 300 },
      { 日期: "2026-09-08", 总分: 315 },
      { 日期: "2026-09-15", 总分: 330 },
    ] });
    expect(result.overall.calibration).toMatchObject({ tier: "structural-only", completeMocks: 0 });
  });

  it("当前真实形状落在可解释区间，而不是沿用 v3 的 29", () => {
    const snapshot = quant({
      刑法: { covered: 21, progress: 100, depth: 57, recitePct: 33, open: 21, absorbed: 32, repeat: 5 },
      民法: { covered: 11, progress: 52, depth: 32, recitePct: 0, open: 5, absorbed: 5, repeat: 0 },
      法理: { covered: 12, progress: 92, depth: 56, recitePct: 85, open: 13, absorbed: 4, repeat: 0 },
      宪法: { covered: 0, progress: 0, depth: 0, recitePct: 0 },
      法制史: { covered: 2, progress: 29, depth: 19, recitePct: 29, open: 5, absorbed: 0, repeat: 0 },
    }, { papers14d: 4, essays30d: 0, open: 5, absorbed: 0, repeat: 0 });
    const logs = [
      ...accuracyLogs("刑法", Array(7).fill(91)),
      ...accuracyLogs("民法", Array(6).fill(91)),
      ...accuracyLogs("法理", Array(5).fill(88)),
      ...accuracyLogs("法制史", Array(3).fill(84)),
      ...accuracyLogs("英语", Array(4).fill(75)),
    ];
    const result = build({ snapshot, logs });
    expect(result.overall.index).toBeGreaterThanOrEqual(35);
    expect(result.overall.index).toBeLessThanOrEqual(45);
    expect(result.overall.weakestPaper.paper).toBe("专业综合");
  });
});
