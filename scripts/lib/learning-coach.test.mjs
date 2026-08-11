import { describe, expect, it } from "vitest";
import {
  buildExamRiskModel,
  buildPredictiveDispatch,
  buildReciteMemoryModel,
  buildTopicLearningStates,
  desaturateDispatchScores,
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

function transferReview(date, index, overrides = {}) {
  const variantKind = overrides.variant_kind ?? (index === 1 ? "counterfactual" : "novel_case");
  return {
    id: index,
    topic_id: 1,
    review_date: date,
    result: "pass",
    dimension: "application",
    cold: true,
    prompt_integrity: "clean",
    variant_kind: variantKind,
    transfer_level: variantKind === "counterfactual" ? 3 : 4,
    probe_axis: index === 1 ? "rule_boundary" : index === 2 ? "time_condition" : "fact_signal",
    angle: `角度${index}`,
    evidence_anchor: `变式#${index}`,
    ...overrides,
  };
}

describe("learning coach topic state machine", () => {
  it("覆盖发现、确认、短期通过、冷却、稳定与长期保持", () => {
    expect(stateFor({ classificationStatus: "pending" }).state).toBe("discovered");
    expect(stateFor({}).state).toBe("confirmed");
    expect(stateFor({}, [{ topic_id: 1, review_date: TODAY, result: "pass" }]).state).toBe("short_pass");
    expect(stateFor({}, [{ topic_id: 1, review_date: "2026-07-30", result: "pass" }]).state).toBe("cooling");
    expect(stateFor({}, [
      transferReview("2026-07-20", 1),
      transferReview("2026-07-28", 2),
    ]).state).toBe("stable");
    expect(stateFor({}, [
      transferReview("2026-07-10", 1),
      transferReview("2026-07-20", 2),
      transferReview("2026-07-30", 3),
    ]).state).toBe("maintenance");
  });

  it("提示后、同场、原题复现与 teach-back 不会把主题抬成稳定", () => {
    const result = stateFor({}, [
      transferReview("2026-07-10", 1, { cold: false, variant_kind: "novel_case", transfer_level: 4 }),
      transferReview("2026-07-20", 2, { cold: false, prompt_integrity: "cued", variant_kind: "novel_case", transfer_level: 4 }),
      transferReview("2026-07-25", 3, { variant_kind: "original", transfer_level: 1 }),
      transferReview("2026-07-30", 4, { dimension: "recall", variant_kind: "teach_back", transfer_level: 5 }),
    ]);
    expect(result.state).toBe("confirmed");
    expect(result.masteryStatus).toBe("open");
    expect(result.reviewCounts.qualifyingTransferPasses).toBe(0);
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

    expect(stateFor({}, [
      { topic_id: 1, review_date: "2026-08-01", result: "fail" },
      transferReview("2026-08-04", 2, { cold: false, prompt_integrity: "cued" }),
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

  it("下一探针冷却日约束派单，并只采用 confirmed 栽点定向验证轴", () => {
    const result = stateFor({
      confirmedFailurePatterns: ["subject_confusion"],
      pendingFailurePatterns: ["time_condition"],
    }, [transferReview("2026-08-03", 1, { probe_axis: "rule_boundary" })]);
    expect(result.nextProbe).toMatchObject({
      variantKind: "novel_case",
      transferLevel: 4,
      probeAxis: "subject_condition",
      sourceFailurePattern: "subject_confusion",
      earliestDate: "2026-08-10",
    });
    expect(result.dueDate).toBe("2026-08-10");
    expect(result.reviewProof.probeAxes).toEqual(["rule_boundary"]);
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
      expect.objectContaining({ date: "2026-08-01", result: "pass", qualifying: false, promptIntegrity: "cued", cold: false }),
      expect.objectContaining({ date: "2026-08-03", result: "partial", qualifying: true, promptIntegrity: "clean", cold: true }),
      expect.objectContaining({ date: "2026-08-05", result: "fail", qualifying: true, promptIntegrity: "clean", cold: true }),
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

  it("结构化带背证据覆盖同日自然语言推断，并保留知识点画像字段", () => {
    const record = {
      id: "X1",
      subject: "刑法",
      title: "程度词",
      status: "active",
      route: "daibei",
      openedOn: "2026-08-01",
      lastTouchedOn: TODAY,
      block: "- **冷复检（08-05）**：✗；把可以说成应当",
      explicitEvidence: [{
        operationId: "ev-1",
        entryId: "X1",
        date: TODAY,
        dimension: "recall",
        result: "fail",
        cold: true,
        promptIntegrity: "clean",
        failurePatternCode: "degree_strength",
        diagnosisStatus: "pending",
        evidenceAnchor: "教材#程度词",
        note: "把可以说成应当",
      }],
    };
    const result = buildReciteMemoryModel({ records: [record] }, TODAY);
    expect(result.items[0].evidence).toHaveLength(1);
    expect(result.items[0].evidence[0]).toMatchObject({
      explicit: true,
      operationId: "ev-1",
      failurePatternCode: "degree_strength",
      diagnosisStatus: "pending",
    });
    expect(result.counts).toMatchObject({ linked: 0, unlinked: 1, multiLinked: 0, ambiguousLinks: 0, evidenceUnlinked: 1, actionableUnlinked: 1 });
    expect(result.linkDebt[0]).toMatchObject({ id: "X1", reason: "missing_confirmed_kp", evidenceCount: 1 });
  });

  it("唯一 confirmed KP 才算已接线，多接线进入冲突债务", () => {
    const records = ["L1", "L2"].map((id) => ({
      id, subject: "刑法", title: id, status: "active", route: "daibei", openedOn: "2026-08-01", lastTouchedOn: TODAY, block: "",
    }));
    const result = buildReciteMemoryModel({ records }, TODAY, { objectLinks: [
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", link_status: "confirmed" },
      { source_kind: "recite_ledger", source_id: "L2", kp_id: "XF-0001", link_status: "confirmed" },
      { source_kind: "recite_ledger", source_id: "L2", kp_id: "XF-0002", link_status: "confirmed" },
    ] });
    expect(result.counts).toMatchObject({ items: 2, linked: 1, unlinked: 0, multiLinked: 1, ambiguousLinks: 1 });
    expect(result.linkDebt).toEqual([expect.objectContaining({ id: "L2", reason: "missing_unique_primary_kp" })]);
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
    expect(result.today.every((item) => item.route === "cuoti-fupan" && item.dimension === "application")).toBe(true);
  });

  it("按知识阶段把任务定向交给答疑、带背或错题复盘", () => {
    const point = (kpId, subject, stage, overrides = {}) => ({
      kpId,
      subject,
      name: kpId,
      stage,
      stageLabel: stage,
      dueDate: TODAY,
      riskScore: 90,
      lastEvidenceDate: "2026-08-01",
      nextAction: "下一步检验",
      sprintLane: false,
      stability: { dimensions: [] },
      evidence: [],
      anki: null,
      ...overrides,
    });
    const result = buildPredictiveDispatch({
      referenceDate: TODAY,
      topicStates: { items: [] },
      reciteMemory: { items: [] },
      knowledgeStates: {
        items: [],
        active: [
          point("XF-0001", "刑法学", "exposed"),
          point("MF-0001", "民法学", "understanding"),
          point("FL-0001", "法理学", "recall"),
          point("XF-0002", "刑法学", "application", { stability: { dimensions: ["application"] } }),
        ],
      },
      examRisk: { subjects: [] },
      limit: 3,
    });
    const byId = new Map(result.queue.map((item) => [item.id, item]));
    expect(byId.get("XF-0001")).toMatchObject({ route: "ask-pc", dimension: "understanding", type: "知识点理解" });
    expect(byId.get("MF-0001")).toMatchObject({ route: "daibei-pc", dimension: "recall", type: "知识点复述" });
    expect(byId.get("FL-0001")).toMatchObject({ route: "cuoti-fupan", dimension: "application", type: "知识点精准复检" });
    expect(byId.get("XF-0002")).toMatchObject({ route: "daibei-pc", dimension: "recall", type: "知识点冷复述" });
  });

  it("带背候选携带 daibei-pc/recall 执行元数据", () => {
    const result = buildPredictiveDispatch({
      referenceDate: TODAY,
      topicStates: { items: [] },
      reciteMemory: { items: [{ id: "L9", subject: "法理学", title: "规则背诵", route: "daibei", dueDate: TODAY, dropRisk: 90, kpIds: [] }] },
      examRisk: { subjects: [] },
      limit: 1,
    });
    expect(result.today[0]).toMatchObject({ kind: "recite", route: "daibei-pc", dimension: "recall", knowledgeLinkStatus: "unlinked" });
    expect(result.today[0].task).toContain("【接线债】");
  });

  it("目标存在未满足确认前置时，先把派单改投根前置", () => {
    const prerequisite = {
      kpId: "XF-0039", subject: "刑法", name: "正当防卫成立条件", stage: "unseen", stageLabel: "未接触",
      dueDate: TODAY, riskScore: 0, nextAction: "先讲清成立条件", stability: { dimensions: [] }, evidence: [], anki: null,
    };
    const target = {
      kpId: "XF-0041", subject: "刑法", name: "防卫过当", stage: "exposed", stageLabel: "已接触（理解待证）",
      activated: true, dueDate: TODAY, riskScore: 90, lastEvidenceDate: "2026-08-01", nextAction: "复检过当", stability: { dimensions: [] }, evidence: [], anki: null,
    };
    const result = buildPredictiveDispatch({
      referenceDate: TODAY,
      topicStates: { items: [] },
      reciteMemory: { items: [] },
      knowledgeStates: { items: [prerequisite, target], active: [target] },
      knowledgeGraph: { byKnowledgePoint: [{ kpId: "XF-0041", blockers: [{ kpId: "XF-0039", requiredStage: "recall", stage: "unseen", strength: 5, root: true, path: ["XF-0039", "XF-0041"] }] }] },
      examRisk: { subjects: [] },
      limit: 1,
    });
    expect(result.today[0]).toMatchObject({ id: "XF-0039", kpId: "XF-0039", type: "知识点前置补洞", route: "ask-pc", dimension: "understanding" });
    expect(result.today[0].task).toContain("它是 XF-0041");
    expect(result.today[0].prerequisiteFor[0].kpId).toBe("XF-0041");
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

describe("learning coach risk de-saturation", () => {
  const candidate = (subject, sourceRisk, overrides = {}) => ({
    id: `${subject}:${sourceRisk}:${overrides.key ?? ""}`,
    subject,
    title: "候选",
    sourceRisk,
    dueDate: TODAY,
    latestOpenDate: "",
    ...overrides,
  });

  it("同科风险分按科内相对位置拉开差距", () => {
    const output = desaturateDispatchScores(
      Array.from({ length: 5 }, (_, index) => candidate("刑法学", 100, { key: index })),
      TODAY,
    );
    const scores = output.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores[0] - scores.at(-1)).toBeGreaterThanOrEqual(10);
    expect(new Set(scores).size).toBe(5);
  });

  it("最近 3 天新栽的错题在同风险下优先", () => {
    const fresh = candidate("刑法学", 90, { key: "fresh", latestOpenDate: "2026-08-04" });
    const stale = candidate("刑法学", 90, { key: "stale", latestOpenDate: "2026-07-10" });
    const [first, second] = desaturateDispatchScores([fresh, stale], TODAY).sort((a, b) => b.score - a.score);
    expect(first.id).toBe(fresh.id);
    expect(first.recencyBoost).toBe(8);
    expect(second.recencyBoost).toBe(0);
  });

  it("积压科目统一降权，避免单科霸榜", () => {
    const backlog = Array.from({ length: 10 }, (_, index) => candidate("刑法学", 100, { key: index }));
    const light = candidate("民法学", 100);
    const output = desaturateDispatchScores([...backlog, light], TODAY);
    const byId = new Map(output.map((item) => [item.id, item]));
    expect(byId.get(backlog[0].id).backlogPenalty).toBe(6);
    expect(byId.get(light.id).backlogPenalty).toBe(0);
    expect(byId.get(light.id).score).toBeGreaterThanOrEqual(byId.get(backlog[0].id).score);
  });

  it("今日队列每科最多 2 件，保证跨科", () => {
    const result = buildPredictiveDispatch({
      referenceDate: TODAY,
      topicStates: {
        items: [
          ...Array.from({ length: 6 }, (_, index) => ({
            id: index + 1,
            subject: "刑法学",
            title: `刑${index}`,
            dueDate: TODAY,
            riskScore: 100 - index,
            latestOpenDate: "",
            nextAction: "复检",
          })),
          { id: 30, subject: "民法学", title: "民", dueDate: TODAY, riskScore: 60, latestOpenDate: "", nextAction: "复检" },
        ],
      },
      reciteMemory: { items: [] },
      examRisk: { subjects: [] },
      limit: 3,
    });
    expect(result.today).toHaveLength(3);
    expect(result.today.filter((item) => item.subject === "刑法学").length).toBeLessThanOrEqual(2);
    expect(result.today.some((item) => item.subject === "民法学")).toBe(true);
  });

  it("只有知识点级画像或已跨点复发的科目画像才改写派单焦点", () => {
    const base = {
      referenceDate: TODAY,
      topicStates: { items: [{ id: 1, kpId: "XF-0001", subject: "刑法", title: "边界题", dueDate: TODAY, riskScore: 80, latestOpenDate: "", nextAction: "普通复检" }] },
      reciteMemory: { items: [] },
      knowledgeStates: { items: [{ kpId: "XF-0001", riskScore: 80, stage: "exposed", anki: null }], active: [] },
      examRisk: { subjects: [] },
      limit: 1,
    };
    const nonHabitualSubject = buildPredictiveDispatch({
      ...base,
      failurePortrait: { byKnowledgePoint: [], bySubject: [{ subject: "刑法", primaryPattern: { pattern: "scope_expansion", label: "扩大范围", status: "confirmed", focus: "限制条件", habitual: false } }] },
    });
    expect(nonHabitualSubject.today[0].task).toContain("普通复检");
    expect(nonHabitualSubject.today[0].failurePattern).toBeNull();

    const pointSpecific = buildPredictiveDispatch({
      ...base,
      failurePortrait: { bySubject: [], byKnowledgePoint: [{ kpId: "XF-0001", primaryPattern: { pattern: "scope_expansion", label: "扩大范围", status: "confirmed", focus: "限制条件" } }] },
    });
    expect(pointSpecific.today[0].task).toContain("主要栽在「扩大范围」");
    expect(pointSpecific.today[0].failurePattern).toMatchObject({ code: "scope_expansion", scope: "point" });
  });

  it("定向病根派单固化失分基线，并按历史低响应要求改策略", () => {
    // [gpt] 2026-08-10：验证纵向闭环从画像/预测/历史响应进入同一派单对象。
    const result = buildPredictiveDispatch({
      referenceDate: TODAY,
      topicStates: { items: [{ id: 1, kpId: "XF-0001", subject: "刑法", title: "边界题", dueDate: TODAY, riskScore: 82, latestOpenDate: "", nextAction: "做陌生变式" }] },
      reciteMemory: { items: [] },
      knowledgeStates: { items: [{ kpId: "XF-0001", riskScore: 82, stage: "recall", anki: null }], active: [] },
      failurePortrait: { bySubject: [], byKnowledgePoint: [{ kpId: "XF-0001", primaryPattern: { pattern: "scope_expansion", label: "扩大范围", status: "confirmed", focus: "限制条件" } }] },
      examRisk: { subjects: [] },
      examForecast: { hotspots: [{ kpId: "XF-0001", lossRiskIndex: 74 }] },
      interventionResponse: { items: [{
        key: "scope_expansion@cuoti-fupan:application",
        status: "needs-redesign",
        observedCleanPassRate: 0,
        counts: { countable: 3, distinctKps: 2 },
      }] },
      limit: 1,
    });
    expect(result.today[0].task).toContain("历史同病根干预响应低");
    expect(result.today[0].task).toContain("干预协议");
    expect(result.today[0].intervention).toMatchObject({
      code: "scope_expansion@cuoti-fupan:application",
      protocolVersion: 1,
      selectionMode: "explore",
      episodeId: "EP-AUTO-20260805-T1",
      observationWindow: "immediate",
      failurePatternCode: "scope_expansion",
      failurePatternScope: "point",
      kpId: "XF-0001",
      baselineRisk: 74,
      expectedOutcome: "clean-pass",
      prior: { status: "needs-redesign", countable: 3, distinctKps: 2, observedCleanPassRate: 0 },
    });
    expect(result.today[0].intervention.protocolCode).toBeTruthy();
  });
});

describe("learning coach dispatch calibration", () => {
  // [gpt] 2026-08-10：外部大于 1 的系数不得绕过真实台账自动加量。
  const candidate = (subject, score, overrides = {}) => ({
    kind: "topic", id: "T1", subject, title: "X", score, sourceRisk: score,
    latestOpenDate: "", dueDate: TODAY, type: "错题冷复检", task: "T#1（X）：复检",
    baseRef: "coach-engine:topic:T1", priority: "P1", ...overrides,
  });

  it("高估系数把 limit 折成可信执行量", () => {
    const fitted = fitDispatchToSchedule(
      [candidate("刑法学", 90), candidate("民法学", 88), candidate("法理学", 60)],
      [],
      3,
      { executionFactor: { value: 0.6, basis: "任务量历史高估 53%" } },
    );
    expect(fitted.effectiveLimit).toBe(2);
    expect(fitted.selected).toHaveLength(2);
    expect(fitted.adjustment).toMatchObject({ kind: "reduce", from: 3, to: 2 });
  });

  it("大于 1 的外部系数不会自动加量", () => {
    const fitted = fitDispatchToSchedule(
      [candidate("刑法学", 90), candidate("民法学", 88), candidate("法理学", 60)],
      [],
      2,
      { executionFactor: { value: 1.15, basis: "外部异常加量系数" } },
    );
    expect(fitted.effectiveLimit).toBe(2);
    expect(fitted.selected).toHaveLength(2);
    expect(fitted.adjustment).toBeNull();
  });

  it("无系数时行为与旧版一致", () => {
    const fitted = fitDispatchToSchedule(
      [candidate("刑法学", 90), candidate("民法学", 88), candidate("法理学", 60)],
      [],
      3,
      null,
    );
    expect(fitted.effectiveLimit).toBe(3);
    expect(fitted.adjustment).toBeNull();
    expect(fitted.selected).toHaveLength(3);
  });

  it("受限模式冻结 P2 并把新增派单压到两件", () => {
    // [gpt] 2026-08-10：控制器降载只作用于新增候选，已有到期义务仍占位。
    const fitted = fitDispatchToSchedule(
      [
        candidate("刑法学", 90, { priority: "P0" }),
        candidate("民法学", 88, { priority: "P1", id: "T2" }),
        candidate("法理学", 60, { priority: "P2", id: "T3" }),
      ],
      [],
      3,
      null,
      { mode: "constrained", reason: "连续两周失守", policy: { maxNewDaily: 2, maxP1PerWeek: 1, allowP2: false } },
    );
    expect(fitted.effectiveLimit).toBe(2);
    expect(fitted.selected.map((item) => item.priority)).toEqual(["P0", "P1"]);
    expect(fitted.controllerAdjustment).toMatchObject({ mode: "constrained", from: 3, to: 2 });
  });

  it("受限模式按本周既有 P1 占用配额，且不把第二个 P0 偷降为 P1", () => {
    const controller = {
      mode: "constrained",
      reason: "连续两周失守",
      currentWeek: "2026-08-03",
      current: { weekEnd: "2026-08-09" },
      policy: { maxNewDaily: 2, maxP1PerWeek: 1, allowP2: false },
    };
    const withP1 = fitDispatchToSchedule(
      [candidate("民法学", 88, { priority: "P1", id: "T2" }), candidate("刑法学", 90, { priority: "P0" })],
      [{ id: "OLD-P1", priority: "P1", dueDate: "2026-08-05" }],
      3,
      null,
      controller,
    );
    expect(withP1.selected.map((item) => item.priority)).toEqual(["P0"]);

    const withP0 = fitDispatchToSchedule(
      [candidate("刑法学", 90, { priority: "P0" }), candidate("民法学", 88, { priority: "P1", id: "T2" })],
      [{ id: "OLD-P0", priority: "P0", dueDate: "2026-08-05" }],
      3,
      null,
      controller,
    );
    expect(withP0.selected.map((item) => item.priority)).toEqual(["P1"]);
  });
});
