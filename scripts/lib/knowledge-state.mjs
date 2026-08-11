// [gpt] 2026-08-10：知识点多维证据状态机、时间衰减与“栽点画像”。
// 所有状态均为可重算视图；本模块不接受、也不回写人工维护的 mastery 布尔值。

import { buildKnowledgeDecayProfile } from "./knowledge-decay.mjs";
import { ASSESSMENT_CONTEXTS, normalizeTransferMetadata } from "./evidence-transfer.mjs";

const DAY = 86400000;

export const KNOWLEDGE_STATE_VERSION = "3.0";
export const KNOWLEDGE_DIMENSIONS = Object.freeze(["exposure", "understanding", "recall", "application"]);
export const KNOWLEDGE_STAGES = Object.freeze(["unseen", "exposed", "understanding", "recall", "application", "stable"]);
export const KNOWLEDGE_STAGE_LABELS = Object.freeze({
  unseen: "未接触",
  exposed: "已接触（理解待证）",
  understanding: "理解",
  recall: "能复述",
  application: "能应用",
  stable: "稳定",
});

export const FAILURE_PATTERNS = Object.freeze({
  knowledge_gap: { label: "知识缺口", focus: "规则骨架与必要要件，不做整章泛背" },
  exception_omission: { label: "漏例外", focus: "例外、但书和排除项；答前先报例外清单" },
  scope_expansion: { label: "扩大范围", focus: "适用范围与限制条件；先划边界再下结论" },
  scope_contraction: { label: "缩小范围", focus: "被漏掉的适用情形；用正反例把外延撑完整" },
  subject_confusion: { label: "主体混淆", focus: "主体资格与身份条件；每题先圈出谁能实施" },
  object_confusion: { label: "对象/客体混淆", focus: "行为对象与保护法益，禁止只凭关键词定性" },
  time_condition: { label: "时间条件遗漏", focus: "时间点、期间和先后条件；先画时间轴" },
  procedure_order: { label: "顺序/前置关卡错位", focus: "判断顺序和前置门槛；按决策树逐关作答" },
  degree_strength: { label: "程度词/效力词漂移", focus: "应当/可以、从轻/减轻/免除等强度词对照" },
  element_omission: { label: "要件漏项", focus: "固定要件清单；每次只检缺的那一格" },
  adjacent_confusion: { label: "相邻概念混淆", focus: "一对一辨析的区分标准，不再分别背两段定义" },
  question_layer: { label: "审题层级错位", focus: "题目究竟问概念、构成还是效力；先复述问题层级" },
  fact_misread: { label: "事实读取错误", focus: "题干主体、行为、结果三栏摘录后再涵摄" },
  terminology_drift: { label: "术语漂移", focus: "教材专名与禁止替换词，做原词输出" },
  recall_application_gap: { label: "会背不会用", focus: "把同一规则换事实做涵摄，不再重复原文复述" },
  expression_gap: { label: "表达漏点", focus: "采分点顺序与完整句式，逐格补齐" },
  memory_decay: { label: "记忆回落", focus: "跨日冷启动提取，缩短复检间隔" },
  other: { label: "其他稳定栽点", focus: "先补证据并给出可复现的错误机制" },
});

const STAGE_INTERVALS = Object.freeze({ unseen: 0, exposed: 1, understanding: 2, recall: 4, application: 7, stable: 21 });

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  if (!validDate(from) || !validDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function shiftDate(date, days) {
  if (!validDate(date)) return null;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value));
}

function camelOrSnake(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

export function normalizeKnowledgeEvidence(row, sequence = 0) {
  const evidenceDate = String(camelOrSnake(row, "evidenceDate", "evidence_date") ?? "");
  const promptIntegrity = String(camelOrSnake(row, "promptIntegrity", "prompt_integrity") ?? "clean");
  const diagnosisStatus = String(camelOrSnake(row, "diagnosisStatus", "diagnosis_status") ?? "pending");
  const failurePatternCode = camelOrSnake(row, "failurePatternCode", "failure_pattern_code") ?? null;
  let transfer;
  let transferValid = true;
  try {
    transfer = normalizeTransferMetadata({
      dimension: String(row?.dimension ?? ""),
      result: String(row?.result ?? ""),
      promptIntegrity,
      cold: Boolean(row?.cold),
      variantKind: camelOrSnake(row, "variantKind", "variant_kind") ?? null,
      transferLevel: camelOrSnake(row, "transferLevel", "transfer_level") ?? null,
      assessmentContext: camelOrSnake(row, "assessmentContext", "assessment_context") ?? "practice",
      durationSeconds: camelOrSnake(row, "durationSeconds", "duration_seconds") ?? null,
    });
  } catch {
    transferValid = false;
    transfer = {
      variantKind: camelOrSnake(row, "variantKind", "variant_kind") ?? null,
      transferLevel: camelOrSnake(row, "transferLevel", "transfer_level") ?? null,
      assessmentContext: camelOrSnake(row, "assessmentContext", "assessment_context") ?? "practice",
      durationSeconds: camelOrSnake(row, "durationSeconds", "duration_seconds") ?? null,
    };
  }
  return {
    id: row?.id ?? null,
    operationId: camelOrSnake(row, "operationId", "operation_id") ?? null,
    kpId: String(camelOrSnake(row, "kpId", "kp_id") ?? ""),
    evidenceDate,
    dimension: String(row?.dimension ?? ""),
    result: String(row?.result ?? ""),
    sourceKind: String(camelOrSnake(row, "sourceKind", "source_kind") ?? "manual"),
    sourceId: camelOrSnake(row, "sourceId", "source_id") == null ? null : String(camelOrSnake(row, "sourceId", "source_id")),
    cold: Boolean(row?.cold),
    promptIntegrity,
    failurePatternCode,
    diagnosisStatus,
    ...transfer,
    evidenceAnchor: camelOrSnake(row, "evidenceAnchor", "evidence_anchor") ?? null,
    note: row?.note ?? null,
    sequence,
    valid: validDate(evidenceDate)
      && KNOWLEDGE_DIMENSIONS.includes(String(row?.dimension ?? ""))
      && ["pass", "partial", "fail", "void"].includes(String(row?.result ?? ""))
      && ["clean", "cued", "invalid"].includes(promptIntegrity)
      && ((String(row?.result ?? "") === "void") === (promptIntegrity === "invalid"))
      && (!Boolean(row?.cold) || promptIntegrity === "clean")
      && transferValid,
  };
}

// [gpt] 2026-08-10：周/日报只汇总观察到的证据，不把证据数量换算成掌握率。
export function summarizeKnowledgeEvidence(evidence = [], { start, end } = {}) {
  if (!validDate(start) || !validDate(end) || start > end) throw new Error("start/end 必须是合法且有序的 YYYY-MM-DD");
  const normalized = evidence
    .map((row, index) => normalizeKnowledgeEvidence(row, index))
    .filter((row) => validDate(row.evidenceDate) && row.evidenceDate >= start && row.evidenceDate <= end);
  const unique = new Map();
  for (const row of normalized) {
    const key = row.operationId
      ? `op:${row.kpId}:${row.operationId}`
      : `sig:${row.kpId}:${row.evidenceDate}:${row.dimension}:${row.result}:${row.sourceKind}:${row.sourceId ?? ""}:${row.promptIntegrity}:${row.cold}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  const observed = [...unique.values()];
  const valid = observed.filter((row) => row.valid);
  const isCleanPass = (row) => row.result === "pass" && row.promptIntegrity === "clean";
  const isSetback = (row) => ["partial", "fail"].includes(row.result) && row.promptIntegrity !== "invalid";
  const bucket = (rows) => ({
    observed: rows.length,
    valid: rows.filter((row) => row.valid).length,
    cleanPass: rows.filter((row) => row.valid && isCleanPass(row)).length,
    coldCleanPass: rows.filter((row) => row.valid && isCleanPass(row) && row.cold).length,
    setbacks: rows.filter((row) => row.valid && isSetback(row)).length,
    cuedPass: rows.filter((row) => row.valid && row.result === "pass" && row.promptIntegrity === "cued").length,
    voidOrInvalidPrompt: rows.filter((row) => row.valid && (row.result === "void" || row.promptIntegrity === "invalid")).length,
  });
  const byDimension = Object.fromEntries(KNOWLEDGE_DIMENSIONS.map((dimension) => [dimension, bucket(observed.filter((row) => row.dimension === dimension))]));
  const bySource = [...new Set(observed.map((row) => row.sourceKind))].sort().map((sourceKind) => ({
    sourceKind,
    ...bucket(observed.filter((row) => row.sourceKind === sourceKind)),
  }));
  const byTransferLevel = Object.fromEntries([0, 1, 2, 3, 4, 5].map((level) => [level, bucket(observed.filter((row) => row.transferLevel === level))]));
  const byAssessmentContext = Object.fromEntries(Object.keys(ASSESSMENT_CONTEXTS).map((context) => [context, bucket(observed.filter((row) => row.assessmentContext === context))]));
  return {
    start,
    end,
    counts: { ...bucket(observed), invalidSchema: observed.length - valid.length, duplicatesIgnored: normalized.length - observed.length },
    byDimension,
    bySource,
    byTransferLevel,
    byAssessmentContext,
    policy: "仅陈述结构化证据；通过、结案与证据数量均不自动等于稳定掌握。",
  };
}

function analyseExamReadiness(evidence, stability) {
  const rows = orderedEvidence(evidence.filter((row) => row.dimension !== "exposure" && qualifies(row)));
  let lastSetbackIndex = -1;
  rows.forEach((row, index) => {
    if (row.result !== "pass") lastSetbackIndex = index;
  });
  const highTransfer = rows.slice(lastSetbackIndex + 1).filter((row) => promotingPass(row)
    && row.cold
    && row.dimension === "application"
    && Number(row.transferLevel) >= 4);
  const dates = [...new Set(highTransfer.map((row) => row.evidenceDate))].sort();
  const timed = highTransfer.filter((row) => ["timed", "full_mock"].includes(row.assessmentContext));
  const fullMock = timed.filter((row) => row.assessmentContext === "full_mock");
  const achieved = stability.achieved && dates.length >= 2 && timed.length >= 1;
  return {
    achieved,
    highTransferPasses: highTransfer.length,
    highTransferDates: dates,
    timedPasses: timed.length,
    fullMockPasses: fullMock.length,
    confidence: achieved ? (fullMock.length ? "high" : "medium") : "insufficient",
    requirement: "当前稳定 + 最近失败后至少两个日期的 L4 陌生/综合应用冷通过 + 至少一次限时或成套模考证据",
  };
}

function orderedEvidence(rows) {
  return rows
    .filter((row) => row.valid)
    .sort((left, right) => left.evidenceDate.localeCompare(right.evidenceDate) || left.sequence - right.sequence);
}

function qualifies(row) {
  return row.valid && row.result !== "void" && row.promptIntegrity !== "invalid";
}

function promotingPass(row) {
  return qualifies(row) && row.result === "pass" && row.promptIntegrity === "clean";
}

function analyseDimension(evidence, dimension, supportingDimensions = [dimension]) {
  const rows = orderedEvidence(evidence.filter((row) => supportingDimensions.includes(row.dimension) && qualifies(row)));
  let lastSetbackIndex = -1;
  rows.forEach((row, index) => {
    if (row.result !== "pass") lastSetbackIndex = index;
  });
  const cleanPasses = rows.slice(lastSetbackIndex + 1).filter(promotingPass);
  const latest = rows.at(-1) ?? null;
  return {
    dimension,
    status: cleanPasses.length ? "demonstrated" : rows.length ? "learning" : "unseen",
    demonstrated: cleanPasses.length > 0,
    directPasses: cleanPasses.filter((row) => row.dimension === dimension).length,
    cleanPassDates: [...new Set(cleanPasses.map((row) => row.evidenceDate))],
    latestResult: latest?.result ?? null,
    latestDate: latest?.evidenceDate ?? null,
    latestCleanPassDate: cleanPasses.at(-1)?.evidenceDate ?? null,
    evidenceCount: rows.length,
  };
}

function analyseStability(evidence) {
  const rows = orderedEvidence(evidence.filter((row) => row.dimension !== "exposure" && qualifies(row)));
  let lastSetbackIndex = -1;
  rows.forEach((row, index) => {
    if (row.result !== "pass") lastSetbackIndex = index;
  });
  const coldPasses = rows.slice(lastSetbackIndex + 1).filter((row) => promotingPass(row) && row.cold && ["recall", "application"].includes(row.dimension));
  const dates = [...new Set(coldPasses.map((row) => row.evidenceDate))].sort();
  const dimensions = new Set(coldPasses.map((row) => row.dimension));
  const spanDays = dates.length >= 2 ? daysBetween(dates[0], dates.at(-1)) : 0;
  const achieved = dates.length >= 2 && spanDays >= 7 && dimensions.has("recall") && dimensions.has("application");
  return {
    achieved,
    coldPassDates: dates,
    spanDays,
    dimensions: [...dimensions].sort(),
    requirement: "最近一次失败后，复述与应用均有干净冷检通过，至少 2 个不同日期且跨度不少于 7 天",
  };
}

function stageFromDimensions(dimensions, stability, evidence) {
  if (stability.achieved) return "stable";
  if (dimensions.application.demonstrated) return "application";
  if (dimensions.recall.demonstrated) return "recall";
  if (dimensions.understanding.demonstrated) return "understanding";
  if (evidence.some(qualifies)) return "exposed";
  return "unseen";
}

function currentStageFromDecay(dimensions, stability, decay, evidence) {
  if (stability.achieved) return "stable";
  if (dimensions.application.demonstrated && decay.dimensions.application.isCurrent) return "application";
  if (dimensions.recall.demonstrated && decay.dimensions.recall.isCurrent) return "recall";
  if (dimensions.understanding.demonstrated && decay.dimensions.understanding.isCurrent) return "understanding";
  if (evidence.some(qualifies)) return "exposed";
  return "unseen";
}

function nextActionFor(stage) {
  return {
    unseen: "先建立理解证据：用自己的话讲清规则边界",
    exposed: "做一次不看材料的理解解释，讲出为什么与边界",
    understanding: "转入冷启动复述，闭卷说出骨架和限定条件",
    recall: "换事实做应用题，先列规则再完成涵摄",
    application: "跨日至少 7 天完成复述+应用双冷检，争取进入稳定",
    stable: "低频保持；到期后换角度抽检，不连考同题",
  }[stage];
}

function resolveConfirmedLinks(objectLinks = []) {
  const activeByKp = new Map();
  for (const row of objectLinks) {
    const status = camelOrSnake(row, "linkStatus", "link_status") ?? "pending";
    if (status !== "confirmed") continue;
    const kpId = String(camelOrSnake(row, "kpId", "kp_id") ?? "");
    if (!kpId) continue;
    const kinds = activeByKp.get(kpId) ?? new Set();
    kinds.add(String(camelOrSnake(row, "sourceKind", "source_kind") ?? "manual"));
    activeByKp.set(kpId, kinds);
  }
  return activeByKp;
}

function dueDateFor({ stage, lastEvidenceDate, decay, referenceDate, activated }) {
  if (!activated) return null;
  if (["unseen", "exposed"].includes(stage)) return referenceDate;
  if (stage === "understanding") return shiftDate(lastEvidenceDate ?? referenceDate, STAGE_INTERVALS.understanding);
  if (stage === "recall") return shiftDate(lastEvidenceDate ?? referenceDate, STAGE_INTERVALS.recall);
  const candidates = [decay.dimensions.recall.nextReviewDate, decay.dimensions.application.nextReviewDate].filter(validDate).sort();
  return candidates[0] ?? shiftDate(lastEvidenceDate ?? referenceDate, STAGE_INTERVALS[stage]);
}

function riskFor({ stage, evidence, decay, importanceScore, lastEvidenceDate, dueDate, referenceDate, activated }) {
  if (!activated) return 0;
  const stageBase = { unseen: 64, exposed: 78, understanding: 64, recall: 50, application: 36, stable: 14 }[stage];
  const latest = orderedEvidence(evidence.filter(qualifies)).at(-1) ?? null;
  const latestFailure = latest && latest.result !== "pass" ? 14 : 0;
  const overdue = dueDate && dueDate < referenceDate ? Math.min(20, Math.max(0, daysBetween(dueDate, referenceDate) ?? 0) * 3) : 0;
  const retentionPenalty = Math.round((100 - decay.retentionIndex) * 0.34);
  const decayPenalty = Math.min(12, decay.decayedDimensions.length * 5);
  const stale = lastEvidenceDate ? Math.min(8, Math.max(0, (daysBetween(lastEvidenceDate, referenceDate) ?? 0) - 30)) : 0;
  const importance = (Number(importanceScore ?? 50) - 50) * 0.24;
  return clamp(Math.round(stageBase * 0.72 + retentionPenalty + decayPenalty + latestFailure + overdue + stale + importance));
}

export function buildKnowledgePointStates({
  catalog,
  evidence = [],
  objectLinks = [],
  referenceDate,
  examDate = null,
} = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const normalized = evidence.map(normalizeKnowledgeEvidence);
  const evidenceByKp = new Map();
  for (const row of normalized) {
    if (!row.kpId) continue;
    const rows = evidenceByKp.get(row.kpId) ?? [];
    rows.push(row);
    evidenceByKp.set(row.kpId, rows);
  }
  const linksByKp = resolveConfirmedLinks(objectLinks);
  const daysToExam = validDate(examDate) ? daysBetween(referenceDate, examDate) : null;
  const items = (catalog?.items ?? []).map((point) => {
    // [gpt] 未来日期证据不能泄漏进今天的状态；原始行仍保留在事实账中供审计。
    const rows = orderedEvidence(evidenceByKp.get(point.kpId) ?? []).filter((row) => row.evidenceDate <= referenceDate);
    const dimensions = {
      exposure: analyseDimension(rows, "exposure", KNOWLEDGE_DIMENSIONS),
      understanding: analyseDimension(rows, "understanding", ["understanding", "recall", "application"]),
      recall: analyseDimension(rows, "recall"),
      application: analyseDimension(rows, "application"),
    };
    const historicalStability = analyseStability(rows);
    const decay = buildKnowledgeDecayProfile(rows, referenceDate);
    const stabilityCurrent = historicalStability.achieved
      && decay.dimensions.recall.isCurrent
      && decay.dimensions.application.isCurrent;
    const stability = {
      ...historicalStability,
      everAchieved: historicalStability.achieved,
      achieved: stabilityCurrent,
      decayed: historicalStability.achieved && !stabilityCurrent,
      currentRequirement: "历史稳定门槛达成后，复述与应用的时间衰减指数今天仍须高于各自有效阈值",
    };
    const examReadiness = analyseExamReadiness(rows, stability);
    const demonstratedStage = stageFromDimensions(dimensions, historicalStability, rows);
    const stage = currentStageFromDecay(dimensions, stability, decay, rows);
    const lastEvidenceDate = rows.map((row) => row.evidenceDate).sort().at(-1) ?? null;
    const activeLinkKinds = [...(linksByKp.get(point.kpId) ?? [])].sort();
    const activated = rows.some(qualifies) || activeLinkKinds.length > 0;
    const dueDate = dueDateFor({ stage, lastEvidenceDate, decay, referenceDate, activated });
    const riskScore = riskFor({ stage, evidence: rows, decay, importanceScore: point.importanceScore, lastEvidenceDate, dueDate, referenceDate, activated });
    const sprintEligible = point.importanceScore >= 65;
    const sprintLane = activated && daysToExam != null && daysToExam >= 0 && daysToExam <= 60 && (sprintEligible || riskScore >= 65);
    const stageRank = (value) => KNOWLEDGE_STAGES.indexOf(value);
    const decayedFrom = stageRank(stage) < stageRank(demonstratedStage) ? demonstratedStage : null;
    return {
      kpId: point.kpId,
      subject: point.subject,
      parentKp: point.parentKp,
      name: point.name,
      stage,
      stageLabel: KNOWLEDGE_STAGE_LABELS[stage],
      demonstratedStage,
      demonstratedStageLabel: KNOWLEDGE_STAGE_LABELS[demonstratedStage],
      decayedFrom,
      decayedFromLabel: decayedFrom ? KNOWLEDGE_STAGE_LABELS[decayedFrom] : null,
      dimensions: Object.fromEntries(Object.entries(dimensions).map(([dimension, value]) => [dimension, {
        ...value,
        current: decay.dimensions[dimension].isCurrent,
        retentionIndex: decay.dimensions[dimension].retentionIndex,
        decay: decay.dimensions[dimension],
      }])),
      stability,
      examReadiness,
      decay,
      activated,
      activeLinkKinds,
      evidenceCount: rows.length,
      invalidEvidenceCount: evidenceByKp.get(point.kpId)?.filter((row) => !row.valid || row.result === "void" || row.promptIntegrity === "invalid").length ?? 0,
      lastEvidenceDate,
      dueDate,
      riskScore,
      importanceScore: point.importanceScore,
      sprintEligible,
      sprintLane,
      sprintReason: sprintLane ? `距考试 ${daysToExam} 天；冲刺是调度通道，不改变「${KNOWLEDGE_STAGE_LABELS[stage]}」掌握状态` : null,
      nextAction: decayedFrom
        ? `历史上达到「${KNOWLEDGE_STAGE_LABELS[decayedFrom]}」，但截至今天已衰减到「${KNOWLEDGE_STAGE_LABELS[stage]}」；${nextActionFor(stage)}`
        : stage === "stable" && !examReadiness.achieved
          ? "掌握状态已稳定，但尚缺 L4 陌生/综合题与限时环境证据，不能标考试就绪"
          : nextActionFor(stage),
      anki: {
        matchLevel: point.anki.matchLevel,
        noteIds: point.anki.noteIds,
        references: point.anki.references,
        masteryImpact: "none",
      },
      evidence: rows,
    };
  }).sort((left, right) => right.riskScore - left.riskScore || right.importanceScore - left.importanceScore || left.kpId.localeCompare(right.kpId));

  return {
    version: KNOWLEDGE_STATE_VERSION,
    referenceDate,
    examDate: validDate(examDate) ? examDate : null,
    counts: {
      total: items.length,
      activated: items.filter((item) => item.activated).length,
      dispatchEligible: items.filter((item) => item.activated && (item.dueDate <= referenceDate || item.riskScore >= 65)).length,
      decayed: items.filter((item) => item.activated && item.decayedFrom).length,
      dueByDecay: items.filter((item) => item.activated && item.decay.dueDimensions.length).length,
      sprintLane: items.filter((item) => item.sprintLane).length,
      examReady: items.filter((item) => item.examReadiness.achieved).length,
      byStage: Object.fromEntries(KNOWLEDGE_STAGES.map((stage) => [stage, items.filter((item) => item.stage === stage).length])),
      activatedByStage: Object.fromEntries(KNOWLEDGE_STAGES.map((stage) => [stage, items.filter((item) => item.activated && item.stage === stage).length])),
    },
    active: items.filter((item) => item.activated),
    items,
    caveat: "Anki 只影响材料引用与重要度；历史最高表现与今天的衰减状态分开保留。retentionIndex 只作调度，不是记忆概率；冲刺是独立通道。",
  };
}

function patternRowFromError(row, sequence) {
  const pattern = camelOrSnake(row, "failurePatternCode", "failure_pattern_code");
  if (!pattern || !(pattern in FAILURE_PATTERNS)) return null;
  const diagnosisStatus = String(camelOrSnake(row, "diagnosisStatus", "diagnosis_status") ?? "pending");
  if (diagnosisStatus === "rejected") return null;
  const kpId = camelOrSnake(row, "topicKpId", "topic_kp_id") ?? camelOrSnake(row, "eventKpId", "event_kp_id") ?? null;
  const sourceId = String(camelOrSnake(row, "studyErrorId", "study_error_id") ?? sequence);
  return {
    kpId: kpId ? String(kpId) : null,
    subject: row?.topic_subject ?? row?.event_subject ?? null,
    pattern,
    diagnosisStatus,
    result: "fail",
    date: String(row?.log_date ?? ""),
    cold: false,
    promptIntegrity: "clean",
    sourceKind: "study_error",
    sourceId,
    topicId: camelOrSnake(row, "topicId", "topic_id") == null ? null : String(camelOrSnake(row, "topicId", "topic_id")),
    anchor: row?.evidence_anchor ?? `study_error#${sourceId}`,
    note: row?.root_cause_note ?? null,
    sequence,
  };
}

function patternRowFromEvidence(row, sequence) {
  const value = normalizeKnowledgeEvidence(row, sequence);
  if (!value.valid || !value.failurePatternCode || !(value.failurePatternCode in FAILURE_PATTERNS) || value.diagnosisStatus === "rejected") return null;
  return {
    kpId: value.kpId || null,
    subject: row?.subject ?? null,
    pattern: value.failurePatternCode,
    diagnosisStatus: value.diagnosisStatus,
    result: value.result,
    date: value.evidenceDate,
    cold: value.cold,
    promptIntegrity: value.promptIntegrity,
    sourceKind: value.sourceKind,
    sourceId: value.sourceId ?? value.operationId ?? String(sequence),
    anchor: value.evidenceAnchor,
    note: value.note,
    sequence,
  };
}

function dedupePatternRows(rows) {
  const deduped = new Map();
  for (const row of rows) {
    const key = [row.sourceKind, row.sourceId, row.pattern, row.result, row.date].join("|");
    const known = deduped.get(key);
    if (!known || (known.diagnosisStatus !== "confirmed" && row.diagnosisStatus === "confirmed")) deduped.set(key, row);
  }
  return [...deduped.values()];
}

function profileForRows(rows, { kpId = null, subject = null } = {}) {
  const byPattern = new Map();
  for (const row of rows) {
    const list = byPattern.get(row.pattern) ?? [];
    list.push(row);
    byPattern.set(row.pattern, list);
  }
  return [...byPattern.entries()].map(([pattern, patternRows]) => {
    const failures = patternRows.filter((row) => ["fail", "partial"].includes(row.result));
    const confirmedFailures = failures.filter((row) => row.diagnosisStatus === "confirmed");
    const pendingFailures = failures.filter((row) => row.diagnosisStatus === "pending");
    const lastFailureDate = failures.map((row) => row.date).filter(validDate).sort().at(-1) ?? null;
    const laterPasses = patternRows.filter((row) => row.result === "pass" && row.promptIntegrity === "clean" && validDate(row.date) && (!lastFailureDate || row.date > lastFailureDate));
    // [gpt] 2026-08-10：栽点退役只认真正冷检；同场订正可进入观察，但不能凑退役日期。
    const laterColdPasses = laterPasses.filter((row) => row.cold);
    const passDates = [...new Set(laterColdPasses.map((row) => row.date))].sort();
    const passSpan = passDates.length >= 2 ? daysBetween(passDates[0], passDates.at(-1)) : 0;
    let status = confirmedFailures.length ? "confirmed" : "pending";
    if (confirmedFailures.length && laterPasses.length) status = "monitoring";
    if (confirmedFailures.length && passDates.length >= 2 && passSpan >= 7) status = "retired";
    const definition = FAILURE_PATTERNS[pattern];
    const distinctSources = new Set(failures.map((row) => `${row.sourceKind}:${row.sourceId}`)).size;
    const score = confirmedFailures.length * 10 + pendingFailures.length * 3 + distinctSources * 2 - (status === "retired" ? 20 : 0);
    return {
      kpId,
      subject,
      pattern,
      label: definition.label,
      focus: definition.focus,
      status,
      evidenceCounts: {
        confirmedFailures: confirmedFailures.length,
        pendingFailures: pendingFailures.length,
        laterCleanPasses: laterPasses.length,
        distinctSources,
      },
      lastFailureDate,
      retirementEvidence: { passDates, spanDays: passSpan, coldPasses: laterColdPasses.length, hasColdPass: laterColdPasses.length > 0 },
      score,
      statement: status === "retired"
        ? `「${definition.label}」已有跨日冷检证据，转入低频监测`
        : status === "pending"
          ? `候选栽点是「${definition.label}」，尚待你认领或补证据`
          : confirmedFailures.length >= 2
            ? `主要栽在「${definition.label}」；本轮只练${definition.focus}`
            : `已确认出现一次「${definition.label}」；本轮定向练${definition.focus}，但暂不称稳定习惯`,
      evidence: patternRows.sort((left, right) => left.date.localeCompare(right.date) || left.sequence - right.sequence),
    };
  }).sort((left, right) => right.score - left.score || String(right.lastFailureDate).localeCompare(String(left.lastFailureDate)) || left.pattern.localeCompare(right.pattern));
}

function confirmedLinkIds(objectLinks, sourceKind, sourceId) {
  const matches = objectLinks.filter((row) => {
    const kind = camelOrSnake(row, "sourceKind", "source_kind");
    const id = String(camelOrSnake(row, "sourceId", "source_id") ?? "");
    const status = camelOrSnake(row, "linkStatus", "link_status");
    return kind === sourceKind && id === String(sourceId ?? "") && status === "confirmed";
  });
  // [gpt] 2026-08-10：related/reference 只表达关联，不把一条失败复制到多个 KP；有 primary 时画像只认 primary。
  const primary = matches.filter((row) => String(camelOrSnake(row, "role", "role") ?? "primary") === "primary");
  const selected = primary.length ? primary : matches;
  return [...new Set(selected.map((row) => String(camelOrSnake(row, "kpId", "kp_id") ?? "")).filter(Boolean))];
}

export function buildFailurePortrait({ errorRows = [], knowledgeEvidence = [], objectLinks = [], catalog = null } = {}) {
  const catalogById = new Map((catalog?.items ?? []).map((item) => [item.kpId, item]));
  const expandedErrorRows = errorRows.map(patternRowFromError).filter(Boolean).flatMap((row) => {
    if (row.kpId) return [row];
    const topicLinks = row.topicId ? confirmedLinkIds(objectLinks, "error_topic", row.topicId) : [];
    const eventLinks = confirmedLinkIds(objectLinks, "study_error", row.sourceId);
    const kpIds = topicLinks.length ? topicLinks : eventLinks;
    return kpIds.length ? kpIds.map((kpId) => ({ ...row, kpId })) : [row];
  });
  const rows = dedupePatternRows([
    ...expandedErrorRows,
    ...knowledgeEvidence.map(patternRowFromEvidence).filter(Boolean),
  ]).map((row) => {
    // [gpt] 2026-08-10：knowledge_evidence 本身不重复存科目；按稳定 kp_id 从目录补科目，避免分科画像漏样本。
    const catalogPoint = row.kpId ? catalogById.get(row.kpId) : null;
    return row.subject || !catalogPoint?.subject ? row : { ...row, subject: catalogPoint.subject };
  });
  const pointKeys = [...new Set(rows.map((row) => row.kpId).filter(Boolean))];
  const byKnowledgePoint = pointKeys.map((kpId) => {
    const point = catalogById.get(kpId);
    const pointRows = rows.filter((row) => row.kpId === kpId);
    const patterns = profileForRows(pointRows, { kpId, subject: point?.subject ?? pointRows[0]?.subject ?? null });
    return {
      kpId,
      subject: point?.subject ?? pointRows[0]?.subject ?? null,
      name: point?.name ?? null,
      patterns,
      primaryPattern: patterns.find((item) => item.status !== "retired") ?? patterns[0] ?? null,
    };
  }).sort((left, right) => (right.primaryPattern?.score ?? 0) - (left.primaryPattern?.score ?? 0) || left.kpId.localeCompare(right.kpId));

  const subjects = [...new Set(rows.map((row) => row.subject).filter(Boolean))];
  const bySubject = subjects.map((subject) => {
    const subjectRows = rows.filter((row) => row.subject === subject);
    const patterns = profileForRows(subjectRows, { subject }).map((profile) => {
      const allFailureRows = profile.evidence.filter((row) => ["fail", "partial"].includes(row.result));
      const failureRows = allFailureRows.filter((row) => row.diagnosisStatus === "confirmed");
      const mappedKnowledgePoints = new Set(allFailureRows.map((row) => row.kpId).filter(Boolean)).size;
      const distinctKps = new Set(failureRows.map((row) => row.kpId).filter(Boolean)).size;
      const habitual = failureRows.length >= 3 && distinctKps >= 2;
      const statement = profile.status === "retired"
        ? profile.statement
        : profile.status === "pending"
          ? profile.statement
          : habitual
            ? `${subject}反复出现「${profile.label}」；本轮只练${profile.focus}`
            : `${subject}已确认出现「${profile.label}」，但尚不足以称跨知识点稳定习惯`;
      return { ...profile, mappedKnowledgePoints, distinctKnowledgePoints: distinctKps, habitual, statement };
    });
    return { subject, patterns, primaryPattern: patterns.find((item) => item.status !== "retired") ?? patterns[0] ?? null };
  }).sort((left, right) => (right.primaryPattern?.score ?? 0) - (left.primaryPattern?.score ?? 0));

  const pointPatterns = byKnowledgePoint.flatMap((item) => item.patterns);
  const subjectPatterns = bySubject.flatMap((item) => item.patterns);

  return {
    version: 1,
    counts: {
      evidence: rows.length,
      knowledgePoints: byKnowledgePoint.length,
      subjects: bySubject.length,
      activeConfirmed: pointPatterns.filter((item) => ["confirmed", "monitoring"].includes(item.status)).length,
      pending: pointPatterns.filter((item) => item.status === "pending").length,
      retired: pointPatterns.filter((item) => item.status === "retired").length,
      subjectActiveConfirmed: subjectPatterns.filter((item) => ["confirmed", "monitoring"].includes(item.status)).length,
      subjectPending: subjectPatterns.filter((item) => item.status === "pending").length,
      habitual: subjectPatterns.filter((item) => item.habitual && item.status !== "retired").length,
      unmatchedEvidence: rows.filter((row) => !row.kpId).length,
    },
    byKnowledgePoint,
    bySubject,
    unmatched: rows.filter((row) => !row.kpId),
    policy: "pending 不写成用户稳定特征；跨知识点至少 3 次确认失败才称为习惯性栽点；两次跨日定向干净通过后可退役。",
  };
}

function portraitStatusRank(pattern) {
  if (pattern.status === "retired") return 4;
  if (pattern.habitual) return 0;
  return { confirmed: 1, monitoring: 2, pending: 3 }[pattern.status] ?? 5;
}

function portraitStatusLabel(pattern) {
  if (pattern.status === "retired") return "已退役";
  if (pattern.habitual) return "习惯性";
  return {
    confirmed: "已确认个案",
    monitoring: "修复观察",
    pending: "候选待认领",
  }[pattern.status] ?? pattern.status;
}

/**
 * [gpt] 2026-08-10：把可重算栽点画像格式化为复盘入口报告。
 * 只报告样本计数和证据层级，不输出掌握百分比；低样本不自动改训练策略。
 */
export function formatFailurePortrait(portrait, { subject = null, limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("画像 limit 必须是 1-20 的整数");
  const scopes = (portrait?.bySubject ?? []).filter((item) => !subject || item.subject === subject);
  const unmatched = portrait?.unmatched?.length ?? 0;
  const lines = [
    `错因画像（${subject ?? "全科"}｜只读派生，不是掌握率）`,
    `细粒度证据 ${portrait?.counts?.evidence ?? 0} 条｜已映射知识点 ${portrait?.counts?.knowledgePoints ?? 0} 个｜未映射知识点 ${unmatched} 条`,
  ];

  if (!scopes.length) {
    lines.push("", subject ? `${subject}暂无可用细粒度栽点证据。` : "暂无可用细粒度栽点证据。");
  }

  for (const scope of scopes) {
    const patterns = [...(scope.patterns ?? [])]
      .sort((left, right) => portraitStatusRank(left) - portraitStatusRank(right) || right.score - left.score)
      .slice(0, limit);
    lines.push("", `[${scope.subject}] ${scope.patterns.length} 种已记录栽点`);
    for (const pattern of patterns) {
      const confirmed = pattern.evidenceCounts?.confirmedFailures ?? 0;
      const pending = pattern.evidenceCounts?.pendingFailures ?? 0;
      const distinctKps = pattern.distinctKnowledgePoints ?? 0;
      const mappedKps = pattern.mappedKnowledgePoints ?? distinctKps;
      const samples = [`确认失败 ${confirmed}`, `待认领 ${pending}`, `映射知识点 ${mappedKps}`, `确认跨点 ${distinctKps}`];
      if (pattern.lastFailureDate) samples.push(`最近 ${pattern.lastFailureDate}`);
      lines.push(`- ${portraitStatusLabel(pattern)}｜${pattern.label}｜${samples.join(" / ")}`);
      if (pattern.status === "pending") lines.push("  用法：只作为下一题的待验证候选，未认领前不得写成你的稳定特征。");
      else if (pattern.status === "retired") lines.push(`  证据：${pattern.retirementEvidence.passDates.length} 个冷检日期，跨度 ${pattern.retirementEvidence.spanDays} 天；转入低频监测。`);
      else if (!pattern.habitual) lines.push(`  口径：当前只算已确认个案；达到跨至少 2 个知识点、3 次确认失败前，不称为习惯性。`);
      lines.push(`  训练焦点：${pattern.focus}`);
    }
    if ((scope.patterns?.length ?? 0) > patterns.length) lines.push(`  …另有 ${scope.patterns.length - patterns.length} 种栽点未展开（用 --limit 调整）。`);
  }

  lines.push("", `口径：${portrait?.policy ?? "pending 不写成稳定画像；所有画像均由现有证据重算。"}`, "画像分布与教练预测兑现率都不是掌握概率、卷面分或上岸率。");
  return lines.join("\n");
}

export function reciteEvidenceFromLinks(reciteMemory, objectLinks = []) {
  const links = objectLinks.filter((row) => {
    const kind = camelOrSnake(row, "sourceKind", "source_kind");
    const status = camelOrSnake(row, "linkStatus", "link_status");
    return kind === "recite_ledger" && status === "confirmed";
  });
  const primaryKpByRecord = new Map();
  for (const link of links) {
    if (String(camelOrSnake(link, "role", "role") ?? "primary") !== "primary") continue;
    const sourceId = String(camelOrSnake(link, "sourceId", "source_id") ?? "");
    const kpId = String(camelOrSnake(link, "kpId", "kp_id") ?? "");
    if (!sourceId || !kpId) continue;
    const ids = primaryKpByRecord.get(sourceId) ?? new Set();
    ids.add(kpId);
    primaryKpByRecord.set(sourceId, ids);
  }
  const output = [];
  for (const item of reciteMemory?.items ?? []) {
    // [gpt] 2026-08-10：只有唯一 confirmed KP 才传播证据；零/多映射都留作接线债，避免证据复制污染。
    const kpIds = [...(primaryKpByRecord.get(String(item.id)) ?? [])];
    if (kpIds.length !== 1) continue;
    for (const kpId of kpIds) {
      for (const [sequence, row] of (item.evidence ?? []).entries()) {
        output.push({
          operationId: row.operationId ?? `recite-ledger:${item.id}:${row.date}:${sequence}`,
          kpId,
          evidenceDate: row.date,
          dimension: row.dimension ?? "recall",
          result: row.result,
          sourceKind: "recite_ledger",
          sourceId: row.operationId ?? `${item.id}:${sequence}`,
          cold: Boolean(row.cold),
          promptIntegrity: row.promptIntegrity ?? (row.result === "void" ? "invalid" : row.qualifying === false ? "cued" : "clean"),
          failurePatternCode: row.failurePatternCode ?? null,
          diagnosisStatus: row.diagnosisStatus ?? null,
          evidenceAnchor: row.evidenceAnchor ?? `.local/带背挂账.md#${item.id}`,
          note: row.source ?? null,
        });
      }
    }
  }
  return output;
}
