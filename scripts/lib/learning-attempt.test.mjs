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
