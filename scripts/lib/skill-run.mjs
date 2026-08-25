// [gpt] 2026-08-12：高频 Skill 执行控制面；只记录步骤与校验结果，不保存题干、答案或密钥。
// [gpt] 2026-08-24：v2 记录 producerHost/turnIdSource/identityState，并支持 Claude 会话身份。

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentCodexTurnReference } from "./skill-turn-guard.mjs";
import { assertStudySubject, normalizeStudySubject } from "./study-subject.mjs";
import { extractDaibeiReciteIds } from "./daibei-target.mjs";
import { canonicalObservabilityFile, discoverObservabilityFiles } from "./observability-paths.mjs";
import { legacyIdentity, resolveRuntimeIdentity, runtimeSessionId } from "./host-identity.mjs";
// [claude] 2026-08-24：阻断必须同时说明怎么补，否则模型要么再花一次往返查规则、要么瞎猜再阻断。
import { formatRecovery, recoveryHint } from "./skill-run-recovery.mjs";

export const SKILL_RUN_SCHEMA_VERSION = 2;
export const DEFAULT_SKILL_RUN_FILE = process.env.FASHUO_SKILL_RUN_FILE
  ?? canonicalObservabilityFile("skill-runs.jsonl", { moduleUrl: import.meta.url });

const AUTO_STEPS = new Set([
  "context_loaded",
  "materials_checked",
  "question_integrity_pass",
  "judgment_output_verified",
  "diagnosis_recorded",
  "replanned",
  "ledger_validated",
  // [gpt] 2026-08-21：自背进度是独立业务事实，不冒充带背答题 result_recorded。
  "progress_recorded",
  "result_recorded",
  "writeback_verified",
  "answer_key_checked",
  "grading_bound",
  // [gpt] 2026-08-16：英语阅读不能只凭判分/流水收口；语料、干扰项实证与生命周期由专用校验器自动落证。
  "reading_artifacts_verified",
  "lifecycle_checked",
  // [claude] 2026-08-25：六步预检由手工签改为脚本签。原先它只是白名单里的一个字符串，
  // 没有任何脚本产出或校验，2026-08-25 答疑实测中我在没读过其定义的情况下就 --done 签了它。
  // 现由 ask.mjs preflight 从 materials_checked 的真实每类命中数推导判权后自动落证。
  "preflight_checked",
]);

const RUN_PURPOSES = new Set(["learning", "diagnostic", "simulation"]);
const ABORT_SOURCES = new Set(["user", "model", "guard", "system", "reconstruction", "unattributed"]);

const MANUAL_STEPS = new Set([
  "target_frozen",
  "priority_checked",
  "source_checked",
  "reference_answer_checked",
  "rubric_applied",
  "response_verified",
  "reading_page_verified",
  // [gpt] 2026-08-16：这三项是必须真实发生的教学互动，保留人工短证据引用，但不能由 --done 之外的自动脚本冒签。
  "reading_review_verified",
  "long_sentence_reviewed",
  "vocabulary_handoff_ready",
]);

export const SKILL_MANUAL_STEPS = Object.freeze([...MANUAL_STEPS]);
export const SKILL_AUTOMATIC_STEPS = Object.freeze([...AUTO_STEPS]);

const ALL_STEPS = new Set([...AUTO_STEPS, ...MANUAL_STEPS]);

export const SKILL_WORKFLOWS = Object.freeze({
  // [gpt] 2026-08-13：context_loaded 只约束需要系统替用户选任务的 plan 路径；
  // 用户已经给出题目、目标或作答时，证据、题面和写回回执才是必要门槛。
  "ask-pc": Object.freeze({
    answer: ["materials_checked", "preflight_checked", "response_verified"],
    question: ["materials_checked", "question_integrity_pass"],
    result: ["materials_checked", "question_integrity_pass", "result_recorded", "writeback_verified", "response_verified"],
  }),
  "coach-pc": Object.freeze({
    conversation: ["response_verified"],
    plan: ["context_loaded", "priority_checked", "response_verified"],
    question: ["materials_checked", "question_integrity_pass"],
    result: ["result_recorded", "writeback_verified", "response_verified"],
  }),
  "cuoti-fupan": Object.freeze({
    intake: ["target_frozen", "materials_checked", "result_recorded", "writeback_verified", "response_verified"],
    intake_question: ["target_frozen", "materials_checked", "result_recorded", "writeback_verified"],
    question: ["target_frozen", "materials_checked", "question_integrity_pass"],
    diagnosis_question: ["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded", "writeback_verified", "judgment_output_verified"],
    result: ["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded", "writeback_verified", "judgment_output_verified"],
  }),
  "daibei-pc": Object.freeze({
    plan: ["context_loaded", "priority_checked", "response_verified"],
    // [gpt] 2026-08-21：明确章节的自背汇报走轻量写回，不为一条流水加载全盘画像。
    progress: ["target_frozen", "progress_recorded", "writeback_verified", "response_verified"],
    question: ["target_frozen", "materials_checked", "question_integrity_pass"],
    result: ["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded", "writeback_verified", "response_verified"],
  }),
  "lunshu-pc": Object.freeze({
    question: ["target_frozen", "source_checked", "reference_answer_checked", "grading_bound", "question_integrity_pass"],
    grading: ["target_frozen", "source_checked", "reference_answer_checked", "grading_bound", "question_integrity_pass", "rubric_applied", "ledger_validated", "result_recorded", "writeback_verified", "response_verified"],
  }),
  "yingyu-pc": Object.freeze({
    plan: ["context_loaded", "priority_checked", "response_verified"],
    question: ["target_frozen", "source_checked", "reading_page_verified"],
    reading_review_question: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated", "reading_review_verified", "reading_artifacts_verified", "lifecycle_checked", "vocabulary_handoff_ready"],
    writing_question: ["target_frozen", "source_checked", "reference_answer_checked", "question_integrity_pass"],
    reading_grading: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated", "reading_review_verified", "long_sentence_reviewed", "vocabulary_handoff_ready", "reading_artifacts_verified", "lifecycle_checked", "result_recorded", "writeback_verified", "response_verified"],
    writing_grading: ["target_frozen", "source_checked", "reference_answer_checked", "question_integrity_pass", "rubric_applied", "ledger_validated", "result_recorded", "writeback_verified", "response_verified"],
  }),
});

export class SkillRunGateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkillRunGateError";
    this.details = details;
  }
}

function timestamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Skill Run 时间戳无效");
  return parsed.toISOString();
}

function beijingDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  return new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function safeToken(value, label, { required = false, max = 160 } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label} 不能为空`);
  if (!normalized) return null;
  if (normalized.length > max || /[\r\n]/u.test(normalized)) throw new Error(`${label} 必须是 ${max} 字符内的单行引用`);
  return normalized;
}

// [gpt] 2026-08-14：带背冻结对象、账本对象和排期对象统一解析成稳定条目 ID。
export function parseDaibeiTargetRef(value) {
  const ref = String(value ?? "").trim();
  const reciteIds = extractDaibeiReciteIds(ref);
  return {
    ref: ref || null,
    reciteIds,
    reciteId: reciteIds.length === 1 ? reciteIds[0] : null,
    stable: reciteIds.length === 1,
  };
}

function parseDaibeiResultRef(value) {
  const match = String(value ?? "").match(/^([A-Z]\d+):(understanding|recall)\/(pass|partial|fail|void):op=([^:\s]+)$/u);
  return match ? {
    reciteId: match[1],
    dimension: match[2],
    result: match[3],
    operationId: match[4],
  } : null;
}

function parseDaibeiKnowledgeAttemptRef(value) {
  const match = String(value ?? "").match(/^learning-attempt:([A-Z]{2,4}-\d{4}):([^:\s]+):applied$/u);
  return match ? { kpId: match[1], operationId: match[2] } : null;
}

function assertDaibeiResultConsistency(run, evidenceRef = run.steps.result_recorded?.evidenceRef) {
  if (run.skill !== "daibei-pc") return null;
  const frozenRef = String(run.steps.target_frozen?.evidenceRef ?? "").trim().toUpperCase();
  const knowledgeAttempt = parseDaibeiKnowledgeAttemptRef(evidenceRef);
  if (/^[A-Z]{2,4}-\d{4}$/u.test(frozenRef) || knowledgeAttempt) {
    if (!/^[A-Z]{2,4}-\d{4}$/u.test(frozenRef) || !knowledgeAttempt) {
      throw new Error("DAIBEI_KP_RESULT_REF_INVALID｜KP 抽查回执必须是 learning-attempt:<KP-ID>:<operation_id>:applied");
    }
    if (frozenRef !== knowledgeAttempt.kpId) {
      throw new Error(`DAIBEI_TARGET_MISMATCH｜冻结=${frozenRef}，写回=${knowledgeAttempt.kpId}；禁止把上一题结果写到当前 Run`);
    }
    return { target: { ref: frozenRef, kpId: frozenRef, stable: true }, result: knowledgeAttempt };
  }
  const target = parseDaibeiTargetRef(run.steps.target_frozen?.evidenceRef);
  const result = parseDaibeiResultRef(evidenceRef);
  if (!target.stable) {
    throw new Error(`DAIBEI_TARGET_UNSTABLE｜冻结目标“${target.ref ?? "空"}”不含唯一稳定带背条目 ID，禁止写回`);
  }
  if (!result) {
    throw new Error("DAIBEI_RESULT_REF_INVALID｜带背结果回执必须是 <条目ID>:<understanding|recall>/<pass|partial|fail|void>:op=<operation_id>");
  }
  if (target.reciteId !== result.reciteId) {
    throw new Error(`DAIBEI_TARGET_MISMATCH｜冻结=${target.reciteId}，写回=${result.reciteId}；禁止把上一题结果写到当前 Run`);
  }
  return { target, result };
}

function normalizedComparableText(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, "").trim();
}

// [gpt] 2026-08-21：进度流水只能给 daibei progress Run 签回执，并绑定同科同章与自背方式。
export function validateDaibeiProgressWriteback({
  runId,
  subject,
  chapter,
  activity,
  recitationMode,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = assertSkillRunPrerequisites({ runId, expectedSkill: "daibei-pc", steps: ["target_frozen"], file });
  if (!["progress", "progress-only"].includes(run.kind)) {
    throw new Error(`DAIBEI_PROGRESS_KIND_REQUIRED｜进度流水要求 kind=progress|progress-only，实际 ${run.kind ?? "空"}`);
  }
  const normalizedSubject = normalizeStudySubject(subject);
  if (normalizedSubject !== run.subject) {
    throw new Error(`DAIBEI_PROGRESS_SUBJECT_MISMATCH｜冻结=${run.subject}，待写回=${normalizedSubject ?? "空"}`);
  }
  const target = normalizedComparableText(run.steps.target_frozen?.evidenceRef);
  const normalizedChapter = normalizedComparableText(chapter);
  if (!target || !normalizedChapter || target !== normalizedChapter) {
    throw new Error(`DAIBEI_PROGRESS_TARGET_MISMATCH｜冻结=${run.steps.target_frozen?.evidenceRef ?? "空"}，待写回=${chapter ?? "空"}`);
  }
  if (String(activity ?? "").trim() !== "背诵") {
    throw new Error(`DAIBEI_PROGRESS_ACTIVITY_INVALID｜进度流水必须是 activity=背诵，实际 ${activity ?? "空"}`);
  }
  if (String(recitationMode ?? "").trim() !== "自背") {
    throw new Error(`DAIBEI_PROGRESS_MODE_INVALID｜用户自背汇报必须保留 [背诵方式=自背]，实际 ${recitationMode ?? "空"}`);
  }
  return run;
}

function assertSkill(skill) {
  const normalized = safeToken(skill, "skill", { required: true, max: 40 });
  if (!SKILL_WORKFLOWS[normalized]) throw new Error(`不受控的 Skill：${normalized}`);
  return normalized;
}

function assertStep(step) {
  const normalized = safeToken(step, "step", { required: true, max: 60 });
  if (!ALL_STEPS.has(normalized)) throw new Error(`未知 Skill 步骤：${normalized}`);
  return normalized;
}

function assertPhase(skill, phase) {
  const normalized = safeToken(phase, "phase", { required: true, max: 40 });
  if (!SKILL_WORKFLOWS[skill]?.[normalized]) {
    throw new Error(`${skill} 不支持阶段 ${normalized}；可用：${Object.keys(SKILL_WORKFLOWS[skill] ?? {}).join("|")}`);
  }
  return normalized;
}

function appendEvent(event, file = DEFAULT_SKILL_RUN_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function hashSkillArtifact(value) {
  const normalized = String(value ?? "").replace(/\r\n/gu, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function eventBase({ runId, event, now = new Date(), sessionId = null, turnId = null }) {
  const observedAt = timestamp(now);
  const turnReference = currentCodexTurnReference({ sessionId: sessionId ?? runtimeSessionId() });
  const resolvedTurnId = turnId ?? turnReference.turnId;
  const identity = resolveRuntimeIdentity({
    producerHost: turnReference.producerHost,
    sessionId: sessionId ?? turnReference.sessionId,
    turnId: resolvedTurnId,
    turnIdSource: resolvedTurnId && resolvedTurnId === turnReference.turnId
      ? turnReference.turnIdSource
      : resolvedTurnId
        ? "explicit"
        : "none",
  });
  return {
    schemaVersion: SKILL_RUN_SCHEMA_VERSION,
    eventId: `SE-${randomUUID()}`,
    runId: safeToken(runId, "runId", { required: true, max: 80 }),
    event,
    observedAt,
    beijingDate: beijingDate(now),
    producerHost: identity.producerHost,
    sessionId: safeToken(identity.sessionId, "sessionId", { max: 100 }),
    turnId: safeToken(identity.turnId, "turnId", { max: 100 }),
    turnIdSource: identity.turnIdSource,
    identityState: identity.identityState,
  };
}

function readSkillRunEventFile(file) {
  if (!existsSync(file)) return { events: [], issues: [] };
  const events = [];
  const issues = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    try {
      const event = JSON.parse(raw);
      if (![1, SKILL_RUN_SCHEMA_VERSION].includes(event?.schemaVersion) || !event?.runId || !event?.event || !event?.observedAt) {
        throw new Error("缺少可兼容 schemaVersion/runId/event/observedAt");
      }
      events.push(event.schemaVersion === 1 ? { ...event, ...legacyIdentity(event) } : event);
    } catch (error) {
      issues.push({
        code: "skill_run_telemetry_unreadable",
        severity: "error",
        file,
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { events, issues };
}

export function readSkillRunEvents(file) {
  const files = file
    ? [file]
    : process.env.FASHUO_SKILL_RUN_FILE
      ? [process.env.FASHUO_SKILL_RUN_FILE]
      : discoverObservabilityFiles("skill-runs.jsonl", { canonicalFile: DEFAULT_SKILL_RUN_FILE });
  const events = [];
  const issues = [];
  const seen = new Set();
  for (const source of files) {
    const parsed = readSkillRunEventFile(source);
    issues.push(...parsed.issues);
    for (const event of parsed.events) {
      const key = event.eventId ?? `${event.runId}:${event.event}:${event.observedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  events.sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));
  return { events, issues, files };
}

function latestRunTurn(run) {
  return [...(run?.events ?? [])].reverse().find((event) => event.turnId)?.turnId ?? run?.turnId ?? null;
}

function activeRunConflict(runs, sessionId, turnId) {
  return [...runs.values()].find((run) => (
    !run.end
      && ((run.sessionId && sessionId && run.sessionId === sessionId)
        || (!run.sessionId && !sessionId && run.turnId && turnId && run.turnId === turnId))
  ));
}

export function reconstructSkillRuns(events = []) {
  const runs = new Map();
  const sorted = [...events].sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));
  for (const event of sorted) {
    const current = runs.get(event.runId) ?? {
      runId: event.runId,
      skill: null,
      subject: null,
      kind: null,
      referenceDate: null,
      entryMode: null,
      runPurpose: null,
      producerHost: null,
      turnIdSource: null,
      identityState: null,
      sessionId: null,
      turnId: null,
      startedAt: null,
      lastEventAt: null,
      status: "unknown",
      steps: {},
      checkpoints: [],
      blocked: [],
      deferredWriteback: null,
      end: null,
      events: [],
    };
    current.events.push(event);
    current.lastEventAt = event.observedAt;
    if (event.producerHost) current.producerHost = event.producerHost;
    if (event.turnIdSource) current.turnIdSource = event.turnIdSource;
    if (event.identityState) current.identityState = event.identityState;
    if (event.sessionId) current.sessionId = event.sessionId;
    if (event.turnId) current.turnId = event.turnId;
    if (event.event === "started") {
      current.skill = event.skill;
      current.subject = event.subject ?? null;
      current.kind = event.kind ?? null;
      current.referenceDate = event.referenceDate ?? event.beijingDate;
      current.entryMode = event.entryMode ?? null;
      current.runPurpose = event.runPurpose ?? "unknown";
      current.startedAt = event.observedAt;
      current.status = "active";
    } else if (event.event === "step") {
      current.steps[event.step] = {
        status: event.status,
        observedAt: event.observedAt,
        source: event.source,
        durationMs: event.durationMs ?? null,
        evidenceRef: event.evidenceRef ?? null,
        artifactHash: event.artifactHash ?? null,
        artifactLength: event.artifactLength ?? null,
        candidateHash: event.candidateHash ?? null,
        referenceHash: event.referenceHash ?? null,
      };
      // [claude] 2026-08-24：写回真成功后，之前的延迟标记不再成立。
      if (event.step === "writeback_verified" && event.status === "pass") current.deferredWriteback = null;
      if (!current.end) current.status = "active";
    } else if (event.event === "writeback_deferred") {
      // [claude] 2026-08-24：证据已进本地 outbox、只是远端没同步上。
      // 这既不是"完成"也不是"放弃"，此前没有这一档，断网只能被迫记成 aborted。
      current.deferredWriteback = {
        source: event.source ?? null,
        reason: event.reason ?? null,
        operationId: event.operationId ?? null,
        evidenceRef: event.evidenceRef ?? null,
        observedAt: event.observedAt,
      };
      if (!current.end) current.status = "deferred";
    } else if (event.event === "checkpoint_passed") {
      current.checkpoints.push({ phase: event.phase, observedAt: event.observedAt });
      if (!current.end) current.status = event.phase.endsWith("question") ? "waiting_user" : "active";
    } else if (["checkpoint_blocked", "end_blocked"].includes(event.event)) {
      current.blocked.push({ phase: event.phase, missing: event.missing ?? [], observedAt: event.observedAt, event: event.event });
      if (!current.end) current.status = "blocked";
    } else if (event.event === "ended") {
      current.end = {
        outcome: event.outcome,
        phase: event.phase ?? null,
        handoffSkill: event.handoffSkill ?? null,
        handoffReason: event.handoffReason ?? null,
        abortReason: event.outcome === "aborted" ? event.abortReason ?? "unattributed" : null,
        abortSource: event.outcome === "aborted" ? event.abortSource ?? "unattributed" : null,
        // 事件自带的标记优先；老事件没有这个字段时回落到运行期状态。
        deferredWriteback: event.deferredWriteback ?? current.deferredWriteback ?? null,
        observedAt: event.observedAt,
      };
      current.status = event.outcome;
    }
    runs.set(event.runId, current);
  }
  return runs;
}

// [claude] 2026-08-24：补同步要按 Run 自身的 skill 决定门槛，调用方得先读得到 Run。
export function readSkillRun(runId, file = DEFAULT_SKILL_RUN_FILE) {
  return loadRun(runId, file);
}

function loadRun(runId, file) {
  const parsed = readSkillRunEvents(file);
  if (parsed.issues.length) throw new Error(`Skill Run 遥测文件有 ${parsed.issues.length} 个结构错误，拒绝继续写入`);
  const run = reconstructSkillRuns(parsed.events).get(runId);
  if (!run?.startedAt) throw new Error(`找不到 Skill Run：${runId}`);
  return run;
}

function assertEventTurn(run) {
  const reference = currentCodexTurnReference({ sessionId: runtimeSessionId() });
  if (run.sessionId && reference.sessionId && run.sessionId !== reference.sessionId) {
    throw new Error(`Skill Run 会话不一致：${run.sessionId} != ${reference.sessionId}`);
  }
  // [gpt] 2026-08-13：中断恢复和普通用户续答都可能跨 turn；只有宿主把当前 prompt 明确绑定到同一 Run 时才允许续写。
  if (run.turnId && reference.turnId && run.turnId !== reference.turnId) {
    const routedToRun = reference.expectedRunId === run.runId && reference.expectedSkill === run.skill;
    if (!routedToRun) {
      throw new Error(`Skill Run 轮次不一致：${run.turnId} != ${reference.turnId}；当前 prompt 未路由到 ${run.runId}`);
    }
  }
  return { sessionId: run.sessionId ?? reference.sessionId, turnId: reference.turnId ?? run.turnId };
}

export function startSkillRun({
  skill,
  subject = null,
  kind = null,
  referenceDate = null,
  source = "skill-run",
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
  runId = null,
  sessionId = null,
  turnId = null,
  entryMode = null,
  targetRef = null,
  runPurpose = "learning",
} = {}) {
  const normalizedSkill = assertSkill(skill);
  const normalizedSubject = normalizeStudySubject(subject);
  const normalizedTargetRef = safeToken(targetRef, "targetRef", { max: 160 });
  let normalizedEntryMode = safeToken(entryMode, "entryMode", { max: 20 });
  const normalizedRunPurpose = safeToken(runPurpose, "runPurpose", { required: true, max: 20 });
  if (!RUN_PURPOSES.has(normalizedRunPurpose)) throw new Error("runPurpose 只接受 learning|diagnostic|simulation");
  if (normalizedSkill === "daibei-pc") {
    assertStudySubject(normalizedSubject);
    normalizedEntryMode ??= normalizedTargetRef ? "direct" : null;
    if (!normalizedEntryMode) {
      throw new Error("DAIBEI_CONTEXT_REQUIRED｜只指定科目不等于目标明确；请运行 skill-context.mjs daibei <科目>，或为明确对象提供 --target");
    }
    if (!['snapshot', 'direct'].includes(normalizedEntryMode)) throw new Error("daibei entryMode 只接受 snapshot|direct");
    if (normalizedEntryMode === "direct" && !normalizedTargetRef) {
      throw new Error("DAIBEI_TARGET_REQUIRED｜轻量带背必须提供稳定章节、设问或条目 --target");
    }
  }
  const observedAt = timestamp(now);
  // [gpt] 2026-08-12：先解析宿主会话再查冲突；不能因调用方省略 --session 就绕过“一会话一条活跃 Run”。
  const turnReference = currentCodexTurnReference({ sessionId: sessionId ?? runtimeSessionId() });
  const resolvedSessionId = sessionId ?? turnReference.sessionId;
  const resolvedTurnId = turnId ?? turnReference.turnId;
  if (turnReference.producerHost === "claude" && !resolvedSessionId) {
    throw new Error("SKILL_IDENTITY_REQUIRED｜Claude 宿主缺少 FASHUO_SESSION_ID/session_id；禁止新建可能串写学习事实的 Run");
  }
  const resolvedRunId = runId ?? `SR-${beijingDate(now).replaceAll("-", "")}-${observedAt.slice(11, 19).replaceAll(":", "")}-${randomUUID().slice(0, 8)}`;
  const existing = readSkillRunEvents(file);
  if (existing.issues.length) throw new Error(`Skill Run 遥测文件有 ${existing.issues.length} 个结构错误，拒绝新建运行`);
  const existingRuns = reconstructSkillRuns(existing.events);
  if (existingRuns.has(resolvedRunId)) throw new Error(`Skill Run 已存在：${resolvedRunId}`);
  const activeConflict = activeRunConflict(existingRuns, resolvedSessionId, resolvedTurnId);
  if (activeConflict) {
    throw new Error(`同一会话已有未收口 Skill Run：${activeConflict.runId}/${activeConflict.skill}；先续用、handoff 或 aborted，禁止另建 Run 掩盖漏步`);
  }
  appendEvent({
    ...eventBase({ runId: resolvedRunId, event: "started", now, sessionId: resolvedSessionId, turnId: resolvedTurnId }),
    skill: normalizedSkill,
    subject: safeToken(normalizedSubject, "subject", { max: 40 }),
    kind: safeToken(kind, "kind", { max: 40 }),
    referenceDate: safeToken(referenceDate, "referenceDate", { max: 20 }) ?? beijingDate(now),
    source: safeToken(source, "source", { max: 60 }) ?? "skill-run",
    entryMode: normalizedEntryMode,
    runPurpose: normalizedRunPurpose,
  }, file);
  if (normalizedTargetRef) {
    appendEvent({
      ...eventBase({ runId: resolvedRunId, event: "step", now, sessionId: resolvedSessionId, turnId: resolvedTurnId }),
      skill: normalizedSkill,
      step: "target_frozen",
      status: "pass",
      source: "skill-run-start",
      evidenceRef: normalizedTargetRef,
      artifactHash: null,
      artifactLength: null,
      durationMs: null,
    }, file);
  }
  return reconstructSkillRuns(readSkillRunEvents(file).events).get(resolvedRunId);
}

function daibeiRecoverySummary(run) {
  const target = parseDaibeiTargetRef(run.steps.target_frozen?.evidenceRef);
  const result = parseDaibeiResultRef(run.steps.result_recorded?.evidenceRef);
  const resultState = !run.steps.result_recorded
    ? "none"
    : result && target.stable && result.reciteId === target.reciteId
      ? "consistent"
      : "mismatch";
  return {
    runId: run.runId,
    subject: normalizeStudySubject(run.subject),
    status: run.status,
    targetRef: target.ref,
    reciteId: target.reciteId,
    startedAt: run.startedAt,
    lastEventAt: run.lastEventAt,
    sessionId: run.sessionId,
    stable: target.stable,
    resultState,
    resumable: run.status === "waiting_user" && target.stable && resultState === "none",
  };
}

export function findDaibeiRecovery({
  subject,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const normalizedSubject = assertStudySubject(subject);
  const parsed = readSkillRunEvents(file);
  if (parsed.issues.length) throw new Error(`Skill Run 遥测文件有 ${parsed.issues.length} 个结构错误，拒绝恢复带背`);
  const open = [...reconstructSkillRuns(parsed.events).values()]
    .filter((run) => run.skill === "daibei-pc" && !run.end && normalizeStudySubject(run.subject) === normalizedSubject)
    .map(daibeiRecoverySummary)
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)));
  const candidates = open.filter((run) => run.resumable);
  // [gpt] 历史 Run 若已把上一题结果写进当前目标，不放宽新 Gate；只继承目标到新 Run，旧遥测留作审计。
  const targetFallbacks = open.filter((run) => run.status === "waiting_user" && run.stable && run.resultState === "mismatch");
  const preferred = candidates[0] ?? null;
  const targetFallback = preferred ? null : targetFallbacks[0] ?? null;
  return {
    subject: normalizedSubject,
    rule: "waiting_user/stable_target > due_schedule > mainline",
    preferred,
    targetFallback,
    openRuns: open,
    ignored: open.filter((run) => run !== preferred && run !== targetFallback),
  };
}

export function resumeDaibeiSkillRun({
  runId,
  subject,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
  sessionId = null,
  turnId = null,
} = {}) {
  const run = loadRun(runId, file);
  const normalizedSubject = assertStudySubject(subject);
  if (run.skill !== "daibei-pc") throw new Error(`只能恢复 daibei-pc Run：${runId}/${run.skill}`);
  if (run.end) throw new Error(`Skill Run 已结束：${runId}`);
  if (normalizeStudySubject(run.subject) !== normalizedSubject) {
    throw new Error(`带背恢复科目不一致：${normalizeStudySubject(run.subject)} != ${normalizedSubject}`);
  }
  const target = parseDaibeiTargetRef(run.steps.target_frozen?.evidenceRef);
  if (run.status !== "waiting_user" || !target.stable || run.steps.result_recorded?.status === "pass") {
    throw new Error(`DAIBEI_RECOVERY_BLOCK｜${runId} 不是无既有结果且带稳定条目 ID 的 waiting_user Run`);
  }
  const reference = currentCodexTurnReference({ sessionId: sessionId ?? runtimeSessionId() });
  const resolvedSessionId = sessionId ?? reference.sessionId ?? run.sessionId;
  const resolvedTurnId = turnId ?? reference.turnId ?? run.turnId;
  if (run.sessionId === resolvedSessionId && latestRunTurn(run) === resolvedTurnId) return run;
  const parsed = readSkillRunEvents(file);
  const conflict = [...reconstructSkillRuns(parsed.events).values()].find((item) => (
    item.runId !== runId && !item.end && resolvedSessionId && item.sessionId === resolvedSessionId
  ));
  if (conflict) throw new Error(`当前会话已有未收口 Skill Run：${conflict.runId}/${conflict.skill}；禁止用恢复覆盖`);
  appendEvent({
    ...eventBase({ runId, event: "resumed", now, sessionId: resolvedSessionId, turnId: resolvedTurnId }),
    skill: run.skill,
    source: "daibei-recovery",
    targetRef: target.ref,
    previousSessionId: run.sessionId,
    previousTurnId: latestRunTurn(run),
  }, file);
  return loadRun(runId, file);
}

function recordSkillStep({
  runId,
  step,
  status = "pass",
  source = "manual",
  evidenceRef = null,
  artifactHash = null,
  artifactLength = null,
  candidateHash = null,
  referenceHash = null,
  durationMs = null,
  automatic = false,
  expectedSkill = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const run = loadRun(runId, file);
  if (run.end) throw new Error(`Skill Run 已结束：${runId}`);
  assertEventTurn(run);
  if (expectedSkill && run.skill !== expectedSkill) throw new Error(`Skill Run 路由不一致：预期 ${expectedSkill}，实际 ${run.skill}`);
  const normalizedStep = assertStep(step);
  const normalizedEvidenceRef = safeToken(evidenceRef, "evidenceRef", { max: 160 });
  if (normalizedStep === "target_frozen" && run.steps.target_frozen?.status === "pass") {
    const existingTarget = run.steps.target_frozen.evidenceRef;
    if (existingTarget !== normalizedEvidenceRef) {
      throw new Error(`SKILL_TARGET_IMMUTABLE｜Run 已冻结 ${existingTarget}，不能改成 ${normalizedEvidenceRef}；先收口当前 Run 再开下一题`);
    }
    return run;
  }
  if (normalizedStep === "result_recorded" && run.steps.result_recorded?.status === "pass") {
    const existingResult = run.steps.result_recorded.evidenceRef;
    if (existingResult !== normalizedEvidenceRef) {
      throw new Error(`SKILL_RESULT_IMMUTABLE｜Run 已记录 ${existingResult}，不能覆盖为 ${normalizedEvidenceRef}`);
    }
    return run;
  }
  if (AUTO_STEPS.has(normalizedStep) && !automatic) {
    throw new Error(`${normalizedStep} 只能由对应脚本自动落证，不能手工声明完成`);
  }
  if (run.skill === "lunshu-pc" && normalizedStep === "reference_answer_checked" && !automatic) {
    throw new Error("lunshu-pc/reference_answer_checked 只能由 reference-answer 加载器绑定，不能手工声明完成");
  }
  if (MANUAL_STEPS.has(normalizedStep) && !automatic && !normalizedEvidenceRef) {
    throw new Error(`${normalizedStep} 是手工核验步骤，必须用 --ref 提供可核对的短证据引用`);
  }
  if (!["pass", "fail"].includes(status)) throw new Error("step status 只接受 pass|fail");
  const milliseconds = durationMs == null ? null : Number(durationMs);
  if (milliseconds != null && (!Number.isFinite(milliseconds) || milliseconds < 0)) throw new Error("durationMs 必须是非负数");
  const hash = safeToken(artifactHash, "artifactHash", { max: 64 });
  if (hash && !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("artifactHash 必须是 64 位小写 sha256");
  const normalizedArtifactLength = artifactLength == null ? null : Number(artifactLength);
  if (normalizedArtifactLength != null && (!Number.isInteger(normalizedArtifactLength) || normalizedArtifactLength < 1 || normalizedArtifactLength > 100000)) {
    throw new Error("artifactLength 必须是 1-100000 的整数");
  }
  if (["question_integrity_pass", "judgment_output_verified"].includes(normalizedStep) && status === "pass" && (!hash || !normalizedArtifactLength)) {
    throw new Error(`${normalizedStep} 必须带同一展示草稿的 sha256 与长度，禁止无草稿回执`);
  }
  const normalizedCandidateHash = safeToken(candidateHash, "candidateHash", { max: 64 });
  if (normalizedCandidateHash && !/^[a-f0-9]{64}$/u.test(normalizedCandidateHash)) {
    throw new Error("candidateHash 必须是 64 位小写 sha256");
  }
  if (normalizedStep === "judgment_output_verified" && run.steps.judgment_output_verified?.candidateHash
    && normalizedCandidateHash !== run.steps.judgment_output_verified.candidateHash) {
    throw new Error("DIAGNOSIS_CANDIDATES_IMMUTABLE｜终态判题卡必须逐字沿用本 Run 已展示的病根候选，不能认领后改写");
  }
  const normalizedReferenceHash = safeToken(referenceHash, "referenceHash", { max: 64 });
  if (normalizedReferenceHash && !/^[a-f0-9]{64}$/u.test(normalizedReferenceHash)) {
    throw new Error("referenceHash 必须是 64 位小写 sha256");
  }
  if (normalizedStep === "grading_bound" && status === "pass" && !normalizedReferenceHash) {
    throw new Error("grading_bound 必须绑定 referenceHash");
  }
  if (["reference_answer_checked", "grading_bound"].includes(normalizedStep)
    && run.steps[normalizedStep]?.referenceHash
    && run.steps[normalizedStep].referenceHash !== normalizedReferenceHash) {
    throw new Error(`REFERENCE_BINDING_IMMUTABLE｜${normalizedStep} 已绑定另一 referenceHash，禁止换标答继续同一 Run`);
  }
  if (["reference_answer_checked", "grading_bound"].includes(normalizedStep)
    && run.steps[normalizedStep]?.referenceHash === normalizedReferenceHash) return run;
  if (run.skill === "daibei-pc" && normalizedStep === "result_recorded" && status === "pass") {
    assertDaibeiResultConsistency(run, normalizedEvidenceRef);
  }
  appendEvent({
    ...eventBase({ runId, event: "step", now }),
    skill: run.skill,
    step: normalizedStep,
    status,
    source: safeToken(source, "source", { max: 60 }) ?? (automatic ? "automatic" : "manual"),
    evidenceRef: normalizedEvidenceRef,
    artifactHash: hash,
    artifactLength: normalizedArtifactLength,
    candidateHash: normalizedCandidateHash,
    referenceHash: normalizedReferenceHash,
    durationMs: milliseconds == null ? null : Math.round(milliseconds),
  }, file);
  return loadRun(runId, file);
}

function recordManualDone({ runId, done = [], evidenceRef = null, file, now }) {
  for (const step of done) {
    const normalized = assertStep(step);
    if (!MANUAL_STEPS.has(normalized)) throw new Error(`${normalized} 不能通过 --done 手工补签`);
    recordSkillStep({ runId, step: normalized, status: "pass", source: "manual-checkpoint", evidenceRef, file, now });
  }
}

export function recordManualSkillStep({ runId, step, evidenceRef = null, file = DEFAULT_SKILL_RUN_FILE, now = new Date() } = {}) {
  return recordSkillStep({
    runId,
    step,
    status: "pass",
    source: "skill-run-cli",
    evidenceRef,
    file,
    now,
  });
}

export function recordAutomaticSkillStep({
  runId,
  step,
  status = "pass",
  source,
  evidenceRef = null,
  artifactHash = null,
  artifactLength = null,
  candidateHash = null,
  referenceHash = null,
  durationMs = null,
  expectedSkill = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const normalized = assertStep(step);
  if (!AUTO_STEPS.has(normalized)) throw new Error(`${normalized} 不是自动步骤`);
  return recordSkillStep({
    runId,
    step: normalized,
    status,
    source,
    evidenceRef,
    artifactHash,
    artifactLength,
    candidateHash,
    referenceHash,
    durationMs,
    automatic: true,
    expectedSkill,
    file,
    now,
  });
}

export function recordReferenceAnswerBinding({
  runId,
  referenceHash,
  evidenceRef,
  source = "reference-answer-loader",
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  let run = loadRun(runId, file);
  if (run.skill !== "lunshu-pc") throw new Error(`参考答案绑定只支持 lunshu-pc：${runId}/${run.skill}`);
  for (const step of ["reference_answer_checked", "grading_bound"]) {
    run = recordSkillStep({
      runId,
      step,
      status: "pass",
      source,
      evidenceRef,
      referenceHash,
      automatic: true,
      expectedSkill: "lunshu-pc",
      file,
      now,
    });
  }
  return run;
}

/**
 * [claude] 2026-08-24：证据已落本地 outbox、远端同步失败时留痕。
 *
 * 病因：写回步骤只在成功时才签，失败不产生任何遥测。2026-08-24 云三次断网，
 * 四个 cuoti Run 被迫记成 aborted，监控显示"判了题没写回"，而证据其实躺在
 * outbox 里、网络恢复后自己同步上了（error_review T#94 迟到 19 分钟落库）。
 * 结果是状态机与现实脱节，我据此误诊为"模型偷懒放弃"。
 *
 * 本函数不放宽任何门槛：它不签 writeback_verified，只记录"停在哪、怎么续"。
 */
export function recordWritebackDeferred({
  runId,
  source,
  reason = null,
  operationId = null,
  evidenceRef = null,
  expectedSkill = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const run = loadRun(runId, file);
  if (run.end) throw new Error(`Skill Run 已结束，不能再记延迟写回：${runId}`);
  if (expectedSkill && run.skill !== expectedSkill) {
    throw new Error(`Skill Run 路由不一致：预期 ${expectedSkill}，实际 ${run.skill}`);
  }
  appendEvent({
    ...eventBase({ runId, event: "writeback_deferred", now }),
    skill: run.skill,
    source: safeToken(source, "source", { required: true, max: 60 }),
    reason: safeToken(reason, "reason", { max: 200 }),
    operationId: safeToken(operationId, "operationId", { max: 80 }),
    evidenceRef: safeToken(evidenceRef, "evidenceRef", { max: 200 }),
  }, file);
  return loadRun(runId, file);
}

export function recordBusinessWriteback({
  runId,
  source,
  evidenceRef = null,
  expectedSkill = null,
  requiredSteps = [],
  durationMs = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const normalizedSource = safeToken(source, "source", { required: true, max: 60 });
  const prerequisiteRun = assertSkillRunPrerequisites({ runId, expectedSkill, steps: requiredSteps, file });
  if (prerequisiteRun.skill === "cuoti-fupan" && normalizedSource === "cuoti-review") {
    const recorded = parsedCuotiEvidenceRef(evidenceRef);
    const judged = parsedCuotiEvidenceRef(prerequisiteRun.steps.judgment_output_verified?.evidenceRef);
    if (!recorded?.diagnosisStatus || !judged?.diagnosisStatus) {
      throw new Error("错题 review 写回必须带可解析的 T#:<result>:diagnosis=<status>，且先通过判题证据卡 Gate");
    }
    if (recorded.targetRef !== judged.targetRef
      || recorded.result !== judged.result
      || recorded.diagnosisStatus !== judged.diagnosisStatus) {
      throw new Error(`错题判题 Gate 与待写回结果不一致：${judged.targetRef}:${judged.result}:diagnosis=${judged.diagnosisStatus} != ${recorded.targetRef}:${recorded.result}:diagnosis=${recorded.diagnosisStatus}`);
    }
  }
  let run;
  // [gpt] 2026-08-12：通用业务桥只确认“结果已记录/写回已核验”；答案键必须由专用判分脚本读取真实材料后落证。
  for (const step of ["result_recorded", "writeback_verified"]) {
    run = recordAutomaticSkillStep({ runId, step, source: normalizedSource, evidenceRef, durationMs, expectedSkill, file, now });
  }
  return run;
}

// [gpt] 2026-08-21：自背进度写回使用独立步骤，避免触发带背复检结果的条目 ID 一致性校验。
export function recordDaibeiProgressWriteback({
  runId,
  subject,
  chapter,
  activity,
  recitationMode,
  operationId,
  source = "coach-log",
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  validateDaibeiProgressWriteback({ runId, subject, chapter, activity, recitationMode, file });
  const normalizedOperationId = safeToken(operationId, "operationId", { required: true, max: 100 });
  const evidenceRef = `study-log:${normalizedOperationId}:applied`;
  let run;
  for (const step of ["progress_recorded", "writeback_verified"]) {
    run = recordAutomaticSkillStep({
      runId,
      step,
      source,
      evidenceRef,
      expectedSkill: "daibei-pc",
      file,
      now,
    });
  }
  return run;
}

// [gpt] 2026-08-21：新章节 KP 抽查写统一 learning_attempt；只允许与冻结 KP-ID 完全一致的 recall Run 签结果回执。
export function recordDaibeiKnowledgeAttemptWriteback({
  runId,
  kpId,
  operationId,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const requiredSteps = ["target_frozen", "materials_checked", "question_integrity_pass"];
  const run = assertSkillRunPrerequisites({ runId, expectedSkill: "daibei-pc", steps: requiredSteps, file });
  if (run.kind !== "recall") {
    throw new Error(`DAIBEI_ATTEMPT_KIND_REQUIRED｜知识点抽查要求 kind=recall，实际 ${run.kind ?? "空"}`);
  }
  const normalizedKpId = safeToken(kpId, "kpId", { required: true, max: 40 }).toUpperCase();
  const frozenTarget = safeToken(run.steps.target_frozen?.evidenceRef, "target_frozen", { required: true, max: 200 }).toUpperCase();
  if (frozenTarget !== normalizedKpId) {
    throw new Error(`DAIBEI_ATTEMPT_TARGET_MISMATCH｜冻结=${frozenTarget}，待写回=${normalizedKpId}`);
  }
  const normalizedOperationId = safeToken(operationId, "operationId", { required: true, max: 100 });
  return recordBusinessWriteback({
    runId,
    source: "knowledge-attempt",
    evidenceRef: `learning-attempt:${normalizedKpId}:${normalizedOperationId}:applied`,
    expectedSkill: "daibei-pc",
    requiredSteps,
    file,
    now,
  });
}

function parsedCuotiEvidenceRef(value) {
  const match = String(value ?? "").match(/^(T#\d+)(?:\/(E#\d+))?:(pass|partial|fail|void)(?::diagnosis=(pending|confirmed|rejected|untraceable))?$/u);
  return match ? {
    targetRef: match[1],
    eventRef: match[2] ?? null,
    result: match[3],
    diagnosisStatus: match[4] ?? null,
  } : null;
}

function parsedDiagnosisEvidenceRef(value) {
  const match = String(value ?? "").match(/^(T|E)#(\d+):diagnosis=(confirmed|rejected|untraceable)$/u);
  return match ? { targetKind: match[1], targetId: Number(match[2]), diagnosisStatus: match[3] } : null;
}

// [gpt] 2026-08-17：新错题/历史批次摄入的收口必须证明“本批错题已逐题讲解”，不能只落库就 completed/intake。
// 只读 Run 内已有 checkpoint 与回执计数，不扫描本地台账或加载额外材料，避免把门禁做成新的慢路径。
function cuotiIntakeCheckpointGate(run) {
  if (run.skill !== "cuoti-fupan") return null;
  const resultRef = run.steps.result_recorded?.evidenceRef ?? run.steps.writeback_verified?.evidenceRef ?? "";
  const refText = String(resultRef);
  let expected = null;
  const batchMatch = refText.match(/errors=(\d+)/u);
  const existingMatch = refText.match(/errors#([\d,]+)/u);
  const targetEvents = String(run.steps.target_frozen?.evidenceRef ?? "").match(/(?:E|T)#\d+/gu) ?? [];
  const frozenCount = new Set(targetEvents).size;
  if (existingMatch) expected = existingMatch[1].split(",").filter(Boolean).length;
  else if (batchMatch) expected = Number(batchMatch[1]);
  else if (frozenCount > 0) expected = frozenCount;
  if (expected == null || !Number.isInteger(expected) || expected <= 0) {
    return { expected: null, missing: 0, reason: "cuoti intake 缺可解析的错题数回执（errors=N 或 errors#id 列表或冻结 E#/T# 列表）" };
  }
  const explained = run.checkpoints.filter((item) => item.phase === "intake_question").length;
  return {
    expected,
    explained,
    missing: Math.max(0, expected - explained),
    reason: `cuoti intake 本批 ${expected} 道错题仅落 ${explained} 次逐题讲解 checkpoint，缺 ${Math.max(0, expected - explained)} 道；不能只写库就收口`,
  };
}

// [gpt] 2026-08-13：判题卡、复检写回与病根认领必须指向同一对象和状态，不能各自通过却互相矛盾。
function assertCuotiJudgmentConsistency(run) {
  if (run.skill !== "cuoti-fupan") return;
  const recorded = parsedCuotiEvidenceRef(run.steps.result_recorded?.evidenceRef);
  const judged = parsedCuotiEvidenceRef(run.steps.judgment_output_verified?.evidenceRef);
  if (!recorded?.diagnosisStatus || !judged?.diagnosisStatus) {
    throw new Error("错题复检缺可解析的 T#:<pass|partial|fail|void>:diagnosis=<pending|confirmed|rejected|untraceable> 判题或写回引用");
  }
  if (recorded.targetRef !== judged.targetRef || recorded.result !== judged.result) {
    throw new Error(`错题判题卡与业务写回不一致：${judged.targetRef}:${judged.result} != ${recorded.targetRef}:${recorded.result}`);
  }
  if (["partial", "fail"].includes(judged.result) && judged.diagnosisStatus === "pending") {
    if (recorded.diagnosisStatus !== "pending") {
      throw new Error(`错题判题卡病根状态与复检写回不一致：pending != ${recorded.diagnosisStatus}`);
    }
    throw new Error("错题病根仍待认领；先 checkpoint --phase diagnosis_question 展示 pending 证据卡并等待用户选择，不能直接 completed/result");
  }
  if (["confirmed", "rejected", "untraceable"].includes(judged.diagnosisStatus)) {
    const diagnosis = run.steps.diagnosis_recorded?.status === "pass"
      ? parsedDiagnosisEvidenceRef(run.steps.diagnosis_recorded.evidenceRef)
      : null;
    if (!diagnosis) {
      throw new Error("错题判题卡已声称病根确认或排除，但缺可解析的 diagnosis_recorded 业务回执");
    }
    if (diagnosis.diagnosisStatus !== judged.diagnosisStatus) {
      throw new Error(`错题判题卡病根状态与业务回执不一致：${judged.diagnosisStatus} != ${diagnosis.diagnosisStatus}`);
    }
    const diagnosisTarget = `${diagnosis.targetKind}#${diagnosis.targetId}`;
    const frozenTargets = new Set(String(run.steps.target_frozen?.evidenceRef ?? "").match(/(?:T|E)#\d+/gu) ?? []);
    const targetMatchesCard = diagnosis.targetKind === "T"
      ? diagnosisTarget === judged.targetRef
      : !judged.eventRef || diagnosisTarget === judged.eventRef;
    if (!targetMatchesCard || !frozenTargets.has(diagnosisTarget)) {
      throw new Error(`错题病根认领对象与冻结对象/判题卡不一致：${diagnosisTarget}`);
    }
  } else if (recorded.diagnosisStatus !== judged.diagnosisStatus) {
    throw new Error(`错题判题卡病根状态与复检写回不一致：${judged.diagnosisStatus} != ${recorded.diagnosisStatus}`);
  }
}

export function assertCuotiJudgmentReady({
  runId,
  topicId,
  result,
  diagnosisStatus,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "cuoti-fupan",
    steps: ["target_frozen", "materials_checked", "question_integrity_pass", "judgment_output_verified"],
    file,
  });
  const judged = parsedCuotiEvidenceRef(run.steps.judgment_output_verified?.evidenceRef);
  const expected = {
    targetRef: `T#${Number(topicId)}`,
    result: String(result ?? ""),
    diagnosisStatus: String(diagnosisStatus ?? ""),
  };
  if (!judged
    || judged.targetRef !== expected.targetRef
    || judged.result !== expected.result
    || judged.diagnosisStatus !== expected.diagnosisStatus) {
    const actualRef = judged
      ? `${judged.targetRef}:${judged.result}:diagnosis=${judged.diagnosisStatus ?? "missing"}`
      : "无有效回执";
    throw new Error(`错题判题 Gate 与待写回结果不一致：${actualRef} != ${expected.targetRef}:${expected.result}:diagnosis=${expected.diagnosisStatus || "missing"}`);
  }
  return run;
}

export function assertSkillRunPrerequisites({
  runId,
  expectedSkill = null,
  steps = [],
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = loadRun(runId, file);
  if (run.end) throw new Error(`Skill Run 已结束：${runId}`);
  assertEventTurn(run);
  if (expectedSkill && run.skill !== expectedSkill) throw new Error(`Skill Run 路由不一致：预期 ${expectedSkill}，实际 ${run.skill}`);
  const missing = [...new Set(steps)].filter((step) => {
    assertStep(step);
    return run.steps[step]?.status !== "pass";
  });
  if (missing.length) throw new Error(`Skill Run 缺业务前置回执：${missing.join(",")}`);
  return run;
}

export function assertDaibeiTargetWritebackReady({
  runId,
  reciteId,
  scheduleId = null,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "daibei-pc",
    steps: ["target_frozen", "materials_checked", "question_integrity_pass"],
    file,
  });
  const target = parseDaibeiTargetRef(run.steps.target_frozen?.evidenceRef);
  const expectedReciteId = safeToken(reciteId, "reciteId", { required: true, max: 40 })?.toUpperCase();
  if (!target.stable) {
    throw new Error(`DAIBEI_TARGET_UNSTABLE｜冻结目标“${target.ref ?? "空"}”不含唯一稳定带背条目 ID，禁止写回 ${expectedReciteId}`);
  }
  if (target.reciteId !== expectedReciteId) {
    throw new Error(`DAIBEI_TARGET_MISMATCH｜冻结=${target.reciteId}，待写回=${expectedReciteId}`);
  }
  const normalizedScheduleId = safeToken(scheduleId, "scheduleId", { max: 100 });
  if (normalizedScheduleId && !String(target.ref).includes(normalizedScheduleId)) {
    throw new Error(`DAIBEI_SCHEDULE_MISMATCH｜冻结目标未包含排期 ${normalizedScheduleId}`);
  }
  return { run, target, reciteId: expectedReciteId, scheduleId: normalizedScheduleId };
}

function englishReadingGrade(run) {
  const evidenceRef = run.steps.answer_key_checked?.evidenceRef ?? "";
  const match = evidenceRef.match(/^reading:(20\d{2}):T([1-4]):score=([0-5])\/5:key=([a-f0-9]{8,64}):paper=([a-f0-9]{8,64})$/u);
  if (!match) throw new Error("英语阅读 Run 缺可解析的本地答案键核验回执");
  return { year: match[1], text: Number(match[2]), score: Number(match[3]), maximum: 5, evidenceRef };
}

export function validateEnglishReadingWriteback({
  runId,
  chapter,
  sessionKey,
  score,
  maxScore,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "yingyu-pc",
    steps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated"],
    file,
  });
  const grade = englishReadingGrade(run);
  const ledgerSession = String(run.steps.ledger_validated?.evidenceRef ?? "").match(/^english-ledger:([^:]+):line=\d+$/u)?.[1] ?? null;
  if (!ledgerSession) throw new Error("英语阅读 Run 缺可解析的本场台账核验回执");
  if (String(chapter ?? "").trim() !== `${grade.year} Text ${grade.text}`) {
    throw new Error(`英语日志篇目与答案核验不一致：应为 ${grade.year} Text ${grade.text}`);
  }
  const normalizedSession = String(sessionKey ?? "").trim();
  if (!new RegExp(`^EN-\\d{8}-R-${grade.year}-T${grade.text}$`, "u").test(normalizedSession)) {
    throw new Error(`英语阅读会话键与答案核验不一致：应匹配 EN-YYYYMMDD-R-${grade.year}-T${grade.text}`);
  }
  if (normalizedSession !== ledgerSession) throw new Error(`英语日志会话键与已核台账不一致：${normalizedSession} != ${ledgerSession}`);
  if (Number(score) !== grade.score || Number(maxScore) !== grade.maximum) {
    throw new Error(`英语日志分数与答案键实算不一致：应为 ${grade.score}/${grade.maximum}`);
  }
  return grade;
}

export function recordEnglishReadingWriteback({
  runId,
  chapter,
  sessionKey,
  score,
  maxScore,
  evidenceRef = null,
  source = "english-reading-log",
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  const grade = validateEnglishReadingWriteback({ runId, chapter, sessionKey, score, maxScore, file });
  return recordBusinessWriteback({
    runId,
    source,
    evidenceRef: evidenceRef ?? `${grade.year}-T${grade.text}:${grade.score}/${grade.maximum}`,
    expectedSkill: "yingyu-pc",
    requiredSteps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated"],
    file,
    now,
  });
}

export function validateDaibeiIngestReceipt({
  runId,
  operationId,
  receipt,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const normalizedOperationId = safeToken(operationId, "operationId", { required: true, max: 100 });
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "daibei-pc",
    steps: ["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded"],
    file,
  });
  const consistent = assertDaibeiResultConsistency(run);
  if (!String(run.steps.result_recorded?.evidenceRef ?? "").includes(`op=${normalizedOperationId}`)) {
    throw new Error(`Skill Run 的本地结果回执与 operation_id 不一致：${normalizedOperationId}`);
  }
  if (!receipt
    || receipt.operation_id !== normalizedOperationId
    || receipt.status !== "applied"
    || receipt.op_type !== "learning_attempt") {
    throw new Error(`指定 operation_id 尚未完成 learning_attempt 入库：${normalizedOperationId}`);
  }
  if (consistent.result.operationId !== normalizedOperationId) {
    throw new Error(`Skill Run 的结构化结果 operation_id 与同步目标不一致：${consistent.result.operationId} != ${normalizedOperationId}`);
  }
  return run;
}

export function validateBusinessWriteback({
  runId,
  sourceKind = null,
  subject = null,
  chapter = null,
  activity = null,
  recitationMode = null,
  sessionKey = null,
  score = null,
  maxScore = null,
  file = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const run = assertSkillRunPrerequisites({ runId, file });
  if (!sourceKind && run.skill === "daibei-pc") {
    validateDaibeiProgressWriteback({ runId, subject, chapter, activity, recitationMode, file });
    return { run, expectedSkill: "daibei-pc", requiredSteps: ["target_frozen"], businessMode: "daibei_progress" };
  }
  if (sourceKind === "objective_question" && subject === "英语") {
    validateEnglishReadingWriteback({ runId, chapter, sessionKey, score, maxScore, file });
    return { run, expectedSkill: "yingyu-pc", requiredSteps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated"] };
  }
  if (sourceKind === "subjective_answer") {
    const expectedSkill = subject === "英语" ? "yingyu-pc" : "lunshu-pc";
    const requiredSteps = [
      "target_frozen",
      "source_checked",
      "reference_answer_checked",
      // [gpt] 2026-08-24：referenceHash 绑定只属于 lunshu；英语作文仍使用
      // 用户指定评分档的既有手工证据，不能被法硕主观题加载器误伤。
      ...(expectedSkill === "lunshu-pc" ? ["grading_bound"] : []),
      "question_integrity_pass",
      "rubric_applied",
      "ledger_validated",
    ];
    assertSkillRunPrerequisites({ runId, expectedSkill, steps: requiredSteps, file });
    return { run, expectedSkill, requiredSteps };
  }
  if (sourceKind) throw new Error(`${sourceKind} 不能通过 coach.mjs log 给 Skill Run 签业务回执`);
  assertSkillRunPrerequisites({ runId, expectedSkill: "coach-pc", file });
  return { run, expectedSkill: "coach-pc", requiredSteps: [], businessMode: "generic" };
}

function phaseState(run, phase) {
  const required = SKILL_WORKFLOWS[run.skill]?.[phase] ?? [];
  const missing = required.filter((step) => run.steps[step]?.status !== "pass");
  return { required, missing };
}

export function checkpointSkillRun({
  runId,
  phase,
  done = [],
  evidenceRef = null,
  artifactHash = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  let run = loadRun(runId, file);
  if (run.end) throw new Error(`Skill Run 已结束：${runId}`);
  assertEventTurn(run);
  const reference = currentCodexTurnReference({ sessionId: runtimeSessionId() });
  if (run.status === "waiting_user" && reference.turnId && latestRunTurn(run) !== reference.turnId) {
    appendEvent({
      ...eventBase({ runId, event: "resumed", now }),
      skill: run.skill,
    }, file);
    run = loadRun(runId, file);
  }
  const normalizedPhase = assertPhase(run.skill, phase);
  recordManualDone({ runId, done, evidenceRef, file, now });
  run = loadRun(runId, file);
  const state = phaseState(run, normalizedPhase);
  const displayStep = normalizedPhase === "diagnosis_question" ? "judgment_output_verified" : "question_integrity_pass";
  const integrity = run.steps[displayStep];
  const lastGate = [...run.events].reverse().find((event) => event.event === "step" && event.step === displayStep);
  const suppliedHash = safeToken(artifactHash, "artifactHash", { max: 64 });
  if (suppliedHash && !/^[a-f0-9]{64}$/u.test(suppliedHash)) throw new Error("artifactHash 必须是 64 位小写 sha256");
  const staleQuestionDraft = normalizedPhase.endsWith("question")
    && state.required.includes(displayStep)
    && (!integrity?.artifactHash || lastGate?.status !== "pass" || suppliedHash !== integrity.artifactHash);
  if (staleQuestionDraft && !state.missing.includes(displayStep)) state.missing.push(displayStep);
  if (state.missing.length) {
    appendEvent({
      ...eventBase({ runId, event: "checkpoint_blocked", now }),
      skill: run.skill,
      phase: normalizedPhase,
      required: state.required,
      missing: state.missing,
    }, file);
    throw new SkillRunGateError(
      `SKILL_RUN_BLOCK｜${run.skill}/${normalizedPhase} 缺步骤：${state.missing.join(",")}`
        + formatRecovery(run.skill, state.missing, { runId, subject: run.subject, phase: normalizedPhase }),
      { runId, skill: run.skill, phase: normalizedPhase, ...state },
    );
  }
  appendEvent({
    ...eventBase({ runId, event: "checkpoint_passed", now }),
    skill: run.skill,
    phase: normalizedPhase,
    required: state.required,
  }, file);
  return loadRun(runId, file);
}

export function endSkillRun({
  runId,
  phase = null,
  outcome = "completed",
  done = [],
  evidenceRef = null,
  artifactHash = null,
  handoffSkill = null,
  handoffReason = null,
  abortReason = null,
  abortSource = null,
  file = DEFAULT_SKILL_RUN_FILE,
  now = new Date(),
} = {}) {
  let run = loadRun(runId, file);
  if (run.end) {
    if (run.end.outcome === outcome && run.end.phase === phase) return run;
    throw new Error(`Skill Run 已以 ${run.end.outcome} 结束：${runId}`);
  }
  assertEventTurn(run);
  if (!["completed", "aborted", "handoff"].includes(outcome)) throw new Error("outcome 只接受 completed|aborted|handoff");
  const normalizedHandoffSkill = safeToken(handoffSkill, "handoffSkill", { max: 40 });
  const normalizedHandoffReason = safeToken(handoffReason, "handoffReason", { max: 160 });
  const normalizedAbortReason = outcome === "aborted"
    ? safeToken(abortReason ?? evidenceRef ?? run.deferredWriteback?.reason, "abortReason", { max: 200 }) ?? "unattributed"
    : safeToken(abortReason, "abortReason", { max: 200 });
  const normalizedAbortSource = outcome === "aborted"
    ? safeToken(abortSource, "abortSource", { max: 30 }) ?? (run.deferredWriteback ? "system" : "unattributed")
    : safeToken(abortSource, "abortSource", { max: 30 });
  if (normalizedAbortSource && !ABORT_SOURCES.has(normalizedAbortSource)) {
    throw new Error(`abortSource 只接受 ${[...ABORT_SOURCES].join("|")}`);
  }
  if (outcome === "handoff") {
    if (!normalizedHandoffSkill || normalizedHandoffSkill === run.skill) {
      throw new Error("handoff 必须指定不同的 --to <受控 Skill>");
    }
    assertSkill(normalizedHandoffSkill);
    if (!normalizedHandoffReason) throw new Error("handoff 必须用 --reason 提供可核对的转手原因");
  } else if (normalizedHandoffSkill || normalizedHandoffReason) {
    throw new Error("只有 handoff 可以使用 --to/--reason");
  }
  if (outcome !== "aborted" && (normalizedAbortReason || normalizedAbortSource)) {
    throw new Error("只有 aborted 可以使用 abortReason/abortSource");
  }
  let normalizedPhase = null;
  if (outcome === "completed") {
    normalizedPhase = assertPhase(run.skill, phase);
    // [gpt] 2026-08-21：带背进度、抽查和规划不能互相降级收口；阶段必须与入口意图一致。
    const daibeiPhaseMismatch = run.skill === "daibei-pc" && (
      (["progress", "progress-only"].includes(run.kind) && normalizedPhase !== "progress")
      || (run.kind === "recall" && normalizedPhase === "plan")
    );
    if (daibeiPhaseMismatch) {
      const expectedPhase = ["progress", "progress-only"].includes(run.kind) ? "progress" : "question|result";
      const missing = [`phase_kind_mismatch:${run.kind ?? "unknown"}->${expectedPhase}`];
      appendEvent({
        ...eventBase({ runId, event: "end_blocked", now }),
        skill: run.skill,
        phase: normalizedPhase,
        required: [expectedPhase],
        missing,
      }, file);
      throw new SkillRunGateError(
        `SKILL_RUN_END_BLOCK｜daibei-pc kind=${run.kind ?? "空"} 不能按 ${normalizedPhase} 收口；应为 ${expectedPhase}`
          // [claude] 2026-08-24：只报"应为 X"仍要模型自己推怎么走；直接给下一步。
          + `\n补救：\n  - 先按 --phase ${expectedPhase.split("|")[0]} 收口当前 Run；换阶段要另建 Run，不要改写本 Run 的 kind`,
        { runId, skill: run.skill, phase: normalizedPhase, required: [expectedPhase], missing },
      );
    }
    // [gpt] 2026-08-20：英语已进入真实阅读判分后，不得改用 plan 阶段绕过 reading_grading 闭环。
    if (run.skill === "yingyu-pc" && normalizedPhase === "plan" && run.steps.answer_key_checked?.status === "pass") {
      const missing = ["phase_mismatch:reading_grading"];
      appendEvent({
        ...eventBase({ runId, event: "end_blocked", now }),
        skill: run.skill,
        phase: normalizedPhase,
        required: ["reading_grading"],
        missing,
      }, file);
      throw new SkillRunGateError("SKILL_RUN_END_BLOCK｜yingyu-pc 已核对阅读答案键，必须按 reading_grading 完整收口，不能降级为 plan", {
        runId, skill: run.skill, phase: normalizedPhase, required: ["reading_grading"], missing,
      });
    }
    recordManualDone({ runId, done, evidenceRef, file, now });
    run = loadRun(runId, file);
    const state = phaseState(run, normalizedPhase);
    if (state.missing.length) {
      appendEvent({
        ...eventBase({ runId, event: "end_blocked", now }),
        skill: run.skill,
        phase: normalizedPhase,
        required: state.required,
        missing: state.missing,
      }, file);
      throw new SkillRunGateError(
        `SKILL_RUN_END_BLOCK｜${run.skill}/${normalizedPhase} 缺步骤：${state.missing.join(",")}`
          + formatRecovery(run.skill, state.missing, { runId, subject: run.subject, phase: normalizedPhase }),
        { runId, skill: run.skill, phase: normalizedPhase, ...state },
      );
    }
    if (run.skill === "cuoti-fupan" && normalizedPhase === "result") {
      assertCuotiJudgmentConsistency(run);
      const suppliedHash = safeToken(artifactHash, "artifactHash", { required: true, max: 64 });
      if (!/^[a-f0-9]{64}$/u.test(suppliedHash)) throw new Error("artifactHash 必须是 64 位小写 sha256");
      if (suppliedHash !== run.steps.judgment_output_verified?.artifactHash) {
        throw new Error("错题复检收口 hash 与已校验证据卡不一致；只能展示并收口 Gate 返回的同一张卡");
      }
    }
    if (run.skill === "cuoti-fupan" && normalizedPhase === "intake") {
      const gate = cuotiIntakeCheckpointGate(run);
      if (gate.expected == null || gate.missing > 0) {
        appendEvent({
          ...eventBase({ runId, event: "end_blocked", now }),
          skill: run.skill,
          phase: normalizedPhase,
          required: [...state.required, `intake_question×${gate.expected ?? "?"}`],
          missing: [`intake_question×${gate.missing}`],
        }, file);
        throw new SkillRunGateError(
          `SKILL_RUN_END_BLOCK｜${run.skill}/${normalizedPhase} ${gate.reason}`
            + formatRecovery(run.skill, [`intake_question×${gate.missing}`], { runId, subject: run.subject, phase: normalizedPhase }),
          { runId, skill: run.skill, phase: normalizedPhase, missing: [`intake_question_missing:${gate.missing}`], ...state },
        );
      }
    }
    if (run.skill === "daibei-pc" && normalizedPhase === "result") assertDaibeiResultConsistency(run);
  }
  appendEvent({
    ...eventBase({ runId, event: "ended", now }),
    skill: run.skill,
    phase: normalizedPhase,
    outcome,
    handoffSkill: normalizedHandoffSkill,
    handoffReason: normalizedHandoffReason,
    abortReason: normalizedAbortReason,
    abortSource: normalizedAbortSource,
    // [claude] 2026-08-24：因同步失败而中止的 Run，证据其实在 outbox 里等着补同步。
    // 打上标记，监控才能把"基础设施抖动"和"真放弃"分开，不再一律记成不合规。
    deferredWriteback: run.deferredWriteback ? {
      source: run.deferredWriteback.source,
      reason: run.deferredWriteback.reason,
      operationId: run.deferredWriteback.operationId,
    } : null,
  }, file);
  return loadRun(runId, file);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function inWindow(value, start, end) {
  const date = beijingDate(value);
  return (!start || date >= start) && (!end || date <= end);
}

// [claude] 2026-08-24：把阻断按"缺了哪一步"聚合。只报总数看不出模式，
// 而模式才是可行动的信息：同一步被反复跳过说明该步的触发时机或提示有问题，
// 不是随机失误。byStep 回答"哪一步在漏"，bySkillPhase 回答"漏在哪条路径上"。
export function summarizeGateFailureReasons(gateFailures = []) {
  const byStep = new Map();
  const bySkillPhase = new Map();
  for (const event of gateFailures) {
    const missing = Array.isArray(event?.missing) && event.missing.length
      ? event.missing
      : (event?.step ? [event.step] : []);
    for (const raw of missing) {
      // intake_question×2 这类带计数后缀的归一到同一类，否则每个数字自成一类。
      const step = String(raw).replace(/×\d+$/u, "×N");
      byStep.set(step, (byStep.get(step) ?? 0) + 1);
    }
    if (!event?.skill) continue;
    const key = `${event.skill}/${event.phase ?? "未标阶段"}`;
    bySkillPhase.set(key, (bySkillPhase.get(key) ?? 0) + 1);
  }
  const rank = (map) => Object.fromEntries([...map.entries()].sort((left, right) => right[1] - left[1]));
  return { total: gateFailures.length, byStep: rank(byStep), bySkillPhase: rank(bySkillPhase) };
}

export function summarizeSkillRuns(input = {}, {
  nowIso = new Date().toISOString(),
  windowStart = null,
  windowEnd = null,
  staleMinutes = 24 * 60,
  postProgressProbeGraceMinutes = 10,
  runPurpose = "learning",
} = {}) {
  if (!RUN_PURPOSES.has(runPurpose)) throw new Error("runPurpose 只接受 learning|diagnostic|simulation");
  const events = Array.isArray(input) ? input : input.events ?? [];
  const parseIssues = Array.isArray(input) ? [] : input.issues ?? [];
  const telemetrySources = Array.isArray(input) ? [] : input.files ?? [];
  const nowMs = new Date(nowIso).getTime();
  const allRuns = [...reconstructSkillRuns(events).values()].filter((run) => (
    run.startedAt && (inWindow(run.startedAt, windowStart, windowEnd) || (!run.end && inWindow(run.lastEventAt, windowStart, windowEnd)))
  ));
  // [gpt] 2026-08-25：诊断/仿真 Run 保留遥测，但不得污染学习完成率、失败数和耗时。
  // schema v1 与早期 v2 没有 purpose，按历史默认 learning 兼容，避免重算旧窗口时数据消失。
  const effectivePurpose = (run) => RUN_PURPOSES.has(run.runPurpose) ? run.runPurpose : "learning";
  const runs = allRuns.filter((run) => effectivePurpose(run) === runPurpose);
  const startupLatency = runs.flatMap((run) => {
    const value = run.steps.context_loaded?.durationMs;
    return Number.isFinite(value) ? [value] : [];
  });
  // [gpt] 2026-08-13：按自动阶段统计机器耗时；用户作答等待不进入任何 step duration。
  const stepLatencyMs = Object.fromEntries([...AUTO_STEPS].map((step) => {
    const values = runs.flatMap((run) => {
      const value = run.steps[step]?.durationMs;
      return Number.isFinite(value) ? [value] : [];
    });
    return [step, {
      samples: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values.length ? Math.max(...values) : null,
    }];
  }).filter(([, summary]) => summary.samples > 0));
  // [gpt] 已安全展示题目并正常等待用户作答不是漏收口；只有 active/blocked 长时间无后续才告警。
  const stale = runs.filter((run) => !run.end && run.status !== "waiting_user" && Number.isFinite(nowMs)
    && (nowMs - new Date(run.lastEventAt).getTime()) / 60000 >= staleMinutes);
  const gateFailures = runs.flatMap((run) => run.events.filter((event) => (
    ["checkpoint_blocked", "end_blocked"].includes(event.event)
      || (event.event === "step" && event.status === "fail")
  )));
  const gateFailureReasons = summarizeGateFailureReasons(gateFailures);
  const completed = runs.filter((run) => run.end?.outcome === "completed");
  const aborted = runs.filter((run) => run.end?.outcome === "aborted");
  // [claude] 2026-08-24：证据已落 outbox、只差远端同步的，不能和"真放弃"混为一谈。
  // 2026-08-24 云三次断网就是这样被记成 4 个 aborted，看上去像模型不肯收口。
  const deferredWriteback = runs.filter((run) => run.deferredWriteback || run.end?.deferredWriteback);
  const abandonedAborted = aborted.filter((run) => !run.end?.deferredWriteback);
  const handoff = runs.filter((run) => run.end?.outcome === "handoff");
  const invalidHandoffs = handoff.filter((run) => !run.end?.handoffSkill || !run.end?.handoffReason);
  const unresolvedHandoffs = handoff.filter((run) => {
    if (!run.end?.handoffSkill || !run.sessionId) return false;
    const destination = runs.find((candidate) => (
      candidate.skill === run.end.handoffSkill
        && candidate.sessionId === run.sessionId
        && String(candidate.startedAt) >= String(run.end.observedAt)
    ));
    return !destination;
  });
  // [gpt] 2026-08-21：监控用户意图链，不再把“recall 按 plan 收口”或“记完进度未进入抽查”算作干净完成。
  const daibeiPhaseKindMismatches = completed.filter((run) => run.skill === "daibei-pc" && (
    (run.kind === "recall" && run.end?.phase === "plan")
    || (["progress", "progress-only"].includes(run.kind) && run.end?.phase !== "progress")
  ));
  const daibeiPostProgressProbeMissing = completed.filter((run) => {
    if (run.skill !== "daibei-pc" || run.kind !== "progress" || run.end?.phase !== "progress") return false;
    const endedAt = new Date(run.end.observedAt).getTime();
    if (!Number.isFinite(nowMs) || !Number.isFinite(endedAt)
      || (nowMs - endedAt) / 60000 < postProgressProbeGraceMinutes) return false;
    return !runs.some((candidate) => (
      candidate.runId !== run.runId
        && candidate.skill === "daibei-pc"
        && candidate.kind === "recall"
        && candidate.sessionId
        && candidate.sessionId === run.sessionId
        && candidate.subject === run.subject
        && String(candidate.startedAt) >= String(run.end.observedAt)
        && candidate.checkpoints.some((checkpoint) => checkpoint.phase === "question")
    ));
  });
  const invalidClosureIds = new Set([
    ...daibeiPhaseKindMismatches,
    ...daibeiPostProgressProbeMissing,
  ].map((run) => run.runId));
  // [gpt] 2026-08-14：waiting_user 也可能已被旧流程串入上一题结果；单列隔离，不能伪装成正常等待。
  const quarantinedDaibeiRuns = runs.filter((run) => {
    if (run.end || run.skill !== "daibei-pc" || run.steps.result_recorded?.status !== "pass") return false;
    const target = parseDaibeiTargetRef(run.steps.target_frozen?.evidenceRef);
    const result = parseDaibeiResultRef(run.steps.result_recorded.evidenceRef);
    return !target.stable || !result || target.reciteId !== result.reciteId;
  });
  const quarantinedIds = new Set(quarantinedDaibeiRuns.map((run) => run.runId));
  // [gpt] 2026-08-20：长期 waiting_user 不改写业务状态，只在监控层标成孤儿等待并纳入完整率分母。
  const orphanedWaiting = runs.filter((run) => !run.end && run.status === "waiting_user" && Number.isFinite(nowMs)
    && (nowMs - new Date(run.lastEventAt).getTime()) / 60000 >= staleMinutes);
  const orphanedWaitingIds = new Set(orphanedWaiting.map((run) => run.runId));
  const bySkill = {};
  for (const run of runs) {
    const bucket = bySkill[run.skill] ?? {
      started: 0, completed: 0, cleanCompleted: 0, invalidClosures: 0, handoff: 0, aborted: 0, active: 0, actionableActive: 0, waitingUser: 0, orphanedWaiting: 0, quarantined: 0, blocked: 0, stale: 0,
    };
    bucket.started += 1;
    if (run.end?.outcome === "completed") bucket.completed += 1;
    if (run.end?.outcome === "completed" && !invalidClosureIds.has(run.runId)) bucket.cleanCompleted += 1;
    if (invalidClosureIds.has(run.runId)) bucket.invalidClosures += 1;
    if (run.end?.outcome === "handoff") bucket.handoff += 1;
    if (run.end?.outcome === "aborted") bucket.aborted += 1;
    if (!run.end) bucket.active += 1;
    if (!run.end && !quarantinedIds.has(run.runId) && !orphanedWaitingIds.has(run.runId)) bucket.actionableActive += 1;
    if (run.status === "waiting_user") bucket.waitingUser += 1;
    if (orphanedWaitingIds.has(run.runId)) bucket.orphanedWaiting += 1;
    if (quarantinedIds.has(run.runId)) bucket.quarantined += 1;
    if (run.blocked.length || run.steps.question_integrity_pass?.status === "fail") bucket.blocked += 1;
    if (stale.includes(run)) bucket.stale += 1;
    bySkill[run.skill] = bucket;
  }
  for (const bucket of Object.values(bySkill)) {
    const closedCleanly = bucket.cleanCompleted + bucket.handoff;
    bucket.rawCleanRate = bucket.started ? Math.round((closedCleanly / bucket.started) * 1000) / 10 : null;
  }
  const eligible = new Set([...completed, ...handoff, ...aborted, ...stale, ...orphanedWaiting, ...quarantinedDaibeiRuns].map((run) => run.runId)).size;
  const cleanCompleted = completed.filter((run) => !invalidClosureIds.has(run.runId));
  const quarantineIssues = quarantinedDaibeiRuns.map((run) => ({
    code: "daibei_target_result_mismatch",
    severity: "error",
    runId: run.runId,
    message: `带背 Run 冻结目标 ${run.steps.target_frozen?.evidenceRef ?? "空"} 与结果 ${run.steps.result_recorded?.evidenceRef ?? "空"} 不一致；已从可恢复池隔离`,
  }));
  // [gpt] 2026-08-17：判分答案键到长难句互动的真实时间差，用于识别“过几天才补讲”的英语教学尾段；只产出告警数据，不在此处阻断。
  const englishLongSentenceDelays = runs.filter((run) => (
    run.skill === "yingyu-pc"
      && run.end?.outcome === "completed"
      && run.end?.phase === "reading_grading"
      && run.steps.answer_key_checked?.observedAt
      && run.steps.long_sentence_reviewed?.observedAt
  )).map((run) => {
    const start = new Date(run.steps.answer_key_checked.observedAt).getTime();
    const end = new Date(run.steps.long_sentence_reviewed.observedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return {
      runId: run.runId,
      answerKeyAt: run.steps.answer_key_checked.observedAt,
      longSentenceAt: run.steps.long_sentence_reviewed.observedAt,
      delayMinutes: Math.max(0, Math.floor((end - start) / 60000)),
    };
  }).filter(Boolean);
  return {
    schemaVersion: SKILL_RUN_SCHEMA_VERSION,
    telemetrySources,
    purposeScope: {
      selected: runPurpose,
      legacyFallback: "learning",
      byPurpose: Object.fromEntries([...RUN_PURPOSES].map((purpose) => [
        purpose,
        allRuns.filter((run) => effectivePurpose(run) === purpose).length,
      ])),
      excluded: allRuns.length - runs.length,
    },
    counts: {
      runs: runs.length,
      completed: completed.length,
      active: runs.filter((run) => !run.end).length,
      actionableActive: runs.filter((run) => !run.end && !quarantinedIds.has(run.runId) && !orphanedWaitingIds.has(run.runId)).length,
      waitingUser: runs.filter((run) => run.status === "waiting_user").length,
      freshWaitingUser: runs.filter((run) => run.status === "waiting_user" && !orphanedWaitingIds.has(run.runId)).length,
      orphanedWaiting: orphanedWaiting.length,
      quarantined: quarantinedDaibeiRuns.length,
      aborted: aborted.length,
      // 拆开看：deferredWriteback 是基础设施抖动（证据在 outbox，可补同步），
      // abandonedAborted 才是真放弃。混在一起会让 aborted 这个数字失去意义。
      deferredWriteback: deferredWriteback.length,
      abandonedAborted: abandonedAborted.length,
      handoff: handoff.length,
      stale: stale.length,
      gateFailures: gateFailures.length,
      invalidHandoffs: invalidHandoffs.length,
      unresolvedHandoffs: unresolvedHandoffs.length,
      daibeiPhaseKindMismatches: daibeiPhaseKindMismatches.length,
      daibeiPostProgressProbeMissing: daibeiPostProgressProbeMissing.length,
    },
    compliance: {
      eligible,
      completed: completed.length,
      closedCleanly: cleanCompleted.length + handoff.length,
      rate: eligible ? Math.round(((cleanCompleted.length + handoff.length) / eligible) * 1000) / 10 : null,
      rawStarted: runs.length,
      rawRate: runs.length ? Math.round(((cleanCompleted.length + handoff.length) / runs.length) * 1000) / 10 : null,
    },
    startupLatencyMs: {
      samples: startupLatency.length,
      p50: percentile(startupLatency, 0.5),
      p95: percentile(startupLatency, 0.95),
      max: startupLatency.length ? Math.max(...startupLatency) : null,
    },
    stepLatencyMs,
    bySkill,
    staleRuns: stale.map((run) => ({
      runId: run.runId,
      skill: run.skill,
      status: run.status,
      lastEventAt: run.lastEventAt,
      ageMinutes: Math.floor((nowMs - new Date(run.lastEventAt).getTime()) / 60000),
      lastMissing: run.blocked.at(-1)?.missing ?? [],
    })),
    orphanedWaitingRuns: orphanedWaiting.map((run) => ({
      runId: run.runId,
      skill: run.skill,
      status: run.status,
      lastEventAt: run.lastEventAt,
      ageMinutes: Math.floor((nowMs - new Date(run.lastEventAt).getTime()) / 60000),
    })),
    // [claude] 2026-08-24：原来只给 10 条样例，看不出模式。2026-08-13～08-23 的
    // 21 次阻断里 question_integrity_pass 缺 7 次、context_loaded 缺 6 次
    // （后者是 daibei-pc/plan 同一处 8 天复发 5 次），全靠离线脚本才统计出来。
    // 聚合进报表，才能让"哪一步在被反复跳过"自己浮出来。
    gateFailureReasons,
    // 待补同步的 Run 要能被点名，否则"证据在 outbox 里"等于没人知道。
    deferredWritebackExamples: deferredWriteback.slice(-10).map((run) => {
      const mark = run.deferredWriteback ?? run.end?.deferredWriteback ?? {};
      return {
        runId: run.runId,
        skill: run.skill,
        outcome: run.end?.outcome ?? null,
        source: mark.source ?? null,
        reason: mark.reason ?? null,
        operationId: mark.operationId ?? null,
        resume: mark.operationId
          ? `node --env-file=.env.local scripts/cuoti.mjs sync --run ${run.runId} --operation ${mark.operationId}`
          : "node --env-file=.env.local scripts/cuoti.mjs sync",
      };
    }),
    gateFailureExamples: gateFailures.slice(-10).map((event) => ({
      runId: event.runId,
      skill: event.skill,
      phase: event.phase ?? null,
      step: event.step ?? null,
      missing: event.missing ?? [],
      observedAt: event.observedAt,
    })),
    invalidHandoffExamples: invalidHandoffs.slice(-10).map((run) => ({
      runId: run.runId,
      skill: run.skill,
      observedAt: run.end?.observedAt ?? run.lastEventAt,
    })),
    unresolvedHandoffExamples: unresolvedHandoffs.slice(-10).map((run) => ({
      runId: run.runId,
      skill: run.skill,
      handoffSkill: run.end?.handoffSkill ?? null,
      observedAt: run.end?.observedAt ?? run.lastEventAt,
    })),
    daibeiPhaseKindMismatchExamples: daibeiPhaseKindMismatches.slice(-10).map((run) => ({
      runId: run.runId,
      kind: run.kind,
      phase: run.end?.phase ?? null,
      observedAt: run.end?.observedAt ?? run.lastEventAt,
    })),
    daibeiPostProgressProbeMissingExamples: daibeiPostProgressProbeMissing.slice(-10).map((run) => ({
      runId: run.runId,
      subject: run.subject,
      targetRef: run.steps.target_frozen?.evidenceRef ?? null,
      observedAt: run.end?.observedAt ?? run.lastEventAt,
    })),
    quarantinedRuns: quarantinedDaibeiRuns.map((run) => ({
      runId: run.runId,
      skill: run.skill,
      status: run.status,
      targetRef: run.steps.target_frozen?.evidenceRef ?? null,
      resultRef: run.steps.result_recorded?.evidenceRef ?? null,
      lastEventAt: run.lastEventAt,
    })),
    englishLongSentenceDelays,
    issues: [...parseIssues, ...quarantineIssues],
  };
}

export function buildSkillExecutionContext(run) {
  if (!run?.runId || !run?.skill) throw new Error("缺少可用的 Skill Run");
  const phases = SKILL_WORKFLOWS[run.skill];
  // [claude] 2026-08-24：phases 只说"要哪些步骤"，不说"每步归谁签"，模型得等被
  // 阻断才发现。这里在启动时就把签发命令给出，把 Gate 从事后阻断改成事前告知。
  // 只列自动步骤：它们是模型唯一猜不出的部分。手工步骤的写法已由下面的
  // commands.step/checkpoint/end 模板覆盖，重复列出只会撑大每轮必读的启动载荷；
  // 手工步骤该写什么证据引用，仍在真正阻断时由补救指令给出。
  const stepCommands = {};
  const seenHint = new Map();
  for (const steps of Object.values(phases ?? {})) {
    for (const step of steps) {
      if (stepCommands[step] || !AUTO_STEPS.has(step)) continue;
      const hint = recoveryHint(run.skill, step, { runId: run.runId, subject: run.subject });
      if (!hint) continue;
      // 同一条命令同时签多步（如 cuoti 的 result_recorded + writeback_verified）时
      // 只写一遍正文，其余回指，避免把同一段长命令重复塞进每轮必读的启动载荷。
      const first = seenHint.get(hint);
      stepCommands[step] = first ? `同 ${first}` : hint;
      if (!first) seenHint.set(hint, step);
    }
  }
  return {
    schemaVersion: SKILL_RUN_SCHEMA_VERSION,
    runId: run.runId,
    skill: run.skill,
    phases,
    stepCommands,
    materialFlag: `--run ${run.runId}`,
    commands: {
      step: `node scripts/skill-run.mjs step --run ${run.runId} --step <手工步骤> [--ref <证据引用>]`,
      checkpoint: `node scripts/skill-run.mjs checkpoint --run ${run.runId} --phase <阶段> [--done <手工步骤,...>] [--hash <Gate返回的题面sha256>] [--ref <证据引用>]`,
      end: `node scripts/skill-run.mjs end --run ${run.runId} --phase <阶段> --done <手工步骤,...> [--ref <证据引用>]`,
      handoff: `node scripts/skill-run.mjs end --run ${run.runId} --outcome handoff --to <目标Skill> --reason <可核对转手原因>`,
    },
    rule: "自动步骤只能由真实脚本回执落证；题目展示前 checkpoint question，完整收口用 end。BLOCK 时补步骤后重跑，不得口头越过。",
  };
}
