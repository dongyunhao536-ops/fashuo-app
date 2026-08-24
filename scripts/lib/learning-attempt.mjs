// [gpt] 2026-08-10：统一学习尝试契约；成功、失败与作废共用同一分母，不从错题反推成功样本。
import { normalizeTransferMetadata } from "./evidence-transfer.mjs";

const DIMENSIONS = new Set(["exposure", "understanding", "recall", "application"]);
const RESULTS = new Set(["pass", "partial", "fail", "void"]);
const SOURCES = new Set([
  "objective_question", "subjective_answer", "error_review", "recite_ledger",
  "ask_verification", "study_error", "manual",
]);
const PROMPTS = new Set(["clean", "cued", "invalid"]);
const WINDOWS = new Set(["immediate", "d3", "d14", "d30"]);
const ATTEMPT_ROLES = new Set(["primary", "rewrite", "recheck", "followup"]);
const STABLE_SOURCE_REQUIRED = new Set([
  "objective_question", "subjective_answer", "error_review", "recite_ledger",
  "ask_verification", "study_error",
]);

function choice(value, choices, label) {
  const normalized = String(value ?? "");
  if (!choices.has(normalized)) throw new Error(`${label}不合法：${normalized || "空"}`);
  return normalized;
}

function optionalNumber(value, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  return number;
}

export function normalizeLearningAttempt(operation, today) {
  const operationId = String(operation.operation_id ?? "").trim();
  if (!operationId) throw new Error("learning_attempt 缺 operation_id");
  const dimension = choice(operation.dimension, DIMENSIONS, "学习尝试维度");
  const result = choice(operation.result, RESULTS, "学习尝试结果");
  const sourceKind = choice(operation.sourceKind ?? "manual", SOURCES, "学习尝试来源");
  const attemptRole = choice(operation.attemptRole ?? "primary", ATTEMPT_ROLES, "学习尝试角色");
  const promptIntegrity = choice(operation.promptIntegrity ?? "clean", PROMPTS, "学习尝试提示完整性");
  const cold = operation.cold ?? false;
  if (typeof cold !== "boolean") throw new Error("learning_attempt cold 必须是布尔值");
  if ((result === "void") !== (promptIntegrity === "invalid")) throw new Error("learning_attempt void 必须且只能对应 invalid 题干");
  if (cold && promptIntegrity !== "clean") throw new Error("learning_attempt 冷检必须使用 clean 题干");

  const score = optionalNumber(operation.score, "score");
  const maxScore = optionalNumber(operation.maxScore, "maxScore");
  if ((score == null) !== (maxScore == null)) throw new Error("score/maxScore 必须成对提供");
  if (score != null && (!(maxScore > 0) || score < 0 || score > maxScore)) throw new Error("score 必须位于 0..maxScore");
  // [gpt] 2026-08-12：void 是教练题面事故审计，不是用户作答成绩；禁止夹带分数归责用户。
  if (result === "void" && score != null) throw new Error("void 作废题不能记录 score/maxScore");

  const questionRef = operation.questionRef == null ? null : String(operation.questionRef).trim() || null;
  const sourceId = operation.sourceId == null ? null : String(operation.sourceId).trim() || null;
  if (STABLE_SOURCE_REQUIRED.has(sourceKind) && !sourceId) throw new Error(`${sourceKind} 学习尝试必须提供稳定 sourceId`);
  if (["objective_question", "subjective_answer"].includes(sourceKind)) {
    if (!questionRef) throw new Error(`${sourceKind} 学习尝试必须提供稳定 questionRef`);
    if (score == null) throw new Error(`${sourceKind} 学习尝试必须提供 score/maxScore`);
  }

  const transfer = normalizeTransferMetadata({
    dimension,
    result,
    promptIntegrity,
    cold,
    variantKind: operation.variantKind ?? null,
    transferLevel: operation.transferLevel ?? null,
    assessmentContext: operation.assessmentContext ?? "practice",
    durationSeconds: operation.durationSeconds ?? null,
  });

  const protocolValues = [operation.protocol, operation.protocolVersion, operation.interventionEpisodeId, operation.observationWindow];
  const protocolCount = protocolValues.filter((value) => value != null && value !== "").length;
  if (![0, 4].includes(protocolCount)) throw new Error("protocol/protocolVersion/interventionEpisodeId/observationWindow 必须成组提供");
  const observationWindow = protocolCount ? choice(operation.observationWindow, WINDOWS, "观察窗口") : null;
  const protocolVersion = protocolCount ? Number(operation.protocolVersion) : null;
  if (protocolCount && (!Number.isInteger(protocolVersion) || protocolVersion < 1)) throw new Error("protocolVersion 必须是正整数");

  return {
    operation_id: operationId,
    ingest_operation_id: operation.ingestOperationId ?? operationId,
    attempt_date: operation.date ?? today,
    occurred_at: operation.occurredAt ?? null,
    subject: operation.subject ?? null,
    kp_id: operation.kpId ? String(operation.kpId).trim().toUpperCase() : null,
    question_ref: questionRef,
    source_kind: sourceKind,
    source_id: sourceId,
    session_key: operation.sessionKey ?? null,
    attempt_role: attemptRole,
    dimension,
    result,
    score,
    max_score: maxScore,
    cold,
    prompt_integrity: promptIntegrity,
    variant_kind: transfer.variantKind,
    transfer_level: transfer.transferLevel,
    probe_axis: operation.probeAxis ?? null,
    assessment_context: transfer.assessmentContext,
    duration_seconds: transfer.durationSeconds,
    failure_pattern_code: operation.failurePatternCode ?? null,
    diagnosis_status: operation.diagnosisStatus ?? "pending",
    protocol: protocolCount ? String(operation.protocol) : null,
    protocol_version: protocolVersion,
    intervention_episode_id: protocolCount ? String(operation.interventionEpisodeId) : null,
    observation_window: observationWindow,
    evidence_anchor: operation.evidenceAnchor ?? null,
    response_excerpt: operation.responseExcerpt ?? null,
    note: operation.note ?? null,
    // [gpt] 2026-08-11：显式保存“是否应投影知识证据”，监控只据声明查部分成功，不从 kp_id 猜生产意图。
    metadata: {
      ...(operation.metadata ?? {}),
      // [gpt] 2026-08-12：调用方不能把污染题改写成用户失败或有效题量；void 归责在规范化层强制覆盖。
      ...(result === "void" ? {
        responsibility: "teacher",
        count_as_valid_attempt: false,
        count_as_user_error: false,
        advance_cooldown: false,
        close_schedule: false,
      } : {}),
      projection_expected: operation.projectEvidence ?? true,
    },
    project_evidence: operation.projectEvidence ?? true,
  };
}

export async function recordLearningAttempt(db, operation, today, { required = true } = {}) {
  const payload = normalizeLearningAttempt(operation, today);
  if (typeof db?.rpc !== "function") {
    if (required) throw new Error("数据库客户端不支持 record_learning_attempt RPC");
    return { kind: "learning_attempt", skipped: true, reason: "rpc-unavailable-in-test-double" };
  }
  const response = await db.rpc("record_learning_attempt", { p_payload: payload });
  if (response?.error) throw new Error(`学习尝试写入失败：${response.error.message ?? response.error}`);
  return response?.data;
}
