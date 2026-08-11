import {
  buildFailurePortrait,
  buildKnowledgePointStates,
  reciteEvidenceFromLinks,
} from "./knowledge-state.mjs";
import { buildKnowledgeGraph } from "./knowledge-graph.mjs";
import { buildExamLossForecast } from "./knowledge-forecast.mjs";
import { buildInterventionResponse, findInterventionResponse, interventionResponseKey } from "./intervention-response.mjs";
import { selectInterventionProtocol } from "./intervention-protocols.mjs";
import { normalizeReviewEvidence, recommendNextReviewProbe, summarizeReviewProof } from "./error-taxonomy.mjs";
import { buildLearningController, formatLearningController } from "./learning-controller.mjs";

const DAY = 86400000;

export const LEARNING_COACH_VERSION = "3.2"; // [gpt] 2026-08-10：加入协议化 episode 与多时点保守选策。
export const LEARNING_STATES = Object.freeze([
  "discovered",
  "confirmed",
  "reinforcing",
  "short_pass",
  "cooling",
  "stable",
  "maintenance",
]);

export const LEARNING_STATE_LABELS = Object.freeze({
  discovered: "发现",
  confirmed: "确认",
  reinforcing: "强化",
  short_pass: "短期通过",
  cooling: "冷却观察",
  stable: "稳定",
  maintenance: "长期保持",
  routed: "已转轨",
});

const TOPIC_INTERVALS = Object.freeze({
  discovered: 1,
  confirmed: 2,
  reinforcing: 2,
  short_pass: 4,
  cooling: 7,
  stable: 14,
  maintenance: 21,
});

const RECITE_INTERVALS = Object.freeze({
  discovered: 1,
  reinforcing: 2,
  short_pass: 4,
  cooling: 7,
  stable: 14,
  maintenance: 21,
  routed: 30,
});

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDate(date, days) {
  if (!validDate(date)) return null;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  if (!validDate(from) || !validDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function latestDate(values) {
  return values.filter(validDate).sort().at(-1) ?? null;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function resolveDateToken(token, referenceDate) {
  const clean = String(token ?? "").trim();
  if (/^20\d{2}-\d{2}-\d{2}$/.test(clean)) return validDate(clean) ? clean : null;
  const match = clean.match(/^(\d{2})-(\d{2})$/);
  if (!match) return null;
  let value = `${referenceDate.slice(0, 4)}-${match[1]}-${match[2]}`;
  if (!validDate(value)) return null;
  const future = daysBetween(referenceDate, value);
  if (future != null && future > 45) value = `${Number(referenceDate.slice(0, 4)) - 1}-${match[1]}-${match[2]}`;
  return validDate(value) ? value : null;
}

function sortedEvidence(evidence) {
  return [...evidence].sort((left, right) => left.date.localeCompare(right.date) || (left.sequence ?? 0) - (right.sequence ?? 0));
}

function cleanPassDatesAfterLastFailure(evidence) {
  const ordered = sortedEvidence(evidence).filter((item) => item.qualifying !== false);
  let lastFailureIndex = -1;
  ordered.forEach((item, index) => {
    if (item.result !== "pass") lastFailureIndex = index;
  });
  return [...new Set(ordered.slice(lastFailureIndex + 1).filter((item) => item.result === "pass").map((item) => item.date))];
}

function observedForgettingIntervals(evidence) {
  const ordered = sortedEvidence(evidence).filter((item) => item.qualifying !== false);
  const intervals = [];
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index].result === "pass") continue;
    const priorPass = ordered.slice(0, index).reverse().find((item) => item.result === "pass");
    const interval = priorPass ? daysBetween(priorPass.date, ordered[index].date) : null;
    if (interval != null && interval > 0) intervals.push(interval);
  }
  return intervals;
}

function intervalEstimate(evidence, fallback, { recurrent = false, memoryDecay = false } = {}) {
  const observed = observedForgettingIntervals(evidence);
  const empirical = median(observed);
  let days = empirical ?? fallback;
  if (recurrent) days *= 0.8;
  if (memoryDecay) days *= 0.75;
  days = clamp(Math.round(days), 1, 45);
  return {
    days,
    source: empirical == null ? "state-default" : "observed-pass-to-fail",
    confidence: observed.length >= 2 ? "high" : observed.length === 1 ? "medium" : "low",
    observedIntervals: observed,
  };
}

function urgencyFor(score) {
  if (score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function topicStage(topic, evidence, reviewProof = summarizeReviewProof(evidence)) {
  if (topic.classificationStatus !== "confirmed") return "discovered";
  const latest = reviewProof.latestEvidence;
  const latestPassDate = reviewProof.latestSupportingPass?.date ?? null;
  const newerOpenEvent = topic.active && topic.latestOpenDate && (!latestPassDate || topic.latestOpenDate > latestPassDate);
  if (latest?.result === "partial" || latest?.result === "fail") return "reinforcing";
  if (reviewProof.lastFailure && !reviewProof.latestSupportingPass) return "reinforcing";
  if (newerOpenEvent) return "reinforcing";
  if (!latest) return topic.recurrent ? "reinforcing" : "confirmed";
  if (!topic.active && reviewProof.stable && reviewProof.passDates.length >= 3) return "maintenance";
  if (!topic.active && reviewProof.stable) return "stable";
  if (reviewProof.status === "open") return topic.recurrent ? "reinforcing" : "confirmed";
  const passAge = daysBetween(reviewProof.latestSupportingPass?.date, topic.referenceDate);
  return passAge != null && passAge <= 2 ? "short_pass" : "cooling";
}

function topicNextAction(stage) {
  return {
    discovered: "先确认标准主题与病根候选，再做一发正中原栽点的变式",
    confirmed: "做一发冷启动变式，答后写 error_review",
    reinforcing: "针对最近失败角度强化，避免同题复述",
    short_pass: "暂不连考，等待冷却后换角度复检",
    cooling: "到期后做跨日冷复检",
    stable: "降低频率，以新情境做保持性复检",
    maintenance: "进入长期轮换，只在到期或复发时升频",
  }[stage];
}

export function buildTopicLearningStates(errorSummary, reviews = [], referenceDate, { objectLinks = [] } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const confirmedKpByTopic = new Map();
  for (const link of objectLinks) {
    if ((link.sourceKind ?? link.source_kind) !== "error_topic" || (link.linkStatus ?? link.link_status) !== "confirmed") continue;
    const topicId = Number(link.sourceId ?? link.source_id);
    const kpId = String(link.kpId ?? link.kp_id ?? "");
    if (!Number.isInteger(topicId) || !kpId) continue;
    const ids = confirmedKpByTopic.get(topicId) ?? new Set();
    ids.add(kpId);
    confirmedKpByTopic.set(topicId, ids);
  }
  const reviewsByTopic = new Map();
  for (const [sequence, review] of reviews.entries()) {
    const normalized = normalizeReviewEvidence(review, sequence);
    const topicId = normalized.topicId;
    const date = normalized.date;
    if (!Number.isInteger(topicId) || !validDate(date)) continue;
    const rows = reviewsByTopic.get(topicId) ?? [];
    rows.push({
      ...normalized,
      // [gpt] 2026-08-10：合格迁移 pass 与有效失败参与遗忘估计；提示/同场/低迁移 pass 和 void 不参与。
      qualifying: normalized.result === "pass"
        ? normalized.qualifyingTransferPass || normalized.legacyPass
        : normalized.substantive,
    });
    reviewsByTopic.set(topicId, rows);
  }

  const items = (errorSummary?.topics ?? []).map((topic) => {
    const linkedKpIds = [...(confirmedKpByTopic.get(topic.id) ?? [])];
    const resolvedKpId = topic.kpId ?? (linkedKpIds.length === 1 ? linkedKpIds[0] : null);
    const evidence = reviewsByTopic.get(topic.id) ?? [];
    const reviewProof = summarizeReviewProof(evidence);
    const confirmedFailurePatterns = [...(topic.confirmedFailurePatterns ?? [])].sort();
    const nextProbe = recommendNextReviewProbe(evidence, {
      referenceDate,
      failurePatternCode: confirmedFailurePatterns[0] ?? null,
    });
    const enriched = { ...topic, referenceDate };
    const state = topicStage(enriched, evidence, reviewProof);
    const latestReview = reviewProof.latestEvidence;
    const lastEvidenceDate = latestDate([topic.latestEventDate, latestReview?.date]);
    const memoryDecay = topic.confirmedRootCauses?.includes("memory_decay") ?? false;
    const interval = intervalEstimate(evidence, TOPIC_INTERVALS[state], {
      recurrent: topic.recurrent,
      memoryDecay,
    });
    const intervalDueDate = shiftDate(lastEvidenceDate ?? referenceDate, interval.days);
    // [gpt] 2026-08-10：遗忘到期与证明门槛同时约束派单；未到下一探针冷却日不得提前连考。
    const dueDate = latestDate([intervalDueDate, nextProbe.earliestDate]);
    const daysSinceEvidence = lastEvidenceDate ? daysBetween(lastEvidenceDate, referenceDate) : null;
    const overdueDays = dueDate && dueDate < referenceDate ? daysBetween(dueDate, referenceDate) : 0;
    const stateBase = {
      discovered: 72,
      confirmed: 62,
      reinforcing: 78,
      short_pass: 34,
      cooling: 44,
      stable: 20,
      maintenance: 14,
    }[state];
    const riskScore = clamp(Math.round(
      stateBase
      + Math.min(25, (overdueDays ?? 0) * 5)
      + (topic.recurrent ? 10 : 0)
      + Math.min(12, topic.eventCounts.open * 3)
      + (reviewProof.lastFailure && reviewProof.status === "open" ? 12 : 0)
      + (memoryDecay ? 8 : 0),
    ));
    return {
      id: topic.id,
      kpId: resolvedKpId,
      subject: topic.subject,
      title: topic.title,
      chapter: topic.chapter,
      state,
      stateLabel: LEARNING_STATE_LABELS[state],
      masteryStatus: reviewProof.status,
      storedMasteryStatus: topic.masteryStatus,
      classificationStatus: topic.classificationStatus,
      active: topic.active,
      recurrent: topic.recurrent,
      confirmedFailurePatterns,
      pendingFailurePatterns: topic.pendingFailurePatterns ?? [],
      eventCounts: topic.eventCounts,
      reviewCounts: {
        total: evidence.length,
        pass: evidence.filter((item) => item.result === "pass").length,
        partial: evidence.filter((item) => item.result === "partial").length,
        fail: evidence.filter((item) => item.result === "fail").length,
        void: evidence.filter((item) => item.result === "void").length,
        qualifyingTransferPasses: reviewProof.qualifyingPassCount,
        legacyPasses: reviewProof.legacyPassCount,
        cleanPassDates: reviewProof.passDates.length,
      },
      reviewProof: {
        status: reviewProof.status,
        spanDays: reviewProof.spanDays,
        angles: reviewProof.angles,
        probeAxes: reviewProof.probeAxes,
        hasNovelTransfer: reviewProof.hasNovelTransfer,
        blockers: reviewProof.blockers,
      },
      latestReview,
      lastEvidenceDate,
      daysSinceEvidence,
      estimatedRetentionDays: interval.days,
      intervalEvidence: interval,
      intervalDueDate,
      dueDate,
      overdueDays,
      riskScore,
      urgency: urgencyFor(riskScore),
      nextAction: topicNextAction(state),
      nextProbe,
    };
  }).sort((left, right) => right.riskScore - left.riskScore || String(left.dueDate).localeCompare(String(right.dueDate)) || left.id - right.id);

  return {
    counts: Object.fromEntries(LEARNING_STATES.map((state) => [state, items.filter((item) => item.state === state).length])),
    due: items.filter((item) => item.dueDate && item.dueDate <= referenceDate),
    items,
  };
}

export function extractReciteReviewEvidence(entry, referenceDate) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const proseEvidence = [];
  const lines = String(entry?.block ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const [sequence, line] of lines.entries()) {
    if (!/复检|冷启动|抽查/.test(line)) continue;
    const token = line.match(/(?<!\d)(?:20\d{2}-)?\d{2}-\d{2}(?!\d)/)?.[0];
    const date = resolveDateToken(token, referenceDate);
    if (!date || date > referenceDate) continue;
    let result = null;
    if (/✗|❌/.test(line)) result = "fail";
    else if (/半\s*✓|半✓|⚠/.test(line)) result = "partial";
    else if (/✓|✅/.test(line)) result = "pass";
    if (!result) continue;
    const invalidQuestion = /问法失真|该发作废|题干喂答案/.test(line);
    const nonQualifyingPass = result === "pass" && /不算|当场|同场|原文刚在眼前|问法打折/.test(line);
    // [gpt] 2026-08-10：知识点状态机需要区分干净冷提取、提示后通过与作废题。
    proseEvidence.push({
      date,
      dimension: "recall",
      result,
      qualifying: !invalidQuestion && !nonQualifyingPass,
      cold: /冷启动|冷复检|冷检|抽查/.test(line),
      promptIntegrity: invalidQuestion ? "invalid" : nonQualifyingPass ? "cued" : "clean",
      sequence,
      source: line.replace(/\s+/g, " ").trim().slice(0, 180),
    });
  }
  // [gpt] 2026-08-10：v2 流水覆盖同日同结果的自然语言推断；未结构化的旧记录继续保留。
  const consumedProse = new Set();
  const explicitEvidence = (entry?.explicitEvidence ?? [])
    .filter((row) => validDate(row.date) && row.date <= referenceDate)
    .map((row, explicitSequence) => {
      const promptIntegrity = row.promptIntegrity ?? "clean";
      const matchingIndex = row.dimension === "recall"
        ? proseEvidence.findIndex((candidate, index) => !consumedProse.has(index) && candidate.date === row.date && candidate.result === row.result)
        : -1;
      const inferred = matchingIndex >= 0 ? proseEvidence[matchingIndex] : null;
      if (matchingIndex >= 0) consumedProse.add(matchingIndex);
      return {
        ...(inferred ?? {}),
        date: row.date,
        dimension: row.dimension ?? "recall",
        result: row.result,
        qualifying: row.result !== "void" && promptIntegrity !== "invalid" && !(row.result === "pass" && promptIntegrity !== "clean"),
        cold: Boolean(row.cold),
        promptIntegrity,
        failurePatternCode: row.failurePatternCode ?? null,
        diagnosisStatus: row.diagnosisStatus ?? null,
        operationId: row.operationId ?? null,
        evidenceAnchor: row.evidenceAnchor ?? null,
        sequence: inferred?.sequence ?? lines.length + explicitSequence,
        source: row.note ?? inferred?.source ?? row.evidenceAnchor ?? null,
        explicit: true,
      };
    });
  return sortedEvidence([
    ...proseEvidence.filter((_, index) => !consumedProse.has(index)),
    ...explicitEvidence,
  ]);
}

function reciteStage(entry, evidence, referenceDate) {
  if (entry.route !== "daibei" || entry.status === "transferred") return "routed";
  const qualifying = evidence.filter((item) => item.qualifying !== false);
  const latest = qualifying.at(-1) ?? null;
  if (latest?.result && latest.result !== "pass") return "reinforcing";
  const passDates = cleanPassDatesAfterLastFailure(qualifying);
  if (entry.status === "withdrawn" && passDates.length >= 3) return "maintenance";
  if (entry.status === "withdrawn" && passDates.length >= 2) return "stable";
  if (entry.status === "withdrawn") return "cooling";
  if (!latest) return entry.status === "active" ? "discovered" : "cooling";
  const age = daysBetween(latest.date, referenceDate);
  return age != null && age <= 2 ? "short_pass" : "cooling";
}

export function buildReciteMemoryModel(reciteParsed, referenceDate, { objectLinks = [] } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const confirmedKpByRecord = new Map();
  const primaryKpByRecord = new Map();
  for (const link of objectLinks) {
    const sourceKind = link.sourceKind ?? link.source_kind;
    const linkStatus = link.linkStatus ?? link.link_status;
    if (sourceKind !== "recite_ledger" || linkStatus !== "confirmed") continue;
    const sourceId = String(link.sourceId ?? link.source_id ?? "");
    const kpId = String(link.kpId ?? link.kp_id ?? "");
    if (!sourceId || !kpId) continue;
    const ids = confirmedKpByRecord.get(sourceId) ?? new Set();
    ids.add(kpId);
    confirmedKpByRecord.set(sourceId, ids);
    if ((link.role ?? "primary") === "primary") {
      const primaryIds = primaryKpByRecord.get(sourceId) ?? new Set();
      primaryIds.add(kpId);
      primaryKpByRecord.set(sourceId, primaryIds);
    }
  }
  const items = (reciteParsed?.records ?? []).map((entry) => {
    const evidence = extractReciteReviewEvidence(entry, referenceDate);
    const recallEvidence = evidence.filter((item) => (item.dimension ?? "recall") === "recall");
    const state = reciteStage(entry, recallEvidence, referenceDate);
    const passCount = recallEvidence.filter((item) => item.result === "pass" && item.qualifying !== false).length;
    const partialCount = recallEvidence.filter((item) => item.result === "partial" && item.qualifying !== false).length;
    const failCount = recallEvidence.filter((item) => item.result === "fail" && item.qualifying !== false).length;
    const interval = intervalEstimate(recallEvidence, RECITE_INTERVALS[state], {
      recurrent: failCount >= 2,
      memoryDecay: false,
    });
    const lastEvidenceDate = latestDate([entry.lastTouchedOn, evidence.at(-1)?.date]);
    const daysSinceEvidence = lastEvidenceDate ? daysBetween(lastEvidenceDate, referenceDate) : null;
    const dueDate = shiftDate(lastEvidenceDate ?? referenceDate, interval.days);
    const overdueDays = dueDate && dueDate < referenceDate ? daysBetween(dueDate, referenceDate) : 0;
    const baseStrength = {
      discovered: 32,
      reinforcing: 26,
      short_pass: 66,
      cooling: 58,
      stable: 82,
      maintenance: 90,
      routed: 75,
    }[state];
    const ageRatio = daysSinceEvidence == null ? 1 : daysSinceEvidence / Math.max(1, interval.days);
    const memoryStrength = clamp(Math.round(
      baseStrength
      + Math.min(12, passCount * 4)
      - Math.min(22, failCount * 5 + partialCount * 2)
      - Math.min(45, ageRatio * 24),
    ));
    const dropRisk = clamp(Math.round(100 - memoryStrength + Math.min(20, (overdueDays ?? 0) * 4)));
    const title = String(entry.title ?? "").split("｜")[0].trim();
    const kpIds = [...(confirmedKpByRecord.get(String(entry.id)) ?? [])].sort();
    const primaryKpIds = [...(primaryKpByRecord.get(String(entry.id)) ?? [])].sort();
    return {
      id: entry.id,
      kpIds,
      primaryKpId: primaryKpIds.length === 1 ? primaryKpIds[0] : null,
      subject: entry.subject,
      title,
      status: entry.status,
      route: entry.route,
      state,
      stateLabel: LEARNING_STATE_LABELS[state],
      openedOn: entry.openedOn,
      lastEvidenceDate,
      daysSinceEvidence,
      evidenceCounts: { total: evidence.length, pass: passCount, partial: partialCount, fail: failCount },
      estimatedRetentionDays: interval.days,
      intervalEvidence: interval,
      dueDate,
      overdueDays,
      memoryStrength,
      dropRisk,
      urgency: urgencyFor(dropRisk),
      evidence,
    };
  }).sort((left, right) => right.dropRisk - left.dropRisk || String(left.dueDate).localeCompare(String(right.dueDate)) || left.id.localeCompare(right.id, "en", { numeric: true }));

  // [gpt] 2026-08-10：未接线和多接线均保留带背事实，但不冒充已归属某个稳定知识点。
  const linked = items.filter((item) => item.primaryKpId);
  const unlinked = items.filter((item) => item.kpIds.length === 0);
  const multiLinked = items.filter((item) => item.kpIds.length > 1);
  const ambiguousLinks = items.filter((item) => item.kpIds.length > 0 && !item.primaryKpId);
  const linkDebt = items
    .filter((item) => item.route === "daibei" && !item.primaryKpId && (item.status === "active" || item.evidenceCounts.total > 0))
    .map((item) => ({
      id: item.id,
      subject: item.subject,
      title: item.title,
      status: item.status,
      kpIds: item.kpIds,
      evidenceCount: item.evidenceCounts.total,
      dueDate: item.dueDate,
      dropRisk: item.dropRisk,
      reason: item.kpIds.length ? "missing_unique_primary_kp" : "missing_confirmed_kp",
    }));

  return {
    counts: {
      items: items.length,
      due: items.filter((item) => item.route === "daibei" && item.dueDate && item.dueDate <= referenceDate).length,
      highRisk: items.filter((item) => item.route === "daibei" && item.dropRisk >= 70).length,
      linked: linked.length,
      unlinked: unlinked.length,
      multiLinked: multiLinked.length,
      ambiguousLinks: ambiguousLinks.length,
      evidenceUnlinked: items.filter((item) => !item.primaryKpId && item.evidenceCounts.total > 0).length,
      actionableUnlinked: items.filter((item) => !item.primaryKpId && item.route === "daibei" && item.status === "active").length,
    },
    linkDebt,
    topDropRisk: items.filter((item) => item.route === "daibei").slice(0, 20),
    items,
  };
}

function latestStudyDate(logs, subject) {
  return latestDate(logs.filter((row) => row.subject === subject).map((row) => String(row.log_date ?? "")));
}

function structuredMockRecords(targets) {
  const records = targets?.mockRecords ?? targets?.["模拟分记录"]?.["记录"] ?? [];
  return Array.isArray(records) ? records : [];
}

export function buildExamRiskModel({ referenceDate, quantV3, studyLogs = [], topicStates, reciteMemory, knowledgeStates, targets = {}, mockRecords = [] }) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const targetScores = targets?.["科目拆分"] ?? {};
  const records = Array.isArray(mockRecords) ? mockRecords : structuredMockRecords(targets);
  const subjects = (quantV3?.subjects ?? []).map((quant) => {
    const subjectTopics = (topicStates?.items ?? []).filter((item) => item.subject === quant.subject);
    const subjectRecite = (reciteMemory?.items ?? []).filter((item) => item.subject === quant.subject && item.route === "daibei");
    const subjectKnowledge = (knowledgeStates?.active ?? []).filter((item) => item.subject === quant.subject);
    const latest = latestStudyDate(studyLogs, quant.subject);
    const daysSinceStudy = latest ? daysBetween(latest, referenceDate) : null;
    const recencyPenalty = daysSinceStudy == null ? 16 : daysSinceStudy > 14 ? 14 : daysSinceStudy > 7 ? 9 : daysSinceStudy > 3 ? 4 : 0;
    const highRiskTopics = subjectTopics.filter((item) => item.riskScore >= 70).length;
    const recurrentTopics = subjectTopics.filter((item) => item.recurrent).length;
    const highRiskRecite = subjectRecite.filter((item) => item.dropRisk >= 70).length;
    const highRiskKnowledgePoints = subjectKnowledge.filter((item) => item.riskScore >= 70).length;
    const weakPenalty = Math.min(18, highRiskTopics * 2 + recurrentTopics * 2);
    const recitePenalty = Math.min(10, highRiskRecite * 1.5);
    const knowledgePenalty = Math.min(10, highRiskKnowledgePoints * 1.5);
    const riskScore = clamp(Math.round(0.62 * (100 - quant.ability) + recencyPenalty + weakPenalty + recitePenalty + knowledgePenalty));
    const targetScore = Number(targetScores[quant.subject] ?? 0) || null;
    const targetIntensityPct = targetScore == null ? null : Math.round((targetScore / quant.weight) * 100);
    const drivers = [];
    if (quant.covered === 0) drivers.push("尚未形成章节覆盖证据");
    if (daysSinceStudy == null) drivers.push("没有学习流水");
    else if (daysSinceStudy > 7) drivers.push(`${daysSinceStudy} 天未出现该科学习流水`);
    if (highRiskTopics) drivers.push(`${highRiskTopics} 个高风险弱项主题`);
    if (recurrentTopics) drivers.push(`${recurrentTopics} 个复发主题`);
    if (highRiskRecite) drivers.push(`${highRiskRecite} 个高掉落风险背诵点`);
    if (highRiskKnowledgePoints) drivers.push(`${highRiskKnowledgePoints} 个高风险知识点证据状态`);
    if (!drivers.length) drivers.push("暂无额外高风险信号");
    return {
      subject: quant.subject,
      weight: quant.weight,
      ability: quant.ability,
      targetScore,
      targetIntensityPct,
      readinessIndex: 100 - riskScore,
      riskScore,
      urgency: urgencyFor(riskScore),
      latestStudyDate: latest,
      daysSinceStudy,
      highRiskTopics,
      recurrentTopics,
      highRiskRecite,
      highRiskKnowledgePoints,
      drivers,
    };
  }).sort((left, right) => right.riskScore - left.riskScore || right.weight - left.weight);
  const weightTotal = subjects.reduce((sum, subject) => sum + subject.weight, 0);
  const overallRisk = weightTotal
    ? Math.round(subjects.reduce((sum, subject) => sum + subject.riskScore * subject.weight, 0) / weightTotal)
    : null;
  return {
    calibration: {
      status: records.length ? "limited" : "uncalibrated",
      mockCount: records.length,
      canProjectScore: false,
      reason: records.length
        ? "已有模考记录，但尚未建立能力指标到卷面分的稳定映射"
        : "尚无成套模考分；只输出风险排序，不伪造卷面预测或胜率",
    },
    overallRisk,
    overallReadiness: overallRisk == null ? null : 100 - overallRisk,
    subjects,
    topRisks: subjects.slice(0, 5),
  };
}

function priorityFor(score) {
  if (score >= 90) return "P0";
  if (score >= 68) return "P1";
  return "P2";
}

function recencyBoostFor(candidate, referenceDate) {
  const latest = String(candidate.latestOpenDate ?? "");
  if (!validDate(latest)) return 0;
  const days = daysBetween(latest, referenceDate);
  return days != null && days >= 0 && days <= 3 ? 8 : 0;
}

// 风险分去饱和（2026-08-07）：原始风险分常顶到 100、Top 3 无区分度。
// 按科内相对位置拉开差距（科内第一 100、线性降到 55），再叠“新错加权 +8”
// 与“积压限流 -6”；rawScore 仍保留供审计。产出仍是 0-100 调度分，
// 不是遗忘概率或卷面分。
export function desaturateDispatchScores(candidates, referenceDate) {
  const bySubject = new Map();
  for (const candidate of candidates) {
    const list = bySubject.get(candidate.subject) ?? [];
    list.push(candidate);
    bySubject.set(candidate.subject, list);
  }
  const scored = [];
  for (const list of bySubject.values()) {
    const ordered = [...list].sort(
      (a, b) => b.sourceRisk - a.sourceRisk
        || String(a.dueDate).localeCompare(String(b.dueDate))
        || String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
    );
    const n = ordered.length;
    const backlogPenalty = n > 6 ? 6 : 0;
    ordered.forEach((candidate, index) => {
      const withinRankScore = n <= 1 ? 85 : Math.max(55, Math.round(100 - (index / (n - 1)) * 30));
      const recencyBoost = recencyBoostFor(candidate, referenceDate);
      const score = clamp(Math.round(0.6 * candidate.sourceRisk + 0.4 * withinRankScore + recencyBoost - backlogPenalty));
      scored.push({
        ...candidate,
        rawScore: candidate.sourceRisk,
        withinRankScore,
        recencyBoost,
        backlogPenalty,
        score,
      });
    });
  }
  return scored;
}

function diverseTop(candidates, limit) {
  const selected = [];
  const usedSubjects = new Set();
  const counts = new Map();
  const quotaPerSubject = Math.max(1, Math.ceil(limit / 2)); // limit=3 → 每科最多 2 件，保证 ≥2 科
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (usedSubjects.has(candidate.subject)) continue;
    selected.push(candidate);
    usedSubjects.add(candidate.subject);
    counts.set(candidate.subject, 1);
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selected.includes(candidate)) continue;
    const used = counts.get(candidate.subject) ?? 0;
    if (used >= quotaPerSubject) continue;
    selected.push(candidate);
    counts.set(candidate.subject, used + 1);
  }
  return selected;
}

function activePattern(profile) {
  const pattern = profile?.primaryPattern ?? null;
  return pattern && pattern.status !== "retired" ? pattern : null;
}

function targetedTask(base, profile, { scope = "point", subject = null } = {}) {
  const pattern = activePattern(profile);
  if (!pattern) return base;
  if (pattern.status === "pending") return `${base}；顺带验证候选栽点「${pattern.label}」，未认领前不写成定论`;
  if (scope === "subject") {
    return `${subject ?? "该科"}已确认出现「${pattern.label}」${pattern.habitual ? "的跨知识点复发" : ""}，本轮只练${pattern.focus}`;
  }
  return `你在该点主要栽在「${pattern.label}」，本轮只练${pattern.focus}`;
}

function patternRiskBoost(pattern, scope) {
  if (!pattern) return 0;
  if (pattern.status === "pending") return 1;
  if (scope === "subject") return pattern.habitual ? 6 : 2;
  return pattern.status === "confirmed" ? 8 : 5;
}

function habitualSubjectPortrait(profile) {
  return profile?.primaryPattern?.habitual ? profile : null;
}

function knowledgeDispatchMetadata(item) {
  if (["unseen", "exposed"].includes(item.stage)) {
    return { route: "ask-pc", dimension: "understanding", type: "知识点理解" };
  }
  if (item.stage === "understanding") {
    return { route: "daibei-pc", dimension: "recall", type: "知识点复述" };
  }
  if (item.stage === "recall") {
    return { route: "cuoti-fupan", dimension: "application", type: "知识点精准复检" };
  }
  const coldDimensions = new Set(item.stability?.dimensions ?? []);
  if (!coldDimensions.has("recall")) return { route: "daibei-pc", dimension: "recall", type: "知识点冷复述" };
  if (!coldDimensions.has("application")) return { route: "cuoti-fupan", dimension: "application", type: "知识点精准复检" };
  const latestCold = [...(item.evidence ?? [])]
    .filter((row) => row.valid && row.cold && row.result === "pass" && row.promptIntegrity === "clean" && ["recall", "application"].includes(row.dimension))
    .sort((left, right) => left.evidenceDate.localeCompare(right.evidenceDate) || left.sequence - right.sequence)
    .at(-1);
  return latestCold?.dimension === "application"
    ? { route: "daibei-pc", dimension: "recall", type: "知识点冷复述" }
    : { route: "cuoti-fupan", dimension: "application", type: "知识点精准复检" };
}

function redirectToPrerequisite(candidate, knowledgeGraph, knowledgeById) {
  if (!candidate.kpId) return candidate;
  const node = (knowledgeGraph?.byKnowledgePoint ?? []).find((item) => item.kpId === candidate.kpId);
  const blockers = node?.blockers ?? [];
  if (!blockers.length) return candidate;
  const blocker = [...blockers].sort((left, right) => Number(right.root) - Number(left.root) || right.path.length - left.path.length || right.strength - left.strength)[0];
  const prerequisite = knowledgeById.get(blocker.kpId);
  if (!prerequisite) return candidate;
  const dispatch = knowledgeDispatchMetadata(prerequisite);
  const target = { kpId: candidate.kpId, title: candidate.title, kind: candidate.kind, sourceId: candidate.id };
  return {
    ...candidate,
    kind: "knowledge",
    id: prerequisite.kpId,
    kpId: prerequisite.kpId,
    subject: prerequisite.subject,
    title: prerequisite.name ?? prerequisite.kpId,
    type: "知识点前置补洞",
    route: dispatch.route,
    dimension: dispatch.dimension,
    dueDate: [candidate.dueDate, prerequisite.dueDate].filter(Boolean).sort()[0] ?? candidate.dueDate,
    sourceRisk: clamp(Math.round(Math.max(candidate.sourceRisk, prerequisite.riskScore ?? 0) + Math.min(12, blocker.strength * 2))),
    task: `${prerequisite.kpId}（${prerequisite.name ?? "未命名前置"}）：它是 ${target.kpId}（${target.title ?? "目标知识点"}）的前置，须先达到 ${blocker.requiredStage}；当前 ${prerequisite.stageLabel ?? prerequisite.stage}。${prerequisite.nextAction}`,
    baseRef: `coach-engine:knowledge:${prerequisite.kpId}:prerequisite`,
    knowledgeStage: prerequisite.stage,
    prerequisiteFor: [target],
    prerequisitePath: blocker.path,
    redirectedFrom: { kind: candidate.kind, id: candidate.id, kpId: candidate.kpId, route: candidate.route, dimension: candidate.dimension },
    // [gpt] 2026-08-10：依赖点的栽点不能自动传播给前置点；前置点须用自己的证据重新画像。
    failurePattern: null,
    ankiReference: prerequisite.anki,
  };
}

function mergePrerequisiteRedirects(candidates) {
  const output = [];
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!candidate.prerequisiteFor) {
      output.push(candidate);
      continue;
    }
    const key = `${candidate.kpId}:${candidate.route}:${candidate.dimension}`;
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, candidate);
      output.push(candidate);
      continue;
    }
    known.sourceRisk = Math.max(known.sourceRisk, candidate.sourceRisk);
    known.prerequisiteFor.push(...candidate.prerequisiteFor.filter((target) => !known.prerequisiteFor.some((item) => item.kpId === target.kpId)));
    if (known.prerequisiteFor.length > 1) {
      known.task += `；同一前置还将解锁 ${known.prerequisiteFor.slice(1).map((item) => item.kpId).join("、")}`;
    }
  }
  return output;
}

function attachInterventionMetadata(candidate, interventionResponse, forecastByKp, referenceDate) {
  const pattern = candidate.failurePattern;
  if (!pattern?.code) return candidate;
  const prior = findInterventionResponse(interventionResponse, {
    patternCode: pattern.code,
    route: candidate.route,
    dimension: candidate.dimension,
  });
  const calibrationNote = prior?.status === "needs-redesign"
    ? "；【策略校准】历史同病根干预响应低，先复核病根并改变问法，禁止机械重复"
    : prior?.status === "mixed"
      ? "；【策略校准】历史响应混合，本轮必须换验证角度并留结构化结果"
      : "";
  // [gpt] route/dimension 之下再选择可比较的具体教法；选择理由随派单快照审计。
  const protocol = selectInterventionProtocol({
    patternCode: pattern.code,
    subject: candidate.subject,
    route: candidate.route,
    dimension: candidate.dimension,
    interventionResponse,
    decisionKey: `${referenceDate}:${candidate.kpId ?? candidate.id}:${candidate.baseRef}`,
  });
  const protocolNote = protocol
    ? `；【干预协议·${protocol.label}】${protocol.instruction}`
    : "";
  return {
    ...candidate,
    task: `${candidate.task}${calibrationNote}${protocolNote}`,
    intervention: {
      code: interventionResponseKey(pattern.code, candidate.route, candidate.dimension),
      protocolCode: protocol?.code ?? null,
      protocolVersion: protocol?.version ?? null,
      protocolLabel: protocol?.label ?? null,
      selectionMode: protocol?.mode ?? null,
      selectionReason: protocol?.reason ?? null,
      failurePatternCode: pattern.code,
      failurePatternScope: pattern.scope,
      kpId: candidate.kpId ?? null,
      baselineRisk: candidate.kpId ? forecastByKp.get(candidate.kpId) ?? null : null,
      expectedOutcome: "clean-pass",
      prior: prior ? {
        status: prior.status,
        countable: prior.counts.countable,
        distinctKps: prior.counts.distinctKps,
        observedCleanPassRate: prior.observedCleanPassRate,
      } : null,
    },
  };
}

export function buildPredictiveDispatch({ referenceDate, topicStates, reciteMemory, knowledgeStates, knowledgeGraph, failurePortrait, examRisk, examForecast, interventionResponse, limit = 3 }) {
  const examBySubject = new Map((examRisk?.subjects ?? []).map((item) => [item.subject, item]));
  const knowledgeById = new Map((knowledgeStates?.items ?? []).map((item) => [item.kpId, item]));
  const profileByKp = new Map((failurePortrait?.byKnowledgePoint ?? []).map((item) => [item.kpId, item]));
  const profileBySubject = new Map((failurePortrait?.bySubject ?? []).map((item) => [item.subject, item]));
  const topicCandidates = (topicStates?.items ?? [])
    .filter((item) => item.dueDate <= referenceDate || item.riskScore >= 75)
    .map((item) => {
      const pointState = item.kpId ? knowledgeById.get(item.kpId) : null;
      const pointPortrait = item.kpId ? profileByKp.get(item.kpId) : null;
      const portrait = pointPortrait ?? habitualSubjectPortrait(profileBySubject.get(item.subject));
      const portraitScope = pointPortrait ? "point" : "subject";
      const pattern = activePattern(portrait);
      const baseRisk = Math.max(item.riskScore, pointState?.riskScore ?? 0);
      const sourceRisk = clamp(Math.round(baseRisk + (examBySubject.get(item.subject)?.riskScore ?? 0) * 0.15 + patternRiskBoost(pattern, portraitScope)));
      const probeSuffix = item.nextProbe
        ? `；下一探针 ${item.nextProbe.variantLabel}/L${item.nextProbe.transferLevel}，验证「${item.nextProbe.probeAxisLabel}」，最早 ${item.nextProbe.earliestDate}`
        : "";
      return {
        kind: "topic",
        id: `T${item.id}`,
        kpId: item.kpId ?? null,
        subject: item.subject,
        title: item.title,
        score: sourceRisk,
        sourceRisk,
        latestOpenDate: item.latestOpenDate ?? "",
        dueDate: item.dueDate,
        type: "错题冷复检",
        route: "cuoti-fupan",
        dimension: "application",
        task: `T#${item.id}（${item.title}${item.kpId ? `｜${item.kpId}` : ""}）：${targetedTask(item.nextAction, portrait, { scope: portraitScope, subject: item.subject })}${probeSuffix}`,
        baseRef: `coach-engine:topic:T${item.id}`,
        knowledgeStage: pointState?.stage ?? null,
        failurePattern: pattern ? { code: pattern.pattern, label: pattern.label, status: pattern.status, focus: pattern.focus, scope: portraitScope } : null,
        reviewProbe: item.nextProbe ?? null,
        ankiReference: pointState?.anki ?? null,
      };
    });
  const reciteCandidates = (reciteMemory?.items ?? [])
    .filter((item) => item.route === "daibei" && (item.dueDate <= referenceDate || item.dropRisk >= 65))
    .map((item) => {
      const kpId = item.primaryKpId ?? (item.kpIds?.length === 1 ? item.kpIds[0] : null);
      const knowledgeLinkStatus = kpId ? "linked" : item.kpIds?.length ? "ambiguous" : "unlinked";
      const pointState = kpId ? knowledgeById.get(kpId) : null;
      const pointPortrait = kpId ? profileByKp.get(kpId) : null;
      const portrait = pointPortrait ?? habitualSubjectPortrait(profileBySubject.get(item.subject));
      const portraitScope = pointPortrait ? "point" : "subject";
      const pattern = activePattern(portrait);
      const sourceRisk = clamp(Math.round(Math.max(item.dropRisk, pointState?.riskScore ?? 0) + (examBySubject.get(item.subject)?.riskScore ?? 0) * 0.15 + patternRiskBoost(pattern, portraitScope)));
      return {
        kind: "recite",
        id: item.id,
        kpId,
        subject: item.subject,
        title: item.title,
        score: sourceRisk,
        sourceRisk,
        latestOpenDate: "",
        dueDate: item.dueDate,
        type: "带背复检",
        route: "daibei-pc",
        dimension: "recall",
        task: `${item.id}（${item.title}${kpId ? `｜${kpId}` : ""}）：${targetedTask("冷启动复检并把结果回写带背挂账", portrait, { scope: portraitScope, subject: item.subject })}${knowledgeLinkStatus === "unlinked" ? "；【接线债】尚未映射稳定 KP，证据先留带背账，补映射后可追溯接入" : knowledgeLinkStatus === "ambiguous" ? "；【接线冲突】关联多个 KP，本轮证据先留带背账，确认唯一主 KP 后再接入" : ""}`,
        baseRef: `coach-engine:recite:${item.id}`,
        knowledgeLinkStatus,
        knowledgeStage: pointState?.stage ?? null,
        failurePattern: pattern ? { code: pattern.pattern, label: pattern.label, status: pattern.status, focus: pattern.focus, scope: portraitScope } : null,
        ankiReference: pointState?.anki ?? null,
      };
    });
  const coveredKpIds = new Set([...topicCandidates, ...reciteCandidates].map((item) => item.kpId).filter(Boolean));
  const knowledgeCandidates = (knowledgeStates?.active ?? [])
    .filter((item) => !coveredKpIds.has(item.kpId) && (item.dueDate <= referenceDate || item.riskScore >= 65))
    .map((item) => {
      const dispatch = knowledgeDispatchMetadata(item);
      const pointPortrait = profileByKp.get(item.kpId);
      const portrait = pointPortrait ?? habitualSubjectPortrait(profileBySubject.get(item.subject));
      const portraitScope = pointPortrait ? "point" : "subject";
      const pattern = activePattern(portrait);
      const sourceRisk = clamp(Math.round(item.riskScore + (examBySubject.get(item.subject)?.riskScore ?? 0) * 0.15 + patternRiskBoost(pattern, portraitScope)));
      return {
        kind: "knowledge",
        id: item.kpId,
        kpId: item.kpId,
        subject: item.subject,
        title: item.name ?? item.kpId,
        score: sourceRisk,
        sourceRisk,
        latestOpenDate: item.lastEvidenceDate ?? "",
        dueDate: item.dueDate,
        type: dispatch.type,
        route: dispatch.route,
        dimension: dispatch.dimension,
        task: `${item.kpId}（${item.name ?? "未命名知识点"}｜${item.stageLabel}）：${targetedTask(item.nextAction, portrait, { scope: portraitScope, subject: item.subject })}`,
        baseRef: `coach-engine:knowledge:${item.kpId}`,
        knowledgeStage: item.stage,
        sprintLane: item.sprintLane,
        failurePattern: pattern ? { code: pattern.pattern, label: pattern.label, status: pattern.status, focus: pattern.focus, scope: portraitScope } : null,
        ankiReference: item.anki,
      };
    });
  // [gpt] 2026-08-10：目标有未满足 confirmed 前置时，派单先转向根前置；图谱不改变状态，只改变顺序。
  const graphOrdered = mergePrerequisiteRedirects(
    [...topicCandidates, ...reciteCandidates, ...knowledgeCandidates]
      .map((candidate) => redirectToPrerequisite(candidate, knowledgeGraph, knowledgeById)),
  );
  // [gpt] 2026-08-10：定向病根任务携带事前失分基线和历史响应，写进排期后可事后校准。
  const forecastByKp = new Map((examForecast?.hotspots ?? []).map((item) => [item.kpId, item.lossRiskIndex]));
  const interventionAware = graphOrdered.map((candidate) => attachInterventionMetadata(candidate, interventionResponse, forecastByKp, referenceDate));
  const desaturated = desaturateDispatchScores(interventionAware, referenceDate);
  const ranked = desaturated
    .sort((left, right) => right.score - left.score || String(left.dueDate).localeCompare(String(right.dueDate)) || left.id.localeCompare(right.id, "en", { numeric: true }))
    .map((candidate, index) => ({ ...candidate, rank: index + 1, priority: priorityFor(candidate.score) }));
  const queue = ranked.slice(0, 20);
  // 先在完整候选集上做科目多样化，再截今日队列；否则单科高风险项可占满 top20，
  // 让“优先跨科”策略名存实亡。queue 仍保留纯风险榜，便于审计排序。
  const today = diverseTop(ranked, limit);
  let p0Used = false;
  const normalizedToday = today.map((candidate) => {
    let priority = candidate.priority;
    if (priority === "P0") {
      if (p0Used) priority = "P1";
      p0Used = true;
    }
    const scheduleId = `AUTO-${referenceDate.replaceAll("-", "")}-${candidate.kind === "topic" ? candidate.id : candidate.kind === "recite" ? `R${candidate.id}` : `K${candidate.id.replaceAll("-", "")}`}`;
    return {
      ...candidate,
      priority,
      dispatchRef: `${candidate.baseRef}:${referenceDate}`,
      scheduleId,
      intervention: candidate.intervention?.protocolCode ? {
        ...candidate.intervention,
        episodeId: `EP-${scheduleId}`,
        observationWindow: "immediate",
      } : candidate.intervention,
    };
  });
  return { queue, today: normalizedToday, policy: { maxToday: limit, maxP0: 1, diversity: "prefer-subject-diversity", unit: "knowledge-point × failure-pattern when confirmed" } };
}

/**
 * 按判断台账校准系数折算派单量（2026-08-07 P2）。
 * 历史任务量高估 → 可信执行量 = limit × 系数（四舍五入，最少 1 件）。
 * [gpt] 2026-08-10：台账结果不编码“低估”，因此只允许减量，不再接受自动加量系数。
 */
export function fitDispatchToSchedule(candidates, actionable = [], limit = 3, calibration = null, controller = null) {
  let effectiveLimit = limit;
  let adjustment = null;
  let controllerAdjustment = null;
  const factor = calibration?.executionFactor;
  if (factor && Number.isFinite(Number(factor.value))) {
    const raw = Math.round(limit * factor.value);
    if (factor.value < 1) {
      effectiveLimit = Math.max(1, raw);
      adjustment = { kind: "reduce", reason: factor.basis, from: limit, to: effectiveLimit, factor: factor.value };
    }
  }
  // [gpt] 2026-08-10：控制器只削外围负载，不静默降低既有 P0 验收标准或丢弃到期维护义务。
  const controllerLimit = Number(controller?.policy?.maxNewDaily);
  if (Number.isInteger(controllerLimit) && controllerLimit >= 1 && controllerLimit < effectiveLimit) {
    controllerAdjustment = { kind: "controller", mode: controller.mode, reason: controller.reason, from: effectiveLimit, to: controllerLimit };
    effectiveLimit = controllerLimit;
  }
  const availableSlots = Math.max(0, effectiveLimit - actionable.length);
  const existingP0 = actionable.some((item) => item.priority === "P0");
  let newP0Used = false;
  const currentWeek = controller?.currentWeek;
  const currentWeekEnd = controller?.current?.weekEnd;
  const isCurrentWeek = (item) => item.planWeek
    ? item.planWeek === currentWeek
    : item.dueDate && currentWeek && currentWeekEnd && item.dueDate >= currentWeek && item.dueDate <= currentWeekEnd;
  const currentPlannedP1 = Number(controller?.current?.byPriority?.P1?.plannedUnits ?? 0);
  let p1Used = Math.max(currentPlannedP1, actionable.filter((item) => item.priority === "P1" && isCurrentWeek(item)).length);
  const allowP2 = controller?.policy?.allowP2 ?? true;
  const maxP1 = Number.isInteger(controller?.policy?.maxP1PerWeek) ? controller.policy.maxP1PerWeek : Number.POSITIVE_INFINITY;
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= availableSlots) break;
    if (candidate.priority === "P2" && !allowP2) continue;
    if (controller?.mode === "rescue" && candidate.priority !== "P0") continue;
    let priority = candidate.priority;
    if (priority === "P0" && (existingP0 || newP0Used)) {
      // [gpt] 2026-08-10：降载模式下宁可延后候选，也不把第二个 P0 偷改成 P1；normal 保留旧兼容行为。
      if (controller && controller.mode !== "normal") continue;
      priority = "P1";
    }
    if (priority === "P1" && p1Used >= maxP1) continue;
    if (priority === "P0") newP0Used = true;
    if (priority === "P1") p1Used += 1;
    selected.push({ ...candidate, priority });
  }
  return { selected, availableSlots, existingActionable: actionable.length, effectiveLimit, adjustment, controllerAdjustment };
}

export function buildLearningCoachSnapshot(input) {
  const topicStates = buildTopicLearningStates(input.errorSummary, input.reviews, input.referenceDate, { objectLinks: input.knowledgeObjectLinks });
  const reciteMemory = buildReciteMemoryModel(input.reciteParsed, input.referenceDate, { objectLinks: input.knowledgeObjectLinks });
  const reciteKnowledgeEvidence = reciteEvidenceFromLinks(reciteMemory, input.knowledgeObjectLinks ?? []);
  const allKnowledgeEvidence = [...(input.knowledgeEvidence ?? []), ...reciteKnowledgeEvidence];
  const knowledgeStates = buildKnowledgePointStates({
    catalog: input.knowledgeCatalog,
    evidence: allKnowledgeEvidence,
    objectLinks: input.knowledgeObjectLinks,
    referenceDate: input.referenceDate,
    examDate: input.examDate,
  });
  const knowledgeGraph = buildKnowledgeGraph({
    catalog: input.knowledgeCatalog,
    relations: input.knowledgeRelations ?? [],
    knowledgeStates,
  });
  const failurePortrait = buildFailurePortrait({
    errorRows: input.errorBookRows,
    knowledgeEvidence: allKnowledgeEvidence,
    objectLinks: input.knowledgeObjectLinks,
    catalog: input.knowledgeCatalog,
  });
  const examRisk = buildExamRiskModel({
    referenceDate: input.referenceDate,
    quantV3: input.quantV3,
    studyLogs: input.studyLogs,
    topicStates,
    reciteMemory,
    knowledgeStates,
    knowledgeGraph,
    targets: input.targets,
    mockRecords: input.mockRecords,
  });
  const examForecast = buildExamLossForecast({
    referenceDate: input.referenceDate,
    examDate: input.examDate,
    knowledgeStates,
    knowledgeGraph,
    failurePortrait,
    studyLogs: input.studyLogs,
    targets: input.targets,
    mockRecords: input.mockRecords,
  });
  const interventionResponse = buildInterventionResponse({
    reviewSchedule: input.reviewSchedule,
    examForecast,
    failurePortrait,
    referenceDate: input.referenceDate,
  });
  const controller = buildLearningController({
    schedule: input.reviewSchedule,
    referenceDate: input.referenceDate,
    milestoneRisk: input.milestoneRisk ?? null,
  });
  const dispatch = buildPredictiveDispatch({
    referenceDate: input.referenceDate,
    topicStates,
    reciteMemory,
    knowledgeStates,
    knowledgeGraph,
    failurePortrait,
    examRisk,
    examForecast,
    interventionResponse,
    limit: input.dispatchLimit ?? 3,
  });
  // 933 个目录点可随时由 catalog+evidence 重算；快照只携带已激活点，避免把 Anki
  // 元数据重复展开成兆级 JSON。counts 仍覆盖完整目录。
  const knowledgeStateSnapshot = Object.fromEntries(Object.entries(knowledgeStates).filter(([key]) => !["items", "active"].includes(key)));
  knowledgeStateSnapshot.items = knowledgeStates.active;
  return {
    schemaVersion: 3,
    modelVersion: LEARNING_COACH_VERSION,
    referenceDate: input.referenceDate,
    topicStates,
    reciteMemory,
    knowledgeStates: knowledgeStateSnapshot,
    knowledgeGraph,
    failurePortrait,
    examRisk,
    examForecast,
    interventionResponse,
    controller,
    dispatch,
    caveat: "衰减/失分压力只用于调度排序，不是记忆概率；同口径完整模考少于 3 次不报分、少于 6 次不报概率。图谱只改学习顺序，Anki 不构成掌握证据。",
  };
}

export function formatLearningCoachSummary(snapshot) {
  const states = snapshot.topicStates.counts;
  // [gpt] 2026-08-10：快照摘要暴露 route/dimension，报告层不再二次猜 owner。
  const top = snapshot.dispatch.today.map((item) => `[${item.priority}] ${item.subject}·${item.id} ${item.title}→${item.route}/${item.dimension}`).join("；") || "无到期候选";
  const exam = snapshot.examRisk.topRisks.map((item) => `${item.subject}${item.riskScore}`).join(" / ") || "无";
  return [
    `智能教练快照（北京 ${snapshot.referenceDate}，model v${snapshot.modelVersion}）`,
    `弱项状态：发现${states.discovered} / 确认${states.confirmed} / 强化${states.reinforcing} / 短期通过${states.short_pass} / 冷却${states.cooling} / 稳定${states.stable} / 长期保持${states.maintenance}`,
    `预测复习：主题到期 ${snapshot.topicStates.due.length} / 带背到期 ${snapshot.reciteMemory.counts.due} / 带背高掉落风险 ${snapshot.reciteMemory.counts.highRisk}`,
    `带背接线：唯一主链接 ${snapshot.reciteMemory.counts.linked}/${snapshot.reciteMemory.counts.items} / 零链接 ${snapshot.reciteMemory.counts.unlinked} / 主链接歧义 ${snapshot.reciteMemory.counts.ambiguousLinks}（未接入且有证据 ${snapshot.reciteMemory.counts.evidenceUnlinked}）/ 含 related 的多链接记录 ${snapshot.reciteMemory.counts.multiLinked}`,
    `知识点状态：已激活 ${snapshot.knowledgeStates.counts.activated}/${snapshot.knowledgeStates.counts.total} / 可派单 ${snapshot.knowledgeStates.counts.dispatchEligible} / 稳定 ${snapshot.knowledgeStates.counts.activatedByStage.stable} / 考试就绪 ${snapshot.knowledgeStates.counts.examReady} / 冲刺通道 ${snapshot.knowledgeStates.counts.sprintLane}`,
    `时间衰减：已回落 ${snapshot.knowledgeStates.counts.decayed} / 衰减到期 ${snapshot.knowledgeStates.counts.dueByDecay}；图谱确认前置 ${snapshot.knowledgeGraph.counts.confirmedPrerequisites} / 活跃目标受阻 ${snapshot.knowledgeGraph.counts.activeBlockedTargets} / 环 ${snapshot.knowledgeGraph.counts.cycles}`,
    `栽点画像：知识点级确认/观察 ${snapshot.failurePortrait.counts.activeConfirmed} / 待认领 ${snapshot.failurePortrait.counts.pending} / 已退役 ${snapshot.failurePortrait.counts.retired}；科目级确认 ${snapshot.failurePortrait.counts.subjectActiveConfirmed} / 习惯性 ${snapshot.failurePortrait.counts.habitual}`,
    `考试风险排序（调度分，非卷面分）：${exam}；校准=${snapshot.examRisk.calibration.status}`,
    `考试失分前瞻：${snapshot.examForecast.hotspots.slice(0, 3).map((item) => `${item.kpId}:${item.lossRiskIndex}`).join(" / ") || "无已观测点"}；校准=${snapshot.examForecast.calibration.status}/${snapshot.examForecast.calibration.rankingConfidence}，可投影卷面分=${snapshot.examForecast.calibration.canProjectScore ? "是" : "否"}，可报达标概率=${snapshot.examForecast.calibration.canProjectProbability ? "是" : "否"}`,
    `干预响应：episode ${snapshot.interventionResponse.counts.episodes} / 结构化观察 ${snapshot.interventionResponse.counts.structuredObservations} / 具体协议 ${snapshot.interventionResponse.counts.protocols} / 已支持 ${snapshot.interventionResponse.counts.supported} / 待改 ${snapshot.interventionResponse.counts.needsRedesign}`,
    formatLearningController(snapshot.controller),
    `今日建议：${top}`,
    snapshot.caveat,
  ].join("\n");
}
