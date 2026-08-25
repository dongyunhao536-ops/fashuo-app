// [gpt] 2026-08-13：错题事件的单一机器校验入口；确定性字段交给代码，内容判断仍由模型/用户完成。
import {
  CLASSIFICATION_STATUSES,
  PERSISTED_DIAGNOSIS_STATUSES,
  SUBJECTS,
  cleanTopicTitle,
  normalizeSubject,
  validatePersistedDiagnosisStatus,
  validateFailurePattern,
  validateRootCause,
} from "./error-taxonomy.mjs";

export const ERROR_ENTRY_SOURCES = Object.freeze({
  direct: Object.freeze({ dbLabel: "pc复盘", chapterMode: "required" }),
  batch: Object.freeze({ dbLabel: "pc复盘", chapterMode: "required" }),
  recurrence: Object.freeze({ dbLabel: "pc复盘·复发", chapterMode: "inherit" }),
});

function text(value) {
  return String(value ?? "").trim();
}

function issue(code, field, message) {
  return Object.freeze({ code, field, message });
}

export class ErrorEntryValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [];
    super(`错题条目校验失败：${list.map((item) => `[${item.code}] ${item.message}`).join("；")}`);
    this.name = "ErrorEntryValidationError";
    this.code = "ERROR_ENTRY_INVALID";
    this.issues = list;
  }
}

function normalizeTopic(topic, chapter, issues) {
  if (topic == null) return null;
  if (typeof topic !== "object" || Array.isArray(topic)) {
    issues.push(issue("topic_type", "topic", "topic 必须是对象或 null"));
    return null;
  }

  const title = cleanTopicTitle(topic.title);
  if (!title) issues.push(issue("topic_title_missing", "topic.title", "提供 topic 时必须给稳定主题标题"));

  const classificationStatus = text(topic.classificationStatus) || "pending";
  if (!CLASSIFICATION_STATUSES.includes(classificationStatus)) {
    issues.push(issue("classification_status_invalid", "topic.classificationStatus", `分类状态不合法：${classificationStatus}`));
  }

  let rootCauseCode = "unclassified";
  try {
    rootCauseCode = validateRootCause(topic.rootCauseCode ?? "unclassified");
  } catch (error) {
    issues.push(issue("root_cause_invalid", "topic.rootCauseCode", error.message));
  }

  let failurePatternCode = null;
  try {
    failurePatternCode = validateFailurePattern(topic.failurePatternCode);
  } catch (error) {
    issues.push(issue("failure_pattern_invalid", "topic.failurePatternCode", error.message));
  }

  let diagnosisStatus = "unassessed";
  try {
    diagnosisStatus = validatePersistedDiagnosisStatus(topic.diagnosisStatus ?? "unassessed");
  } catch (error) {
    issues.push(issue("diagnosis_status_invalid", "topic.diagnosisStatus", error.message));
  }

  const role = text(topic.role) || "primary";
  if (!["primary", "related"].includes(role)) {
    issues.push(issue("topic_role_invalid", "topic.role", "topic.role 只能是 primary 或 related"));
  }

  const topicChapter = text(topic.chapter) || chapter || null;
  const rootCauseNote = text(topic.rootCauseNote) || null;
  const evidenceAnchor = text(topic.evidenceAnchor) || null;

  if (classificationStatus === "confirmed" && !topicChapter) {
    issues.push(issue("confirmed_topic_chapter_missing", "topic.chapter", "confirmed 主题必须有章节"));
  }
  if (diagnosisStatus === "confirmed" && rootCauseCode === "unclassified") {
    issues.push(issue("confirmed_cause_unclassified", "topic.rootCauseCode", "confirmed 病根不能仍是 unclassified"));
  }
  if (diagnosisStatus === "confirmed" && !rootCauseNote) {
    issues.push(issue("confirmed_cause_note_missing", "topic.rootCauseNote", "confirmed 病根必须记录用户认领或证据说明"));
  }

  return {
    title,
    chapter: topicChapter,
    section: text(topic.section) || null,
    kpId: text(topic.kpId) || null,
    classificationStatus,
    rootCauseCode,
    failurePatternCode,
    rootCauseNote,
    diagnosisStatus,
    diagnosisDecidedRunId: text(topic.diagnosisDecidedRunId) || null,
    untraceableAt: text(topic.untraceableAt) || null,
    untraceableBy: text(topic.untraceableBy) || null,
    untraceableReason: text(topic.untraceableReason) || null,
    evidenceAnchor,
    role,
  };
}

/**
 * 校验并规范化一条 new_error。
 *
 * - source/chapter 由调用入口传入，不要求模型记忆来源枚举。
 * - 未识别主题或病根是合法状态，但会被显式写成 unassessed/unclassified；pending 候选不入库。
 * - confirmed 表示已有人/证据认领，因此必须带完整锚点与说明。
 */
export function validateErrorEntry(input, defaults = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ErrorEntryValidationError([issue("entry_type", "$", "错题条目必须是对象")]);
  }
  if (input.op != null && input.op !== "new_error") {
    issues.push(issue("operation_type", "op", "validateErrorEntry 只接受 new_error"));
  }

  const subject = normalizeSubject(input.subject);
  if (!SUBJECTS.includes(subject)) {
    issues.push(issue("subject_invalid", "subject", `科目必须是：${SUBJECTS.join("/")}`));
  }
  const knowledge = text(input.knowledge);
  if (!knowledge) issues.push(issue("knowledge_missing", "knowledge", "缺少真实错题事件说明"));

  const recurOf = input.recurOf == null ? null : Number(input.recurOf);
  if (recurOf != null && (!Number.isInteger(recurOf) || recurOf <= 0)) {
    issues.push(issue("recur_of_invalid", "recurOf", "recurOf 必须是正整数"));
  }

  const entrySource = text(input.entrySource ?? defaults.entrySource);
  if (!(entrySource in ERROR_ENTRY_SOURCES)) {
    issues.push(issue("entry_source_invalid", "entrySource", `来源必须是：${Object.keys(ERROR_ENTRY_SOURCES).join("/")}`));
  }
  if (entrySource === "recurrence" && recurOf == null) {
    issues.push(issue("recurrence_source_missing_id", "recurOf", "复发来源必须带 recurOf"));
  }
  if (recurOf != null && entrySource && entrySource !== "recurrence") {
    issues.push(issue("recurrence_source_mismatch", "entrySource", "带 recurOf 的错题来源必须是 recurrence"));
  }

  const requestedChapter = text(input.chapter ?? defaults.chapter) || null;
  const chapterMode = ERROR_ENTRY_SOURCES[entrySource]?.chapterMode;
  const chapter = requestedChapter || text(input.topic?.chapter) || null;
  if (chapterMode === "required" && !chapter) {
    issues.push(issue("chapter_missing", "chapter", "单条或批量新错题必须有章节；未归类主题也不能丢章节"));
  }

  const topic = normalizeTopic(input.topic, chapter, issues);
  const classificationStatus = topic?.classificationStatus ?? "pending";
  const diagnosisStatus = topic?.diagnosisStatus ?? "unassessed";
  const rootCauseCode = topic?.rootCauseCode ?? "unclassified";
  if (!PERSISTED_DIAGNOSIS_STATUSES.includes(diagnosisStatus)) {
    issues.push(issue("diagnosis_status_invalid", "topic.diagnosisStatus", `诊断状态不合法：${diagnosisStatus}`));
  }

  if (issues.length) throw new ErrorEntryValidationError(issues);

  return {
    ...input,
    op: "new_error",
    subject,
    knowledge,
    recurOf,
    entrySource,
    chapter,
    topic,
    // 机器派生审计状态：没有病根不是跨会话待认领，而是明确“未作诊断”。
    entryState: {
      classificationStatus,
      diagnosisStatus,
      rootCauseCode,
      chapterStatus: chapter ? "explicit" : "inherit",
    },
  };
}

// [gpt] 2026-08-13：兼容校验器上线前已经生成、但尚未同步的本地 outbox；新写入仍必须显式来源和章节。
export function migrateLegacyErrorEntry(input) {
  if (!input || typeof input !== "object" || input.op !== "new_error") return input;
  if (input.entrySource) return input;
  const recurOf = input.recurOf == null ? null : Number(input.recurOf);
  return {
    ...input,
    entrySource: recurOf ? "recurrence" : "direct",
    chapter: text(input.chapter) || text(input.topic?.chapter) || "历史待补章节",
  };
}

export function isLegacyErrorEntry(input) {
  return Boolean(input && typeof input === "object" && input.op === "new_error" && !text(input.entrySource));
}

export function errorEntrySourceLabel(entrySource) {
  return ERROR_ENTRY_SOURCES[entrySource]?.dbLabel ?? null;
}
