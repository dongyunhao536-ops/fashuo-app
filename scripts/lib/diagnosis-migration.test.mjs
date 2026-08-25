import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("db/migrations/103_diagnosis_untraceable_same_run.sql", "utf8");
const provenanceMigration = readFileSync("db/migrations/104_diagnosis_policy_migration_provenance.sql", "utf8");

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

  it("103 的历史字节保持原始迁移契约，后续语义更正另走 104", () => {
    expect(migration).toMatch(/check \(diagnosis_status in \('unassessed', 'confirmed', 'rejected', 'untraceable'\)\)/u);
    expect(migration).toContain("untraceable_by = 'user'");
    expect(migration).toContain("PENDING_DIAGNOSIS_MIGRATION_INCOMPLETE");
  });

  it("数据库层拒绝把 untraceable 改回确定诊断", () => {
    expect(migration).toContain("UNTRACEABLE_DIAGNOSIS_TERMINAL");
  });
});

describe("diagnosis provenance correction migration contract", () => {
  it("政策封账同时纠正关系和转换日志，且不改错题事件状态", () => {
    expect(provenanceMigration).toContain("untraceable_by = 'policy_migration'");
    expect(provenanceMigration).toContain("actor = 'policy_migration'");
    expect(provenanceMigration).toContain("不代表用户逐条确认遗忘");
    expect(provenanceMigration).not.toMatch(/update\s+study_error\s+set\s+status/iu);
  });

  it("最终约束区分真实用户决定和政策迁移", () => {
    expect(provenanceMigration).toContain("untraceable_by = 'user'");
    expect(provenanceMigration).toContain("untraceable_by = 'policy_migration'");
    expect(provenanceMigration).toContain("diagnosis_decided_run_id is null");
    expect(provenanceMigration).toContain("nullif(btrim(diagnosis_decided_run_id), '') is not null");
  });

  it("只放行用户原决定 Run 内的 confirmed/rejected 更正，且禁止偷换 primary 关系", () => {
    expect(provenanceMigration).toContain("new.diagnosis_decided_run_id is distinct from old.diagnosis_decided_run_id");
    expect(provenanceMigration).toContain("new.diagnosis_status not in ('confirmed', 'rejected')");
    expect(provenanceMigration).toContain("UNTRACEABLE_DIAGNOSIS_ROLE_TERMINAL");
    expect(provenanceMigration).toContain("user_same_run_correction");
  });
});
