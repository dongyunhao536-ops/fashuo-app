import { createHash } from "node:crypto";

export const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"];

const SUBJECT_ALIASES = new Map([
  ["刑法学", "刑法"],
  ["民法学", "民法"],
  ["法理学", "法理"],
  ["宪法学", "宪法"],
  ["中国法制史", "法制史"],
  ["法制史", "法制史"],
  ["英语一", "英语"],
]);

export const ROOT_CAUSES = Object.freeze({
  unclassified: "待认领",
  knowledge_gap: "规则或结论缺失",
  boundary_miss: "限定语、例外或边界遗漏",
  concept_confusion: "易混概念混淆",
  reasoning_order: "前置关卡或推理顺序错误",
  question_layer: "审题层级错位",
  fact_misread: "题干事实误读",
  terminology_drift: "法律术语被日常语言改写",
  expression_gap: "主观题表达漏点",
  memory_decay: "已掌握内容回落",
});

export const DIAGNOSIS_STATUSES = ["pending", "confirmed", "rejected"];
export const CLASSIFICATION_STATUSES = ["pending", "confirmed"];
export const REVIEW_RESULTS = ["pass", "partial", "fail"];

export function normalizeSubject(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return SUBJECT_ALIASES.get(raw) ?? (SUBJECTS.includes(raw) ? raw : raw);
}

export function cleanTopicTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/^[：:·|｜\-—\s]+|[：:·|｜\-—\s]+$/g, "")
    .trim();
}

export function normalizeTopicText(value) {
  return cleanTopicTitle(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。；、：:,.!?！？“”‘’"'（）()【】\[\]《》<>·|｜\-—_/\\]+/g, "");
}

export function topicKey(subject, title) {
  const normalizedSubject = normalizeSubject(subject) ?? "未分类";
  const normalizedTitle = normalizeTopicText(title);
  if (normalizedTitle.length < 2) throw new Error("弱项主题至少需要 2 个有效字符");
  const digest = createHash("sha256")
    .update(`${normalizedSubject}\n${normalizedTitle}`)
    .digest("hex")
    .slice(0, 20);
  return `${normalizedSubject}:${digest}`;
}

export function validateRootCause(code) {
  const value = String(code ?? "unclassified");
  if (!(value in ROOT_CAUSES)) {
    throw new Error(`未知病根代码「${value}」；可用：${Object.keys(ROOT_CAUSES).join(", ")}`);
  }
  return value;
}

export function validateDiagnosisStatus(status) {
  const value = String(status ?? "pending");
  if (!DIAGNOSIS_STATUSES.includes(value)) {
    throw new Error(`未知诊断状态「${value}」；可用：${DIAGNOSIS_STATUSES.join(", ")}`);
  }
  return value;
}

export function validateReviewResult(result) {
  const value = String(result ?? "");
  if (!REVIEW_RESULTS.includes(value)) {
    throw new Error(`未知复检结果「${value}」；可用：${REVIEW_RESULTS.join(", ")}`);
  }
  return value;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value == null || String(value).startsWith("--")) throw new Error(`${name} 需要一个值`);
  args.splice(index, 2);
  return String(value).trim();
}

export function parseTopicOptions(input, { requireTopic = false } = {}) {
  const args = [...input];
  const title = cleanTopicTitle(takeOption(args, "--topic"));
  const chapter = takeOption(args, "--chapter");
  const section = takeOption(args, "--section");
  const kpId = takeOption(args, "--kp");
  const rootCauseCode = validateRootCause(takeOption(args, "--cause") ?? "unclassified");
  const rootCauseNote = takeOption(args, "--cause-note");
  const diagnosisStatus = validateDiagnosisStatus(takeOption(args, "--diagnosis") ?? "pending");
  const classificationStatus = takeOption(args, "--classification") ?? "confirmed";
  if (!CLASSIFICATION_STATUSES.includes(classificationStatus)) {
    throw new Error(`未知分类状态「${classificationStatus}」；可用：${CLASSIFICATION_STATUSES.join(", ")}`);
  }
  const evidenceAnchor = takeOption(args, "--anchor");
  const role = takeOption(args, "--role") ?? "primary";
  if (!['primary', 'related'].includes(role)) throw new Error("--role 只能是 primary 或 related");
  if (requireTopic && !title) throw new Error("缺少 --topic <标准弱项主题>");
  if (!title && [chapter, section, kpId, rootCauseNote, evidenceAnchor].some(Boolean)) {
    throw new Error("填写章节、病根或锚点前必须先给 --topic");
  }
  return {
    rest: args,
    topic: title ? {
      title,
      chapter,
      section,
      kpId,
      classificationStatus,
      rootCauseCode,
      rootCauseNote,
      diagnosisStatus,
      evidenceAnchor,
      role,
    } : null,
  };
}

export function parseAddArgs(input) {
  const args = [...input];
  const recurIndex = args.indexOf("--recur-of");
  let recurOf = null;
  if (recurIndex !== -1) {
    recurOf = Number(args[recurIndex + 1]);
    args.splice(recurIndex, 2);
    if (!Number.isInteger(recurOf) || recurOf <= 0) throw new Error("--recur-of 需要旧错题的正整数 id");
  }
  const { rest, topic } = parseTopicOptions(args);
  const subject = normalizeSubject(rest.shift());
  const knowledge = rest.join(" ").trim();
  if (!subject || !SUBJECTS.includes(subject)) throw new Error(`add 需要合法科目：${SUBJECTS.join("/")}`);
  if (!knowledge) throw new Error("add 需要错题事件原文或知识点说明");
  return { subject, knowledge, recurOf, topic };
}

export function topicInsertPayload(subject, topic, nowIso = new Date().toISOString()) {
  const normalizedSubject = normalizeSubject(subject);
  const title = cleanTopicTitle(topic?.title);
  if (!normalizedSubject) throw new Error("弱项主题缺科目");
  if (!title) throw new Error("弱项主题缺标题");
  return {
    topic_key: topicKey(normalizedSubject, title),
    subject: normalizedSubject,
    chapter: topic.chapter ?? null,
    section: topic.section ?? null,
    kp_id: topic.kpId ?? null,
    title,
    classification_status: topic.classificationStatus ?? "pending",
    updated_at: nowIso,
  };
}

export function nextMasteryStatus(reviews) {
  const ordered = [...reviews].sort((a, b) => {
    const date = String(b.review_date ?? "").localeCompare(String(a.review_date ?? ""));
    return date || Number(b.id ?? 0) - Number(a.id ?? 0);
  });
  if (!ordered.length) return "open";
  if (ordered[0].result !== "pass") return "open";
  const lastFailureIndex = ordered.findIndex((r) => r.result !== "pass");
  const cleanRun = lastFailureIndex === -1 ? ordered : ordered.slice(0, lastFailureIndex);
  const distinctPassDates = new Set(cleanRun.filter((r) => r.result === "pass").map((r) => r.review_date));
  return distinctPassDates.size >= 2 ? "stable" : "monitoring";
}
