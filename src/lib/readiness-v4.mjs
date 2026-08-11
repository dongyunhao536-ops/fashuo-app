/**
 * [gpt] 2026-08-11：目标达成指数 v4.1。
 *
 * 这个模块只回答一个问题：当前可核验的学习证据，能支撑 378 目标的多少。
 * - 学习流水是模考前的结构先验，不伪装成卷面分预测；
 * - 先按真实试卷聚合，再惩罚最弱卷，不再拿五个内部学科中的最小值冒充“单科线”；
 * - 政治仍不伪造过程数据；用户明确给出的暂定分只作为“基线假设”进入主数，并与实测证据分开返回；
 * - 至少 3 次带总分的完整同口径模考后，才让真实卷面分进入主指数。
 */

export const READINESS_V4_VERSION = "4.1";

export const SUBJECT_MAX_SCORES = Object.freeze({
  刑法: 75,
  民法: 75,
  法理: 60,
  宪法: 50,
  法制史: 40,
  英语: 100,
});

const DEFAULT_SUBJECT_TARGETS = Object.freeze({ 刑法: 62, 民法: 53, 法理: 50, 宪法: 40, 法制史: 33 });
const DEFAULT_PAPER_TARGETS = Object.freeze({ 专业基础: 115, 专业综合: 123, 英语: 75, 政治: 65 });
const PAPER_SUBJECTS = Object.freeze({
  专业基础: ["刑法", "民法"],
  专业综合: ["法理", "宪法", "法制史"],
});
const LAW_SUBJECTS = Object.freeze(["刑法", "民法", "法理", "宪法", "法制史"]);
const DAY = 86_400_000;

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function daysBetween(from, to) {
  if (!validDate(from) || !validDate(to)) return 0;
  return Math.max(0, Math.floor((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY));
}

function latestSubjectLogs(logs, subject) {
  return logs
    .filter((row) => row.subject === subject)
    .sort((left, right) => String(right.log_date ?? "").localeCompare(String(left.log_date ?? "")));
}

function accuracyEvidence(logs, subject, { excludeEssay = false } = {}) {
  const values = latestSubjectLogs(logs, subject)
    .filter((row) => !excludeEssay || !/作文/.test(String(row.chapter ?? "")))
    // null 表示“这条流水没有正确率”，Number(null)=0，必须在数值转换前排除。
    .filter((row) => row.accuracy != null && row.accuracy !== "")
    .map((row) => Number(row.accuracy))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    .slice(0, 8);
  return {
    samples: values.length,
    average: values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
  };
}

function topicMasteryBySubject(rows = []) {
  const topics = new Map();
  for (const row of rows) {
    const id = Number(row.topic_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const topic = topics.get(id) ?? {
      subject: row.topic_subject ?? row.event_subject ?? null,
      mastery: String(row.mastery_status ?? "open"),
      eventIds: new Set(),
      statuses: new Set(),
    };
    const eventId = Number(row.study_error_id);
    if (Number.isInteger(eventId) && eventId > 0) topic.eventIds.add(eventId);
    if (row.event_status) topic.statuses.add(String(row.event_status));
    topics.set(id, topic);
  }

  const bySubject = new Map();
  for (const topic of topics.values()) {
    if (!topic.subject) continue;
    const current = bySubject.get(topic.subject) ?? { total: 0, open: 0, monitoring: 0, stable: 0, recurrent: 0 };
    current.total += 1;
    if (topic.mastery === "stable" || topic.mastery === "archived") current.stable += 1;
    else if (topic.mastery === "monitoring") current.monitoring += 1;
    else current.open += 1;
    if (topic.eventIds.size > 1 || (topic.statuses.has("open") && topic.statuses.has("absorbed"))) current.recurrent += 1;
    bySubject.set(topic.subject, current);
  }
  return bySubject;
}

function riskPenalty(stat, mastery = { total: 0, monitoring: 0, stable: 0 }) {
  const open = Math.max(0, finiteNumber(stat.open, 0));
  const absorbed = Math.max(0, finiteNumber(stat.absorbed, 0));
  const seen = open + absorbed;
  const repeat = Math.min(seen, Math.max(0, finiteNumber(stat.repeat, 0)));
  const denominator = seen + 5;
  // open 与重犯分轴：重犯用自己的平滑分母，避免“再添一条 open 反而稀释重犯率、风险下降”。
  const gross = 10 * (open / denominator) + 6 * (repeat / (repeat + 5));
  // 冷复检只用于抵消已登记错题的风险，不凭“销账数量”给整科额外加分。
  const recovery = 6 * ((mastery.stable + 0.5 * mastery.monitoring) / (mastery.total + 2));
  return round1(Math.max(0, gross - recovery));
}

function stalenessPenalty(logs, subject, referenceDate, graceDays) {
  const lastDate = latestSubjectLogs(logs, subject).map((row) => String(row.log_date ?? "")).find(validDate) ?? null;
  if (!lastDate) return { lastDate: null, penalty: 0 };
  const staleDays = daysBetween(lastDate, referenceDate);
  return { lastDate, penalty: round1(Math.min(12, Math.max(0, staleDays - graceDays) * 0.4)) };
}

function targetConfig(targets = {}) {
  const subjectSource = targets.subjectTargets ?? targets["科目拆分"] ?? {};
  const paperSource = targets.paperTargets ?? targets["拆分"] ?? {};
  const subjectTargets = Object.fromEntries(LAW_SUBJECTS.map((subject) => [
    subject,
    finiteNumber(subjectSource[subject], DEFAULT_SUBJECT_TARGETS[subject]),
  ]));
  const paperTargets = {
    专业基础: finiteNumber(paperSource["专业基础"], DEFAULT_PAPER_TARGETS["专业基础"]),
    专业综合: finiteNumber(paperSource["专业综合"] ?? paperSource["综合"], DEFAULT_PAPER_TARGETS["专业综合"]),
    英语: finiteNumber(paperSource["英语"] ?? paperSource["英语一"], DEFAULT_PAPER_TARGETS["英语"]),
    政治: finiteNumber(paperSource["政治"], DEFAULT_PAPER_TARGETS["政治"]),
  };
  const fullTarget = finiteNumber(targets.totalTarget ?? targets["总分"], Object.values(paperTargets).reduce((sum, value) => sum + value, 0));
  return { subjectTargets, paperTargets, fullTarget };
}

function scoreLawSubject({ subject, quant, logs, mastery, target, referenceDate }) {
  const stock = 0.25 * quant.progress + 0.35 * quant.depth + 0.40 * quant.recitePct;
  const performance = accuracyEvidence(logs, subject);
  const performanceConfidence = performance.samples / (performance.samples + 6);
  // 无训练正确率时，过程证据只保留 82% 上限；样本越多，正确率最多占当前判断的 30%。
  const performancePrior = 0.4 * stock;
  const evidence = 0.7 * stock + 0.3 * (
    performanceConfidence * (performance.average ?? 0)
    + (1 - performanceConfidence) * performancePrior
  );
  const risk = riskPenalty(quant, mastery);
  const stale = stalenessPenalty(logs, subject, referenceDate, 21);
  const readiness = Math.round(clamp(evidence - risk - stale.penalty));
  const estimatedScore = round1(SUBJECT_MAX_SCORES[subject] * readiness / 100);
  const targetAttainment = Math.round(clamp(100 * estimatedScore / target));
  return {
    ...quant,
    target,
    maximum: SUBJECT_MAX_SCORES[subject],
    stock: Math.round(stock),
    performance: performance.average,
    performanceSamples: performance.samples,
    performanceConfidence: Math.round(100 * performanceConfidence),
    riskPenalty: Math.round(risk),
    stalenessPenalty: Math.round(stale.penalty),
    lastEvidenceDate: stale.lastDate,
    mastery: { ...mastery },
    readiness,
    estimatedScore,
    targetAttainment,
  };
}

function scoreEnglish({ quant, logs, mastery, target, referenceDate }) {
  const performance = accuracyEvidence(logs, "英语", { excludeEssay: true });
  const readingEvidence = (performance.average ?? 0) * Math.min(1, performance.samples / 4);
  const paceEvidence = 100 * Math.min(1, quant.papers14d / 4);
  const writingEvidence = 100 * Math.min(1, quant.essays30d / 2);
  const volumeValidation = 100 * Math.min(1, performance.samples / 8);
  const evidence = 0.50 * readingEvidence + 0.15 * paceEvidence + 0.25 * writingEvidence + 0.10 * volumeValidation;
  const risk = riskPenalty({ ...quant, repeat: quant.repeat ?? 0 }, mastery);
  const stale = stalenessPenalty(logs, "英语", referenceDate, 30);
  const readiness = Math.round(clamp(evidence - risk - stale.penalty));
  const estimatedScore = round1(readiness);
  return {
    ...quant,
    target,
    maximum: SUBJECT_MAX_SCORES.英语,
    reading: performance.average,
    performance: performance.average,
    performanceSamples: performance.samples,
    stock: Math.round(evidence),
    riskPenalty: Math.round(risk),
    stalenessPenalty: Math.round(stale.penalty),
    lastEvidenceDate: stale.lastDate,
    mastery: { ...mastery },
    readiness,
    estimatedScore,
    targetAttainment: Math.round(clamp(100 * estimatedScore / target)),
  };
}

function splitScores(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const aliases = { 基础: "专业基础", 专业基础: "专业基础", 综合: "专业综合", 专业综合: "专业综合", 英语: "英语", 英语一: "英语", 政治: "政治" };
  const parsed = {};
  for (const match of value.matchAll(/(专业基础|基础|专业综合|综合|英语一|英语|政治)\s*[:：]?\s*(\d+(?:\.\d+)?)/g)) {
    parsed[aliases[match[1]]] = Number(match[2]);
  }
  return parsed;
}

function completeMockTotals(records, fullTarget) {
  const byDate = new Map();
  for (const record of records ?? []) {
    const date = String(record?.date ?? record?.["日期"] ?? "");
    if (!validDate(date)) continue;
    const split = splitScores(record?.scores ?? record?.["拆分"] ?? record?.["科目拆分"]);
    const normalized = {
      专业基础: Number(split?.["专业基础"] ?? split?.["基础"]),
      专业综合: Number(split?.["专业综合"] ?? split?.["综合"]),
      英语: Number(split?.["英语"] ?? split?.["英语一"]),
      政治: Number(split?.["政治"]),
    };
    // 和 PC 预测层同口径：总分存在也不能替代四张卷完整拆分，更不能拼零散单科凑三次。
    if (!Object.values(normalized).every(Number.isFinite)) continue;
    const splitTotal = Object.values(normalized).reduce((sum, score) => sum + score, 0);
    const explicitTotal = Number(record?.total ?? record?.["总分"]);
    if (Number.isFinite(explicitTotal) && Math.abs(explicitTotal - splitTotal) > 1) continue;
    const total = Number.isFinite(explicitTotal) ? explicitTotal : splitTotal;
    if (total < 0 || total > Math.max(500, fullTarget * 1.25)) continue;
    byDate.set(date, { date, total });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function mockCalibration(records, fullTarget, processIndex) {
  const complete = completeMockTotals(records, fullTarget);
  if (complete.length < 3) return {
    tier: "structural-only",
    label: "过程估算·低置信",
    completeMocks: complete.length,
    requiredMocks: 3,
    mockIndex: null,
    mockWeight: 0,
    index: processIndex,
  };
  const recent = complete.slice(-3);
  const mockIndex = round1(clamp(100 * recent.reduce((sum, item) => sum + item.total, 0) / recent.length / fullTarget));
  const mockWeight = complete.length / (complete.length + 3);
  return {
    tier: complete.length >= 6 ? "mock-calibrated" : "trend-calibrated",
    label: complete.length >= 6 ? "模考校准·较高置信" : "模考校准·中等置信",
    completeMocks: complete.length,
    requiredMocks: 3,
    evidenceDates: recent.map((item) => item.date),
    mockIndex,
    mockWeight: round1(mockWeight),
    index: Math.round((1 - mockWeight) * processIndex + mockWeight * mockIndex),
  };
}

function baselineAssumptions(input, config) {
  const politicsScore = Number(input?.politicsScore);
  if (!Number.isFinite(politicsScore)) return [];
  const target = config.paperTargets.政治;
  const score = round1(clamp(politicsScore, 0, 100));
  return [{
    subject: "政治",
    target,
    score,
    attainment: Math.round(clamp(100 * score / target)),
    treatment: "user-baseline",
  }];
}

function feasibilityLine(input, fullTarget, records) {
  const score = Number(input?.score);
  if (!Number.isFinite(score) || score <= 0) return null;
  const complete = completeMockTotals(records, fullTarget);
  const latest = complete.at(-1) ?? null;
  return {
    date: validDate(input?.date) ? String(input.date) : null,
    score: round1(score),
    // [gpt] 红线是“至少达到”，换算为整数指数时向上取整，320/378 = 84.66，因此显示 85。
    index: Math.ceil(100 * score / fullTarget),
    evidence: "complete-mock-only",
    status: latest == null ? "awaiting-complete-mock" : latest.total >= score ? "met-single-sample" : "below-line",
    latestCompleteScore: latest?.total ?? null,
  };
}

/**
 * @param {{
 *   quantV3: Record<string, any>,
 *   logs?: Array<Record<string, any>>,
 *   topicRows?: Array<Record<string, any>>,
 *   referenceDate: string,
 *   targets?: Record<string, any>,
 *   mockRecords?: Array<Record<string, any>>,
 *   assumptions?: { politicsScore?: number },
 *   feasibility?: { date?: string, score?: number }
 * }} input
 */
export function buildTargetReadinessV4({
  quantV3,
  logs = [],
  topicRows = [],
  referenceDate,
  targets = {},
  mockRecords = [],
  assumptions = {},
  feasibility = {},
}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  if (!quantV3?.subjects || !quantV3?.overall?.english) throw new Error("quantV3 快照不完整");

  const config = targetConfig(targets);
  const mastery = topicMasteryBySubject(topicRows);
  const quantBySubject = new Map(quantV3.subjects.map((subject) => [subject.subject, subject]));
  const emptyMastery = { total: 0, open: 0, monitoring: 0, stable: 0, recurrent: 0 };
  const subjects = LAW_SUBJECTS.map((subject) => scoreLawSubject({
    subject,
    quant: quantBySubject.get(subject),
    logs,
    mastery: mastery.get(subject) ?? emptyMastery,
    target: config.subjectTargets[subject],
    referenceDate,
  }));
  const subjectByName = new Map(subjects.map((subject) => [subject.subject, subject]));
  const english = scoreEnglish({
    quant: quantV3.overall.english,
    logs,
    mastery: mastery.get("英语") ?? emptyMastery,
    target: config.paperTargets.英语,
    referenceDate,
  });

  const papers = Object.entries(PAPER_SUBJECTS).map(([paper, paperSubjects]) => {
    const estimatedScore = round1(paperSubjects.reduce((sum, subject) => sum + subjectByName.get(subject).estimatedScore, 0));
    const targetScore = config.paperTargets[paper];
    return {
      paper,
      targetScore,
      estimatedScore,
      attainment: Math.round(clamp(100 * estimatedScore / targetScore)),
      subjects: [...paperSubjects],
    };
  });
  papers.push({
    paper: "英语",
    targetScore: config.paperTargets.英语,
    estimatedScore: english.estimatedScore,
    attainment: english.targetAttainment,
    subjects: ["英语"],
  });

  const trackedTargetPoints = papers.reduce((sum, paper) => sum + paper.targetScore, 0);
  const trackedSupportedPoints = round1(papers.reduce((sum, paper) => sum + Math.min(paper.targetScore, paper.estimatedScore), 0));
  const trackedPointAttainment = Math.round(clamp(100 * trackedSupportedPoints / trackedTargetPoints));
  const weakestTrackedPaper = papers.reduce((weakest, paper) => paper.attainment < weakest.attainment ? paper : weakest, papers[0]);
  // 80% 看目标分已被多少证据支撑，20% 看真实最弱卷；内部五科不再直接充当资格线。
  const trackedIndex = Math.round(0.8 * trackedPointAttainment + 0.2 * weakestTrackedPaper.attainment);
  const declaredAssumptions = baselineAssumptions(assumptions, config);
  const assumedTargetPoints = declaredAssumptions.reduce((sum, item) => sum + item.target, 0);
  const assumedSupportedPoints = round1(declaredAssumptions.reduce((sum, item) => sum + Math.min(item.target, item.score), 0));
  const coveredTargetPoints = Math.min(config.fullTarget, trackedTargetPoints + assumedTargetPoints);
  const supportedPoints = round1(trackedSupportedPoints + assumedSupportedPoints);
  const pointAttainment = Math.round(clamp(100 * supportedPoints / config.fullTarget));
  const coveredPapers = [...papers, ...declaredAssumptions.map((item) => ({
    paper: item.subject,
    attainment: item.attainment,
  }))];
  const weakestPaper = coveredPapers.reduce((weakest, paper) => paper.attainment < weakest.attainment ? paper : weakest, coveredPapers[0]);
  // [gpt] 最弱卷维度也受“已覆盖目标分”约束：政治无假设时沿用原 313/378 缩放；有 65 基线后才恢复完整四卷口径。
  const paperBalance = Math.round(weakestPaper.attainment * coveredTargetPoints / config.fullTarget);
  const processIndex = Math.round(0.8 * pointAttainment + 0.2 * paperBalance);
  const evidenceOnlyPointAttainment = Math.round(clamp(100 * trackedSupportedPoints / config.fullTarget));
  const evidenceOnlyPaperBalance = Math.round(weakestTrackedPaper.attainment * trackedTargetPoints / config.fullTarget);
  const evidenceOnlyIndex = Math.round(0.8 * evidenceOnlyPointAttainment + 0.2 * evidenceOnlyPaperBalance);
  const calibration = mockCalibration(mockRecords, config.fullTarget, processIndex);
  const untrackedTargetPoints = Math.max(0, config.fullTarget - coveredTargetPoints);

  return {
    version: READINESS_V4_VERSION,
    referenceDate,
    subjects,
    english,
    papers,
    overall: {
      index: calibration.index,
      processIndex,
      evidenceOnlyIndex,
      trackedIndex,
      pointAttainment,
      trackedPointAttainment,
      paperBalance,
      weakestPaper: { paper: weakestPaper.paper, attainment: weakestPaper.attainment },
      supportedPoints,
      trackedSupportedPoints,
      trackedTargetPoints,
      assumedTargetPoints,
      coveredTargetPoints,
      fullTarget: config.fullTarget,
      untrackedTargetPoints,
      untrackedSubjects: untrackedTargetPoints > 0 ? [{ subject: "政治", target: untrackedTargetPoints, treatment: "zero-evidence" }] : [],
      assumptions: declaredAssumptions,
      feasibility: feasibilityLine(feasibility, config.fullTarget, mockRecords),
      notStarted: subjects.filter((subject) => subject.covered === 0 && subject.open === 0 && subject.absorbed === 0).length,
      calibration,
    },
  };
}
