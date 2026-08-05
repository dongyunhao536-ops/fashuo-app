const DAY = 86400000;

export const LEARNING_COACH_VERSION = "1.0";
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

function topicStage(topic, evidence) {
  if (topic.classificationStatus !== "confirmed") return "discovered";
  const ordered = sortedEvidence(evidence);
  const latest = ordered.at(-1) ?? null;
  const latestPassDate = latestDate(ordered.filter((item) => item.result === "pass").map((item) => item.date));
  const newerOpenEvent = topic.active && topic.latestOpenDate && (!latestPassDate || topic.latestOpenDate > latestPassDate);
  if (latest?.result && latest.result !== "pass") return "reinforcing";
  if (newerOpenEvent && topic.recurrent) return "reinforcing";
  if (!latest) return topic.recurrent ? "reinforcing" : "confirmed";
  const passDates = cleanPassDatesAfterLastFailure(ordered);
  if (!topic.active && passDates.length >= 3) return "maintenance";
  if (!topic.active && passDates.length >= 2) return "stable";
  const passAge = daysBetween(latest.date, topic.referenceDate);
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

export function buildTopicLearningStates(errorSummary, reviews = [], referenceDate) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const reviewsByTopic = new Map();
  for (const [sequence, review] of reviews.entries()) {
    const topicId = Number(review.topic_id ?? review.topicId);
    const date = String(review.review_date ?? review.date ?? "");
    if (!Number.isInteger(topicId) || !validDate(date)) continue;
    const rows = reviewsByTopic.get(topicId) ?? [];
    rows.push({
      date,
      result: String(review.result ?? ""),
      qualifying: true,
      sequence,
    });
    reviewsByTopic.set(topicId, rows);
  }

  const items = (errorSummary?.topics ?? []).map((topic) => {
    const evidence = reviewsByTopic.get(topic.id) ?? [];
    const enriched = { ...topic, referenceDate };
    const state = topicStage(enriched, evidence);
    const latestReview = sortedEvidence(evidence).at(-1) ?? null;
    const lastEvidenceDate = latestDate([topic.latestEventDate, latestReview?.date]);
    const memoryDecay = topic.confirmedRootCauses?.includes("memory_decay") ?? false;
    const interval = intervalEstimate(evidence, TOPIC_INTERVALS[state], {
      recurrent: topic.recurrent,
      memoryDecay,
    });
    const dueDate = shiftDate(lastEvidenceDate ?? referenceDate, interval.days);
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
      + (latestReview && latestReview.result !== "pass" ? 12 : 0)
      + (memoryDecay ? 8 : 0),
    ));
    const passDates = cleanPassDatesAfterLastFailure(evidence);
    return {
      id: topic.id,
      subject: topic.subject,
      title: topic.title,
      chapter: topic.chapter,
      state,
      stateLabel: LEARNING_STATE_LABELS[state],
      masteryStatus: topic.masteryStatus,
      classificationStatus: topic.classificationStatus,
      active: topic.active,
      recurrent: topic.recurrent,
      eventCounts: topic.eventCounts,
      reviewCounts: {
        total: evidence.length,
        pass: evidence.filter((item) => item.result === "pass").length,
        partial: evidence.filter((item) => item.result === "partial").length,
        fail: evidence.filter((item) => item.result === "fail").length,
        cleanPassDates: passDates.length,
      },
      latestReview,
      lastEvidenceDate,
      daysSinceEvidence,
      estimatedRetentionDays: interval.days,
      intervalEvidence: interval,
      dueDate,
      overdueDays,
      riskScore,
      urgency: urgencyFor(riskScore),
      nextAction: topicNextAction(state),
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
  const evidence = [];
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
    evidence.push({
      date,
      result,
      qualifying: !invalidQuestion && !nonQualifyingPass,
      sequence,
      source: line.replace(/\s+/g, " ").trim().slice(0, 180),
    });
  }
  return sortedEvidence(evidence);
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

export function buildReciteMemoryModel(reciteParsed, referenceDate) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const items = (reciteParsed?.records ?? []).map((entry) => {
    const evidence = extractReciteReviewEvidence(entry, referenceDate);
    const state = reciteStage(entry, evidence, referenceDate);
    const passCount = evidence.filter((item) => item.result === "pass" && item.qualifying !== false).length;
    const partialCount = evidence.filter((item) => item.result === "partial" && item.qualifying !== false).length;
    const failCount = evidence.filter((item) => item.result === "fail" && item.qualifying !== false).length;
    const interval = intervalEstimate(evidence, RECITE_INTERVALS[state], {
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
    return {
      id: entry.id,
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

  return {
    counts: {
      items: items.length,
      due: items.filter((item) => item.route === "daibei" && item.dueDate && item.dueDate <= referenceDate).length,
      highRisk: items.filter((item) => item.route === "daibei" && item.dropRisk >= 70).length,
    },
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

export function buildExamRiskModel({ referenceDate, quantV3, studyLogs = [], topicStates, reciteMemory, targets = {}, mockRecords = [] }) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const targetScores = targets?.["科目拆分"] ?? {};
  const records = Array.isArray(mockRecords) ? mockRecords : structuredMockRecords(targets);
  const subjects = (quantV3?.subjects ?? []).map((quant) => {
    const subjectTopics = (topicStates?.items ?? []).filter((item) => item.subject === quant.subject);
    const subjectRecite = (reciteMemory?.items ?? []).filter((item) => item.subject === quant.subject && item.route === "daibei");
    const latest = latestStudyDate(studyLogs, quant.subject);
    const daysSinceStudy = latest ? daysBetween(latest, referenceDate) : null;
    const recencyPenalty = daysSinceStudy == null ? 16 : daysSinceStudy > 14 ? 14 : daysSinceStudy > 7 ? 9 : daysSinceStudy > 3 ? 4 : 0;
    const highRiskTopics = subjectTopics.filter((item) => item.riskScore >= 70).length;
    const recurrentTopics = subjectTopics.filter((item) => item.recurrent).length;
    const highRiskRecite = subjectRecite.filter((item) => item.dropRisk >= 70).length;
    const weakPenalty = Math.min(18, highRiskTopics * 2 + recurrentTopics * 2);
    const recitePenalty = Math.min(10, highRiskRecite * 1.5);
    const riskScore = clamp(Math.round(0.62 * (100 - quant.ability) + recencyPenalty + weakPenalty + recitePenalty));
    const targetScore = Number(targetScores[quant.subject] ?? 0) || null;
    const targetIntensityPct = targetScore == null ? null : Math.round((targetScore / quant.weight) * 100);
    const drivers = [];
    if (quant.covered === 0) drivers.push("尚未形成章节覆盖证据");
    if (daysSinceStudy == null) drivers.push("没有学习流水");
    else if (daysSinceStudy > 7) drivers.push(`${daysSinceStudy} 天未出现该科学习流水`);
    if (highRiskTopics) drivers.push(`${highRiskTopics} 个高风险弱项主题`);
    if (recurrentTopics) drivers.push(`${recurrentTopics} 个复发主题`);
    if (highRiskRecite) drivers.push(`${highRiskRecite} 个高掉落风险背诵点`);
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

function diverseTop(candidates, limit) {
  const selected = [];
  const usedSubjects = new Set();
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (usedSubjects.has(candidate.subject)) continue;
    selected.push(candidate);
    usedSubjects.add(candidate.subject);
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

export function buildPredictiveDispatch({ referenceDate, topicStates, reciteMemory, examRisk, limit = 3 }) {
  const examBySubject = new Map((examRisk?.subjects ?? []).map((item) => [item.subject, item]));
  const topicCandidates = (topicStates?.items ?? [])
    .filter((item) => item.dueDate <= referenceDate || item.riskScore >= 75)
    .map((item) => {
      const score = clamp(Math.round(item.riskScore + (examBySubject.get(item.subject)?.riskScore ?? 0) * 0.15));
      return {
        kind: "topic",
        id: `T${item.id}`,
        subject: item.subject,
        title: item.title,
        score,
        sourceRisk: item.riskScore,
        dueDate: item.dueDate,
        type: "错题冷复检",
        task: `T#${item.id}（${item.title}）：${item.nextAction}`,
        baseRef: `coach-engine:topic:T${item.id}`,
      };
    });
  const reciteCandidates = (reciteMemory?.items ?? [])
    .filter((item) => item.route === "daibei" && (item.dueDate <= referenceDate || item.dropRisk >= 65))
    .map((item) => {
      const score = clamp(Math.round(item.dropRisk + (examBySubject.get(item.subject)?.riskScore ?? 0) * 0.15));
      return {
        kind: "recite",
        id: item.id,
        subject: item.subject,
        title: item.title,
        score,
        sourceRisk: item.dropRisk,
        dueDate: item.dueDate,
        type: "带背复检",
        task: `${item.id}（${item.title}）：冷启动复检并把结果回写带背挂账`,
        baseRef: `coach-engine:recite:${item.id}`,
      };
    });
  const ranked = [...topicCandidates, ...reciteCandidates]
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
    return {
      ...candidate,
      priority,
      dispatchRef: `${candidate.baseRef}:${referenceDate}`,
      scheduleId: `AUTO-${referenceDate.replaceAll("-", "")}-${candidate.kind === "topic" ? candidate.id : `R${candidate.id}`}`,
    };
  });
  return { queue, today: normalizedToday, policy: { maxToday: limit, maxP0: 1, diversity: "prefer-subject-diversity" } };
}

export function fitDispatchToSchedule(candidates, actionable = [], limit = 3) {
  const availableSlots = Math.max(0, limit - actionable.length);
  const existingP0 = actionable.some((item) => item.priority === "P0");
  let newP0Used = false;
  const selected = candidates.slice(0, availableSlots).map((candidate) => {
    let priority = candidate.priority;
    if (priority === "P0" && (existingP0 || newP0Used)) priority = "P1";
    if (priority === "P0") newP0Used = true;
    return { ...candidate, priority };
  });
  return { selected, availableSlots, existingActionable: actionable.length };
}

export function buildLearningCoachSnapshot(input) {
  const topicStates = buildTopicLearningStates(input.errorSummary, input.reviews, input.referenceDate);
  const reciteMemory = buildReciteMemoryModel(input.reciteParsed, input.referenceDate);
  const examRisk = buildExamRiskModel({
    referenceDate: input.referenceDate,
    quantV3: input.quantV3,
    studyLogs: input.studyLogs,
    topicStates,
    reciteMemory,
    targets: input.targets,
    mockRecords: input.mockRecords,
  });
  const dispatch = buildPredictiveDispatch({
    referenceDate: input.referenceDate,
    topicStates,
    reciteMemory,
    examRisk,
    limit: input.dispatchLimit ?? 3,
  });
  return {
    schemaVersion: 1,
    modelVersion: LEARNING_COACH_VERSION,
    referenceDate: input.referenceDate,
    topicStates,
    reciteMemory,
    examRisk,
    dispatch,
    caveat: "风险分只用于调度排序；没有成套模考校准时，不代表卷面分、遗忘概率或录取胜率。",
  };
}

export function formatLearningCoachSummary(snapshot) {
  const states = snapshot.topicStates.counts;
  const top = snapshot.dispatch.today.map((item) => `[${item.priority}] ${item.subject}·${item.id} ${item.title}`).join("；") || "无到期候选";
  const exam = snapshot.examRisk.topRisks.map((item) => `${item.subject}${item.riskScore}`).join(" / ") || "无";
  return [
    `智能教练快照（北京 ${snapshot.referenceDate}，model v${snapshot.modelVersion}）`,
    `弱项状态：发现${states.discovered} / 确认${states.confirmed} / 强化${states.reinforcing} / 短期通过${states.short_pass} / 冷却${states.cooling} / 稳定${states.stable} / 长期保持${states.maintenance}`,
    `预测复习：主题到期 ${snapshot.topicStates.due.length} / 带背到期 ${snapshot.reciteMemory.counts.due} / 带背高掉落风险 ${snapshot.reciteMemory.counts.highRisk}`,
    `考试风险排序（调度分，非卷面分）：${exam}；校准=${snapshot.examRisk.calibration.status}`,
    `今日建议：${top}`,
    snapshot.caveat,
  ].join("\n");
}
