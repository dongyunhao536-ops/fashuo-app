import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  buildReviewEvidence,
  nextMasteryStatus,
  topicInsertPayload,
  validateDiagnosisStatus,
  validateFailurePattern,
  validateReviewResult,
  validateRootCause,
} from "./error-taxonomy.mjs";
import { loadEventAbsorptionProofs } from "./error-absorption.mjs";
import { normalizeTransferMetadata } from "./evidence-transfer.mjs";
import { withIngestAudit } from "./ingest-ledger.mjs";
import { recordLearningAttempt } from "./learning-attempt.mjs";
import { materializeStudyLogAttempt } from "./attempt-producers.mjs";
import { errorEntrySourceLabel, isLegacyErrorEntry, migrateLegacyErrorEntry, validateErrorEntry } from "./error-entry.mjs";
import {
  normalizeStudyActivity,
  recitationModeFromActivity,
  withRecitationModeMarker,
} from "./study-activity.mjs";

const STUDY_OUTBOX_HANDLER_VERSION = "data-foundation-v1[gpt]";

function stableLegacyId(line) {
  return `legacy-${createHash("sha256").update(line).digest("hex")}`;
}

function parseLine(line, index) {
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    throw new Error(`outbox 第 ${index + 1} 行不是合法 JSON；为避免丢账，已停止读取`);
  }
  if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string") {
    throw new Error(`outbox 第 ${index + 1} 行缺少合法 op；为避免丢账，已停止读取`);
  }
  return { ...op, operation_id: op.operation_id || stableLegacyId(line) };
}

export function readOutbox(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map(parseLine);
}

export function appendOutbox(path, op, options = {}) {
  const operation = {
    ...op,
    operation_id: op.operation_id || options.operationId || randomUUID(),
    ts: op.ts || options.timestamp || new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(operation)}\n`);
  return operation;
}

/**
 * 用同目录临时文件替换 outbox，避免进程在重写途中退出后只留下半行 JSON。
 * 数据库成功而本地替换失败也安全：下次重试由 operation_id 去重。
 */
export function writeOutbox(path, operations) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = operations.length
    ? `${operations.map((op) => JSON.stringify(op)).join("\n")}\n`
    : "";
  writeFileSync(temp, body);
  renameSync(temp, path);
}

// [claude] 2026-08-24：只对瞬时网络故障重试。
// 校验类错误重试多少次都还是错，重试只会拖慢并掩盖真问题。
const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /network|socket hang up|premature close/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/i,
  /timeout|timed out/i,
  /TLS|SSL|handshake/i,
  /\b5\d{2}\b.*(gateway|unavailable|timeout)|(gateway|unavailable).*\b5\d{2}\b/i,
];

export function isTransientSyncError(error) {
  const message = error instanceof Error
    ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
    : String(error ?? "");
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * [claude] 2026-08-24：网络抖动时有界重试。
 *
 * 2026-08-24 云网络本身不稳，一次抖动就让整条复检写回失败、Run 被迫中止。
 * 这里的写回本来就由 operation_id 保证幂等（withIngestAudit + 稳定 operation_id），
 * 所以重试不会制造重复流水；缺的只是"别一碰就放弃"。
 */
// [claude] 2026-08-24：退避窗口按实测链路定。ECS 8443 跨境反代实测
// ICMP 0% 丢包但抖动大（49–201ms，stddev 34ms），PostgREST p90 185ms/max 298ms。
// 原来的 500ms+2000ms 只扛 2.5 秒，断几秒就顶不住；1+4+10 覆盖约 15 秒，
// 能吃掉大多数短暂中断。真长时间断网仍会失败，但那时走 deferred 通路，证据不丢。
export async function processOutbox(operations, handler, {
  retries = 3,
  retryDelaysMs = [1000, 4000, 10000],
  isTransient = isTransientSyncError,
  wait = sleep,
} = {}) {
  const succeeded = [];
  const failed = [];
  for (const op of operations) {
    let lastError;
    let attempts = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      attempts = attempt + 1;
      try {
        const result = await handler(op);
        succeeded.push({ op, result, attempts });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt === retries || !isTransient(error)) break;
        await wait(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]);
      }
    }
    if (lastError !== undefined) {
      failed.push({
        op,
        attempts,
        transient: isTransient(lastError),
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }
  return { succeeded, failed };
}

function throwOnError(response, label) {
  if (response?.error) throw new Error(`${label}：${response.error.message}`);
  return response;
}

function shiftDate(ymd, days) {
  const value = new Date(`${ymd}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const ASK_SUBJECTS = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const ASK_RESOLUTIONS = new Set(["clarified", "dismissed", "superseded"]);
const ASK_INITIAL_RESULTS = new Set(["partial", "fail"]);

async function getTopic(db, subject, topic, nowIso) {
  const base = topicInsertPayload(subject, topic, nowIso);
  const payload = Object.fromEntries(
    Object.entries(base).filter(([, value]) => value != null),
  );
  // pending 只能作为新主题的默认值，不能把已确认主题降级回 pending。
  if (payload.classification_status === "pending") delete payload.classification_status;
  const response = await db
    .from("error_topic")
    .upsert(payload, { onConflict: "topic_key" })
    .select("id, topic_key, title, classification_status")
    .single();
  throwOnError(response, "弱项主题写入失败");
  return response.data;
}

async function linkErrorTopic(db, studyErrorId, topicId, topic, nowIso) {
  const role = topic.role ?? "primary";
  if (role === "primary") {
    const demote = await db
      .from("study_error_topic")
      .update({ role: "related", updated_at: nowIso })
      .eq("study_error_id", studyErrorId)
      .eq("role", "primary")
      .neq("topic_id", topicId);
    throwOnError(demote, "旧主主题降级失败");
  }
  const response = await db.from("study_error_topic").upsert({
    study_error_id: studyErrorId,
    topic_id: topicId,
    role,
    root_cause_code: validateRootCause(topic.rootCauseCode),
    failure_pattern_code: validateFailurePattern(topic.failurePatternCode),
    root_cause_note: topic.rootCauseNote ?? null,
    diagnosis_status: validateDiagnosisStatus(topic.diagnosisStatus),
    evidence_anchor: topic.evidenceAnchor ?? null,
    updated_at: nowIso,
  }, { onConflict: "study_error_id,topic_id" });
  throwOnError(response, "错题与弱项主题关联失败");
}

async function findInsertedError(db, operationId, insertResponse) {
  const inserted = Array.isArray(insertResponse.data) ? insertResponse.data[0] : insertResponse.data;
  if (inserted?.id) return inserted;
  const lookup = await db
    .from("study_error")
    .select("id, subject, kp_id")
    .eq("operation_id", operationId)
    .maybeSingle();
  throwOnError(lookup, "重试时查找错题事件失败");
  if (!lookup.data?.id) throw new Error("错题事件写入后未能取回 id");
  return lookup.data;
}

async function inheritRecurTopics(db, sourceId, targetId, explicitTopic, nowIso) {
  if (!sourceId) return 0;
  const response = await db
    .from("study_error_topic")
    .select("topic_id, role, root_cause_code, failure_pattern_code, root_cause_note, diagnosis_status, evidence_anchor")
    .eq("study_error_id", sourceId);
  throwOnError(response, "读取复发源主题失败");
  let count = 0;
  for (const link of response.data ?? []) {
    await linkErrorTopic(db, targetId, link.topic_id, {
      role: explicitTopic && link.role === "primary" ? "related" : link.role,
      rootCauseCode: link.root_cause_code,
      failurePatternCode: link.failure_pattern_code,
      rootCauseNote: link.root_cause_note,
      diagnosisStatus: link.diagnosis_status,
      evidenceAnchor: link.evidence_anchor,
    }, nowIso);
    count++;
  }
  return count;
}

const KNOWLEDGE_DIMENSIONS = new Set(["exposure", "understanding", "recall", "application"]);
const KNOWLEDGE_RESULTS = new Set(["pass", "partial", "fail", "void"]);
const PROMPT_INTEGRITY = new Set(["clean", "cued", "invalid"]);
const EVIDENCE_KINDS = new Set(["study_error", "error_review", "recite_ledger", "detection_legacy", "ask_point", "study_log", "learning_attempt", "manual"]);
const LINK_KINDS = new Set(["study_error", "error_topic", "error_review", "recite_ledger", "ask_point", "study_log", "manual"]);
const LINK_ROLES = new Set(["primary", "related", "reference"]);
const LINK_METHODS = new Set(["manual", "legacy_direct", "exact_name", "anki_exact", "anki_section", "fuzzy"]);
const LINK_STATUSES = new Set(["pending", "confirmed", "rejected"]);
const RELATION_TYPES = new Set(["prerequisite", "supports", "contrast"]);
const RELATION_STATUSES = new Set(["pending", "confirmed", "rejected"]);
const RELATION_SOURCES = new Set(["manual", "curated", "textbook", "catalog", "model"]);
const PREREQUISITE_STAGES = new Set(["understanding", "recall", "application", "stable"]);

function oneOf(value, choices, label) {
  const normalized = String(value ?? "");
  if (!choices.has(normalized)) throw new Error(`${label}不合法：${normalized || "空"}`);
  return normalized;
}

async function appendKnowledgeEvidence(db, op, today) {
  const kpId = String(op.kpId ?? "").trim();
  if (!kpId) throw new Error("知识证据缺 kpId");
  const dimension = oneOf(op.dimension, KNOWLEDGE_DIMENSIONS, "知识证据维度");
  const result = oneOf(op.result, KNOWLEDGE_RESULTS, "知识证据结果");
  const promptIntegrity = oneOf(op.promptIntegrity ?? "clean", PROMPT_INTEGRITY, "提示完整性");
  if (op.cold != null && typeof op.cold !== "boolean") throw new Error("知识证据 cold 必须是布尔值");
  const cold = op.cold ?? false;
  if ((result === "void") !== (promptIntegrity === "invalid")) throw new Error("知识证据 void 必须对应 invalid 题干，invalid 题干也必须记 void");
  if (cold && promptIntegrity !== "clean") throw new Error("知识证据冷检必须使用 clean 题干");
  const sourceKind = oneOf(op.sourceKind ?? "manual", EVIDENCE_KINDS, "知识证据来源");
  // [gpt] 2026-08-12：void 不能携带用户栽点；教练责任在统一证据入口再次强制覆盖。
  const teacherVoid = result === "void";
  const diagnosisStatus = validateDiagnosisStatus(teacherVoid ? "pending" : op.diagnosisStatus ?? "pending");
  const failurePatternCode = teacherVoid ? null : validateFailurePattern(op.failurePatternCode);
  const note = teacherVoid
    ? ["responsibility=teacher", "valid_attempt=false", "user_error=false", "cooldown_advanced=false", op.note].filter(Boolean).join("；")
    : op.note ?? null;
  const transfer = normalizeTransferMetadata({
    dimension,
    result,
    promptIntegrity,
    cold,
    variantKind: op.variantKind ?? null,
    transferLevel: op.transferLevel ?? null,
    assessmentContext: op.assessmentContext ?? "practice",
    durationSeconds: op.durationSeconds ?? null,
  });
  const response = await db.from("knowledge_evidence").upsert({
    operation_id: op.operation_id,
    kp_id: kpId,
    evidence_date: op.date ?? today,
    dimension,
    result,
    source_kind: sourceKind,
    source_id: op.sourceId == null ? null : String(op.sourceId),
    cold,
    prompt_integrity: promptIntegrity,
    failure_pattern_code: failurePatternCode,
    diagnosis_status: diagnosisStatus,
    variant_kind: transfer.variantKind,
    transfer_level: transfer.transferLevel,
    probe_axis: op.probeAxis ?? null,
    assessment_context: transfer.assessmentContext,
    duration_seconds: transfer.durationSeconds,
    evidence_anchor: op.evidenceAnchor ?? null,
    note,
  }, { onConflict: "operation_id", ignoreDuplicates: true });
  throwOnError(response, "知识点证据写入失败");
  return { kind: "knowledge_evidence", affected: 1, kpId, dimension, result, ...transfer };
}

async function linkKnowledgeObject(db, op, nowIso) {
  const sourceKind = oneOf(op.sourceKind, LINK_KINDS, "知识对象类型");
  const sourceId = String(op.sourceId ?? "").trim();
  const kpId = String(op.kpId ?? "").trim();
  if (!sourceId) throw new Error("知识对象链接缺 sourceId");
  if (!kpId) throw new Error("知识对象链接缺 kpId");
  const role = oneOf(op.role ?? "primary", LINK_ROLES, "知识对象角色");
  const matchMethod = oneOf(op.matchMethod ?? "manual", LINK_METHODS, "知识对象匹配方式");
  const linkStatus = oneOf(op.linkStatus ?? "pending", LINK_STATUSES, "知识对象链接状态");
  const confidence = Number(op.confidence ?? (linkStatus === "confirmed" ? 100 : 0));
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error("知识对象链接 confidence 必须是 0-100 整数");
  const response = await db.from("knowledge_object_link").upsert({
    operation_id: op.operation_id,
    source_kind: sourceKind,
    source_id: sourceId,
    kp_id: kpId,
    role,
    match_method: matchMethod,
    link_status: linkStatus,
    confidence,
    evidence_anchor: op.evidenceAnchor ?? null,
    created_by: op.createdBy ?? "pc",
    updated_at: nowIso,
  }, { onConflict: "source_kind,source_id,kp_id" });
  throwOnError(response, "知识对象链接写入失败");
  // 显式映射表是权威；旧单值列只做兼容回填，让现有错题/答疑入口继续能带出 kp_id。
  if (role === "primary" && linkStatus === "confirmed") {
    const numericId = Number(sourceId);
    const legacyTarget = sourceKind === "error_topic"
      ? { table: "error_topic", label: "弱项主题", id: numericId }
      : sourceKind === "study_error"
        ? { table: "study_error", label: "错题事件", id: numericId }
        : null;
    if (legacyTarget) {
      if (!Number.isInteger(legacyTarget.id) || legacyTarget.id <= 0) throw new Error(`${legacyTarget.label} sourceId 必须是正整数`);
      const legacy = await db.from(legacyTarget.table).update({ kp_id: kpId }).eq("id", legacyTarget.id).select("id");
      throwOnError(legacy, `${legacyTarget.label}兼容 kp_id 回填失败`);
      if (!legacy.data?.length) throw new Error(`${legacyTarget.label} #${legacyTarget.id} 不存在`);
    }
  }
  return { kind: "knowledge_link", affected: 1, sourceKind, sourceId, kpId, linkStatus };
}

async function upsertKnowledgeRelation(db, op, nowIso) {
  const prerequisiteKpId = String(op.prerequisiteKpId ?? "").trim().toUpperCase();
  const dependentKpId = String(op.dependentKpId ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2,4}-\d{4}$/.test(prerequisiteKpId) || !/^[A-Z]{2,4}-\d{4}$/.test(dependentKpId)) {
    throw new Error("知识关系需要两个合法 KP-ID");
  }
  if (prerequisiteKpId === dependentKpId) throw new Error("知识关系不能自环");
  const relationType = oneOf(op.relationType ?? "prerequisite", RELATION_TYPES, "知识关系类型");
  const relationStatus = oneOf(op.relationStatus ?? "pending", RELATION_STATUSES, "知识关系状态");
  const sourceKind = oneOf(op.sourceKind ?? "manual", RELATION_SOURCES, "知识关系来源");
  const requiredStage = relationType === "prerequisite"
    ? oneOf(op.requiredStage ?? "understanding", PREREQUISITE_STAGES, "前置最低阶段")
    : null;
  const strength = Number(op.strength ?? 3);
  const confidence = Number(op.confidence ?? (relationStatus === "confirmed" ? 100 : 70));
  if (!Number.isInteger(strength) || strength < 1 || strength > 5) throw new Error("知识关系 strength 必须是 1-5 整数");
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error("知识关系 confidence 必须是 0-100 整数");
  const evidenceAnchor = String(op.evidenceAnchor ?? "").trim() || null;
  if (relationStatus === "confirmed" && !evidenceAnchor) throw new Error("confirmed 知识关系必须带证据锚点");
  if (relationStatus === "confirmed" && !["manual", "curated", "textbook"].includes(sourceKind)) {
    throw new Error("model/catalog 候选不能直接确认知识关系");
  }
  const response = await db.from("knowledge_relation").upsert({
    operation_id: op.operation_id,
    prerequisite_kp_id: prerequisiteKpId,
    dependent_kp_id: dependentKpId,
    relation_type: relationType,
    required_stage: requiredStage,
    strength,
    relation_status: relationStatus,
    confidence,
    source_kind: sourceKind,
    evidence_anchor: evidenceAnchor,
    note: op.note ?? null,
    created_by: op.createdBy ?? "knowledge-cli",
    updated_at: nowIso,
  }, { onConflict: "prerequisite_kp_id,dependent_kp_id,relation_type" });
  throwOnError(response, "知识关系写入失败");
  return { kind: "knowledge_relation", affected: 1, prerequisiteKpId, dependentKpId, relationType, relationStatus };
}

async function resolveAskPoint(db, op, nowIso) {
  if (!Number.isInteger(op.pointId) || op.pointId <= 0) throw new Error("答疑卡点收口缺合法 id");
  if (!ASK_RESOLUTIONS.has(op.action)) throw new Error(`答疑卡点收口动作不合法：${op.action ?? "空"}`);
  const replay = await db.from("ask_summary").select("id, status").eq("resolve_operation_id", op.operation_id).maybeSingle();
  throwOnError(replay, "检查答疑卡点收口重试失败");
  if (replay.data?.id) return { kind: "resolve_ask_point", affected: 0, pointId: replay.data.id, status: replay.data.status };
  const response = await db.from("ask_summary").update({
    status: op.action,
    resolved_at: nowIso,
    resolution_note: op.note ?? null,
    resolve_operation_id: op.operation_id,
    updated_at: nowIso,
  }).eq("id", op.pointId).eq("status", "open").select("id, status");
  throwOnError(response, "答疑卡点收口失败");
  if (response.data?.length) return { kind: "resolve_ask_point", affected: 1, pointId: op.pointId, status: op.action };
  const current = await db.from("ask_summary").select("id, status").eq("id", op.pointId).maybeSingle();
  throwOnError(current, "读取答疑卡点当前状态失败");
  if (!current.data) throw new Error(`答疑卡点 A#${op.pointId} 不存在`);
  if (current.data.status === op.action) return { kind: "resolve_ask_point", affected: 0, pointId: op.pointId, status: op.action };
  throw new Error(`答疑卡点 A#${op.pointId} 已是 ${current.data.status}，不能改为 ${op.action}`);
}

async function applyAskVerification(db, op, today, nowIso) {
  if (!Number.isInteger(op.pointId) || op.pointId <= 0) throw new Error("答疑验证缺合法卡点 id");
  const kpId = String(op.kpId ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2,4}-\d{4}$/.test(kpId)) throw new Error("答疑验证缺合法 KP-ID");
  const result = oneOf(op.result, KNOWLEDGE_RESULTS, "答疑验证结果");
  const promptIntegrity = oneOf(op.promptIntegrity ?? "clean", PROMPT_INTEGRITY, "提示完整性");
  if (promptIntegrity === "invalid" && result !== "void") throw new Error("题面无效时答疑验证结果必须是 void");
  if (result === "void" && promptIntegrity !== "invalid") throw new Error("答疑验证 void 必须标记 invalid prompt");
  const evidenceAnchor = String(op.evidenceAnchor ?? "").trim();
  const teacherVoid = result === "void";
  const noteInput = String(op.note ?? "").trim();
  const note = teacherVoid
    ? ["responsibility=teacher", "valid_attempt=false", "user_error=false", "cooldown_advanced=false", noteInput].filter(Boolean).join("；")
    : noteInput;
  if (!evidenceAnchor) throw new Error("答疑验证缺 evidenceAnchor");
  if (!note) throw new Error("答疑验证缺 note");

  const point = await db.from("ask_summary").select("id, status, kp_id").eq("id", op.pointId).maybeSingle();
  throwOnError(point, "读取待验证答疑卡点失败");
  if (!point.data) throw new Error(`答疑卡点 A#${op.pointId} 不存在`);
  if (point.data.kp_id && String(point.data.kp_id).toUpperCase() !== kpId) {
    throw new Error(`答疑卡点 A#${op.pointId} 已关联 ${point.data.kp_id}，不能按 ${kpId} 验证`);
  }
  const shouldClarify = result === "pass" && promptIntegrity === "clean";
  if (!shouldClarify && point.data.status !== "open") {
    throw new Error(`答疑卡点 A#${op.pointId} 已是 ${point.data.status}，不能追加未收口验证`);
  }

  // [gpt] 2026-08-10：先落映射和理解证据，只有无提示通过后才允许销疑。
  const knowledgeLink = await linkKnowledgeObject(db, {
    operation_id: `${op.operation_id}:knowledge-link`,
    sourceKind: "ask_point",
    sourceId: op.pointId,
    kpId,
    role: "primary",
    matchMethod: "manual",
    linkStatus: "confirmed",
    confidence: 100,
    evidenceAnchor,
    createdBy: "ask-verification",
  }, nowIso);
  if (!point.data.kp_id) {
    const backfill = await db.from("ask_summary").update({ kp_id: kpId, updated_at: nowIso }).eq("id", op.pointId).select("id, kp_id");
    throwOnError(backfill, "回填答疑卡点 kp_id 失败");
    if (!backfill.data?.length) throw new Error(`答疑卡点 A#${op.pointId} 回填 kp_id 失败`);
  }
  const knowledgeEvidence = await appendKnowledgeEvidence(db, {
    operation_id: `${op.operation_id}:knowledge-understanding`,
    kpId,
    date: op.date ?? today,
    dimension: "understanding",
    result,
    sourceKind: "ask_point",
    sourceId: op.pointId,
    cold: Boolean(op.cold),
    promptIntegrity,
    evidenceAnchor,
    note,
  }, today);
  const learningAttempt = await recordLearningAttempt(db, {
    operation_id: `${op.operation_id}:attempt`,
    ingestOperationId: op.operation_id,
    date: op.date ?? today,
    kpId,
      sourceKind: "ask_verification",
      sourceId: op.pointId,
      attemptRole: "recheck",
      questionRef: op.questionRef ?? null,
    sessionKey: op.sessionKey ?? null,
    dimension: "understanding",
    result,
    cold: Boolean(op.cold),
    promptIntegrity,
    assessmentContext: op.assessmentContext ?? "practice",
    durationSeconds: op.durationSeconds ?? null,
    evidenceAnchor,
    responseExcerpt: op.responseExcerpt ?? null,
    note,
    metadata: teacherVoid ? {
      responsibility: "teacher",
      count_as_valid_attempt: false,
      count_as_user_error: false,
      advance_cooldown: false,
      close_schedule: false,
    } : op.metadata,
    projectEvidence: false,
  }, today, { required: false });
  const resolution = shouldClarify
    ? await resolveAskPoint(db, {
      operation_id: op.operation_id,
      pointId: op.pointId,
      action: "clarified",
      note,
    }, nowIso)
    : null;
  return {
    kind: "ask_verification",
    affected: 1,
    pointId: op.pointId,
    kpId,
    result,
    promptIntegrity,
    clarified: Boolean(resolution),
    knowledgeLink,
    knowledgeEvidence,
    learningAttempt,
    resolution,
    ...(teacherVoid ? {
      disposition: {
        responsibility: "teacher",
        countAsValidAttempt: false,
        countAsUserError: false,
        advanceCooldown: false,
        closeSchedule: false,
      },
    } : {}),
  };
}

async function appendErrorApplicationEvidence(db, op, event, today) {
  const kpId = op.topic?.kpId ?? event?.kp_id ?? null;
  if (!kpId) return null;
  return appendKnowledgeEvidence(db, {
    operation_id: `${op.operation_id}:knowledge-application`,
    kpId,
    date: op.date ?? today,
    dimension: "application",
    result: "fail",
    sourceKind: "study_error",
    sourceId: event.id,
    cold: false,
    promptIntegrity: "clean",
    failurePatternCode: op.topic?.failurePatternCode ?? null,
    diagnosisStatus: op.topic?.diagnosisStatus ?? "pending",
    evidenceAnchor: op.topic?.evidenceAnchor ?? `study_error#${event.id}`,
    note: op.topic?.rootCauseNote ?? op.knowledge ?? null,
  }, today);
}

async function applyOperation(db, op, today, nowIso) {
  if (op.op === "absorb") {
    const ids = [...new Set((op.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error("销账操作没有合法 id");
    // [gpt] 2026-08-10：落库前重新读取事实证据，不能信任 CLI 快照或手改 outbox。
    const eventsResponse = await db.from("study_error").select("id,status,log_date").in("id", ids);
    throwOnError(eventsResponse, "读取待销账错题失败");
    const openEvents = (eventsResponse.data ?? []).filter((event) => event.status === "open");
    if (openEvents.length) {
      const proofs = await loadEventAbsorptionProofs(db, openEvents, today);
      const blocked = openEvents
        .map((event) => proofs.get(Number(event.id)))
        .filter((proof) => !proof?.eligible);
      if (blocked.length) {
        throw new Error(`销账证据门槛未满足：${blocked.map((proof) => `#${proof?.eventId ?? "?"} ${proof?.blockers.join("；") ?? "证据不可读"}`).join("｜")}`);
      }
    }
    const response = await db
      .from("study_error")
      .update({ status: "absorbed", absorbed_at: nowIso, absorbed_via: "pc复盘" })
      .in("id", ids)
      .eq("status", "open")
      .select("id, kp_id");
    throwOnError(response, "销账落库失败");
    // 重试时可能已在上一次请求中成功销账，因此 0 行也是幂等成功。
    return { kind: "absorb", affected: response.data?.length ?? 0 };
  }

  if (op.op === "reopen_error") {
    // [gpt] 2026-08-10：只用于纠正误销账；不得伪造成一次 recheck fail。
    const ids = [...new Set((op.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    const reason = String(op.reason ?? "").trim();
    if (!ids.length) throw new Error("恢复错题操作没有合法 id");
    if (!reason) throw new Error("恢复错题必须提供审计原因");
    const response = await db
      .from("study_error")
      .update({
        status: "open",
        absorbed_at: null,
        absorbed_via: null,
        reopened_at: nowIso,
        reopened_via: "pc纠错",
        reopen_reason: reason,
      })
      .in("id", ids)
      .eq("status", "absorbed")
      .select("id, kp_id");
    throwOnError(response, "恢复误销账错题失败");
    return { kind: "reopen_error", affected: response.data?.length ?? 0 };
  }

  if (op.op === "new_error") {
    let recurSource = null;
    if (op.recurOf) {
      const sourceResponse = await db
        .from("study_error")
        .select("id, subject, kp_id")
        .eq("id", op.recurOf)
        .maybeSingle();
      throwOnError(sourceResponse, "读取复发源错题失败");
      if (!sourceResponse.data) throw new Error(`复发源错题 #${op.recurOf} 不存在`);
      recurSource = sourceResponse.data;
    }
    const response = await db.from("study_error").upsert({
      operation_id: op.operation_id,
      log_date: op.date ?? today,
      subject: op.subject,
      kp_id: op.topic?.kpId ?? recurSource?.kp_id ?? null,
      knowledge: op.knowledge,
      source: errorEntrySourceLabel(op.entrySource),
      raw_input: op.recurOf ? `【复发·源#${op.recurOf}】${op.knowledge}` : op.knowledge,
      status: "open",
    }, { onConflict: "operation_id", ignoreDuplicates: true }).select("id, subject, kp_id");
    throwOnError(response, "新错题写入失败");
    const event = await findInsertedError(db, op.operation_id, response);
    const inherited = await inheritRecurTopics(db, op.recurOf, event.id, op.topic, nowIso);
    let topicId = null;
    if (op.topic) {
      const topic = await getTopic(db, op.subject, op.topic, nowIso);
      await linkErrorTopic(db, event.id, topic.id, op.topic, nowIso);
      topicId = topic.id;
    }
    const knowledgeEvidence = await appendErrorApplicationEvidence(db, op, event, today);
    return { kind: "new_error", affected: 1, eventId: event.id, topicId, inherited, knowledgeEvidence };
  }

  if (op.op === "classify_error") {
    const eventResponse = await db
      .from("study_error")
      .select("id, subject, kp_id")
      .eq("id", op.studyErrorId)
      .maybeSingle();
    throwOnError(eventResponse, "读取待归类错题失败");
    if (!eventResponse.data) throw new Error(`错题 #${op.studyErrorId} 不存在`);
    const topic = await getTopic(db, eventResponse.data.subject, op.topic, nowIso);
    await linkErrorTopic(db, eventResponse.data.id, topic.id, op.topic, nowIso);
    if (op.topic.kpId && op.topic.kpId !== eventResponse.data.kp_id) {
      const updateEvent = await db
        .from("study_error")
        .update({ kp_id: op.topic.kpId })
        .eq("id", eventResponse.data.id);
      throwOnError(updateEvent, "回填错题 kp_id 失败");
    }
    const knowledgeEvidence = await appendErrorApplicationEvidence(db, op, {
      ...eventResponse.data,
      kp_id: op.topic.kpId ?? eventResponse.data.kp_id,
    }, today);
    return { kind: "classify_error", affected: 1, eventId: eventResponse.data.id, topicId: topic.id, knowledgeEvidence };
  }

  if (op.op === "error_review") {
    // [gpt] 2026-08-10：在任何远端写入前完成语义校验，避免 invalid 题干造成半完成写入。
    const reviewEvidence = buildReviewEvidence(op);
    const result = validateReviewResult(reviewEvidence.result);
    // [gpt] 2026-08-12：污染题只留教练事故审计，不能沿用用户错因、分数或普通复检备注语义。
    const teacherVoid = result === "void";
    const responsibilityNote = teacherVoid
      ? ["responsibility=teacher", "valid_attempt=false", "user_error=false", "cooldown_advanced=false", op.note].filter(Boolean).join("；")
      : op.note ?? null;
    const insertReview = await db.from("error_review").upsert({
      operation_id: op.operation_id,
      topic_id: op.topicId,
      study_error_id: op.studyErrorId ?? null,
      review_date: op.date ?? today,
      result,
      session_key: op.sessionKey ?? null,
      angle: reviewEvidence.angle,
      evidence_anchor: reviewEvidence.evidenceAnchor,
      note: responsibilityNote,
      dimension: reviewEvidence.dimension,
      cold: reviewEvidence.cold,
      prompt_integrity: reviewEvidence.promptIntegrity,
      variant_kind: reviewEvidence.variantKind,
      transfer_level: reviewEvidence.transferLevel,
      probe_axis: reviewEvidence.probeAxis,
      assessment_context: reviewEvidence.assessmentContext,
      duration_seconds: reviewEvidence.durationSeconds,
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(insertReview, "复检证据写入失败");
    const reviews = await db
      .from("error_review")
      .select("id, review_date, result, angle, evidence_anchor, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds")
      .eq("topic_id", op.topicId)
      .order("review_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(50);
    throwOnError(reviews, "复算弱项掌握状态失败");
    const masteryStatus = nextMasteryStatus(reviews.data ?? []);
    const updateTopic = await db
      .from("error_topic")
      .update({ mastery_status: masteryStatus, updated_at: nowIso })
      .eq("id", op.topicId)
      // [gpt] 2026-08-10：后续证据回写需要 kp_id；只返回 id 会静默断开知识证据链。
      .select("id, kp_id");
    throwOnError(updateTopic, "更新弱项掌握状态失败");
    if (!(updateTopic.data?.length)) throw new Error(`弱项主题 T#${op.topicId} 不存在`);
    const topicKpId = updateTopic.data?.[0]?.kp_id ?? null;
    const knowledgeEvidence = topicKpId
      ? await appendKnowledgeEvidence(db, {
        operation_id: `${op.operation_id}:knowledge-${reviewEvidence.dimension}`,
        kpId: topicKpId,
        date: op.date ?? today,
        dimension: reviewEvidence.dimension,
        result,
        sourceKind: "error_review",
        sourceId: op.operation_id,
        cold: reviewEvidence.cold,
        promptIntegrity: reviewEvidence.promptIntegrity,
        // [gpt] 2026-08-10：错题复检的难度与测试环境进入统一知识证据，不能在接线时被抹平。
        variantKind: reviewEvidence.variantKind,
        transferLevel: reviewEvidence.transferLevel,
        probeAxis: reviewEvidence.probeAxis,
        assessmentContext: op.assessmentContext ?? "practice",
        durationSeconds: op.durationSeconds ?? null,
        failurePatternCode: op.failurePatternCode ?? null,
        diagnosisStatus: op.diagnosisStatus ?? "pending",
        evidenceAnchor: reviewEvidence.evidenceAnchor ?? `error_topic#${op.topicId}`,
        note: teacherVoid ? responsibilityNote : op.note ?? op.angle ?? null,
      }, today)
      : null;
    const learningAttempt = await recordLearningAttempt(db, {
      operation_id: `${op.operation_id}:attempt`,
      ingestOperationId: op.operation_id,
      date: op.date ?? today,
      kpId: topicKpId,
      questionRef: op.questionRef ?? null,
      sourceKind: "error_review",
      sourceId: op.operation_id,
      attemptRole: "recheck",
      sessionKey: op.sessionKey ?? null,
      dimension: reviewEvidence.dimension,
      result,
      cold: reviewEvidence.cold,
      promptIntegrity: reviewEvidence.promptIntegrity,
      variantKind: reviewEvidence.variantKind,
      transferLevel: reviewEvidence.transferLevel,
      probeAxis: reviewEvidence.probeAxis,
      assessmentContext: op.assessmentContext ?? "practice",
      durationSeconds: op.durationSeconds ?? null,
      failurePatternCode: teacherVoid ? null : op.failurePatternCode ?? null,
      diagnosisStatus: op.diagnosisStatus ?? "pending",
      evidenceAnchor: reviewEvidence.evidenceAnchor ?? `error_topic#${op.topicId}`,
      responseExcerpt: op.responseExcerpt ?? null,
      note: teacherVoid ? responsibilityNote : op.note ?? op.angle ?? null,
      metadata: teacherVoid ? {
        responsibility: "teacher",
        count_as_valid_attempt: false,
        count_as_user_error: false,
        advance_cooldown: false,
        close_schedule: false,
      } : op.metadata,
      projectEvidence: false,
    }, today, { required: false });
    return {
      kind: "error_review",
      affected: 1,
      topicId: op.topicId,
      masteryStatus,
      knowledgeEvidence,
      learningAttempt,
      ...(teacherVoid ? {
        disposition: {
          responsibility: "teacher",
          countAsValidAttempt: false,
          countAsUserError: false,
          advanceCooldown: false,
          closeSchedule: false,
        },
      } : {}),
    };
  }

  if (op.op === "knowledge_link") return linkKnowledgeObject(db, op, nowIso);

  if (op.op === "knowledge_evidence") return appendKnowledgeEvidence(db, op, today);

  if (op.op === "knowledge_relation") return upsertKnowledgeRelation(db, op, nowIso);

  if (op.op === "learning_attempt") return recordLearningAttempt(db, op, today, { required: true });

  if (op.op === "study_log_correction") {
    // [gpt] 2026-08-23：错误流水只允许用完整旧业务键唯一命中后原地更正，禁止模糊批量覆盖。
    const match = op.match ?? {};
    const replacement = op.replacement ?? {};
    const requiredMatch = ["date", "subject", "chapter", "activity"];
    for (const key of requiredMatch) {
      if (match[key] == null || String(match[key]).trim() === "") {
        throw new Error(`学习流水更正缺少 match.${key}`);
      }
    }
    if (!replacement.subject || !replacement.chapter) {
      throw new Error("学习流水更正必须提供 replacement.subject 与 replacement.chapter");
    }
    const matchActivity = normalizeStudyActivity(match.activity);
    const replacementActivity = normalizeStudyActivity(replacement.activity);
    const lookup = await db.from("study_log")
      .select("id, operation_id, attempt_expected")
      .eq("log_date", match.date)
      .eq("subject", match.subject)
      .eq("chapter", match.chapter)
      .eq("activity", matchActivity)
      .order("id", { ascending: false })
      .limit(2);
    throwOnError(lookup, "待更正学习流水回读失败");
    const rows = lookup.data ?? [];
    if (rows.length !== 1) {
      throw new Error(`学习流水更正要求唯一命中，实际命中 ${rows.length} 条`);
    }
    const current = rows[0];
    if (current.attempt_expected) {
      throw new Error("带统一尝试分母的学习流水不能通过普通更正入口修改");
    }
    const payload = {
      log_date: replacement.date ?? match.date,
      subject: replacement.subject,
      chapter: replacement.chapter,
      activity: replacementActivity,
      accuracy: replacement.accuracy ?? null,
      feeling: replacement.feeling ?? null,
      source: "pc",
      raw_input: replacement.raw ?? null,
    };
    const updated = await db.from("study_log").update(payload).eq("id", current.id).select("id");
    throwOnError(updated, "学习流水更正失败");
    if ((updated.data ?? []).length !== 1) throw new Error("学习流水更正未更新到目标行");
    return {
      kind: "study_log_correction",
      affected: 1,
      action: "updated",
      studyLogId: current.id,
      operationId: current.operation_id,
    };
  }

  if (op.op === "study_log") {
    const activity = normalizeStudyActivity(op.activity);
    const recitationMode = recitationModeFromActivity(op.activity);
    const payload = {
      operation_id: op.operation_id,
      log_date: op.date ?? today,
      subject: op.subject,
      chapter: op.chapter ?? null,
      activity,
      accuracy: op.accuracy ?? null,
      feeling: op.feeling ?? null,
      source: "pc",
      raw_input: withRecitationModeMarker(op.raw, recitationMode),
      ...(op.attempt ? { attempt_expected: true } : {}),
    };
    // [gpt] 2026-08-21：背诵进度的业务唯一键是北京日+科目+规范章节+活动；重复汇报应复写原行，不能靠新 operation_id 再插一行。
    if (activity === "背诵" && payload.chapter && !op.attempt) {
      const existing = await db.from("study_log")
        .select("id, operation_id")
        .eq("log_date", payload.log_date)
        .eq("subject", payload.subject)
        .eq("chapter", payload.chapter)
        .eq("activity", payload.activity)
        .order("id", { ascending: false })
        .limit(1);
      throwOnError(existing, "背诵进度唯一键回读失败");
      const current = existing.data?.[0] ?? null;
      if (current) {
        const replacement = { ...payload };
        delete replacement.operation_id;
        const updated = await db.from("study_log").update(replacement).eq("id", current.id);
        throwOnError(updated, "背诵进度复写失败");
        return {
          kind: "study_log",
          affected: 1,
          action: "updated",
          studyLogId: current.id,
          operationId: current.operation_id,
        };
      }
    }
    let request = db.from("study_log").upsert(payload, { onConflict: "operation_id", ignoreDuplicates: true });
    if (op.attempt) request = request.select("id");
    const response = await request;
    throwOnError(response, "学习日志写入失败");
    if (!op.attempt) return { kind: "study_log", affected: 1 };

    // [gpt] ignoreDuplicates 重放时不会返回 id；按父 operation_id 找回同一条流水后补齐子事实。
    let studyLogId = response.data?.[0]?.id ?? null;
    if (studyLogId == null) {
      const lookup = await db.from("study_log")
        .select("id")
        .eq("operation_id", op.operation_id)
        .limit(1);
      throwOnError(lookup, "学习日志尝试来源回读失败");
      studyLogId = lookup.data?.[0]?.id ?? null;
    }
    if (studyLogId == null) throw new Error(`学习日志 ${op.operation_id} 已写入但无法取得 id`);
    const attemptOperation = materializeStudyLogAttempt({ ...op, activity }, studyLogId);
    const learningAttempt = await recordLearningAttempt(db, attemptOperation, today, { required: true });
    return { kind: "study_log", affected: 1, studyLogId, learningAttempt };
  }

  if (op.op === "coach_memory") {
    const response = await db.from("coach_memory").upsert({
      operation_id: op.operation_id,
      fact: op.fact,
      category: op.category ?? "画像",
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(response, "长期记忆写入失败");
    return { kind: "coach_memory", affected: 1 };
  }

  if (op.op === "ask_point") {
    if (!ASK_SUBJECTS.has(op.subject)) throw new Error(`答疑卡点科目不合法：${op.subject ?? "空"}`);
    const confusion = String(op.confusion ?? "").trim();
    if (!confusion) throw new Error("答疑卡点缺 confusion");
    const ttlDays = Number.isInteger(op.ttlDays) && op.ttlDays > 0 ? op.ttlDays : 90;
    const response = await db.from("ask_summary").upsert({
      operation_id: op.operation_id,
      subject: op.subject,
      kp_id: op.kpId ?? null,
      question_type: op.questionType ?? null,
      step_stuck: op.stepStuck ?? null,
      confusion,
      status: "open",
      ttl_until: shiftDate(op.date ?? today, ttlDays),
      source: "pc",
      raw_question: op.rawQuestion ?? null,
      evidence_anchor: op.evidenceAnchor ?? null,
      updated_at: nowIso,
    }, { onConflict: "operation_id", ignoreDuplicates: true }).select("id");
    throwOnError(response, "答疑卡点写入失败");
    let pointId = response.data?.[0]?.id ?? null;
    if (!pointId) {
      const lookup = await db.from("ask_summary").select("id").eq("operation_id", op.operation_id).maybeSingle();
      throwOnError(lookup, "重试时查找答疑卡点失败");
      pointId = lookup.data?.id ?? null;
    }
    if (!pointId) throw new Error("答疑卡点写入后未能取回 id");
    let knowledgeLink = null;
    let knowledgeEvidence = null;
    if (op.kpId) {
      const initialUnderstanding = oneOf(op.initialUnderstanding ?? "partial", ASK_INITIAL_RESULTS, "答疑卡点初始理解证据");
      knowledgeLink = await linkKnowledgeObject(db, {
        operation_id: `${op.operation_id}:knowledge-link`,
        sourceKind: "ask_point",
        sourceId: pointId,
        kpId: op.kpId,
        role: "primary",
        matchMethod: "manual",
        linkStatus: "confirmed",
        confidence: 100,
        evidenceAnchor: op.evidenceAnchor ?? `ask_point#${pointId}`,
        createdBy: "ask-cli",
      }, nowIso);
      knowledgeEvidence = await appendKnowledgeEvidence(db, {
        operation_id: `${op.operation_id}:knowledge-understanding`,
        kpId: op.kpId,
        date: op.date ?? today,
        dimension: "understanding",
        result: initialUnderstanding,
        sourceKind: "ask_point",
        sourceId: pointId,
        cold: false,
        promptIntegrity: "clean",
        evidenceAnchor: op.evidenceAnchor ?? `ask_point#${pointId}`,
        note: confusion,
      }, today);
    }
    return { kind: "ask_point", affected: 1, pointId, knowledgeLink, knowledgeEvidence };
  }

  if (op.op === "resolve_ask_point") {
    return resolveAskPoint(db, op, nowIso);
  }

  if (op.op === "ask_verification") return applyAskVerification(db, op, today, nowIso);

  throw new Error(`不认识的 outbox 操作：${op.op}`);
}

// [claude] 2026-08-24：retryOptions 透传给 processOutbox，让调用方与测试能决定重试策略。
export async function syncStudyOutbox({ db, path, today, now = new Date(), retryOptions = {} }) {
  const operations = readOutbox(path);
  // [gpt] 2026-08-13：先校验整批再做任何远端调用，防止后段坏条目造成半批写入。
  const validatedOperations = operations.map((op, index) => {
    if (op.op !== "new_error") return op;
    try {
      const validated = validateErrorEntry(migrateLegacyErrorEntry(op));
      // [gpt] 2026-08-13：旧缓冲在内存中补齐后执行业务，但保留原 payload 给 ingest 指纹，避免已审计重试发生 hash 漂移。
      return isLegacyErrorEntry(op) ? { ...validated, _ingestPayload: op } : validated;
    } catch (error) {
      throw new Error(`outbox 第 ${index + 1} 条 new_error 未通过写回前校验：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const nowIso = now.toISOString();
  const result = await processOutbox(
    validatedOperations,
    (op) => withIngestAudit({
      db,
      operation: op._ingestPayload ?? op,
      handlerVersion: STUDY_OUTBOX_HANDLER_VERSION,
      handler: () => applyOperation(db, op, today, nowIso),
    }),
    retryOptions,
  );
  writeOutbox(path, result.failed.map(({ op }) => op._ingestPayload ?? op));
  return { total: validatedOperations.length, ...result };
}
