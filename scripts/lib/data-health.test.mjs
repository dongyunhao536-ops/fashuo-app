import { describe, expect, it } from "vitest";
import { evaluateDataHealth } from "./data-health.mjs";

describe("data health", () => {
  it("镜像代际、行数和质量门均一致时通过", () => {
    const report = evaluateDataHealth({
      activeGenerations: [{ generation_id: "g1", expected_row_count: 116 }],
      mirrorRowCount: 116,
      stageRowCount: 0,
      qualityIssues: [],
      attemptCount: 20,
    });
    expect(report).toMatchObject({ ok: true, errors: [], warnings: [], metrics: { activeGenerationId: "g1" } });
  });

  it("active 代际基数、镜像行数和 error 级质量问题会阻断", () => {
    const noActive = evaluateDataHealth({ activeGenerations: [], mirrorRowCount: 3, attemptCount: 1 });
    expect(noActive.ok).toBe(false);
    expect(noActive.errors.map((item) => item.code)).toContain("active_generation_cardinality");

    const mismatched = evaluateDataHealth({
      activeGenerations: [{ generation_id: "g1", expected_row_count: 10 }],
      mirrorRowCount: 9,
      qualityIssues: [{ issue_code: "ingest_failed", severity: "error", entity_kind: "ingest_operation", entity_id: "op-1" }],
      attemptCount: 1,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors.map((item) => item.code)).toEqual(expect.arrayContaining([
      "active_generation_row_mismatch",
      "ingest_failed",
    ]));
  });

  it("stage 残留、缺尝试和 warning 质量项只告警", () => {
    const report = evaluateDataHealth({
      activeGenerations: [{ generation_id: "g1", expected_row_count: 1 }],
      mirrorRowCount: 1,
      stageRowCount: 2,
      qualityIssues: [{ issue_code: "law_attempt_missing_kp", severity: "warning", entity_kind: "learning_attempt", entity_id: "8" }],
      attemptCount: 0,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "mirror_stage_not_empty",
      "law_attempt_missing_kp",
      "learning_attempt_empty",
    ]));
  });
});
