// [gpt] 2026-08-13：错题判题输出的单一机器 Gate；确定性字段、证据卡与病根状态由代码约束。

import { DIAGNOSIS_STATUSES, REVIEW_RESULTS } from "./error-taxonomy.mjs";
import { findBareStructuredReferences } from "./structured-reference-lint.mjs";

const MAX_TEXT = 4000;
const DEFINITIVE_PENDING_PATTERNS = [
  /(?:你的|本题的|这次的)?(?:病根|根因|错误原因|栽点)(?:就)?是/u,
  /(?:这|它)(?:就)?说明你/u,
  /暴露(?:出|了)/u,
  /(?:足以|已经|这就)?(?:证明|确认)(?:了)?(?:你|本题|病根|根因)/u,
  /可以确定(?:你|本题)/u,
  /已经证明(?:你|本题)/u,
];

function text(value) {
  return String(value ?? "").trim();
}

function issue(code, field, message) {
  return Object.freeze({ code, field, message });
}

function requiredText(value, field, issues, label, { max = MAX_TEXT } = {}) {
  const normalized = text(value);
  if (!normalized) issues.push(issue(`${field}_missing`, field, `缺少${label}`));
  else if (normalized.length > max) issues.push(issue(`${field}_too_long`, field, `${label}不能超过 ${max} 字`));
  return normalized;
}

function normalizeEvidence(value, index, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("evidence_type", `evidence[${index}]`, "证据必须是对象"));
    return null;
  }
  const source = requiredText(value.source, `evidence[${index}].source`, issues, "证据来源", { max: 240 });
  const anchor = requiredText(value.anchor, `evidence[${index}].anchor`, issues, "证据锚点", { max: 500 });
  const excerpt = requiredText(value.excerpt, `evidence[${index}].excerpt`, issues, "必要原文或内容摘要", { max: 1200 });
  const material = `${source} ${anchor}`;
  const hasPage = /(?:第?\s*\d+\s*(?:—|-|至)?\s*\d*\s*页|页码未知)/u.test(material);
  const hasLine = /(?:第?\s*\d+\s*(?:—|-|至)?\s*\d*\s*行|行\s*\d+(?:\s*(?:—|-|至)\s*\d+)?|(?:^|[^A-Za-z])(?:line|lines?)[：:#\s-]*\d+)/iu.test(material);
  const isArticle = /(?:《[^》]+》)?第\s*\d+\s*条/u.test(material);
  const isExam = /(?:19|20)\d{2}年?.{0,24}(?:真题|法硕|法律硕士).{0,16}第?\s*\d+\s*题/u.test(material);
  if (!isArticle && !isExam && (!hasPage || !hasLine)) {
    issues.push(issue("evidence_anchor_incomplete", `evidence[${index}].anchor`, "证据锚点不完整：教材、讲义或考试分析必须同时给页码（未知须明示）和行号；法条须给条号，真题须给年份与题号"));
  }
  return { source, anchor, excerpt };
}

function normalizeDiagnosis(value, result, issues) {
  const diagnosis = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const status = text(diagnosis.status) || "pending";
  if (!DIAGNOSIS_STATUSES.includes(status)) {
    issues.push(issue("diagnosis_status_invalid", "diagnosis.status", `病根状态必须是：${DIAGNOSIS_STATUSES.join("/")}`));
  }
  const claim = text(diagnosis.claim) || null;
  const candidates = Array.isArray(diagnosis.candidates)
    ? diagnosis.candidates.map(text).filter(Boolean)
    : [];
  const rejectedCandidates = Array.isArray(diagnosis.rejectedCandidates)
    ? diagnosis.rejectedCandidates.map(text).filter(Boolean)
    : [];
  const recognitionRef = text(diagnosis.recognitionRef) || null;

  if (new Set(candidates).size !== candidates.length) {
    issues.push(issue("diagnosis_candidates_duplicate", "diagnosis.candidates", "病根候选必须互斥且不得重复"));
  }
  if (new Set(rejectedCandidates).size !== rejectedCandidates.length) {
    issues.push(issue("diagnosis_rejected_candidates_duplicate", "diagnosis.rejectedCandidates", "被排除候选不得重复"));
  }
  if (rejectedCandidates.some((candidate) => !candidates.includes(candidate))) {
    issues.push(issue("diagnosis_rejected_candidate_unknown", "diagnosis.rejectedCandidates", "被排除项必须逐字来自本 Run 原始 candidates，不得事后改写"));
  }
  if (candidates.some((item) => item.length > 240)) {
    issues.push(issue("diagnosis_candidate_too_long", "diagnosis.candidates", "单个病根候选不能超过 240 字"));
  }

  if (status === "pending") {
    if (claim) issues.push(issue("pending_diagnosis_claim", "diagnosis.claim", "pending 病根禁止写确定性 claim"));
    if (["partial", "fail"].includes(result) && (candidates.length < 2 || candidates.length > 4)) {
      issues.push(issue("pending_candidates_count", "diagnosis.candidates", "答错或部分通过且病根未认领时，必须给 2–4 个互斥候选"));
    }
    const unsafe = [claim, ...candidates].filter(Boolean).find((item) => DEFINITIVE_PENDING_PATTERNS.some((pattern) => pattern.test(item)));
    if (unsafe) issues.push(issue("pending_definitive_language", "diagnosis", "pending 病根含确定性表述；改为候选或待认领措辞"));
    if (recognitionRef) issues.push(issue("pending_recognition_ref", "diagnosis.recognitionRef", "pending 状态不能同时声称已有用户认领引用"));
    if (rejectedCandidates.length) issues.push(issue("pending_rejected_candidates_forbidden", "diagnosis.rejectedCandidates", "用户决定前不能预填排除项"));
  }
  if (status === "confirmed") {
    if (!claim) issues.push(issue("confirmed_claim_missing", "diagnosis.claim", "confirmed 病根必须给出已认领结论"));
    if (!recognitionRef) issues.push(issue("confirmed_recognition_missing", "diagnosis.recognitionRef", "confirmed 病根必须带用户认领或可核验证据引用"));
    if (candidates.length < 2 || candidates.length > 4) issues.push(issue("confirmed_candidates_missing", "diagnosis.candidates", "confirmed 终态必须原样保留本 Run 的 2–4 条候选"));
    if (claim && !candidates.includes(claim)) issues.push(issue("confirmed_claim_not_candidate", "diagnosis.claim", "认领结论必须逐字来自本 Run 原始 candidates"));
    if (candidates.length && (rejectedCandidates.length !== candidates.length - 1 || rejectedCandidates.includes(claim))) {
      issues.push(issue("confirmed_exclusions_incomplete", "diagnosis.rejectedCandidates", "confirmed 终态必须列出除认领项外的全部排除候选"));
    }
  }
  if (status === "rejected") {
    if (!recognitionRef) issues.push(issue("rejected_recognition_missing", "diagnosis.recognitionRef", "rejected 病根必须带排除依据或用户反馈引用"));
    if (candidates.length < 2 || candidates.length > 4) issues.push(issue("rejected_candidates_missing", "diagnosis.candidates", "rejected 终态必须原样保留本 Run 的 2–4 条候选"));
    if (claim) issues.push(issue("rejected_claim_forbidden", "diagnosis.claim", "全部候选被排除时不得另造一个病根结论"));
    if (candidates.length && rejectedCandidates.length !== candidates.length) {
      issues.push(issue("rejected_exclusions_incomplete", "diagnosis.rejectedCandidates", "rejected 终态必须逐项列全本 Run 被排除的候选"));
    }
  }
  if (status === "untraceable") {
    if (claim) issues.push(issue("untraceable_claim_forbidden", "diagnosis.claim", "不可追溯病根禁止补写确定性结论"));
    if (candidates.length < 2 || candidates.length > 4) issues.push(issue("untraceable_candidates_missing", "diagnosis.candidates", "不可追溯终态仍须在临时 artifact 原样保留本 Run 候选；它们不进入数据库"));
    if (rejectedCandidates.length) issues.push(issue("untraceable_rejections_forbidden", "diagnosis.rejectedCandidates", "用户说忘了/不认领不等于逐项排除，不能伪造 rejectedCandidates"));
    if (!recognitionRef) issues.push(issue("untraceable_ref_missing", "diagnosis.recognitionRef", "不可追溯终态必须带用户明确说忘了/不认领的引用；Run 收口或中止不能代替"));
    else if (!/^user:/iu.test(recognitionRef)) issues.push(issue("untraceable_user_ref_invalid", "diagnosis.recognitionRef", "不可追溯引用必须以 user: 开头并指向用户原话；run_close/Stop/abort 不是学习事实依据"));
  }
  return { status, claim, candidates, rejectedCandidates, recognitionRef };
}

export function primaryJudgmentTargetRef(value) {
  return text(value).match(/(?:^|\/)T#(\d+)(?:\/|$)/u)?.[0]?.replace(/^\//u, "").replace(/\/$/u, "") ?? null;
}

export class JudgmentResultValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [];
    super(`判题结果校验失败：${list.map((item) => `[${item.code}] ${item.message}`).join("；")}`);
    this.name = "JudgmentResultValidationError";
    this.code = "JUDGMENT_RESULT_INVALID";
    this.issues = list;
  }
}

/** 校验并规范化一份可展示的错题判题结果。 */
export function validateJudgmentResult(input) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JudgmentResultValidationError([issue("result_type", "$", "判题结果必须是对象")]);
  }
  const result = text(input.result);
  if (!REVIEW_RESULTS.includes(result)) {
    issues.push(issue("result_invalid", "result", `判题结果必须是：${REVIEW_RESULTS.join("/")}`));
  }
  const targetRef = requiredText(input.targetRef, "targetRef", issues, "稳定题目或事件引用", { max: 160 });
  const originalAnswer = requiredText(input.originalAnswer, "originalAnswer", issues, "用户原答");
  const verdict = requiredText(input.verdict, "verdict", issues, "判定结论", { max: 1000 });
  const rule = requiredText(input.rule, "rule", issues, "判题规则");
  const application = requiredText(input.application, "application", issues, "涵摄过程");
  const confidence = text(input.confidence);
  if (!['high', 'medium', 'low'].includes(confidence)) {
    issues.push(issue("confidence_invalid", "confidence", "信心度必须是 high/medium/low"));
  }
  const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (!rawEvidence.length) issues.push(issue("evidence_missing", "evidence", "至少需要一条可核对证据"));
  const evidence = rawEvidence.map((item, index) => normalizeEvidence(item, index, issues)).filter(Boolean);
  const diagnosis = normalizeDiagnosis(input.diagnosis, result, issues);
  if (!/^T#\d+(?:\/E#\d+)?$/u.test(targetRef)) {
    issues.push(issue("target_ref_invalid", "targetRef", "错题复检判题引用只接受 T#主题或 T#主题/E#事件，禁止模糊文本"));
  }
  if (diagnosis.status === "pending") {
    const unsafeNarrative = [verdict, application].find((item) => DEFINITIVE_PENDING_PATTERNS.some((pattern) => pattern.test(item)));
    if (unsafeNarrative) issues.push(issue("pending_definitive_narrative", "verdict/application", "病根仍为 pending 时，判定与涵摄也禁止写确定性病根表述"));
  }
  // [gpt] 2026-08-25：F6 只检查最终会进入证据卡的结构化字段；targetRef 等机器键不在此列。
  const visibleFields = [
    ["originalAnswer", originalAnswer],
    ["verdict", verdict],
    ["rule", rule],
    ["application", application],
    ...evidence.flatMap((item, index) => [
      [`evidence[${index}].source`, item.source],
      [`evidence[${index}].anchor`, item.anchor],
      [`evidence[${index}].excerpt`, item.excerpt],
    ]),
    ...diagnosis.candidates.map((candidate, index) => [`diagnosis.candidates[${index}]`, candidate]),
    ...diagnosis.rejectedCandidates.map((candidate, index) => [`diagnosis.rejectedCandidates[${index}]`, candidate]),
  ];
  for (const [field, value] of visibleFields) {
    const references = findBareStructuredReferences(value);
    if (references.length) {
      issues.push(issue("bare_reference_summary_required", field, `${references.map((item) => item.reference).join("、")} 是孤立裸编号；编号后 10 字内须带内容摘要，并列编号串豁免`));
    }
  }
  if (issues.length) throw new JudgmentResultValidationError(issues);
  return { schemaVersion: 1, targetRef, result, originalAnswer, verdict, rule, application, evidence, confidence, diagnosis };
}

/** 从已校验结构确定性渲染用户可见证据卡，避免模型另写一份不受检的答案。 */
export function renderJudgmentCard(value) {
  const item = validateJudgmentResult(value);
  const lines = [
    `【判题】${item.result}｜${item.verdict}`,
    `【原答】${item.originalAnswer}`,
    `【规则】${item.rule}`,
    `【涵摄】${item.application}`,
    "【证据卡】",
    ...item.evidence.map((evidence, index) => `${index + 1}. ${evidence.source}｜${evidence.anchor}｜${evidence.excerpt}`),
    `【信心度】${item.confidence}`,
  ];
  if (item.diagnosis.status === "confirmed") {
    lines.push(`【病根·已认领】${item.diagnosis.claim}｜认领依据：${item.diagnosis.recognitionRef}`);
    lines.push(`【本轮已排除】${item.diagnosis.rejectedCandidates.join("；")}`);
  } else if (item.diagnosis.status === "rejected") {
    lines.push(`【病根·已排除】${item.diagnosis.rejectedCandidates.join("；")}｜依据：${item.diagnosis.recognitionRef}`);
  } else if (item.diagnosis.status === "untraceable") {
    lines.push(`【病根·不可追溯】当时思路不再可核；只正面复检知识点，不针对猜测误解出题、不与老账并案｜依据：${item.diagnosis.recognitionRef}`);
    lines.push(`【仅存本 Run artifact·未形成事实】${item.diagnosis.candidates.join("；")}`);
  } else if (item.diagnosis.candidates.length) {
    lines.push(`【病根·待认领】以下仅为候选：${item.diagnosis.candidates.map((candidate, index) => `${index + 1}) ${candidate}`).join("；")}`);
  } else {
    lines.push("【病根·待认领】本题通过，本轮不作确定性病根推断。");
  }
  return lines.join("\n");
}

export function judgmentResultContext(runId = null) {
  const runFlag = runId ? ` --run ${runId}` : "";
  return {
    command: `node scripts/judgment-result.mjs check --file <判题结果.json>${runFlag}`,
    passToken: "JUDGMENT_RESULT_PASS",
    rule: "先把原答、规则、涵摄、证据锚点和病根状态写入结构化结果，再由脚本渲染证据卡；不得绕过脚本另写判词",
  };
}
