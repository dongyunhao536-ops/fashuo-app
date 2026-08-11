// [gpt] 2026-08-10：个人知识上下文的强关联、诊断门槛与时间口径回归测试。
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeNeighborhood,
  buildPersonalKnowledgeContext,
  formatPersonalKnowledgeContext,
  toBeijingDate,
} from "./knowledge-context.mjs";

const TODAY = "2026-08-10";

const catalog = {
  items: [
    { kpId: "XF-0001", subject: "刑法", parentKp: "共同犯罪", name: "教唆犯" },
    { kpId: "XF-0002", subject: "刑法", parentKp: "共同犯罪", name: "帮助犯" },
    { kpId: "XF-0003", subject: "刑法", parentKp: "共同犯罪", name: "共同犯罪成立条件" },
    { kpId: "XF-0004", subject: "刑法", parentKp: "共同犯罪", name: "同章但无确认关系" },
  ],
};

const relation = (from, to, type = "contrast", status = "confirmed") => ({
  prerequisite_kp_id: from,
  dependent_kp_id: to,
  relation_type: type,
  required_stage: type === "prerequisite" ? "understanding" : null,
  relation_status: status,
  source_kind: status === "confirmed" ? "curated" : "model",
  evidence_anchor: status === "confirmed" ? `${from}->${to}` : null,
});

function baseContext(overrides = {}) {
  return buildPersonalKnowledgeContext({
    currentKpIds: ["XF-0001"],
    referenceDate: TODAY,
    catalog,
    relations: [relation("XF-0001", "XF-0002")],
    knowledgeStates: { items: [{ kpId: "XF-0001", stage: "understanding", activated: true }] },
    ...overrides,
  });
}

describe("knowledge context date and neighborhood", () => {
  it("把 UTC 时间按北京日归档，并使用含当天在内的 30 个北京日", () => {
    expect(toBeijingDate("2026-08-09T16:30:00.000Z")).toBe("2026-08-10");
    expect(baseContext().window).toEqual({ days: 30, startDate: "2026-07-12", endDate: TODAY });
  });

  it("只沿 confirmed 关系扩展；同章和 pending 候选都不会制造邻点", () => {
    const neighborhood = buildKnowledgeNeighborhood({
      currentKpIds: ["XF-0001"],
      maxDepth: 2,
      relations: [
        relation("XF-0001", "XF-0002", "contrast", "confirmed"),
        relation("XF-0002", "XF-0003", "prerequisite", "confirmed"),
        relation("XF-0001", "XF-0004", "contrast", "pending"),
      ],
    });
    expect(neighborhood.get("XF-0002")).toMatchObject({ depth: 1, nodes: ["XF-0001", "XF-0002"] });
    expect(neighborhood.get("XF-0003")).toMatchObject({ depth: 2, nodes: ["XF-0001", "XF-0002", "XF-0003"] });
    expect(neighborhood.has("XF-0004")).toBe(false);
  });

  it("不把共享 supports 父节点的旁系知识点当作两跳强关联", () => {
    const neighborhood = buildKnowledgeNeighborhood({
      currentKpIds: ["XF-0001"],
      maxDepth: 2,
      relations: [
        relation("XF-0003", "XF-0001", "supports", "confirmed"),
        relation("XF-0003", "XF-0004", "supports", "confirmed"),
      ],
    });
    expect(neighborhood.get("XF-0003")).toMatchObject({ depth: 1 });
    expect(neighborhood.has("XF-0004")).toBe(false);
  });
});

describe("personal evidence recall", () => {
  it("只召回近窗强关联事实，排除 dismissed/void/未确认映射并去掉同源重复证据", () => {
    const context = baseContext({
      objectLinks: [
        { source_kind: "study_error", source_id: "1", kp_id: "XF-0001", role: "primary", link_status: "confirmed" },
        { source_kind: "study_error", source_id: "2", kp_id: "XF-0002", role: "primary", link_status: "confirmed" },
        { source_kind: "study_error", source_id: "3", kp_id: "XF-0001", role: "primary", link_status: "confirmed" },
        { source_kind: "study_error", source_id: "4", kp_id: "XF-0001", role: "primary", link_status: "pending" },
        { source_kind: "ask_point", source_id: "8", kp_id: "XF-0002", role: "primary", link_status: "confirmed" },
      ],
      errorRows: [
        { study_error_id: 1, log_date: "2026-07-12", event_status: "open", knowledge: "窗口首日错误" },
        { study_error_id: 2, log_date: "2026-07-11", event_status: "open", knowledge: "窗口外错误" },
        { study_error_id: 3, log_date: "2026-08-08", event_status: "dismissed", knowledge: "已否决错误" },
        { study_error_id: 4, log_date: "2026-08-08", event_status: "open", knowledge: "仅 pending 映射" },
      ],
      askPoints: [
        { id: 8, created_at: "2026-08-09T16:30:00.000Z", effective_status: "clarified", confusion: "已经打通过的相关卡点" },
        { id: 9, kp_id: "XF-0001", created_at: "2026-08-09T10:00:00.000Z", effective_status: "superseded", confusion: "被替代描述" },
      ],
      knowledgeEvidence: [
        { operation_id: "dup-e1", kp_id: "XF-0001", evidence_date: "2026-07-12", dimension: "application", result: "fail", source_kind: "study_error", source_id: "1", prompt_integrity: "clean", diagnosis_status: "confirmed" },
        { operation_id: "void-e2", kp_id: "XF-0001", evidence_date: "2026-08-08", dimension: "application", result: "void", source_kind: "manual", prompt_integrity: "invalid", diagnosis_status: "pending" },
        { operation_id: "good-e3", kp_id: "XF-0002", evidence_date: "2026-08-09", dimension: "recall", result: "partial", source_kind: "manual", prompt_integrity: "clean", diagnosis_status: "pending", note: "帮助犯复述不完整" },
      ],
      limit: 10,
    });
    expect(context.counts).toMatchObject({ relevantEvents: 3, errorEvents: 1, askPoints: 1, performanceEvidence: 1 });
    expect(context.recentSimilarEvents.map((item) => item.key).sort()).toEqual([
      "ask_point:8",
      "knowledge_evidence:good-e3",
      "study_error:1",
    ]);
    expect(context.recentSimilarEvents.find((item) => item.key === "ask_point:8")?.date).toBe(TODAY);
  });

  it("不会仅凭同一章节召回历史错误", () => {
    const context = baseContext({
      relations: [],
      errorRows: [{ study_error_id: 7, log_date: "2026-08-08", event_kp_id: "XF-0004", event_status: "open", knowledge: "同章其他问题" }],
    });
    expect(context.recentSimilarEvents).toEqual([]);
  });

  it("多主题错题只归入与当前知识邻域有明确映射的主题", () => {
    const context = baseContext({
      relations: [],
      errorRows: [
        {
          study_error_id: 10,
          log_date: "2026-08-08",
          event_kp_id: "XF-0001",
          event_status: "open",
          knowledge: "同一错题同时挂了两个长期主题",
          topic_id: 20,
          topic_title: "当前知识点主题",
          topic_kp_id: "XF-0001",
          diagnosis_status: "confirmed",
          root_cause_note: "当前点的已确认病根",
          mastery_status: "open",
        },
        {
          study_error_id: 10,
          log_date: "2026-08-08",
          event_kp_id: "XF-0001",
          event_status: "open",
          knowledge: "同一错题同时挂了两个长期主题",
          topic_id: 21,
          topic_title: "无关主题",
          topic_kp_id: "XF-0004",
          diagnosis_status: "confirmed",
          root_cause_note: "不应搭便车进入当前答疑",
          mastery_status: "open",
        },
      ],
    });
    expect(context.diagnosisCandidates.filter((item) => item.kind === "error_topic").map((item) => item.id)).toEqual(["20"]);
  });
});

describe("diagnosis thresholds and teaching action", () => {
  it("三次确认失败跨两个知识点才称反复模式，并保留用户确认的具体根因", () => {
    const rows = [
      { study_error_id: 11, log_date: "2026-07-20", event_kp_id: "XF-0001", event_status: "open" },
      { study_error_id: 12, log_date: "2026-08-01", event_kp_id: "XF-0002", event_status: "open" },
      { study_error_id: 13, log_date: "2026-08-08", event_kp_id: "XF-0002", event_status: "open" },
    ].map((row) => ({
      ...row,
      knowledge: `相关错误 ${row.study_error_id}`,
      topic_id: 9,
      topic_title: "共同犯罪人分类标准混淆",
      topic_kp_id: "XF-0001",
      failure_pattern_code: "adjacent_confusion",
      diagnosis_status: "confirmed",
      root_cause_note: "没有区分不同判断维度",
      mastery_status: "open",
    }));
    const context = baseContext({
      errorRows: rows,
      objectLinks: [
        { source_kind: "error_topic", source_id: "9", kp_id: "XF-0001", role: "primary", link_status: "confirmed" },
        { source_kind: "error_topic", source_id: "9", kp_id: "XF-0002", role: "related", link_status: "confirmed" },
      ],
      limit: 5,
    });
    const topic = context.diagnosisCandidates.find((item) => item.kind === "error_topic");
    expect(topic).toMatchObject({
      id: "9",
      diagnosisStatus: "confirmed",
      recurrence: "recurring",
      eventCount: 3,
      confirmedFailures: 3,
      distinctKnowledgePoints: 2,
      rootCause: "没有区分不同判断维度",
    });
    expect(context.teachingAction).toMatchObject({ kind: "error_topic" });
    expect(formatPersonalKnowledgeContext(context)).toContain("已确认·反复模式｜T9 共同犯罪人分类标准混淆");
  });

  it("两次 pending 只能叫候选疑似重复，不能写成已确认个人特征", () => {
    const context = baseContext({
      knowledgeEvidence: [1, 2].map((id) => ({
        operation_id: `pending-${id}`,
        kp_id: id === 1 ? "XF-0001" : "XF-0002",
        evidence_date: `2026-08-0${id}`,
        dimension: "application",
        result: "fail",
        source_kind: "manual",
        source_id: String(id),
        prompt_integrity: "clean",
        failure_pattern_code: "adjacent_confusion",
        diagnosis_status: "pending",
      })),
    });
    const pattern = context.diagnosisCandidates.find((item) => item.kind === "failure_pattern");
    expect(pattern).toMatchObject({ diagnosisStatus: "pending", recurrence: "suspected", eventCount: 2 });
    expect(formatPersonalKnowledgeContext(context)).toContain("候选·疑似重复｜相邻概念混淆");
  });

  it("已退役模式不再驱动当前教学动作", () => {
    const evidence = [1, 2, 3].map((id) => ({
      operation_id: `retired-${id}`,
      kp_id: id === 1 ? "XF-0001" : "XF-0002",
      evidence_date: `2026-08-0${id}`,
      dimension: "application",
      result: "fail",
      source_kind: "manual",
      source_id: String(id),
      prompt_integrity: "clean",
      failure_pattern_code: "degree_strength",
      diagnosis_status: "confirmed",
    }));
    const context = baseContext({
      knowledgeEvidence: evidence,
      failurePortrait: {
        bySubject: [{ subject: "刑法", patterns: [{ pattern: "degree_strength", status: "retired" }] }],
      },
    });
    expect(context.diagnosisCandidates[0]).toMatchObject({ diagnosisStatus: "retired", recurrence: "recurring" });
    expect(context.teachingAction).toMatchObject({ kind: "contrast" });
    expect(context.teachingAction.reason).not.toContain("程度词");
  });

  it("根前置阻塞优先于历史模式，且只改变讲解顺序", () => {
    const context = baseContext({
      knowledgeGraph: {
        byKnowledgePoint: [{
          kpId: "XF-0001",
          name: "教唆犯",
          blockers: [{
            kpId: "XF-0003",
            name: "共同犯罪成立条件",
            requiredStage: "understanding",
            stage: "unseen",
            strength: 5,
            root: true,
            path: ["XF-0003", "XF-0001"],
          }],
        }],
      },
    });
    expect(context.teachingAction).toMatchObject({ kind: "prerequisite", route: "ask-pc" });
    expect(context.policy.verdictBoundary).toContain("不得改变");
  });
});
