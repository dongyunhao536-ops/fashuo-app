import { describe, expect, it } from "vitest";
import {
  buildFailurePortrait,
  buildKnowledgePointStates,
  formatFailurePortrait,
  reciteEvidenceFromLinks,
  summarizeKnowledgeEvidence,
} from "./knowledge-state.mjs";

const TODAY = "2026-08-10";

function catalog(importanceScore = 80) {
  return {
    items: [{
      kpId: "XF-0001",
      subject: "刑法",
      parentKp: "犯罪论",
      name: "犯罪构成",
      importanceScore,
      anki: { matchLevel: "exact", noteIds: ["1"], references: [{ noteId: "1", title: "犯罪构成" }] },
    }],
  };
}

function state(evidence = [], options = {}) {
  return buildKnowledgePointStates({
    catalog: catalog(options.importanceScore),
    evidence,
    objectLinks: options.objectLinks ?? [],
    referenceDate: TODAY,
    examDate: options.examDate ?? "2026-12-20",
  }).items[0];
}

const evidence = (dimension, result, date, overrides = {}) => ({
  operation_id: `${dimension}:${date}:${result}`,
  kp_id: "XF-0001",
  evidence_date: date,
  dimension,
  result,
  source_kind: "manual",
  prompt_integrity: "clean",
  cold: false,
  ...overrides,
});

describe("knowledge point multidimensional state", () => {
  it("Anki 卡片和旧目录本身不把未接触升级成掌握", () => {
    expect(state()).toMatchObject({ stage: "unseen", evidenceCount: 0, activated: false, anki: { masteryImpact: "none" } });
  });

  it("按理解、复述、应用证据推进，提示后通过不升级", () => {
    expect(state([evidence("understanding", "pass", "2026-08-01")]).stage).toBe("understanding");
    expect(state([evidence("recall", "pass", "2026-08-02")]).stage).toBe("recall");
    expect(state([evidence("application", "pass", "2026-08-03")]).stage).toBe("application");
    expect(state([evidence("recall", "pass", "2026-08-03", { prompt_integrity: "cued" })]).stage).toBe("exposed");
  });

  it("稳定必须有复述+应用双维度、跨至少 7 天的干净冷检", () => {
    const stable = state([
      evidence("recall", "pass", "2026-08-01", { cold: true }),
      evidence("application", "pass", "2026-08-08", { cold: true }),
    ]);
    expect(stable).toMatchObject({ stage: "stable", stability: { achieved: true, spanDays: 7 } });

    const demoted = state([
      evidence("recall", "pass", "2026-08-01", { cold: true }),
      evidence("application", "pass", "2026-08-08", { cold: true }),
      evidence("application", "fail", "2026-08-09", { cold: true }),
    ]);
    expect(demoted.stage).toBe("recall");
    expect(demoted.stability.achieved).toBe(false);
  });

  it("稳定不等于考试就绪；须另有跨日 L4 冷应用与限时证据", () => {
    const stableOnly = state([
      evidence("recall", "pass", "2026-08-01", { cold: true }),
      evidence("application", "pass", "2026-08-08", { cold: true }),
    ]);
    expect(stableOnly).toMatchObject({ stage: "stable", examReadiness: { achieved: false, confidence: "insufficient" } });

    const examReady = state([
      evidence("recall", "pass", "2026-08-01", { cold: true }),
      evidence("application", "pass", "2026-08-02", {
        operation_id: "novel-1",
        cold: true,
        variant_kind: "novel_case",
        transfer_level: 4,
      }),
      evidence("application", "pass", "2026-08-08", {
        operation_id: "novel-2",
        cold: true,
        variant_kind: "integrated_case",
        transfer_level: 4,
        assessment_context: "timed",
        duration_seconds: 1200,
      }),
    ]);
    expect(examReady).toMatchObject({
      stage: "stable",
      examReadiness: {
        achieved: true,
        confidence: "medium",
        highTransferPasses: 2,
        highTransferDates: ["2026-08-02", "2026-08-08"],
        timedPasses: 1,
      },
    });
  });

  it("冲刺是独立调度通道，不覆盖稳定掌握状态", () => {
    const result = state([
      evidence("recall", "pass", "2026-08-01", { cold: true }),
      evidence("application", "pass", "2026-08-08", { cold: true }),
    ], { examDate: "2026-09-01" });
    expect(result).toMatchObject({ stage: "stable", sprintLane: true });
    expect(result.sprintReason).toContain("不改变");
  });

  it("已确认对象链接可激活尚无证据的知识点，但 pending 链接不能", () => {
    const confirmed = state([], { objectLinks: [{ source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", link_status: "confirmed" }] });
    const pending = state([], { objectLinks: [{ source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", link_status: "pending" }] });
    expect(confirmed).toMatchObject({ activated: true, stage: "unseen", activeLinkKinds: ["recite_ledger"] });
    expect(pending.activated).toBe(false);
  });
});

describe("failure portrait", () => {
  it("pending 只叫候选；用户确认后才进入明确画像", () => {
    const pending = buildFailurePortrait({ knowledgeEvidence: [{
      ...evidence("application", "fail", "2026-08-01"),
      failure_pattern_code: "scope_expansion",
      diagnosis_status: "pending",
    }], catalog: catalog() });
    expect(pending.byKnowledgePoint[0].primaryPattern).toMatchObject({ status: "pending", label: "扩大范围" });
    expect(pending.byKnowledgePoint[0].primaryPattern.statement).toContain("候选");
    expect(pending.bySubject[0].primaryPattern).toMatchObject({ mappedKnowledgePoints: 1, distinctKnowledgePoints: 0, habitual: false });

    const confirmed = buildFailurePortrait({ knowledgeEvidence: [{
      ...evidence("application", "fail", "2026-08-01"),
      failure_pattern_code: "scope_expansion",
      diagnosis_status: "confirmed",
    }], catalog: catalog() });
    expect(confirmed.byKnowledgePoint[0].primaryPattern).toMatchObject({ status: "confirmed" });
    expect(confirmed.byKnowledgePoint[0].primaryPattern.statement).toContain("本轮定向练");
  });

  it("同一栽点在失败后有跨日定向双冷检才退役", () => {
    const rows = [
      { ...evidence("application", "fail", "2026-07-20"), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
      { ...evidence("recall", "pass", "2026-07-25", { cold: true }), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
      { ...evidence("application", "pass", "2026-08-02", { cold: true }), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
    ];
    const profile = buildFailurePortrait({ knowledgeEvidence: rows, catalog: catalog() }).byKnowledgePoint[0].primaryPattern;
    expect(profile).toMatchObject({ status: "retired", retirementEvidence: { spanDays: 8, hasColdPass: true } });
  });

  it("同场通过不能和一次冷检拼成栽点退役证据", () => {
    const rows = [
      { ...evidence("application", "fail", "2026-07-20"), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
      { ...evidence("recall", "pass", "2026-07-25"), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
      { ...evidence("application", "pass", "2026-08-02", { cold: true }), failure_pattern_code: "time_condition", diagnosis_status: "confirmed" },
    ];
    const profile = buildFailurePortrait({ knowledgeEvidence: rows, catalog: catalog() }).byKnowledgePoint[0].primaryPattern;
    expect(profile).toMatchObject({ status: "monitoring", retirementEvidence: { coldPasses: 1 } });
  });

  it("跨至少两个知识点且三次确认失败，才称科目级习惯性栽点", () => {
    const rows = ["XF-0001", "XF-0002", "XF-0002"].map((kpId, index) => ({
      ...evidence("application", "fail", `2026-08-0${index + 1}`),
      operation_id: `op-${index}`,
      source_id: String(index),
      kp_id: kpId,
      subject: "刑法",
      failure_pattern_code: "exception_omission",
      diagnosis_status: "confirmed",
    }));
    const profile = buildFailurePortrait({ knowledgeEvidence: rows }).bySubject[0].primaryPattern;
    expect(profile).toMatchObject({ habitual: true, distinctKnowledgePoints: 2 });
  });

  it("按知识目录给 evidence-only 样本补科目，并以低样本保护格式化画像", () => {
    const portrait = buildFailurePortrait({
      knowledgeEvidence: [{
        ...evidence("application", "fail", "2026-08-01"),
        failure_pattern_code: "scope_expansion",
        diagnosis_status: "confirmed",
      }],
      catalog: catalog(),
    });
    expect(portrait.bySubject[0]).toMatchObject({ subject: "刑法", primaryPattern: { habitual: false } });

    const text = formatFailurePortrait(portrait, { subject: "刑法" });
    expect(text).toContain("只读派生，不是掌握率");
    expect(text).toContain("已确认个案｜扩大范围");
    expect(text).toContain("不称为习惯性");
    expect(text).toContain("不是掌握概率、卷面分或上岸率");
  });

  // [gpt] 2026-08-10：画像读取共享映射真相，不再只靠兼容 kp_id。
  it("错题画像通过 confirmed 对象映射认稳定知识点，pending 映射仍算未映射", () => {
    const errorRows = [{
      study_error_id: 95,
      log_date: "2026-08-01",
      event_subject: "刑法",
      topic_id: 12,
      failure_pattern_code: "scope_expansion",
      diagnosis_status: "confirmed",
    }];
    const pending = buildFailurePortrait({
      errorRows,
      objectLinks: [{ source_kind: "error_topic", source_id: "12", kp_id: "XF-0001", link_status: "pending" }],
      catalog: catalog(),
    });
    expect(pending.counts.unmatchedEvidence).toBe(1);

    const confirmed = buildFailurePortrait({
      errorRows,
      objectLinks: [{ source_kind: "error_topic", source_id: "12", kp_id: "XF-0001", link_status: "confirmed" }],
      catalog: catalog(),
    });
    expect(confirmed.counts.unmatchedEvidence).toBe(0);
    expect(confirmed.byKnowledgePoint[0]).toMatchObject({ kpId: "XF-0001", primaryPattern: { status: "confirmed" } });
  });

  // [gpt] 2026-08-10：跨知识点主题的 related 关联不得复制同一条失败画像。
  it("主题同时有 primary 与 related 映射时，失败画像只归 primary", () => {
    const portrait = buildFailurePortrait({
      errorRows: [{
        study_error_id: 96,
        log_date: "2026-08-04",
        event_subject: "法制史",
        topic_id: 2,
        failure_pattern_code: "knowledge_gap",
        diagnosis_status: "confirmed",
      }],
      objectLinks: [
        { source_kind: "error_topic", source_id: "2", kp_id: "LS-0014", role: "primary", link_status: "confirmed" },
        { source_kind: "error_topic", source_id: "2", kp_id: "LS-0022", role: "related", link_status: "confirmed" },
      ],
      catalog: {
        items: [
          { kpId: "LS-0014", subject: "法制史", name: "秦朝立法概况" },
          { kpId: "LS-0022", subject: "法制史", name: "汉朝司法制度" },
        ],
      },
    });
    expect(portrait.byKnowledgePoint.map((item) => item.kpId)).toEqual(["LS-0014"]);
    expect(portrait.counts.evidence).toBe(1);
  });
});

describe("recite ledger knowledge evidence", () => {
  it("只有 confirmed 的带背映射才把复检转成知识点复述证据", () => {
    const reciteMemory = { items: [{ id: "L1", evidence: [{ operationId: "ev-1", date: "2026-08-08", dimension: "recall", result: "pass", qualifying: true, cold: true, promptIntegrity: "clean", failurePatternCode: "time_condition", diagnosisStatus: "confirmed", evidenceAnchor: "教材#期间" }] }] };
    const links = [
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", link_status: "confirmed" },
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0002", link_status: "pending" },
    ];
    expect(reciteEvidenceFromLinks(reciteMemory, links)).toEqual([
      expect.objectContaining({ operationId: "ev-1", kpId: "XF-0001", dimension: "recall", result: "pass", cold: true, failurePatternCode: "time_condition", diagnosisStatus: "confirmed", evidenceAnchor: "教材#期间" }),
    ]);
  });

  it("同一带背条目多接了 confirmed KP 时暂停传播，避免复制一份证据污染多个知识点", () => {
    const reciteMemory = { items: [{ id: "L1", evidence: [{ operationId: "ev-1", date: "2026-08-08", dimension: "recall", result: "pass", cold: true, promptIntegrity: "clean" }] }] };
    const links = [
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", link_status: "confirmed" },
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0002", link_status: "confirmed" },
    ];
    expect(reciteEvidenceFromLinks(reciteMemory, links)).toEqual([]);
  });

  it("多链接里只有唯一 primary 时只向主知识点传播，related 仅保留关系", () => {
    const reciteMemory = { items: [{ id: "L1", evidence: [{ operationId: "ev-1", date: "2026-08-08", dimension: "recall", result: "pass", cold: true, promptIntegrity: "clean" }] }] };
    const links = [
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0001", role: "primary", link_status: "confirmed" },
      { source_kind: "recite_ledger", source_id: "L1", kp_id: "XF-0002", role: "related", link_status: "confirmed" },
    ];
    expect(reciteEvidenceFromLinks(reciteMemory, links)).toEqual([
      expect.objectContaining({ kpId: "XF-0001", operationId: "ev-1" }),
    ]);
  });

  it("按三维与来源汇总证据，并把提示通过、作废和坏结构单列", () => {
    const summary = summarizeKnowledgeEvidence([
      evidence("understanding", "pass", "2026-08-04"),
      evidence("recall", "pass", "2026-08-05", { cold: true }),
      evidence("application", "fail", "2026-08-05", { failure_pattern_code: "scope_expansion" }),
      evidence("recall", "pass", "2026-08-05", { operation_id: "recall-cued", prompt_integrity: "cued", source_kind: "recite_ledger" }),
      evidence("recall", "void", "2026-08-05", { prompt_integrity: "invalid", source_kind: "recite_ledger" }),
      evidence("mystery", "pass", "2026-08-05"),
      evidence("recall", "pass", "2026-07-01"),
      evidence("recall", "pass", "2026-08-05", { cold: true }),
    ], { start: "2026-08-04", end: "2026-08-05" });

    expect(summary.counts).toEqual({ observed: 6, valid: 5, cleanPass: 2, coldCleanPass: 1, setbacks: 1, cuedPass: 1, voidOrInvalidPrompt: 1, invalidSchema: 1, duplicatesIgnored: 1 });
    expect(summary.byDimension.understanding).toMatchObject({ observed: 1, cleanPass: 1 });
    expect(summary.byDimension.recall).toMatchObject({ observed: 3, cleanPass: 1, coldCleanPass: 1, cuedPass: 1, voidOrInvalidPrompt: 1 });
    expect(summary.byDimension.application).toMatchObject({ observed: 1, setbacks: 1 });
    expect(summary.bySource).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "manual", observed: 4 }),
      expect.objectContaining({ sourceKind: "recite_ledger", observed: 2 }),
    ]));
    expect(summary.policy).toContain("不自动等于稳定掌握");
  });
});
