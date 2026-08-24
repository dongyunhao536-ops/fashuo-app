import { createHash } from "node:crypto";
import { FAILURE_PATTERNS } from "./knowledge-state.mjs";
import { EVIDENCE_VARIANTS, normalizeTransferMetadata } from "./evidence-transfer.mjs";

export { FAILURE_PATTERNS };

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
export const REVIEW_RESULTS = ["pass", "partial", "fail", "void"];

// [gpt] 2026-08-10：迁移等级改由统一证据枚举提供，避免错题轴与知识轴发生漂移。
export const REVIEW_VARIANTS = EVIDENCE_VARIANTS;

// [gpt] 2026-08-10：验证轴记录“本次主动改变了什么”，与自由文本 angle 分离，避免靠改写措辞伪造多角度证明。
export const REVIEW_PROBE_AXES = Object.freeze({
  rule_boundary: Object.freeze({ label: "规则边界" }),
  subject_condition: Object.freeze({ label: "主体条件" }),
  object_condition: Object.freeze({ label: "对象条件" }),
  time_condition: Object.freeze({ label: "时间条件" }),
  procedure_order: Object.freeze({ label: "程序/判断顺序" }),
  degree_term: Object.freeze({ label: "程度词/效力词" }),
  element_structure: Object.freeze({ label: "要件结构" }),
  concept_boundary: Object.freeze({ label: "相邻概念边界" }),
  question_layer: Object.freeze({ label: "设问层级" }),
  fact_signal: Object.freeze({ label: "事实信号" }),
  integrated: Object.freeze({ label: "多轴综合" }),
  invalid: Object.freeze({ label: "作废题" }),
});

const FAILURE_PATTERN_PROBE_AXES = Object.freeze({
  knowledge_gap: ["element_structure", "rule_boundary"],
  exception_omission: ["rule_boundary", "fact_signal"],
  scope_expansion: ["rule_boundary", "fact_signal"],
  scope_contraction: ["rule_boundary", "fact_signal"],
  subject_confusion: ["subject_condition", "concept_boundary"],
  object_confusion: ["object_condition", "concept_boundary"],
  time_condition: ["time_condition", "procedure_order"],
  procedure_order: ["procedure_order", "time_condition"],
  degree_strength: ["degree_term", "rule_boundary"],
  element_omission: ["element_structure", "fact_signal"],
  adjacent_confusion: ["concept_boundary", "rule_boundary"],
  question_layer: ["question_layer", "fact_signal"],
  fact_misread: ["fact_signal", "question_layer"],
  terminology_drift: ["degree_term", "concept_boundary"],
  recall_application_gap: ["fact_signal", "integrated"],
  expression_gap: ["element_structure", "integrated"],
  memory_decay: ["rule_boundary", "integrated"],
  other: ["fact_signal", "integrated"],
});

const PROBE_AXIS_FALLBACKS = Object.freeze([
  "rule_boundary", "subject_condition", "object_condition", "time_condition",
  "procedure_order", "degree_term", "element_structure", "concept_boundary",
  "question_layer", "fact_signal", "integrated",
]);

export const REVIEW_DIMENSIONS = ["recall", "application"];
export const PROMPT_INTEGRITIES = ["clean", "cued", "invalid"];
export const STABLE_REVIEW_SPAN_DAYS = 7;

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

export function validateReviewVariant(variant) {
  const value = String(variant ?? "").trim();
  if (!(value in REVIEW_VARIANTS)) {
    throw new Error(`未知复检变式「${value || "空"}」；可用：${Object.keys(REVIEW_VARIANTS).join(", ")}`);
  }
  return value;
}

export function validateReviewDimension(dimension) {
  const value = String(dimension ?? "").trim();
  if (!REVIEW_DIMENSIONS.includes(value)) {
    throw new Error(`未知复检维度「${value || "空"}」；可用：${REVIEW_DIMENSIONS.join(", ")}`);
  }
  return value;
}

export function validatePromptIntegrity(integrity) {
  const value = String(integrity ?? "").trim();
  if (!PROMPT_INTEGRITIES.includes(value)) {
    throw new Error(`未知题干完整性「${value || "空"}」；可用：${PROMPT_INTEGRITIES.join(", ")}`);
  }
  return value;
}

export function validateReviewProbeAxis(axis) {
  const value = String(axis ?? "").trim();
  if (!(value in REVIEW_PROBE_AXES)) {
    throw new Error(`未知验证轴「${value || "空"}」；可用：${Object.keys(REVIEW_PROBE_AXES).join(", ")}`);
  }
  return value;
}

function present(value) {
  return String(value ?? "").trim();
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function validReviewDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export function validateReviewDate(value) {
  const text = String(value ?? "");
  if (!validReviewDate(text)) throw new Error("复检日期必须是有效的 YYYY-MM-DD 北京日");
  return text;
}

function daysBetweenDates(from, to) {
  if (!validReviewDate(from) || !validReviewDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function shiftReviewDate(date, days) {
  if (!validReviewDate(date)) return null;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

function latestReviewDate(...values) {
  return values.filter(validReviewDate).sort().at(-1) ?? null;
}

/**
 * 校验并补齐一条新复检证据。旧行兼容只发生在读取侧；新写入必须完整、可审计。
 */
export function buildReviewEvidence(input) {
  const result = validateReviewResult(input?.result);
  const variantKind = validateReviewVariant(rowValue(input, "variantKind", "variant_kind"));
  const variant = REVIEW_VARIANTS[variantKind];
  const dimension = validateReviewDimension(input?.dimension ?? variant.dimension);
  const promptIntegrity = validatePromptIntegrity(rowValue(input, "promptIntegrity", "prompt_integrity") ?? "clean");
  if (typeof input?.cold !== "boolean") throw new Error("复检 cold 必须是布尔值");
  const cold = input.cold;
  const angle = present(input?.angle) || null;
  const evidenceAnchor = present(rowValue(input, "evidenceAnchor", "evidence_anchor")) || null;
  const probeAxisRaw = rowValue(input, "probeAxis", "probe_axis");
  const probeAxis = variantKind === "invalid" && !present(probeAxisRaw)
    ? "invalid"
    : validateReviewProbeAxis(probeAxisRaw);
  const transfer = normalizeTransferMetadata({
    dimension,
    result,
    promptIntegrity,
    cold,
    variantKind,
    transferLevel: variant.transferLevel,
    assessmentContext: rowValue(input, "assessmentContext", "assessment_context") ?? "practice",
    durationSeconds: rowValue(input, "durationSeconds", "duration_seconds") ?? null,
  });

  if (variantKind === "invalid" || result === "void" || promptIntegrity === "invalid") {
    if (!(variantKind === "invalid" && result === "void" && promptIntegrity === "invalid")) {
      throw new Error("作废复检必须同时使用 result=void、--variant invalid 与 --invalid-prompt");
    }
    if (cold) throw new Error("作废题不能记作冷检");
    if (probeAxis !== "invalid") throw new Error("作废题的验证轴必须是 invalid");
  } else {
    if (dimension !== variant.dimension) {
      throw new Error(`变式 ${variantKind} 固定属于 ${variant.dimension} 维度，不能记为 ${dimension}`);
    }
    if (cold && promptIntegrity !== "clean") throw new Error("冷复检必须使用 clean 题干；提示后通过只能记非冷检");
    if (probeAxis === "invalid") throw new Error("非作废复检不能使用 invalid 验证轴");
    if (!angle) throw new Error("非作废复检必须提供 --angle，说明本次验证角度");
    if (!evidenceAnchor) throw new Error("非作废复检必须提供 --anchor，留下可核验依据");
  }

  return {
    result,
    dimension,
    cold,
    promptIntegrity,
    variantKind,
    transferLevel: variant.transferLevel,
    assessmentContext: transfer.assessmentContext,
    durationSeconds: transfer.durationSeconds,
    probeAxis,
    angle,
    evidenceAnchor,
  };
}

/**
 * 把数据库 snake_case、outbox camelCase 与旧版缺字段行归一成同一只读证据形态。
 */
export function normalizeReviewEvidence(row, sequence = 0) {
  const result = String(row?.result ?? "");
  const date = String(rowValue(row, "date", "review_date") ?? "");
  const variantKindRaw = rowValue(row, "variantKind", "variant_kind");
  const variantKind = variantKindRaw != null && String(variantKindRaw) in REVIEW_VARIANTS
    ? String(variantKindRaw)
    : null;
  const variant = variantKind ? REVIEW_VARIANTS[variantKind] : null;
  const dimensionRaw = row?.dimension;
  const dimension = REVIEW_DIMENSIONS.includes(String(dimensionRaw ?? "")) ? String(dimensionRaw) : null;
  const promptRaw = rowValue(row, "promptIntegrity", "prompt_integrity");
  const promptIntegrity = PROMPT_INTEGRITIES.includes(String(promptRaw ?? "")) ? String(promptRaw) : null;
  const coldRaw = row?.cold;
  const cold = typeof coldRaw === "boolean" ? coldRaw : null;
  const storedLevelRaw = rowValue(row, "transferLevel", "transfer_level");
  const storedLevel = Number(storedLevelRaw);
  const transferLevel = storedLevelRaw != null && Number.isInteger(storedLevel) ? storedLevel : null;
  const probeAxisRaw = rowValue(row, "probeAxis", "probe_axis");
  const probeAxis = probeAxisRaw != null && String(probeAxisRaw) in REVIEW_PROBE_AXES
    ? String(probeAxisRaw)
    : null;
  const angle = present(row?.angle) || null;
  const evidenceAnchor = present(rowValue(row, "evidenceAnchor", "evidence_anchor")) || null;
  const assessmentContext = String(rowValue(row, "assessmentContext", "assessment_context") ?? "practice");
  const durationSecondsRaw = rowValue(row, "durationSeconds", "duration_seconds");
  const durationSeconds = durationSecondsRaw == null ? null : Number(durationSecondsRaw);
  // [gpt] 2026-08-10：事件销账证明还要审计原错题指向与用户原答/依据。
  const note = present(row?.note) || null;
  const structured = Boolean(
    variant
    && dimension
    && promptIntegrity
    && cold != null
    && transferLevel === variant.transferLevel
    && probeAxis
    && (variantKind === "invalid"
      ? probeAxis === "invalid"
      : dimension === variant.dimension && probeAxis !== "invalid"),
  );
  const legacyMetadata = [variantKindRaw, dimensionRaw, promptRaw, coldRaw, storedLevelRaw, probeAxisRaw]
    .every((value) => value == null);
  const substantive = ["pass", "partial", "fail"].includes(result);
  const qualifyingTransferPass = Boolean(
    structured
    && result === "pass"
    && cold === true
    && promptIntegrity === "clean"
    && dimension === "application"
    && transferLevel >= 3
    && angle
    && evidenceAnchor,
  );

  return {
    id: Number(row?.id ?? 0),
    topicId: Number(rowValue(row, "topicId", "topic_id") ?? 0) || null,
    studyErrorId: Number(rowValue(row, "studyErrorId", "study_error_id") ?? 0) || null,
    date,
    result,
    dimension,
    cold,
    promptIntegrity,
    variantKind,
    transferLevel,
    assessmentContext,
    durationSeconds,
    probeAxis,
    angle,
    evidenceAnchor,
    note,
    structured,
    substantive,
    qualifyingTransferPass,
    legacyPass: result === "pass" && legacyMetadata,
    sequence,
  };
}

/**
 * [gpt] 2026-08-10：稳定是证据的可重算结论，不是“两次 pass”的可手改标签。
 */
export function summarizeReviewProof(reviews) {
  const ordered = reviews
    .map((row, sequence) => normalizeReviewEvidence(row, sequence))
    .filter((row) => validReviewDate(row.date))
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id || left.sequence - right.sequence);
  const substantive = ordered.filter((row) => row.substantive);
  let lastFailureIndex = -1;
  substantive.forEach((row, index) => {
    if (row.result === "partial" || row.result === "fail") lastFailureIndex = index;
  });
  const cleanRun = substantive.slice(lastFailureIndex + 1);
  const qualifyingPasses = cleanRun.filter((row) => row.qualifyingTransferPass);
  const legacyPasses = cleanRun.filter((row) => row.legacyPass);
  const supportingPasses = cleanRun.filter((row) => row.qualifyingTransferPass || row.legacyPass);
  const passDates = [...new Set(qualifyingPasses.map((row) => row.date))].sort();
  const angles = [...new Set(qualifyingPasses
    .map((row) => row.angle?.normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter(Boolean))];
  const probeAxes = [...new Set(qualifyingPasses.map((row) => row.probeAxis).filter(Boolean))];
  const spanDays = passDates.length >= 2 ? daysBetweenDates(passDates[0], passDates.at(-1)) : 0;
  const hasNovelTransfer = qualifyingPasses.some((row) => row.transferLevel >= 4);
  const stable = passDates.length >= 2
    && spanDays >= STABLE_REVIEW_SPAN_DAYS
    && probeAxes.length >= 2
    && hasNovelTransfer;
  const status = stable
    ? "stable"
    : qualifyingPasses.length || legacyPasses.length
      ? "monitoring"
      : "open";
  const blockers = [];
  if (!qualifyingPasses.length) blockers.push(
    legacyPasses.length
      ? "历史 pass 缺少结构化迁移元数据，只保留 monitoring 兼容，不可证明 stable"
      : "需要一次无提示、跨会话的应用迁移通过（L3+）",
  );
  if (qualifyingPasses.length && passDates.length < 2) blockers.push("需要第二个北京日的合格迁移通过");
  if (passDates.length >= 2 && spanDays < STABLE_REVIEW_SPAN_DAYS) blockers.push(`两次合格通过需跨度至少 ${STABLE_REVIEW_SPAN_DAYS} 天（当前 ${spanDays} 天）`);
  if (qualifyingPasses.length >= 2 && probeAxes.length < 2) blockers.push("需要至少两个不同的结构化验证轴");
  if (qualifyingPasses.length && !hasNovelTransfer) blockers.push("至少需要一次陌生新案例或综合案例迁移（L4+）");

  return {
    status,
    stable,
    blockers,
    total: ordered.length,
    voidCount: ordered.filter((row) => row.result === "void").length,
    substantiveCount: substantive.length,
    qualifyingPassCount: qualifyingPasses.length,
    legacyPassCount: legacyPasses.length,
    passDates,
    angles,
    probeAxes,
    spanDays,
    hasNovelTransfer,
    latestEvidence: substantive.at(-1) ?? null,
    latestSupportingPass: supportingPasses.at(-1) ?? null,
    lastFailure: lastFailureIndex >= 0 ? substantive[lastFailureIndex] : null,
    qualifyingPasses,
  };
}

function pickProbeAxis(preferredAxes, usedAxes) {
  const candidates = [...new Set([...preferredAxes, ...PROBE_AXIS_FALLBACKS])];
  return candidates.find((axis) => axis !== "invalid" && !usedAxes.has(axis)) ?? "integrated";
}

function probeGuardrails(variantKind, probeAxis) {
  const axisLabel = REVIEW_PROBE_AXES[probeAxis].label;
  const common = ["必须无提示、跨会话作答", "题面不得出现规则名、结论或答案线索"];
  if (variantKind === "counterfactual") {
    return [`只主动改变「${axisLabel}」这一主变量，其他核心条件尽量保持`, "不得复用原题答案位置或选项顺序", ...common];
  }
  if (variantKind === "novel_case") {
    return [`使用未见过的案情，重点覆盖「${axisLabel}」`, "更换人物、数字与叙事顺序，避免原题记忆命中", ...common];
  }
  return ["使用未见过的综合案情，至少联动两个判断关卡", ...common];
}

/**
 * [gpt] 2026-08-10：根据已发生的证据缺口开“下一探针处方”。
 * 它只规定变式、验证轴、等级与冷却日期，不生成题目，也不输出掌握概率。
 */
export function recommendNextReviewProbe(reviews, { referenceDate, failurePatternCode = null } = {}) {
  const date = validateReviewDate(referenceDate);
  const sourceFailurePattern = validateFailurePattern(failurePatternCode);
  const visibleReviews = reviews
    .map((row, sequence) => normalizeReviewEvidence(row, sequence))
    .filter((row) => validReviewDate(row.date) && row.date <= date);
  const proof = summarizeReviewProof(visibleReviews);
  const usedAxes = new Set(proof.qualifyingPasses.map((row) => row.probeAxis).filter(Boolean));
  const preferredAxes = FAILURE_PATTERN_PROBE_AXES[sourceFailurePattern] ?? ["fact_signal", "rule_boundary"];
  const axis = pickProbeAxis(preferredAxes, usedAxes);
  const earliest = (...dates) => latestReviewDate(date, ...dates);
  const make = (variantKind, probeAxis, earliestDate, reasonCode, reason) => ({
    variantKind,
    variantLabel: REVIEW_VARIANTS[variantKind].label,
    transferLevel: REVIEW_VARIANTS[variantKind].transferLevel,
    dimension: REVIEW_VARIANTS[variantKind].dimension,
    probeAxis,
    probeAxisLabel: REVIEW_PROBE_AXES[probeAxis].label,
    earliestDate,
    reasonCode,
    reason,
    sourceFailurePattern,
    coldRequired: true,
    promptIntegrity: "clean",
    prerequisite: sourceFailurePattern === "knowledge_gap"
      ? "命题前先确认规则骨架与必要要件已补齐；尚未补齐时先答疑，不用猜题代替教学"
      : null,
    guardrails: probeGuardrails(variantKind, probeAxis),
  });

  if (proof.stable) {
    return make(
      "integrated_case",
      "integrated",
      earliest(shiftReviewDate(proof.latestSupportingPass?.date, 14)),
      "maintenance_after_stable",
      "稳定门槛已满足；降频到综合新情境，检验长期保持而非继续刷相似题",
    );
  }

  const unresolvedFailure = Boolean(proof.lastFailure && !proof.latestSupportingPass);
  if (unresolvedFailure) {
    return make(
      "counterfactual",
      axis,
      earliest(shiftReviewDate(proof.lastFailure.date, 2)),
      "repair_after_failure",
      "最近一次有效复检仍未通过；先用单变量反事实隔离病根，再追求更高迁移",
    );
  }

  if (!proof.qualifyingPassCount) {
    const coolingFrom = proof.latestSupportingPass?.date ?? proof.latestEvidence?.date;
    return make(
      "counterfactual",
      axis,
      earliest(shiftReviewDate(coolingFrom, 2)),
      proof.legacyPassCount ? "replace_legacy_evidence" : "establish_transfer_baseline",
      proof.legacyPassCount
        ? "现有通过缺少结构化迁移元数据；先补一条可审计的 L3 冷检基线"
        : "当前没有合格应用迁移证据；先用单变量反事实建立 L3 冷检基线",
    );
  }

  if (!proof.hasNovelTransfer) {
    return make(
      "novel_case",
      axis,
      earliest(shiftReviewDate(proof.passDates[0], STABLE_REVIEW_SPAN_DAYS)),
      "raise_to_novel_transfer",
      "已有 L3 应用证据，但尚未证明能处理陌生案情；下一次直接检验 L4",
    );
  }

  if (proof.passDates.length < 2 || proof.spanDays < STABLE_REVIEW_SPAN_DAYS) {
    return make(
      "counterfactual",
      axis,
      earliest(shiftReviewDate(proof.passDates[0], STABLE_REVIEW_SPAN_DAYS)),
      "complete_cold_span",
      `已有高迁移证据，但仍缺第二个北京日或 ${STABLE_REVIEW_SPAN_DAYS} 天跨度`,
    );
  }

  return make(
    "counterfactual",
    axis,
    earliest(shiftReviewDate(proof.latestSupportingPass?.date, 2)),
    "diversify_probe_axis",
    "跨时与迁移等级已达标，但结构化验证轴不足；下一次只补未覆盖的轴",
  );
}

export function validateFailurePattern(code, { allowNull = true } = {}) {
  if (code == null || String(code).trim() === "") {
    if (allowNull) return null;
    throw new Error("缺少细粒度栽点代码");
  }
  const value = String(code).trim();
  if (!(value in FAILURE_PATTERNS)) {
    throw new Error(`未知栽点代码「${value}」；可用：${Object.keys(FAILURE_PATTERNS).join(", ")}`);
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

export function parseTopicOptions(input, { requireTopic = false, allowStandaloneChapter = false } = {}) {
  const args = [...input];
  const title = cleanTopicTitle(takeOption(args, "--topic"));
  const chapter = takeOption(args, "--chapter");
  const section = takeOption(args, "--section");
  const kpId = takeOption(args, "--kp");
  const rootCauseCode = validateRootCause(takeOption(args, "--cause") ?? "unclassified");
  const failurePatternCode = validateFailurePattern(takeOption(args, "--pattern"));
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
  if (!title && [section, kpId, rootCauseNote, failurePatternCode, evidenceAnchor].some(Boolean)) {
    throw new Error("填写章节、病根或锚点前必须先给 --topic");
  }
  if (!title && chapter && !allowStandaloneChapter) {
    throw new Error("填写章节、病根或锚点前必须先给 --topic");
  }
  return {
    rest: args,
    chapter,
    topic: title ? {
      title,
      chapter,
      section,
      kpId,
      classificationStatus,
      rootCauseCode,
      failurePatternCode,
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
  const { rest, topic, chapter } = parseTopicOptions(args, { allowStandaloneChapter: true });
  const subject = normalizeSubject(rest.shift());
  const knowledge = rest.join(" ").trim();
  if (!subject || !SUBJECTS.includes(subject)) throw new Error(`add 需要合法科目：${SUBJECTS.join("/")}`);
  if (!knowledge) throw new Error("add 需要错题事件原文或知识点说明");
  return { subject, knowledge, recurOf, chapter: topic?.chapter ?? chapter ?? null, topic };
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
  return summarizeReviewProof(reviews).status;
}
