import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("db/migrations/103_diagnosis_untraceable_same_run.sql", "utf8");

describe("diagnosis untraceable migration contract", () => {
  it("只迁移病根关系，不改 study_error 事件状态", () => {
    expect(migration).toMatch(/update\s+study_error_topic[\s\S]+where\s+diagnosis_status\s*=\s*'pending'/iu);
    expect(migration).not.toMatch(/update\s+study_error\s+set\s+status/iu);
    expect(migration).toContain("root_cause_code = 'unclassified'");
    expect(migration).toContain("failure_pattern_code = null");
  });

  it("untraceable 三项元数据和逐条状态迁移审计都由数据库约束", () => {
    expect(migration).toContain("chk_study_error_topic_untraceable_metadata");
    expect(migration).toContain("untraceable_at is not null");
    expect(migration).toContain("diagnosis_transition_log");
    expect(migration).toContain("trg_audit_diagnosis_transition");
  });

  it("迁移结束后关系表不再允许 pending，且 untraceable 只能来自用户决定", () => {
    expect(migration).toMatch(/check \(diagnosis_status in \('unassessed', 'confirmed', 'rejected', 'untraceable'\)\)/u);
    expect(migration).toContain("untraceable_by = 'user'");
    expect(migration).toContain("PENDING_DIAGNOSIS_MIGRATION_INCOMPLETE");
  });

  it("数据库层拒绝把 untraceable 改回确定诊断", () => {
    expect(migration).toContain("UNTRACEABLE_DIAGNOSIS_TERMINAL");
  });
});
