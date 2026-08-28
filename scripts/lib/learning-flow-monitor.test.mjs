// [gpt] 2026-08-11：监控回归必须守住“低学习量不等于故障”和“部分写入必须报错”两条边界。
import { describe, expect, it } from "vitest";
import { buildWeeklyFlowReview, evaluateLearningFlow } from "./learning-flow-monitor.mjs";

const baseFacts = {
  nowIso: "2026-08-11T12:00:00.000Z",
  windowStart: "2026-08-05",
  windowEnd: "2026-08-11",
  qualityIssues: [],
  ingestOperations: [],
  localOutbox: { operations: [] },
  attempts: [{ attempt_date: "2026-08-11", source_kind: "subjective_answer", result: "pass" }],
  studyLogs: [{ log_date: "2026-08-11" }],
  knowledgeEvidence: [{ evidence_date: "2026-08-11" }],
  knowledgeEvidenceCount: 1,
  errorEvents: [{ log_date: "2026-08-10" }],
  reviews: [{ review_date: "2026-08-09" }],
  ingestHistory: [{ beijing_date: "2026-08-11" }],
  attemptCount: 1,
  validAttemptCount: 1,
  studyLogCount: 1,
  expectedStudyLogCount: 1,
  pendingEvents: [],
  knownKpIds: ["XF-0001"],
  askPoints: [],
  errorSummary: { activeTopics: 1, awaitingColdReviewTopics: 0, unclassifiedEvents: 0 },
  schedule: { counts: { overdue: 0, errors: 0, warnings: 0 }, issues: [] },
  scheduleExecution: { counts: { planned: 1, completedByEnd: 1 } },
  recite: { counts: { errors: 0, warnings: 0 }, issues: [] },
  reciteMapping: { counts: { items: 1, linked: 1, ambiguousLinks: 0, evidenceUnlinked: 0 } },
  skillExecution: {
    counts: { runs: 1, completed: 1, active: 0, stale: 0, gateFailures: 0 },
    startupLatencyMs: { samples: 1, p50: 900, p95: 900, max: 900 },
    bySkill: { "ask-pc": { started: 1, completed: 1, active: 0, blocked: 0, stale: 0 } },
    staleRuns: [], gateFailureExamples: [], issues: [],
  },
  skillTurnCoverage: {
    counts: { sessions: 1, routed: 1, checked: 1, passed: 1, protected: 0, failed: 0, unchecked: 0 },
    coverage: { state: "observed", lastSessionAt: "2026-08-11T00:00:00.000Z" },
    compliance: { eligible: 1, rate: 100 },
    failuresByCode: {}, examples: [], issues: [],
  },
};

describe("learning flow monitor", () => {
  it("记录、传输、映射和台账一致时判健康", () => {
    const report = evaluateLearningFlow(baseFacts);
    expect(report.status).toBe("healthy");
    expect(report.metrics.records).toMatchObject({ studyLogs: 1, learningAttempts: 1 });
    expect(report.issues).toEqual([]);
  });

  it("部分写入、长时 outbox 和账本结构错误会判异常", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      qualityIssues: [{ issue_code: "study_log_missing_attempt", severity: "error", entity_id: "7" }],
      localOutbox: { operations: [{ operation_id: "op-old", op: "study_log", ts: "2026-08-09T10:00:00.000Z" }] },
      schedule: { counts: { overdue: 0, errors: 1 }, issues: [{ code: "duplicate_id", severity: "error", line: 9 }] },
    });
    expect(report.status).toBe("degraded");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "study_log_missing_attempt",
      "local_outbox_backlog",
      "duplicate_id",
    ]));
  });

  it("积压、未分类和证据未接线只进入需关注，不冒充写入故障", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      pendingEvents: [{ id: 3, type: "复验请求", kp_id: "XF-0001", created_at: "2026-08-01T00:00:00.000Z" }],
      errorSummary: { activeTopics: 2, awaitingColdReviewTopics: 1, unclassifiedEvents: 2 },
      reciteMapping: { counts: { items: 4, linked: 2, ambiguousLinks: 0, evidenceUnlinked: 1 } },
      schedule: { counts: { overdue: 2, errors: 0 }, issues: [] },
    });
    expect(report.status).toBe("attention");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "review_request_stale",
      "unclassified_error_event",
      "recite_evidence_unlinked",
      "learning_schedule_overdue",
    ]));
  });

  it("周检直接按七个北京日汇总动作事实，不要求每天运行监控", () => {
    const flowReport = evaluateLearningFlow(baseFacts);
    const weekly = buildWeeklyFlowReview({
      flowReport,
      weekStart: "2026-08-05",
      weekEnd: "2026-08-11",
    });
    expect(weekly.status).toBe("healthy");
    expect(weekly.activeDays).toBe(3);
    expect(weekly.dailyRecords).toHaveLength(7);
    expect(weekly.dailyRecords.at(-1)).toMatchObject({ date: "2026-08-11", studyLogs: 1, learningAttempts: 1, knowledgeEvidence: 1, ingestOperations: 1 });
    expect(weekly.content).toContain("学习动作发生时实时落账，本监控只在周一分析");
    expect(weekly.content).not.toContain("monitor_snapshot_coverage_low");
  });

  it("质量视图与未决状态命中同一问题时不重复计算", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      qualityIssues: [{ issue_code: "ingest_failed", severity: "error", entity_id: "op-1" }],
      ingestOperations: [{ operation_id: "op-1", status: "failed" }],
    });
    expect(report.issues.find((issue) => issue.code === "ingest_failed")?.count).toBe(1);
  });

  it("Skill Run 漏收口、硬闸失败和慢启动进入同一监控", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      skillExecution: {
        counts: { runs: 2, completed: 0, active: 2, stale: 1, orphanedWaiting: 1, gateFailures: 2, invalidHandoffs: 1, unresolvedHandoffs: 1 },
        startupLatencyMs: { samples: 2, p50: 2000, p95: 6200, max: 6200 },
        bySkill: {},
        staleRuns: [{ runId: "SR-OLD", skill: "cuoti-fupan" }],
        orphanedWaitingRuns: [{ runId: "SR-WAIT", skill: "daibei-pc" }],
        gateFailureExamples: [{ runId: "SR-OLD", phase: "question" }],
        unresolvedHandoffExamples: [{ runId: "SR-H", skill: "coach-pc", handoffSkill: "cuoti-fupan" }],
        issues: [],
      },
    });
    expect(report.status).toBe("degraded");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "skill_run_stale",
      "skill_waiting_orphaned",
      "skill_gate_failed",
      "skill_startup_slow",
      "skill_handoff_invalid",
      "skill_handoff_unresolved",
    ]));
    expect(report.metrics.skillExecution.counts.runs).toBe(2);
  });

  // [claude] 2026-08-25：daibei_post_progress_probe_missing 已随"当日抽查不建 Run"整条删除；
  // 断言反转成"即使旧字段还在载荷里，也不再生成该 issue"，防它日后被悄悄加回来。
  it("带背阶段错配进错误；已废弃的记完未抽查不再产出 issue", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      skillExecution: {
        counts: {
          runs: 2,
          completed: 2,
          active: 0,
          stale: 0,
          gateFailures: 0,
          daibeiPhaseKindMismatches: 1,
          daibeiPostProgressProbeMissing: 1,
        },
        startupLatencyMs: { samples: 0, p50: null, p95: null, max: null },
        bySkill: {},
        daibeiPhaseKindMismatchExamples: [{ runId: "SR-M", kind: "recall", phase: "plan" }],
        daibeiPostProgressProbeMissingExamples: [{ runId: "SR-P", subject: "法制史", targetRef: "第三章" }],
        staleRuns: [],
        gateFailureExamples: [],
        issues: [],
      },
    });
    expect(report.status).toBe("degraded");
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["daibei_phase_kind_mismatch"]));
    expect(codes).not.toContain("daibei_post_progress_probe_missing");
  });

  it("宿主守卫能区分自动保护、最终不合规与漏审", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      skillTurnCoverage: {
        counts: { sessions: 1, routed: 4, checked: 3, passed: 1, protected: 1, failed: 1, unchecked: 1 },
        coverage: { state: "observed", lastSessionAt: "2026-08-11T00:00:00.000Z" },
        compliance: { eligible: 2, rate: 50 },
        failuresByCode: { missing_run: 1 },
        examples: [
          { turnId: "turn-fail", expectedSkill: "ask-pc", failureCode: "missing_run" },
          { turnId: "turn-open", expectedSkill: "coach-pc", failureCode: "unchecked" },
        ],
        issues: [],
      },
    });
    expect(report.status).toBe("attention");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "skill_turn_noncompliant",
      "skill_turn_unchecked",
    ]));
    expect(report.metrics.skillTurnCoverage.compliance.rate).toBe(50);
  });

  it("英语阅读长难句讲解晚于判分超过阈值时只告警不判故障", () => {
    const report = evaluateLearningFlow({
      ...baseFacts,
      skillExecution: {
        counts: { runs: 1, completed: 1, active: 0, stale: 0, gateFailures: 0 },
        startupLatencyMs: { samples: 1, p50: 900, p95: 900, max: 900 },
        bySkill: {},
        englishLongSentenceDelays: [{ runId: "SR-EN", delayMinutes: 2 * 24 * 60 }],
        staleRuns: [], gateFailureExamples: [], issues: [],
      },
    });
    expect(report.status).toBe("attention");
    expect(report.issues.map((issue) => issue.code)).toContain("english_long_sentence_delay");
  });
});
