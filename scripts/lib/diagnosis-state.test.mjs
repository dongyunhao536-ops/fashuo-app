import { describe, expect, it } from "vitest";
import { diagnosisProbePolicy, normalizeDiagnosisTransition } from "./diagnosis-state.mjs";

describe("diagnosis same-run lifecycle", () => {
  it("pending 只能留在当前 Run artifact，持久状态从 unassessed 开始", () => {
    expect(() => normalizeDiagnosisTransition({ fromStatus: "unassessed", toStatus: "pending" }))
      .toThrow(/PENDING_DIAGNOSIS_ARTIFACT_ONLY/);
    expect(normalizeDiagnosisTransition({
      fromStatus: "unassessed", toStatus: "rejected", decisionRunId: "SR-A",
    }).toStatus).toBe("rejected");
  });

  it("认领或排除没有当前 Run 回执时直接拒绝", () => {
    expect(() => normalizeDiagnosisTransition({ fromStatus: "unassessed", toStatus: "confirmed" }))
      .toThrow(/DIAGNOSIS_DECISION_RUN_REQUIRED/);
  });

  it("只有用户明确决定才可写 untraceable，Run 中止不能代替用户", () => {
    const base = { fromStatus: "unassessed", toStatus: "untraceable", decisionRunId: "SR-A" };
    expect(() => normalizeDiagnosisTransition(base)).toThrow(/UNTRACEABLE_AT_REQUIRED/);
    expect(() => normalizeDiagnosisTransition({
      ...base,
      untraceableAt: "2026-08-25T02:00:00.000Z",
      untraceableBy: "run_close",
      untraceableReason: "会话中止",
    })).toThrow(/UNTRACEABLE_USER_DECISION_REQUIRED/);
    expect(normalizeDiagnosisTransition({
      ...base,
      untraceableAt: "2026-08-25T02:00:00.000Z",
      untraceableBy: "user",
      untraceableReason: "用户明确表示已经忘记当时思路",
    })).toMatchObject({ toStatus: "untraceable", decisionRunId: "SR-A", untraceableBy: "user" });
  });

  it("用户 untraceable 同 Run 可更正，跨 Run 与政策封账仍是终态", () => {
    expect(normalizeDiagnosisTransition({
      fromStatus: "untraceable",
      fromDecisionRunId: "SR-A",
      fromUntraceableBy: "user",
      toStatus: "confirmed",
      decisionRunId: "SR-A",
    })).toMatchObject({
      fromStatus: "untraceable",
      toStatus: "confirmed",
      decisionRunId: "SR-A",
      untraceableAt: null,
      untraceableBy: null,
      untraceableReason: null,
    });
    expect(() => normalizeDiagnosisTransition({
      fromStatus: "untraceable",
      fromDecisionRunId: "SR-A",
      fromUntraceableBy: "user",
      toStatus: "confirmed",
      decisionRunId: "SR-B",
    })).toThrow(/UNTRACEABLE_DIAGNOSIS_TERMINAL/);
    expect(() => normalizeDiagnosisTransition({
      fromStatus: "untraceable",
      fromDecisionRunId: null,
      fromUntraceableBy: "policy_migration",
      toStatus: "confirmed",
      decisionRunId: "SR-A",
    })).toThrow(/UNTRACEABLE_DIAGNOSIS_TERMINAL/);
  });

  it("untraceable 未更正时只能正面考知识且不得并案", () => {
    expect(diagnosisProbePolicy("untraceable")).toEqual({
      mode: "positive_knowledge_only",
      allowMisconceptionProbe: false,
      allowRootCauseClaim: false,
      allowMerge: false,
    });
  });
});
