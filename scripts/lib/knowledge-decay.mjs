// [gpt] 2026-08-10：知识状态 v3 的时间衰减内核。
// 历史表现证据保持不可变；本模块只派生“截至某日仍可依赖到什么程度”的调度视图。

const DAY = 86400000;

export const KNOWLEDGE_DECAY_VERSION = "3.0";

export const DECAY_DEFAULTS = Object.freeze({
  exposure: { halfLifeDays: 5, currentThreshold: 35, reviewThreshold: 72 },
  understanding: { halfLifeDays: 28, currentThreshold: 55, reviewThreshold: 76 },
  recall: { halfLifeDays: 14, currentThreshold: 60, reviewThreshold: 78 },
  application: { halfLifeDays: 21, currentThreshold: 60, reviewThreshold: 76 },
});

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

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function qualifies(row) {
  return row?.valid !== false
    && validDate(row?.evidenceDate)
    && row?.result !== "void"
    && row?.promptIntegrity !== "invalid";
}

function cleanPass(row) {
  return qualifies(row) && row.result === "pass" && row.promptIntegrity === "clean";
}

function orderedEvidence(evidence, dimensions, referenceDate) {
  return (evidence ?? [])
    .filter((row) => dimensions.includes(row.dimension) && qualifies(row) && row.evidenceDate <= referenceDate)
    .sort((left, right) => left.evidenceDate.localeCompare(right.evidenceDate) || (left.sequence ?? 0) - (right.sequence ?? 0));
}

function observedForgettingIntervals(rows) {
  const intervals = [];
  let lastPass = null;
  for (const row of rows) {
    if (cleanPass(row)) {
      lastPass = row;
      continue;
    }
    if (!["partial", "fail"].includes(row.result) || !lastPass) continue;
    const interval = daysBetween(lastPass.evidenceDate, row.evidenceDate);
    if (interval != null && interval > 0) intervals.push(interval);
    lastPass = null;
  }
  return intervals;
}

function successfulSpacing(rows) {
  const dates = [...new Set(rows.filter((row) => cleanPass(row) && row.cold).map((row) => row.evidenceDate))].sort();
  return dates.slice(1).map((date, index) => daysBetween(dates[index], date)).filter((value) => value != null && value > 0);
}

function lastSetbackIndex(rows) {
  let index = -1;
  rows.forEach((row, current) => {
    if (["partial", "fail"].includes(row.result)) index = current;
  });
  return index;
}

function estimateHalfLife(rows, dimension) {
  const defaults = DECAY_DEFAULTS[dimension];
  const forgettingIntervals = observedForgettingIntervals(rows);
  const spacing = successfulSpacing(rows);
  const setbackIndex = lastSetbackIndex(rows);
  const currentPasses = rows.slice(setbackIndex + 1).filter(cleanPass);
  const uniquePassDates = new Set(currentPasses.map((row) => row.evidenceDate)).size;
  const coldPasses = currentPasses.filter((row) => row.cold).length;
  // 一次冷检只是建立基线；只有跨日重复提取才延长估计半衰期。
  const practiceMultiplier = 1 + Math.min(1.6, Math.max(0, uniquePassDates - 1) * 0.18 + Math.max(0, coldPasses - 1) * 0.22);

  if (forgettingIntervals.length) {
    return {
      halfLifeDays: clamp(Math.round(median(forgettingIntervals)), 2, 180),
      source: "observed-pass-to-setback",
      confidence: forgettingIntervals.length >= 2 ? "high" : "medium",
      forgettingIntervals,
      successfulSpacing: spacing,
      uniquePassDates,
      coldPasses,
    };
  }

  const practicedDefault = defaults.halfLifeDays * practiceMultiplier;
  if (spacing.length) {
    return {
      halfLifeDays: clamp(Math.round(Math.max(practicedDefault, median(spacing) * 1.2)), 2, 180),
      source: "successful-spacing-lower-bound",
      confidence: spacing.length >= 2 ? "medium" : "low",
      forgettingIntervals,
      successfulSpacing: spacing,
      uniquePassDates,
      coldPasses,
    };
  }

  return {
    halfLifeDays: clamp(Math.round(practicedDefault), 2, 180),
    source: "dimension-default",
    confidence: uniquePassDates >= 3 ? "medium" : "low",
    forgettingIntervals,
    successfulSpacing: spacing,
    uniquePassDates,
    coldPasses,
  };
}

function daysUntilIndex(halfLifeDays, targetIndex) {
  return Math.max(0, Math.ceil(halfLifeDays * Math.log2(100 / targetIndex)));
}

export function projectDecayIndex(decay, targetDate) {
  if (!decay?.supported || !validDate(decay.latestCleanPassDate) || !validDate(targetDate)) return 0;
  const ageDays = Math.max(0, daysBetween(decay.latestCleanPassDate, targetDate) ?? 0);
  return clamp(Math.round(100 * (0.5 ** (ageDays / decay.halfLifeDays))), 0, 100);
}

export function calculateDimensionDecay(evidence, dimension, referenceDate, { supportingDimensions = [dimension] } = {}) {
  if (!DECAY_DEFAULTS[dimension]) throw new Error(`未知衰减维度：${dimension}`);
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const rows = orderedEvidence(evidence, supportingDimensions, referenceDate);
  const estimate = estimateHalfLife(rows, dimension);
  const setbackIndex = lastSetbackIndex(rows);
  const currentPasses = rows.slice(setbackIndex + 1).filter(cleanPass);
  const latestPass = currentPasses.at(-1) ?? null;
  const defaults = DECAY_DEFAULTS[dimension];
  const supported = Boolean(latestPass);
  const ageDays = supported ? Math.max(0, daysBetween(latestPass.evidenceDate, referenceDate) ?? 0) : null;
  const retentionIndex = supported ? projectDecayIndex({ supported, latestCleanPassDate: latestPass.evidenceDate, halfLifeDays: estimate.halfLifeDays }, referenceDate) : 0;
  const nextReviewDate = supported ? shiftDate(latestPass.evidenceDate, daysUntilIndex(estimate.halfLifeDays, defaults.reviewThreshold)) : null;
  const expiresOn = supported ? shiftDate(latestPass.evidenceDate, daysUntilIndex(estimate.halfLifeDays, defaults.currentThreshold)) : null;
  const isCurrent = supported && retentionIndex >= defaults.currentThreshold;
  const isDue = supported && nextReviewDate <= referenceDate;
  const overdueDays = isDue ? Math.max(0, daysBetween(nextReviewDate, referenceDate) ?? 0) : 0;
  return {
    dimension,
    supported,
    isCurrent,
    retentionIndex,
    ageDays,
    halfLifeDays: estimate.halfLifeDays,
    currentThreshold: defaults.currentThreshold,
    reviewThreshold: defaults.reviewThreshold,
    nextReviewDate,
    expiresOn,
    isDue,
    overdueDays,
    latestCleanPassDate: latestPass?.evidenceDate ?? null,
    latestResult: rows.at(-1)?.result ?? null,
    evidenceCount: rows.length,
    calibration: estimate,
    status: !rows.length ? "unobserved" : !supported ? "not-demonstrated" : !isCurrent ? "decayed" : isDue ? "due" : "fresh",
  };
}

export function buildKnowledgeDecayProfile(evidence, referenceDate) {
  const dimensions = {
    exposure: calculateDimensionDecay(evidence, "exposure", referenceDate, { supportingDimensions: ["exposure", "understanding", "recall", "application"] }),
    understanding: calculateDimensionDecay(evidence, "understanding", referenceDate, { supportingDimensions: ["understanding", "recall", "application"] }),
    recall: calculateDimensionDecay(evidence, "recall", referenceDate),
    application: calculateDimensionDecay(evidence, "application", referenceDate),
  };
  const core = [dimensions.recall, dimensions.application].filter((item) => item.supported);
  const fallback = dimensions.understanding.supported ? [dimensions.understanding] : dimensions.exposure.supported ? [dimensions.exposure] : [];
  const measured = core.length ? core : fallback;
  const retentionIndex = measured.length
    ? Math.round(measured.reduce((sum, item) => sum + item.retentionIndex, 0) / measured.length)
    : 0;
  const observedIntervals = Object.values(dimensions).reduce((sum, item) => sum + item.calibration.forgettingIntervals.length, 0);
  const mediumOrHigh = Object.values(dimensions).filter((item) => ["medium", "high"].includes(item.calibration.confidence)).length;
  return {
    version: KNOWLEDGE_DECAY_VERSION,
    referenceDate,
    retentionIndex,
    dimensions,
    dueDimensions: Object.values(dimensions).filter((item) => item.isDue).map((item) => item.dimension),
    decayedDimensions: Object.values(dimensions).filter((item) => item.supported && !item.isCurrent).map((item) => item.dimension),
    confidence: observedIntervals >= 2 ? "high" : observedIntervals >= 1 || mediumOrHigh >= 2 ? "medium" : "low",
    policy: "retentionIndex 是时间衰减后的调度指数，不是记忆概率；历史通过仍保留在证据账中。",
  };
}
