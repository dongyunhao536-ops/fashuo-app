// [gpt] 2026-08-10：只有带显式评分语义的训练流水才进入统一尝试分母；禁止从旧 accuracy/散文台账回猜。
import { EVIDENCE_VARIANTS } from "./evidence-transfer.mjs";
import { normalizeLearningAttempt } from "./learning-attempt.mjs";

const ATTEMPT_FLAG_KEYS = new Set([
  "attempt-source", "result", "question", "session", "kp", "dimension", "role",
  "score", "max", "cold", "cued", "invalid-prompt", "variant", "probe-axis",
  "context", "seconds", "anchor", "pattern", "diagnosis", "response",
]);

function value(flags, key) {
  const raw = flags[key];
  return raw == null || raw === true ? null : raw;
}

function booleanValue(flags, key) {
  const raw = flags[key];
  if (raw == null) return false;
  if (raw === true || raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${key} 只接受 true 或 false`);
}

export function buildStudyLogAttemptConfig(flags, {
  date,
  subject,
  chapter,
} = {}) {
  const hasAttemptFlags = Object.keys(flags ?? {}).some((key) => ATTEMPT_FLAG_KEYS.has(key));
  if (!hasAttemptFlags) return null;

  const sourceKind = value(flags, "attempt-source");
  if (!sourceKind) throw new Error("尝试元数据必须显式提供 --attempt-source");
  const result = value(flags, "result");
  if (!result) throw new Error("尝试元数据必须显式提供 --result");
  const questionRef = value(flags, "question") ?? chapter ?? null;
  const variantKind = value(flags, "variant");
  const cued = booleanValue(flags, "cued");
  const invalidPrompt = booleanValue(flags, "invalid-prompt");
  if (cued && invalidPrompt) throw new Error("--cued 与 --invalid-prompt 不能同时使用");

  const attempt = {
    date,
    subject,
    kpId: value(flags, "kp"),
    questionRef,
    sourceKind,
    sessionKey: value(flags, "session"),
    attemptRole: value(flags, "role") ?? "primary",
    dimension: value(flags, "dimension") ?? "application",
    result,
    score: value(flags, "score"),
    maxScore: value(flags, "max"),
    cold: booleanValue(flags, "cold"),
    promptIntegrity: invalidPrompt ? "invalid" : cued ? "cued" : "clean",
    variantKind,
    transferLevel: variantKind ? EVIDENCE_VARIANTS[variantKind]?.transferLevel : null,
    probeAxis: value(flags, "probe-axis"),
    assessmentContext: value(flags, "context") ?? "practice",
    durationSeconds: value(flags, "seconds"),
    failurePatternCode: value(flags, "pattern"),
    diagnosisStatus: value(flags, "diagnosis") ?? "unassessed",
    evidenceAnchor: value(flags, "anchor"),
    responseExcerpt: value(flags, "response"),
  };

  // sourceId 只有 study_log 真正入库后才产生；这里用占位值执行其余完整校验。
  normalizeLearningAttempt({
    operation_id: "validate-study-log-attempt",
    ingestOperationId: "validate-study-log-attempt",
    sourceId: "pending-study-log-id",
    ...attempt,
  }, date);
  return attempt;
}

export function materializeStudyLogAttempt(operation, studyLogId) {
  if (!operation?.attempt) return null;
  if (!operation.operation_id) throw new Error("study_log 尝试缺父 operation_id");
  if (studyLogId == null || studyLogId === "") throw new Error("study_log 尝试缺已入库日志 id");
  const attempt = {
    operation_id: `${operation.operation_id}:attempt`,
    ingestOperationId: operation.operation_id,
    date: operation.date,
    subject: operation.subject,
    ...operation.attempt,
    // [gpt] 数据库主键是 study_log 尝试来源的最终身份，不能被调用方覆盖。
    sourceId: String(studyLogId),
    metadata: {
      ...(operation.attempt.metadata ?? {}),
      producer: "study_log[gpt]",
      study_log_operation_id: operation.operation_id,
      activity: operation.activity ?? "其他",
      chapter: operation.chapter ?? null,
    },
  };
  normalizeLearningAttempt(attempt, operation.date);
  return attempt;
}

export function buildReciteAttemptOperation(event, entry) {
  if (!event?.operationId) throw new Error("带背证据缺 operationId");
  if (!entry?.id || !entry?.subject) throw new Error("带背证据缺稳定条目身份");
  const operation = {
    op: "learning_attempt",
    operation_id: event.operationId,
    date: event.date,
    subject: entry.subject,
    kpId: null,
    questionRef: `recite:${entry.id}`,
    sourceKind: "recite_ledger",
    sourceId: entry.id,
    attemptRole: "recheck",
    dimension: event.dimension,
    result: event.result,
    cold: event.cold,
    promptIntegrity: event.promptIntegrity,
    failurePatternCode: event.failurePatternCode,
    diagnosisStatus: event.diagnosisStatus ?? "unassessed",
    evidenceAnchor: event.evidenceAnchor,
    note: event.note,
    projectEvidence: false,
    metadata: {
      producer: "recite_ledger[gpt]",
      entry_title: entry.title ?? null,
      ...(event.result === "void" ? {
        responsibility: "teacher",
        count_as_valid_attempt: false,
        count_as_user_error: false,
        advance_cooldown: false,
        close_schedule: false,
      } : {}),
    },
  };
  normalizeLearningAttempt(operation, event.date);
  return operation;
}

export function appendOutboxText(previous, operation, timestamp = new Date().toISOString()) {
  const normalizedPrevious = String(previous ?? "");
  const prefix = normalizedPrevious && !normalizedPrevious.endsWith("\n") ? `${normalizedPrevious}\n` : normalizedPrevious;
  const row = { ...operation, ts: operation.ts ?? timestamp };
  return { operation: row, text: `${prefix}${JSON.stringify(row)}\n` };
}
