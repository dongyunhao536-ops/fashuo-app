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
  nextMasteryStatus,
  topicInsertPayload,
  validateDiagnosisStatus,
  validateReviewResult,
  validateRootCause,
} from "./error-taxonomy.mjs";

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

export async function processOutbox(operations, handler) {
  const succeeded = [];
  const failed = [];
  for (const op of operations) {
    try {
      const result = await handler(op);
      succeeded.push({ op, result });
    } catch (error) {
      failed.push({
        op,
        error: error instanceof Error ? error.message : String(error),
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
    .select("topic_id, role, root_cause_code, root_cause_note, diagnosis_status, evidence_anchor")
    .eq("study_error_id", sourceId);
  throwOnError(response, "读取复发源主题失败");
  let count = 0;
  for (const link of response.data ?? []) {
    await linkErrorTopic(db, targetId, link.topic_id, {
      role: explicitTopic && link.role === "primary" ? "related" : link.role,
      rootCauseCode: link.root_cause_code,
      rootCauseNote: link.root_cause_note,
      diagnosisStatus: link.diagnosis_status,
      evidenceAnchor: link.evidence_anchor,
    }, nowIso);
    count++;
  }
  return count;
}

async function applyOperation(db, op, today, nowIso) {
  if (op.op === "absorb") {
    const ids = [...new Set((op.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error("销账操作没有合法 id");
    const response = await db
      .from("study_error")
      .update({ status: "absorbed", absorbed_at: nowIso, absorbed_via: "pc复盘" })
      .in("id", ids)
      .eq("status", "open")
      .select("id");
    throwOnError(response, "销账落库失败");
    // 重试时可能已在上一次请求中成功销账，因此 0 行也是幂等成功。
    return { kind: "absorb", affected: response.data?.length ?? 0 };
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
      source: op.recurOf ? "pc复盘·复发" : "pc复盘",
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
    return { kind: "new_error", affected: 1, eventId: event.id, topicId, inherited };
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
    return { kind: "classify_error", affected: 1, eventId: eventResponse.data.id, topicId: topic.id };
  }

  if (op.op === "error_review") {
    const result = validateReviewResult(op.result);
    const insertReview = await db.from("error_review").upsert({
      operation_id: op.operation_id,
      topic_id: op.topicId,
      study_error_id: op.studyErrorId ?? null,
      review_date: op.date ?? today,
      result,
      session_key: op.sessionKey ?? null,
      angle: op.angle ?? null,
      evidence_anchor: op.evidenceAnchor ?? null,
      note: op.note ?? null,
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(insertReview, "复检证据写入失败");
    const reviews = await db
      .from("error_review")
      .select("id, review_date, result")
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
      .select("id");
    throwOnError(updateTopic, "更新弱项掌握状态失败");
    if (!(updateTopic.data?.length)) throw new Error(`弱项主题 T#${op.topicId} 不存在`);
    return { kind: "error_review", affected: 1, topicId: op.topicId, masteryStatus };
  }

  if (op.op === "study_log") {
    const response = await db.from("study_log").upsert({
      operation_id: op.operation_id,
      log_date: op.date ?? today,
      subject: op.subject,
      chapter: op.chapter ?? null,
      activity: op.activity ?? "其他",
      accuracy: op.accuracy ?? null,
      feeling: op.feeling ?? null,
      source: "pc",
      raw_input: op.raw ?? null,
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(response, "学习日志写入失败");
    return { kind: "study_log", affected: 1 };
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
    return { kind: "ask_point", affected: 1, pointId };
  }

  if (op.op === "resolve_ask_point") {
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

  throw new Error(`不认识的 outbox 操作：${op.op}`);
}

export async function syncStudyOutbox({ db, path, today, now = new Date() }) {
  const operations = readOutbox(path);
  const nowIso = now.toISOString();
  const result = await processOutbox(
    operations,
    (op) => applyOperation(db, op, today, nowIso),
  );
  writeOutbox(path, result.failed.map(({ op }) => op));
  return { total: operations.length, ...result };
}
