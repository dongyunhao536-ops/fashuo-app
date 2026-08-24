import { describe, expect, it } from "vitest";
import { normalizeLearningAttempt, recordLearningAttempt } from "./learning-attempt.mjs";

describe("learning attempt", () => {
  it("保留成功样本、题目分母与结构化迁移环境", () => {
    const payload = normalizeLearningAttempt({
      op: "learning_attempt",
      operation_id: "attempt-1",
      subject: "刑法",
      kpId: "xf-0054",
      questionRef: "2019-base-12",
      sourceKind: "objective_question",
      sourceId: "study_log:88",
      attemptRole: "primary",
      dimension: "application",
      result: "pass",
      score: 1,
      maxScore: 1,
      cold: true,
      promptIntegrity: "clean",
      variantKind: "counterfactual",
      transferLevel: 3,
      probeAxis: "subject_condition",
      evidenceAnchor: "2019基础卷#12",
    }, "2026-08-10");
    expect(payload).toMatchObject({
      operation_id: "attempt-1",
      kp_id: "XF-0054",
      question_ref: "2019-base-12",
      result: "pass",
      score: 1,
      max_score: 1,
      transfer_level: 3,
      attempt_role: "primary",
      metadata: { projection_expected: true },
      project_evidence: true,
    });
  });

  it("拒绝缺分母、非法冷检和不完整干预协议", () => {
    const base = { operation_id: "x", dimension: "application", result: "pass" };
    expect(() => normalizeLearningAttempt({ ...base, score: 1 }, "2026-08-10")).toThrow(/score\/maxScore/);
    expect(() => normalizeLearningAttempt({ ...base, cold: true, promptIntegrity: "cued" }, "2026-08-10")).toThrow(/冷检/);
    expect(() => normalizeLearningAttempt({ ...base, protocol: "x" }, "2026-08-10")).toThrow(/必须成组/);
    expect(() => normalizeLearningAttempt({ ...base, sourceKind: "objective_question", questionRef: "Q1", score: 1, maxScore: 1 }, "2026-08-10")).toThrow(/sourceId/);
    expect(() => normalizeLearningAttempt({ ...base, attemptRole: "guess" }, "2026-08-10")).toThrow(/角色不合法/);
  });

  it("显式不投影时把声明写入 metadata，供监控区分合法跳过与部分成功", () => {
    // [gpt] 2026-08-11：监控不能仅凭 kp_id 猜是否应有 knowledge_evidence。
    const payload = normalizeLearningAttempt({
      operation_id: "attempt-no-projection",
      sourceKind: "manual",
      kpId: "XF-0001",
      dimension: "understanding",
      result: "pass",
      projectEvidence: false,
    }, "2026-08-11");
    expect(payload).toMatchObject({ project_evidence: false, metadata: { projection_expected: false } });
  });

  it("污染题 void 留审计但不能伪装成用户失败或有效冷检", () => {
    const payload = normalizeLearningAttempt({
      operation_id: "teacher-invalid-question",
      sourceKind: "error_review",
      sourceId: "error-review:void:1",
      attemptRole: "recheck",
      dimension: "application",
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      variantKind: "invalid",
      transferLevel: 0,
      probeAxis: "invalid",
    }, "2026-08-12");
    expect(payload).toMatchObject({
      result: "void",
      cold: false,
      prompt_integrity: "invalid",
      metadata: {
        responsibility: "teacher",
        count_as_valid_attempt: false,
        count_as_user_error: false,
        advance_cooldown: false,
        close_schedule: false,
      },
    });
    expect(() => normalizeLearningAttempt({
      operation_id: "teacher-invalid-question-with-score",
      sourceKind: "error_review",
      sourceId: "error-review:void:2",
      attemptRole: "recheck",
      dimension: "application",
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      variantKind: "invalid",
      transferLevel: 0,
      assessmentContext: "practice",
      score: 0,
      maxScore: 1,
    }, "2026-08-12")).toThrow("void 作废题不能记录");
  });

  it("通过单个 RPC 写 attempt，并由数据库同事务投影 knowledge_evidence", async () => {
    const calls = [];
    const db = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: { kind: "learning_attempt", attempt_id: 7, knowledge_evidence_id: 9 }, error: null };
      },
    };
    const result = await recordLearningAttempt(db, {
      operation_id: "attempt-7",
      kpId: "XF-0001",
      sourceKind: "manual",
      dimension: "recall",
      result: "fail",
    }, "2026-08-10");
    expect(result).toMatchObject({ attempt_id: 7, knowledge_evidence_id: 9 });
    expect(calls[0].name).toBe("record_learning_attempt");
  });
});
