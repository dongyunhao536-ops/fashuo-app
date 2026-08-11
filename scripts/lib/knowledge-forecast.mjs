// [gpt] 2026-08-10：从“今天哪里不会”推进到“按当前可观察节奏，考试日哪里最容易失分”。
// 输出始终保留可解释驱动项；无足够模考时只排名，不伪造卷面分或概率。

import { projectDecayIndex } from "./knowledge-decay.mjs";

const DAY = 86400000;

export const KNOWLEDGE_FORECAST_VERSION = "2.0";
export const SCORE_PROJECTION_MINIMUM = 3;
export const PROBABILITY_PROJECTION_MINIMUM = 6;

// [gpt] 目标分是策略线，不是卷面上限；趋势投影可以高于目标，但不能超过该科真实分值。
export const SUBJECT_SCORE_MAXIMUMS = Object.freeze({
  刑法: 75,
  刑法学: 75,
  民法: 75,
  民法学: 75,
  法理: 60,
  法理学: 60,
  宪法: 50,
  宪法学: 50,
  法制史: 40,
  中国法制史: 40,
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
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value));
}

function canonicalEvidence(items) {
  const rows = [];
  for (const item of items) {
    for (const row of item.evidence ?? []) rows.push({ ...row, kpId: item.kpId, subject: item.subject });
  }
  const unique = new Map();
  for (const row of rows) {
    const key = row.operationId
      ? `op:${row.operationId}`
      : [row.kpId, row.evidenceDate, row.dimension, row.result, row.sourceKind, row.sourceId, row.sequence].join("|");
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function observableCheck(row) {
  return row?.valid !== false
    && validDate(row?.evidenceDate)
    && row.result !== "void"
    && row.promptIntegrity !== "invalid";
}

function paceBucket({ subject, evidence, studyLogs, activeItems, referenceDate, windowStart, windowDays }) {
  const checks = evidence.filter((row) => (!subject || row.subject === subject)
    && row.evidenceDate >= windowStart && row.evidenceDate <= referenceDate && observableCheck(row));
  const cleanPasses = checks.filter((row) => row.result === "pass" && row.promptIntegrity === "clean");
  const coldChecks = checks.filter((row) => row.cold);
  const logs = (studyLogs ?? []).filter((row) => (!subject || row.subject === subject)
    && validDate(String(row.log_date ?? "")) && row.log_date >= windowStart && row.log_date <= referenceDate);
  const weeklyChecks = Number((checks.length * 7 / windowDays).toFixed(2));
  const weeklyCleanPasses = Number((cleanPasses.length * 7 / windowDays).toFixed(2));
  const dueDemand = activeItems.filter((item) => (!subject || item.subject === subject)
    && item.dueDate && item.dueDate <= shiftDate(referenceDate, 7)).length;
  const coverageRatio = dueDemand ? clamp(weeklyChecks / dueDemand, 0, 1) : checks.length ? 1 : 0;
  const distinctEvidenceDates = new Set(checks.map((row) => row.evidenceDate)).size;
  const distinctStudyDates = new Set(logs.map((row) => row.log_date)).size;
  const confidence = checks.length >= 20 && distinctEvidenceDates >= 6
    ? "high"
    : checks.length >= 8 && distinctEvidenceDates >= 3
      ? "medium"
      : "low";
  return {
    subject,
    windowStart,
    windowEnd: referenceDate,
    windowDays,
    checks: checks.length,
    cleanPasses: cleanPasses.length,
    coldChecks: coldChecks.length,
    distinctEvidenceDates,
    studyActions: logs.length,
    distinctStudyDates,
    weeklyChecks,
    weeklyCleanPasses,
    weeklyDueDemand: dueDemand,
    maintenanceCoverageIndex: Math.round(coverageRatio * 100),
    confidence,
  };
}

export function buildObservedPace({ knowledgeStates, studyLogs = [], referenceDate, windowDays = 28 } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  if (!Number.isInteger(windowDays) || windowDays < 7 || windowDays > 90) throw new Error("windowDays 必须是 7-90 整数");
  const items = knowledgeStates?.items ?? [];
  const activeItems = items.filter((item) => item.activated);
  const evidence = canonicalEvidence(items);
  const windowStart = shiftDate(referenceDate, -(windowDays - 1));
  const subjects = [...new Set(items.map((item) => item.subject).filter(Boolean))].sort();
  const overall = paceBucket({ subject: null, evidence, studyLogs, activeItems, referenceDate, windowStart, windowDays });
  const bySubject = subjects.map((subject) => paceBucket({ subject, evidence, studyLogs, activeItems, referenceDate, windowStart, windowDays }));
  return {
    overall,
    bySubject,
    status: overall.confidence === "low" ? "bootstrap" : "observed",
    policy: "当前节奏只按结构化表现证据与学习流水估计；低样本时不把缺记录等同于没学习。",
  };
}

function activePortraitFor(portrait, kpId) {
  const profile = (portrait?.byKnowledgePoint ?? []).find((item) => item.kpId === kpId)?.primaryPattern ?? null;
  return profile && profile.status !== "retired" ? profile : null;
}

function graphNode(graph, kpId) {
  return (graph?.byKnowledgePoint ?? []).find((item) => item.kpId === kpId) ?? null;
}

function coreRetentionAt(item, date) {
  const recall = projectDecayIndex(item.decay?.dimensions?.recall, date);
  const application = projectDecayIndex(item.decay?.dimensions?.application, date);
  return Math.round(recall * 0.42 + application * 0.58);
}

function riskBand(score) {
  if (score >= 82) return "critical";
  if (score >= 68) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function normalCdf(value) {
  // Abramowitz-Stegun 7.1.26；这里只用于低样本预测的有界近似，不制造小数位精度。
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-(absolute ** 2) / 2);
  const tail = density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - tail;
  return value >= 0 ? cdf : 1 - cdf;
}

function probabilityConfidence(samples, extrapolationRatio) {
  const base = samples >= 15 ? "high" : samples >= 10 ? "medium" : "low";
  if (extrapolationRatio <= 1 || base === "low") return base;
  return base === "high" ? "medium" : "low";
}

function linearProjection(points, targetDate, maximum, targetScore) {
  const ordered = [...points].sort((left, right) => left.date.localeCompare(right.date));
  const origin = ordered[0].date;
  const xs = ordered.map((item) => daysBetween(origin, item.date));
  const ys = ordered.map((item) => item.score);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, value) => sum + ((value - meanX) ** 2), 0);
  const slope = denominator ? xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0) / denominator : 0;
  const intercept = meanY - slope * meanX;
  const targetX = daysBetween(origin, targetDate);
  const predicted = clamp(intercept + slope * targetX, 0, maximum);
  const signedResiduals = xs.map((value, index) => ys[index] - (intercept + slope * value));
  const residuals = signedResiduals.map(Math.abs);
  const mae = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const sse = signedResiduals.reduce((sum, value) => sum + value ** 2, 0);
  // 个人模考样本很小时，即便恰好落在直线上也不能把误差当作 0；最低保留 2 分噪声。
  const residualSigma = Math.max(2, Math.sqrt(sse / Math.max(1, points.length - 2)));
  const leverage = (1 / points.length) + (denominator ? ((targetX - meanX) ** 2) / denominator : 1);
  const predictiveSd = residualSigma * Math.sqrt(1 + leverage);
  const meanSe = residualSigma * Math.sqrt(leverage);
  const margin = Math.max(2, 1.645 * predictiveSd);
  const observedSpan = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const horizon = Math.max(0, targetX - Math.max(...xs));
  const extrapolationRatio = Number((horizon / observedSpan).toFixed(2));
  const probabilityEligible = points.length >= PROBABILITY_PROJECTION_MINIMUM && Number.isFinite(targetScore);
  let attainmentProbability = null;
  let probabilityBand = null;
  let confidence = null;
  if (probabilityEligible) {
    const probability = clamp(normalCdf((predicted - targetScore) / predictiveSd), 0.02, 0.98);
    const lowerMean = predicted - 1.645 * meanSe;
    const upperMean = predicted + 1.645 * meanSe;
    const lower = clamp(normalCdf((lowerMean - targetScore) / predictiveSd), 0.01, 0.99);
    const upper = clamp(normalCdf((upperMean - targetScore) / predictiveSd), 0.01, 0.99);
    attainmentProbability = Math.round(probability * 100);
    probabilityBand = [Math.round(Math.min(lower, upper) * 100), Math.round(Math.max(lower, upper) * 100)];
    confidence = probabilityConfidence(points.length, extrapolationRatio);
  }
  return {
    projected: Math.round(predicted * 10) / 10,
    band: [Math.max(0, Math.round(predicted - margin)), Math.min(maximum, Math.round(predicted + margin))],
    trendPer30Days: Math.round(slope * 30 * 10) / 10,
    mae: Math.round(mae * 10) / 10,
    residualSigma: Math.round(residualSigma * 10) / 10,
    predictiveSd: Math.round(predictiveSd * 10) / 10,
    extrapolationRatio,
    attainmentProbability,
    probabilityBand,
    probabilityConfidence: confidence,
    modelVersion: "ols-normal-v1",
    probabilityReason: probabilityEligible
      ? `N=${points.length}，以线性趋势和预测误差估计达到 ${targetScore} 分事件；概率区间反映参数不确定性`
      : `同口径完整模考 N=${points.length}<${PROBABILITY_PROJECTION_MINIMUM}，只报趋势区间，不报概率`,
  };
}

function mockSubjectScores(record) {
  const source = record?.subjects ?? record?.["科目拆分"] ?? record?.["科目"] ?? null;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return Object.fromEntries(Object.entries(source).filter(([, value]) => Number.isFinite(Number(value))).map(([key, value]) => [key, Number(value)]));
}

export function buildMockScoreCalibration(mockRecords = [], targets = {}, examDate = null) {
  const targetScores = targets?.["科目拆分"] ?? {};
  const targetSubjects = Object.keys(targetScores).filter((subject) => Number.isFinite(Number(targetScores[subject])));
  const records = (mockRecords ?? []).map((record) => ({
    date: String(record?.date ?? record?.["日期"] ?? ""),
    scores: mockSubjectScores(record),
  })).filter((record) => validDate(record.date) && record.scores);
  // [gpt] 校准门槛按“同一套卷同时具备全部目标科目拆分”的不同日期计数，不能拼接零散单科成绩凑三次。
  const completeRecords = [...new Map(records
    .filter((record) => targetSubjects.every((subject) => Number.isFinite(record.scores[subject])))
    .map((record) => [record.date, record])).values()]
    .sort((left, right) => left.date.localeCompare(right.date));
  const bySubject = targetSubjects.map((subject) => {
    const points = completeRecords.map((record) => ({ date: record.date, score: record.scores[subject] }));
    if (points.length < SCORE_PROJECTION_MINIMUM || !validDate(examDate)) return {
      subject,
      samples: points.length,
      calibrated: false,
      forecastTier: "structural-only",
      projection: null,
    };
    const targetScore = Number(targetScores[subject]);
    const maximum = Math.max(SUBJECT_SCORE_MAXIMUMS[subject] ?? targetScore, targetScore, ...points.map((point) => point.score));
    const probabilityEligible = points.length >= PROBABILITY_PROJECTION_MINIMUM;
    return {
      subject,
      samples: points.length,
      calibrated: true,
      forecastTier: probabilityEligible ? "probability" : "trend-band",
      targetScore,
      maximumScore: maximum,
      evidenceDates: points.map((point) => point.date),
      projection: linearProjection(points, examDate, maximum, targetScore),
    };
  });
  const canProjectScore = targetSubjects.length > 0 && bySubject.every((item) => item.calibrated);
  const canProjectProbability = targetSubjects.length > 0 && bySubject.every((item) => item.forecastTier === "probability");
  return {
    eligibleRecords: completeRecords.length,
    observedRecords: records.length,
    requiredRecords: SCORE_PROJECTION_MINIMUM,
    probabilityRequiredRecords: PROBABILITY_PROJECTION_MINIMUM,
    canProjectScore,
    canProjectProbability,
    subjects: bySubject,
    reason: canProjectProbability
      ? `至少 ${PROBABILITY_PROJECTION_MINIMUM} 个同口径完整模考日期：允许输出带区间、模型版本和证据日期的低样本达标概率`
      : canProjectScore
        ? `${SCORE_PROJECTION_MINIMUM}-${PROBABILITY_PROJECTION_MINIMUM - 1} 个同口径完整模考日期：只输出经验趋势区间，禁止输出百分比`
        : `不足 ${SCORE_PROJECTION_MINIMUM} 个同口径、带完整科目拆分的成套模考：只做结构风险排序，禁止输出卷面分和概率`,
  };
}

export function buildExamLossForecast({
  referenceDate,
  examDate,
  knowledgeStates,
  knowledgeGraph,
  failurePortrait,
  studyLogs = [],
  targets = {},
  mockRecords = [],
  windowDays = 28,
} = {}) {
  if (!validDate(referenceDate) || !validDate(examDate)) throw new Error("referenceDate/examDate 必须是 YYYY-MM-DD");
  const daysToExam = Math.max(0, daysBetween(referenceDate, examDate));
  const items = knowledgeStates?.items ?? [];
  const active = items.filter((item) => item.activated);
  const pace = buildObservedPace({ knowledgeStates, studyLogs, referenceDate, windowDays });
  const paceBySubject = new Map(pace.bySubject.map((item) => [item.subject, item]));
  const hotspots = active.map((item) => {
    const subjectPace = paceBySubject.get(item.subject) ?? pace.overall;
    const currentCore = coreRetentionAt(item, referenceDate);
    const noReviewAtExam = coreRetentionAt(item, examDate);
    const coverage = subjectPace.maintenanceCoverageIndex / 100;
    // 当前节奏情景只保留已被证据证明过的能力，不凭学习流水替未证明维度加分。
    const maintainableFloor = currentCore ? Math.max(noReviewAtExam, Math.min(78, currentCore)) : 0;
    const paceScenarioRetention = Math.round(noReviewAtExam + coverage * (maintainableFloor - noReviewAtExam));
    const node = graphNode(knowledgeGraph, item.kpId);
    const blockers = node?.blockers ?? [];
    const portrait = activePortraitFor(failurePortrait, item.kpId);
    const graphPenalty = Math.min(18, blockers.length * 5 + (blockers.some((entry) => entry.root) ? 3 : 0));
    const portraitPenalty = portrait ? (portrait.status === "pending" ? 2 : 7) : 0;
    const lossRiskIndex = clamp(Math.round(
      (100 - paceScenarioRetention) * 0.56
      + item.riskScore * 0.2
      + item.importanceScore * 0.12
      + graphPenalty
      + portraitPenalty
      + (item.decayedFrom ? 8 : 0),
    ));
    const drivers = [];
    if (item.decayedFrom) drivers.push(`历史达到${item.demonstratedStageLabel}，今天已衰减到${item.stageLabel}`);
    if (!item.decay.dimensions.recall.supported) drivers.push("没有可依赖的复述通过证据");
    if (!item.decay.dimensions.application.supported) drivers.push("没有可依赖的应用通过证据");
    if (blockers.length) drivers.push(`有 ${blockers.length} 个未满足前置：${blockers.slice(0, 2).map((entry) => entry.kpId).join("、")}`);
    if (portrait) drivers.push(`${portrait.status === "pending" ? "候选" : "已确认"}栽点：${portrait.label}`);
    if (subjectPace.maintenanceCoverageIndex < 50) drivers.push(`近 ${windowDays} 天结构化复检供给低于到期需求`);
    if (!drivers.length) drivers.push("主要由考试日前自然衰减与考点重要度驱动");
    return {
      kpId: item.kpId,
      subject: item.subject,
      name: item.name,
      currentStage: item.stage,
      demonstratedStage: item.demonstratedStage,
      currentRetentionIndex: currentCore,
      noReviewRetentionAtExam: noReviewAtExam,
      currentPaceRetentionAtExam: paceScenarioRetention,
      lossRiskIndex,
      riskBand: riskBand(lossRiskIndex),
      importanceScore: item.importanceScore,
      dueDate: item.dueDate,
      blockers: blockers.map((entry) => ({ kpId: entry.kpId, requiredStage: entry.requiredStage, stage: entry.stage, path: entry.path })),
      failurePattern: portrait ? { code: portrait.pattern, label: portrait.label, status: portrait.status } : null,
      paceConfidence: subjectPace.confidence,
      drivers,
    };
  }).sort((left, right) => right.lossRiskIndex - left.lossRiskIndex || right.importanceScore - left.importanceScore || left.kpId.localeCompare(right.kpId));

  const activeIds = new Set(active.map((item) => item.kpId));
  const blindSpots = items.filter((item) => !activeIds.has(item.kpId) && item.importanceScore >= 65)
    .sort((left, right) => right.importanceScore - left.importanceScore || left.kpId.localeCompare(right.kpId));
  const subjects = [...new Set(items.map((item) => item.subject).filter(Boolean))].sort().map((subject) => {
    const rows = hotspots.filter((item) => item.subject === subject);
    const weight = rows.reduce((sum, item) => sum + Math.max(1, item.importanceScore), 0);
    const lossPressureIndex = weight ? Math.round(rows.reduce((sum, item) => sum + item.lossRiskIndex * Math.max(1, item.importanceScore), 0) / weight) : null;
    return {
      subject,
      observedKnowledgePoints: rows.length,
      highRiskKnownPoints: rows.filter((item) => item.lossRiskIndex >= 68).length,
      criticalKnownPoints: rows.filter((item) => item.lossRiskIndex >= 82).length,
      unobservedHighImportancePoints: blindSpots.filter((item) => item.subject === subject).length,
      lossPressureIndex,
      pace: paceBySubject.get(subject) ?? null,
      topHotspots: rows.slice(0, 5).map((item) => item.kpId),
    };
  }).sort((left, right) => (right.lossPressureIndex ?? -1) - (left.lossPressureIndex ?? -1) || right.unobservedHighImportancePoints - left.unobservedHighImportancePoints);
  const mockCalibration = buildMockScoreCalibration(mockRecords, targets, examDate);
  const activationRatio = items.length ? active.length / items.length : 0;
  const rankingConfidence = mockCalibration.canProjectProbability
    ? "high"
    : mockCalibration.canProjectScore
      ? "medium"
    : pace.overall.confidence === "high" && activationRatio >= 0.25
      ? "medium"
      : "low";

  return {
    version: KNOWLEDGE_FORECAST_VERSION,
    referenceDate,
    examDate,
    daysToExam,
    scenario: "observed-pace-with-time-decay",
    pace,
    calibration: {
      status: mockCalibration.canProjectProbability ? "probability-eligible" : mockCalibration.canProjectScore ? "trend-band" : "structural-only",
      rankingConfidence,
      activatedKnowledgePoints: active.length,
      catalogKnowledgePoints: items.length,
      activationRatio: Math.round(activationRatio * 1000) / 10,
      canRankLossHotspots: active.length > 0,
      canProjectScore: mockCalibration.canProjectScore,
      canProjectProbability: mockCalibration.canProjectProbability,
      mock: mockCalibration,
    },
    counts: {
      hotspots: hotspots.length,
      critical: hotspots.filter((item) => item.riskBand === "critical").length,
      high: hotspots.filter((item) => item.riskBand === "high").length,
      unobservedHighImportance: blindSpots.length,
    },
    hotspots: hotspots.slice(0, 30),
    subjects,
    coverageBlindSpots: blindSpots.slice(0, 30).map((item) => ({
      kpId: item.kpId,
      subject: item.subject,
      name: item.name,
      importanceScore: item.importanceScore,
      status: "unobserved-not-proven-weak",
    })),
    policy: `lossRiskIndex 是当前节奏情景下的失分压力排序，不是丢分概率。未激活点只列为观测盲区，不判定为不会；完整同口径模考少于 ${SCORE_PROJECTION_MINIMUM} 次不报分，少于 ${PROBABILITY_PROJECTION_MINIMUM} 次不报百分比。`,
  };
}

export function formatExamLossForecast(forecast, { limit = 10 } = {}) {
  const lines = [
    `考试失分前瞻（${forecast.referenceDate} → ${forecast.examDate}，${forecast.daysToExam} 天）`,
    `校准=${forecast.calibration.status}/${forecast.calibration.rankingConfidence}｜已观测 KP ${forecast.calibration.activatedKnowledgePoints}/${forecast.calibration.catalogKnowledgePoints}｜可投影卷面分=${forecast.calibration.canProjectScore ? "是" : "否"}｜可报达标概率=${forecast.calibration.canProjectProbability ? "是" : "否"}`,
    `当前节奏：近 ${forecast.pace.overall.windowDays} 天结构化检验 ${forecast.pace.overall.checks} 次，折合 ${forecast.pace.overall.weeklyChecks}/周；维护覆盖指数 ${forecast.pace.overall.maintenanceCoverageIndex}`,
    "",
    "最可能失分的已观测知识点：",
  ];
  for (const [index, item] of forecast.hotspots.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${item.kpId} [${item.subject}] ${item.name ?? "未命名"}｜压力 ${item.lossRiskIndex}（${item.riskBand}）｜今日 ${item.currentRetentionIndex} → 考试日情景 ${item.currentPaceRetentionAtExam}`);
    lines.push(`   ${item.drivers.join("；")}`);
  }
  if (!forecast.hotspots.length) lines.push("暂无被真实证据激活的知识点，不能做点位排名。");
  if (forecast.calibration.canProjectScore) {
    lines.push("", "同口径模考分层预测：");
    for (const item of forecast.calibration.mock.subjects) {
      const probability = item.projection.attainmentProbability == null
        ? `N=${item.samples}，只报趋势区间`
        : `达标概率 ${item.projection.attainmentProbability}%（区间 ${item.projection.probabilityBand[0]}%-${item.projection.probabilityBand[1]}%，${item.projection.probabilityConfidence}）`;
      lines.push(`- ${item.subject}：目标 ${item.targetScore}｜考试日投影 ${item.projection.projected} [${item.projection.band.join(", ")}]｜${probability}`);
    }
  }
  lines.push("", `高重要度观测盲区 ${forecast.counts.unobservedHighImportance} 个（不等于不会）：${forecast.coverageBlindSpots.slice(0, 5).map((item) => item.kpId).join("、") || "无"}`);
  lines.push(forecast.policy);
  return lines.join("\n");
}
