// node --env-file=.env.local scripts/verify-schema.mjs
// 用 service_role 通过 PostgREST 探所有表是否就位
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { auditMigrationLedger, readMigrationEntries } from "./lib/migration-ledger.mjs";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
// api_usage 必须在列：它是成本日熔断的命脉表，缺了 recordUsage 静默失败 +
// getTodaySpendUsd fail-open 返 0 → 熔断静默失效、预算能被烧穿（migrations/002）。
const tables = [
  "content_mirror",
  "content_mirror_generation",
  "content_mirror_stage",
  "kp_state",
  "detection_log",
  "study_log",
  "ask_summary",
  "ask_point_v2",
  "events",
  "api_usage",
  "study_error",
  "error_topic",
  "study_error_topic",
  "error_review",
  "error_book_v2",
  // [gpt] 2026-08-10：知识点 v2 事实层；kp_state 仅保留目录身份，状态由 evidence 重算。
  "knowledge_point_v2",
  "knowledge_object_link",
  "knowledge_evidence",
  "knowledge_relation",
  "schema_migrations",
  "ingest_operation",
  "learning_attempt",
  "learning_attempt_rollup_v1",
  "learning_data_quality_v1",
];

let ok = 0;
for (const t of tables) {
  // [gpt] PostgREST 对缺失资源的 HEAD 在部分代理链上会误报成功；取至多一行才能可靠确认表/视图存在。
  const { error, count } = await sb.from(t).select("*", { count: "exact" }).limit(1);
  if (error) {
    console.log(`✗ ${t.padEnd(16)} — ${error.message}`);
  } else {
    console.log(`✓ ${t.padEnd(16)} — rows: ${count ?? 0}`);
    ok++;
  }
}

// [gpt] 2026-08-10：表存在不代表增量迁移已就绪；关键列必须经 PostgREST 实际可选。
const columnProbes = [
  // [gpt] 2026-08-10：误销账必须能安全恢复并留下原因，不能借 recheck-fail 伪造失败。
  { label: "study_error.reopen_guard", table: "study_error", columns: "status,absorbed_at,absorbed_via,reopened_at,reopened_via,reopen_reason" },
  { label: "error_review.probe_v4", table: "error_review", columns: "dimension,cold,prompt_integrity,variant_kind,transfer_level,probe_axis,assessment_context,duration_seconds,angle,evidence_anchor" },
  { label: "knowledge_evidence.v3", table: "knowledge_evidence", columns: "kp_id,evidence_date,dimension,result,prompt_integrity,variant_kind,transfer_level,probe_axis,assessment_context,duration_seconds,failure_pattern_code" },
  { label: "knowledge_relation.v3", table: "knowledge_relation", columns: "prerequisite_kp_id,dependent_kp_id,relation_type,required_stage,relation_status,evidence_anchor" },
  { label: "schema_migrations.v1", table: "schema_migrations", columns: "version,filename,checksum_sha256,source_kind,applied_by,metadata,applied_at,last_verified_at" },
  { label: "content_generation.v1", table: "content_mirror_generation", columns: "generation_id,status,expected_file_count,expected_row_count,config_sha256,scope_sha256,content_sha256,activated_at" },
  { label: "ingest_operation.v1", table: "ingest_operation", columns: "operation_id,op_type,payload_sha256,handler_version,status,attempt_count,result,last_error,applied_at" },
  { label: "study_log.attempt_v2", table: "study_log", columns: "operation_id,attempt_expected" },
  { label: "learning_attempt.v2", table: "learning_attempt", columns: "operation_id,ingest_operation_id,attempt_date,kp_id,question_ref,source_kind,source_id,attempt_role,dimension,result,score,max_score,cold,prompt_integrity,variant_kind,transfer_level,probe_axis,assessment_context,duration_seconds" },
  { label: "learning_attempt_rollup.v1", table: "learning_attempt_rollup_v1", columns: "attempt_date,subject,source_kind,attempt_role,dimension,assessment_context,attempt_count,valid_attempt_count,score_sum,max_score_sum,score_rate" },
  { label: "learning_data_quality.v1", table: "learning_data_quality_v1", columns: "issue_code,severity,entity_kind,entity_id,detected_at,detail" },
];
for (const probe of columnProbes) {
  const { error } = await sb.from(probe.table).select(probe.columns).limit(1);
  if (error) console.log(`✗ ${probe.label.padEnd(28)} — ${error.message}`);
  else {
    console.log(`✓ ${probe.label.padEnd(28)} — columns ready`);
    ok++;
  }
}
// [gpt] 2026-08-10：可选到表列仍不足以证明部署的是本地这份迁移；逐字节核对远端账本。
let migrationAuditOk = false;
const ledger = await sb
  .from("schema_migrations")
  .select("version,filename,checksum_sha256,source_kind,metadata")
  .order("version", { ascending: true });
if (ledger.error) {
  console.log(`✗ migration checksums          — ${ledger.error.message}`);
} else {
  const entries = readMigrationEntries(path.resolve(process.cwd(), "db", "migrations"));
  const audit = auditMigrationLedger(entries, ledger.data ?? []);
  for (const warning of audit.warnings) console.log(`! migration warning            — ${warning}`);
  if (audit.ok) {
    console.log(`✓ migration checksums          — baseline + ${audit.registered} migration(s) verified`);
    migrationAuditOk = true;
    ok++;
  } else {
    for (const issue of audit.issues) console.log(`✗ migration checksums          — ${issue}`);
  }
}

const total = tables.length + columnProbes.length + 1;
console.log(`\n${ok}/${total} schema checks ready.`);
process.exit(ok === total && migrationAuditOk ? 0 : 1);
