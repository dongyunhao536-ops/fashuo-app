import { describe, expect, it } from "vitest";
import {
  buildExamRiskModel,
  buildPredictiveDispatch,
  buildReciteMemoryModel,
  buildTopicLearningStates,
  extractReciteReviewEvidence,
  fitDispatchToSchedule,
} from "./learning-coach.mjs";

const TODAY = "2026-08-05";

function topic(overrides = {}) {
  return {
    id: 1,
    subject: "刑法学",
    title: "因果关系",
    chapter: "犯罪论",
    classificationStatus: "confirmed",
    masteryStatus: "open",
    eventCounts: { open: 0, absorbed: 1, dismissed: 0 },
    eventTotal: 1,
    confirmedRootCauses: [],
    latestEventDate: "2026-07-20",
    latestOpenDate: "",
    active: false,
    recurrent: false,
    ...overrides,
  };
}

function stateFor(topicOverrides, reviews = []) {
  return buildTopicLearningStates({ topics: [topic(topicOverrides)] }, reviews, TODAY).items[0];
}

describe("learning coach topic state machine", () => {
  it("覆盖发现、确认、短期通过、冷却、稳定与长期保持", () => {
    expect(stateFor({ classificationStatus: "pending" }).state).toBe("discovered");
    expect(stateFor({}).state).toBe("confirmed");
    expect(stateFor({}, [{ topic_id: 1, review_date: TODAY, result: "pass" }]).state).toBe("short_pass");
    expect(stateFor({}, [{ topic_id: 1, review_date: "2026-07-30", result: "pass" }]).state).toBe("cooling");
    expect(stateFor({}, [
      { topic_id: 1, review_date: "2026-07-20", result: "pass" },
      { topic_id: 1, review_date: "2026-07-28", result: "pass" },
    ]).state).toBe("stable");
    expect(stateFor({}, [
      { topic_id: 1, review_date: "2026-07-10", result: "pass" },
      { topic_id: 1, review_date: "2026-07-20", result: "pass" },
      { topic_id: 1, review_date: "2026-07-30", result: "pass" },
    ]).state).toBe("maintenance");
  });

  it("最近失败或稳定后出现新 open 事件都会退回强化", () => {
    expect(stateFor({}, [
      { topic_id: 1, review_date: "2026-07-28", result: "pass" },
      { topic_id: 1, review_date: "2026-08-04", result: "fail" },
    ]).state).toBe("reinforcing");

    expect(stateFor({
      active: true,
      recurrent: true,
      latestEventDate: "2026-08-04",
      latestOpenDate: "2026-08-04",
      eventCounts: { open: 1, absorbed: 1, dismissed: 0 },
    }, [
      { topic_id: 1, review_date: "2026-07-20", result: "pass" },
      { topic_id: 1, review_date: "2026-07-28", result: "pass" },
    ]).state).toBe("reinforcing");
  });

  it("用通过到再次失败的实际间隔替代默认遗忘间隔", () => {
    const result = stateFor({}, [
      { topic_id: 1, review_date: "2026-07-20", result: "pass" },
      { topic_id: 1, review_date: "2026-07-25", result: "fail" },
      { topic_id: 1, review_date: "2026-07-30", result: "pass" },
      { topic_id: 1, review_date: "2026-08-04", result: "fail" },
    ]);
    expect(result.estimatedRetentionDays).toBe(5);
    expect(result.intervalEvidence).toMatchObject({ source: "observed-pass-to-fail", confidence: "high" });
  });
});

describe("learning coach recite memory model", () => {
  it("不把当场或明确不算的通过当作合格冷检", () => {
    const evidence = extractReciteReviewEvidence({ block: [
      "- **复检（08-01）**：原文刚在眼前，当场复述 ✓，本次不算",
      "- **冷启动（08-03）**：半✓，边界漏了",
      "- **抽查（08-05）**：A✓、B✗，总体未过",
    ].join("\n") }, TODAY);
    expect(evidence).toEqual([
      expect.objectContaining({ date: "2026-08-01", result: "pass", qualifying: false }),
      expect.objectContaining({ date: "2026-08-03", result: "partial", qualifying: true }),
      expect.objectContaining({ date: "2026-08-05", result: "fail", qualifying: true }),
    ]);
  });

  it("输出按掉落风险排序的前 20 项", () => {
    const records = Array.from({ length: 24 }, (_, index) => ({
      id: `L${index + 1}`,
      subject: index % 2 ? "法理学" : "刑法学",
      title: `背诵点${index + 1}`,
      status: "active",
      route: "daibei",
      openedOn: "2026-07-01",
      lastTouchedOn: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
      block: "",
    }));
    const result = buildReciteMemoryModel({ records }, TODAY);
    expect(result.topDropRisk).toHaveLength(20);
    expect(result.topDropRisk[0].dropRisk).toBeGreaterThanOrEqual(result.topDropRisk.at(-1).dropRisk);
  });
});

describe("learning coach exam risk and dispatch", () => {
  const quantV3 = {
    subjects: [
      { subject: "刑法学", weight: 75, ability: 70, covered: 10 },
      { subject: "法理学", weight: 60, ability: 15, covered: 0 },
    ],
  };

  it("没有成套模考时只做风险排序，不输出卷面分", () => {
    const result = buildExamRiskModel({
      referenceDate: TODAY,
      quantV3,
      studyLogs: [{ subject: "刑法学", log_date: "2026-08-04" }],
      topicStates: { items: [] },
      reciteMemory: { items: [] },
      targets: {},
      mockRecords: [],
    });
    expect(result.calibration).toMatchObject({ status: "uncalibrated", canProjectScore: false, mockCount: 0 });
    expect(result.subjects[0].subject).toBe("法理学");
  });

  it("今日派单最多三项、最多一个 P0，并优先跨科", () => {
    const topicStates = {
      items: [
        ...Array.from({ length: 22 }, (_, index) => ({ id: index + 1, subject: "刑法学", title: `刑${index}`, dueDate: TODAY, riskScore: 95 - index / 100, nextAction: "复检" })),
        { id: 30, subject: "民法学", title: "B", dueDate: TODAY, riskScore: 90, nextAction: "复检" },
        { id: 31, subject: "法理学", title: "C", dueDate: TODAY, riskScore: 89, nextAction: "复检" },
      ],
    };
    const reciteMemory = { items: [] };
    const examRisk = { subjects: quantV3.subjects.map((item) => ({ subject: item.subject, riskScore: 60 })) };
    const result = buildPredictiveDispatch({ referenceDate: TODAY, topicStates, reciteMemory, examRisk, limit: 3 });
    expect(result.today).toHaveLength(3);
    expect(result.today.filter((item) => item.priority === "P0")).toHaveLength(1);
    expect(new Set(result.today.map((item) => item.subject)).size).toBe(3);
  });

  it("已有排期占用每日名额，并约束整个队列最多一个 P0", () => {
    const candidates = [
      { id: "A", priority: "P0" },
      { id: "B", priority: "P1" },
      { id: "C", priority: "P1" },
    ];
    const fitted = fitDispatchToSchedule(candidates, [{ id: "OLD", priority: "P0" }], 3);
    expect(fitted).toMatchObject({ availableSlots: 2, existingActionable: 1 });
    expect(fitted.selected).toEqual([
      { id: "A", priority: "P1" },
      { id: "B", priority: "P1" },
    ]);
  });
});
