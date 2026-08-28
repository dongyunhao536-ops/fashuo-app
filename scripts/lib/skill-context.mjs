// [gpt] 2026-08-11：高频交互 skill 的紧凑会话上下文；只压缩传输，不改事实与证据门槛。
import { questionIntegrityContext } from "./question-integrity.mjs";
import { judgmentResultContext } from "./judgment-result.mjs";
import { extractScheduleTargetIds } from "./schedule-store.mjs";
import { extractDaibeiReciteIds } from "./daibei-target.mjs";

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"];
// [gpt] 2026-08-13：旧带背排期可能只剩稳定条目 ID；用账本前缀恢复科目，避免指定科目时串单。
const RECITE_SUBJECT_BY_PREFIX = Object.freeze({ L: "法理", X: "刑法", M: "民法", S: "法制史" });

function text(value, limit = 240) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function newestFirst(left, right) {
  const leftId = Number(left?.id ?? 0);
  const rightId = Number(right?.id ?? 0);
  if (leftId !== rightId) return rightId - leftId;
  return String(right?.log_date ?? "").localeCompare(String(left?.log_date ?? ""));
}

function uniqueBy(rows, keyOf, limit = Infinity) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(row);
    if (output.length >= limit) break;
  }
  return output;
}

function canonicalStudyActivity(activity) {
  return activity === "带背" || activity === "自背" ? "背诵" : activity;
}

function recitationModeFromStudyRow(row) {
  const detail = `${row?.raw_input ?? ""} ${row?.feeling ?? ""}`;
  const marked = detail.match(/\[背诵方式=(带背|自背)\]/u)?.[1] ?? null;
  if (marked) return marked;
  if (row?.activity === "带背") return "带背";
  // [gpt] 2026-08-16：旧数据按原约定把裸“背诵”视为自背；新数据以 raw 标记保留方式。
  if (row?.activity === "背诵" || row?.activity === "自背") return "自背";
  return null;
}

export function summarizeStudyLogs(rows = [], { subject = null, trailLimit = 120 } = {}) {
  const normalized = [...rows]
    .filter((row) => !subject || row.subject === subject)
    .map((row) => ({
      ...row,
      activity: canonicalStudyActivity(row.activity),
      recitationMode: recitationModeFromStudyRow(row),
    }))
    .sort(newestFirst);
  const subjects = subject ? [subject] : SUBJECTS;
  const bySubject = {};

  for (const name of subjects) {
    const items = normalized.filter((row) => row.subject === name);
    const chapterRows = uniqueBy(items.filter((row) => row.chapter), (row) => row.chapter);
    const activities = {};
    for (const row of items) activities[row.activity ?? "未知"] = (activities[row.activity ?? "未知"] ?? 0) + 1;
    bySubject[name] = {
      total: items.length,
      latestDate: items[0]?.log_date ?? null,
      activities,
      uniqueChapters: chapterRows.length,
      recentChapters: chapterRows.slice(0, 8).map((row) => ({ date: row.log_date, chapter: row.chapter, activity: row.activity })),
    };
  }

  let trail = null;
  if (subject) {
    const all = [...normalized].reverse();
    const compactTrail = (recitationMode) => uniqueBy(
      all.filter((row) => row.recitationMode === recitationMode && row.chapter),
      (row) => row.chapter,
      trailLimit,
    ).map((row) => ({ date: row.log_date, chapter: row.chapter, feeling: text(row.feeling, 180) || null }));
    const allChapters = uniqueBy(all.filter((row) => row.chapter), (row) => row.chapter, trailLimit)
      .map((row) => ({ date: row.log_date, chapter: row.chapter, activity: row.activity }));
    trail = {
      subject,
      chapters: allChapters,
      guided: compactTrail("带背"),
      selfRecite: compactTrail("自背"),
      truncated: uniqueBy(all.filter((row) => row.chapter), (row) => row.chapter).length > trailLimit,
    };
  }

  return {
    total: normalized.length,
    bySubject,
    recent: normalized.slice(0, 12).map((row) => ({
      date: row.log_date,
      subject: row.subject,
      chapter: row.chapter,
      activity: row.activity,
      recitationMode: row.recitationMode,
      accuracy: row.accuracy,
      feeling: text(row.feeling, 180) || null,
    })),
    trail,
  };
}

export function extractWeeklyPriorities(markdown = "") {
  const section = String(markdown).split(/\n##\s+🎯\s*下周指导\s*\n/u)[1] ?? String(markdown);
  const lines = section.split(/\r?\n/);
  const items = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^\*\*第\s*\d+\s*件【(P[012])】(.+?)\*\*\s*$/u);
    if (heading) {
      current = { priority: heading[1], title: text(heading[2], 180), details: [] };
      items.push(current);
      continue;
    }
    if (!current) continue;
    if (/^##\s/u.test(line)) break;
    if (/^-\s+\*\*(?:时段|验收)/u.test(line) && current.details.length < 2) current.details.push(text(line.replace(/^[-\s*]+/u, ""), 220));
  }
  return items.slice(0, 10);
}

export function currentRound(rounds = {}, referenceDate) {
  const ym = String(referenceDate ?? "").slice(0, 7);
  for (const [name, round] of Object.entries(rounds ?? {})) {
    if (!round || typeof round !== "object" || !round["窗口"]) continue;
    const match = String(round["窗口"]).match(/(\d{4})-(\d{2})(?:~(\d{2}))?/u);
    if (!match) continue;
    const start = `${match[1]}-${match[2]}`;
    const end = `${match[1]}-${match[3] ?? match[2]}`;
    if (ym >= start && ym <= end) return { name, ...round };
  }
  return null;
}

function inferScheduleSubjects(item = {}) {
  if (item.subject) return new Set([item.subject]);
  const haystack = text([item.title, item.task, item.goal, item.ref, item.id, item.raw].filter(Boolean).join(" "), 1000);
  const mentioned = SUBJECTS.filter((name) => haystack.includes(name));
  if (mentioned.length) return new Set(mentioned);
  const prefixes = [...haystack.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([LXMS])\d+\b/gu)]
    .map((match) => RECITE_SUBJECT_BY_PREFIX[match[1]])
    .filter(Boolean);
  return new Set(prefixes);
}

export function scheduleItems(schedule = {}, {
  route = null,
  dimension = null,
  subject = null,
  upcomingLimit = 8,
  strictSubject = false,
} = {}) {
  const matches = (item) => {
    if (route && item.route && item.route !== route) return false;
    if (dimension && item.dimension && item.dimension !== dimension) return false;
    if (subject) {
      const inferredSubjects = inferScheduleSubjects(item);
      if (inferredSubjects.size && !inferredSubjects.has(subject)) return false;
      if (strictSubject && !inferredSubjects.size) return false;
    }
    return true;
  };
  const compact = (item) => ({
    id: item.id ?? item.planId ?? null,
    ref: item.ref ?? null,
    date: item.date ?? item.dueDate ?? item.verifyDate ?? null,
    priority: item.priority ?? null,
    subject: item.subject ?? null,
    route: item.route ?? null,
    dimension: item.dimension ?? null,
    title: text(item.title ?? item.task ?? item.goal ?? item.raw ?? "", 220),
  });
  return {
    overdue: (schedule.overdue ?? []).filter(matches).map(compact),
    dueToday: (schedule.dueToday ?? []).filter(matches).map(compact),
    upcoming: (schedule.upcoming ?? []).filter(matches).slice(0, upcomingLimit).map(compact),
    issues: schedule.issues ?? [],
  };
}

function compactTopic(item) {
  return {
    id: item.id,
    kpId: item.kpId ?? null,
    subject: item.subject,
    title: item.title,
    state: item.state,
    masteryStatus: item.masteryStatus,
    active: item.active,
    recurrent: item.recurrent,
    eventCounts: item.eventCounts,
    confirmedFailurePatterns: item.confirmedFailurePatterns ?? [],
    pendingFailurePatterns: item.pendingFailurePatterns ?? [],
    dueDate: item.dueDate ?? null,
    riskScore: item.riskScore ?? null,
    reviewProof: item.reviewProof ?? null,
    nextProbe: item.nextProbe ?? null,
  };
}

const REVIEW_SUBJECTS = SUBJECTS.filter((subject) => subject !== "英语");
const REPLAN_SIGNALS = new Set(["startup", "continue", "too-little", "switch", "pass", "partial", "fail", "absorbed", "new-error"]);

/**
 * [gpt] 2026-08-12：小文字瑕疵只看是否改变答案、争点或关键推理；
 * 不把表达洁癖伪装成掌握度证据。
 */
export function assessPromptMateriality({ changesAnswer = false, changesIssue = false, changesCriticalInference = false, obstructsUnderstanding = false } = {}) {
  const material = Boolean(changesAnswer || changesIssue || changesCriticalInference || obstructsUnderstanding);
  return {
    level: material ? "material" : "immaterial",
    invalidate: material,
    deduct: material,
    repeatRequired: material,
    instruction: material
      ? "修正题面后重新作答；本次结果不计掌握证据"
      : "口头澄清即可；不判错、不扣分、不因此重复出题",
  };
}

export function shouldReplan(signal = "startup") {
  if (!REPLAN_SIGNALS.has(signal)) throw new Error(`未知重规划信号：${signal}`);
  return ["continue", "too-little", "switch", "pass", "partial", "fail", "absorbed", "new-error"].includes(signal);
}

function priorityForCandidate(priorities, subject, topic) {
  const haystack = `${subject ?? ""} ${topic?.title ?? ""} T#${topic?.id ?? ""}`;
  const matched = priorities.find((item) => `${item.title} ${item.details?.join(" ") ?? ""}`.includes(subject)
    || `${item.title} ${item.details?.join(" ") ?? ""}`.includes(`T#${topic?.id}`)
    || haystack.includes(item.title));
  return matched?.priority ?? null;
}

function scheduleTargetIds(item) {
  const haystack = `${item?.ref ?? ""} ${item?.title ?? ""}`;
  const stableTargets = extractScheduleTargetIds({ ref: item?.ref, task: item?.title });
  return {
    topicIds: new Set(stableTargets.topicIds),
    knowledgeIds: new Set(stableTargets.knowledgeIds),
    // T#64 中的 #64 不是事件号；事件号只认前一字符不是 ASCII 字母或数字的独立 #n。
    eventIds: new Set([...haystack.matchAll(/(?:^|[^A-Za-z0-9])#(\d+)\b/gu)].map((match) => Number(match[1]))),
  };
}

function scheduleMatchesCandidate(item, event, topic, { requireStableTarget = false } = {}) {
  const targets = scheduleTargetIds(item);
  const hasStableTarget = targets.topicIds.size > 0 || targets.eventIds.size > 0 || targets.knowledgeIds.size > 0;
  if (hasStableTarget) {
    return targets.eventIds.has(Number(event?.id))
      || targets.topicIds.has(Number(topic?.id))
      || targets.knowledgeIds.has(String(topic?.kpId ?? "").toUpperCase());
  }
  if (requireStableTarget) return false;
  // 仅为无稳定 ID 的旧排期保留标题兼容；指定 P0 硬闸绝不靠模糊标题认领。
  const scheduledTitle = text(item?.title, 500);
  const topicTitle = text(topic?.title, 500);
  return Boolean(topicTitle && (scheduledTitle === topicTitle || scheduledTitle.includes(`：${topicTitle}`) || scheduledTitle.includes(`｜${topicTitle}`)));
}

function candidateScheduleMatches(schedule, event, topic) {
  const matches = (items) => (items ?? []).filter((item) => scheduleMatchesCandidate(item, event, topic));
  const overdue = matches(schedule.overdue);
  const dueToday = matches(schedule.dueToday);
  const upcoming = matches(schedule.upcoming);
  return {
    overdue,
    dueToday,
    upcoming,
    status: overdue.length ? "overdue" : dueToday.length ? "due-today" : upcoming.length ? "upcoming" : "unscheduled",
  };
}

function requiredP0Schedule(schedule = {}) {
  const isRequired = (item) => item.priority === "P0"
    && item.route === "cuoti-fupan"
    && item.dimension === "application";
  return [
    ...(schedule.overdue ?? []).filter(isRequired).map((item) => ({ ...item, gateStatus: "overdue" })),
    ...(schedule.dueToday ?? []).filter(isRequired).map((item) => ({ ...item, gateStatus: "due-today" })),
  ];
}

function eventProof(eventProofs, eventId) {
  if (eventProofs instanceof Map) return eventProofs.get(Number(eventId)) ?? null;
  return eventProofs?.[eventId] ?? eventProofs?.[String(eventId)] ?? null;
}

function closureReadiness({ event, topic, proof, referenceDate }) {
  if (!proof) {
    return {
      state: "unknown",
      action: "drill-proof",
      canAbsorbAfterPass: false,
      estimatedPassesToAbsorb: null,
      blockers: ["缺少事件级销账证明，出题前先钻取 proof"],
    };
  }
  if (proof.eligible) {
    return {
      state: "ready-to-absorb",
      action: "absorb-now",
      canAbsorbAfterPass: false,
      estimatedPassesToAbsorb: 0,
      blockers: [],
    };
  }
  const eventDate = String(event.logDate ?? event.log_date ?? "");
  const earliestDate = topic?.nextProbe?.earliestDate ?? referenceDate;
  const topicCooling = earliestDate > referenceDate;
  const axes = new Set(proof.axes ?? []);
  const nextAxis = topic?.nextProbe?.probeAxis ?? null;
  const passGap = Math.max(0, 2 - Number(proof.passCount ?? 0));
  const axisGap = Math.max(0, 2 - axes.size);
  const coldGap = Number(proof.coldPassCount ?? 0) >= 1 ? 0 : 1;
  const estimatedPassesToAbsorb = Math.max(passGap, axisGap, coldGap);
  // [gpt] 2026-08-13：主题冷却与事件销账是两条轴。主题仍在冷却时，若事件已有一条
  // 跨会话冷检，仍可按事件门槛同场补第二轴；但该题不得推进主题 stable。
  const cooling = eventDate >= referenceDate
    || (topicCooling && Number(proof.coldPassCount ?? 0) < 1);
  const nextPassAddsAxis = Boolean(nextAxis && nextAxis !== "invalid" && !axes.has(nextAxis));
  const hardBlocker = (proof.blockers ?? []).some((item) => /id 无效|尚未关联|缺有效北京日/u.test(item));
  const canAbsorbAfterPass = !cooling
    && !hardBlocker
    && estimatedPassesToAbsorb === 1
    && (axisGap === 0 || nextPassAddsAxis)
    && topic?.nextProbe?.coldRequired !== false
    && Number(topic?.nextProbe?.transferLevel ?? 3) >= 3;
  return {
    state: cooling ? "cooling" : canAbsorbAfterPass ? "one-pass-to-absorb" : "needs-more-evidence",
    action: cooling ? "wait" : "review",
    canAbsorbAfterPass,
    estimatedPassesToAbsorb,
    nextAxis,
    topicCooling,
    topicEarliestDate: earliestDate,
    eventReviewAllowed: !cooling,
    closureScope: canAbsorbAfterPass ? "event-only" : null,
    topicProgressAllowed: !topicCooling,
    blockers: proof.blockers ?? [],
  };
}

function diversifyCandidates(candidates, limit) {
  const selected = [];
  const counts = new Map();
  for (const candidate of candidates) {
    if ((counts.get(candidate.subject) ?? 0) >= 2 && candidates.some((item) => !selected.includes(item) && (counts.get(item.subject) ?? 0) === 0)) continue;
    selected.push(candidate);
    counts.set(candidate.subject, (counts.get(candidate.subject) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function compareReviewCandidates(left, right) {
  return Number(right.mandatory) - Number(left.mandatory)
    || left.mandatoryRank - right.mandatoryRank
    || right.score - left.score
    || left.eventDate.localeCompare(right.eventDate)
    || left.eventId - right.eventId;
}

/**
 * [gpt] 2026-08-12：错题会话的候选池必须先跨五科比较“现在能否问、问完能否销账”，
 * 再把周 P0 当加权项；P0 不是锁科指令。
 */
export function buildCrossSubjectReviewPool({
  topics = [],
  events = [],
  eventProofs = new Map(),
  schedule = {},
  weeklyPriorities = [],
  referenceDate,
  routing = {},
  limit = 10,
} = {}) {
  const byId = new Map(topics.map((topic) => [Number(topic.id), topic]));
  const currentSubject = routing.currentSubject ?? routing.focusSubject ?? null;
  const subjectStreak = Math.max(0, Number(routing.subjectStreak ?? 0));
  const focusMinimumMet = Boolean(routing.focusMinimumMet);
  const signal = routing.signal ?? "startup";
  if (!REPLAN_SIGNALS.has(signal)) throw new Error(`未知重规划信号：${signal}`);
  // [gpt] 2026-08-12：周 P0 只是宏观权重；一旦落成今日/逾期的具体错题 P0，则成为不可替代的验收硬闸。
  const requiredSchedule = requiredP0Schedule(schedule);

  const evaluatedCandidates = events
    .filter((event) => event.status === "open" && REVIEW_SUBJECTS.includes(event.subject))
    .map((event) => {
      const proof = eventProof(eventProofs, event.id);
      const primaryTopicId = Number(proof?.primaryTopicId ?? event.topicIds?.[0] ?? 0) || null;
      const topic = byId.get(primaryTopicId) ?? byId.get(Number(event.topicIds?.[0])) ?? null;
      const readiness = closureReadiness({ event, topic, proof, referenceDate });
      const scheduleMatches = candidateScheduleMatches(schedule, event, topic);
      const mandatoryScheduleIds = requiredSchedule
        .filter((item) => scheduleMatchesCandidate(item, event, topic, { requireStableTarget: true }))
        .map((item) => item.id);
      const mandatoryRank = mandatoryScheduleIds.length
        ? Math.min(...mandatoryScheduleIds.map((id) => requiredSchedule.findIndex((item) => item.id === id)))
        : Number.POSITIVE_INFINITY;
      const weeklyPriority = priorityForCandidate(weeklyPriorities, event.subject, topic);
      let score = Math.round(Number(topic?.riskScore ?? 0) * 0.35);
      if (readiness.state === "ready-to-absorb") score += 90;
      else if (readiness.canAbsorbAfterPass) score += 65;
      else if (readiness.state === "needs-more-evidence") score += 20;
      if (scheduleMatches.status === "overdue") score += 35;
      if (scheduleMatches.status === "due-today") score += 25;
      if (weeklyPriority === "P0") score += 20;
      if (weeklyPriority === "P1") score += 10;
      if (topic?.recurrent) score += 8;
      if (routing.focusSubject && !focusMinimumMet && event.subject === routing.focusSubject) score += 12;
      if (focusMinimumMet && event.subject === currentSubject) score -= 35;
      if (subjectStreak >= 2 && event.subject === currentSubject) score -= 18 * (subjectStreak - 1);
      if (signal === "switch") score += event.subject === currentSubject ? -90 : 15;
      if (["continue", "too-little"].includes(signal) && readiness.canAbsorbAfterPass) score += 12;
      return {
        eventId: event.id,
        topicId: topic?.id ?? primaryTopicId,
        subject: event.subject,
        title: topic?.title ?? text(event.knowledge, 100) ?? "未归类事件",
        eventDate: event.logDate,
        score,
        weeklyPriority,
        scheduleStatus: scheduleMatches.status,
        scheduleIds: [...scheduleMatches.overdue, ...scheduleMatches.dueToday, ...scheduleMatches.upcoming].map((item) => item.id),
        mandatory: mandatoryScheduleIds.length > 0,
        mandatoryRank,
        mandatoryScheduleIds,
        ...readiness,
      };
    });

  // [gpt] 2026-08-13：冷却是执行资格，不是排序权重。先隔离再排名，避免冷却项占候选位、跨科配额或被误执行。
  const candidates = evaluatedCandidates
    .filter((item) => item.action !== "wait")
    .sort(compareReviewCandidates);
  const deferredCandidates = evaluatedCandidates
    .filter((item) => item.action === "wait")
    .sort(compareReviewCandidates);

  const requiredP0 = requiredSchedule.map((item) => {
    const targets = scheduleTargetIds(item);
    const matched = evaluatedCandidates.filter((candidate) => candidate.mandatoryScheduleIds.includes(item.id));
    const actionableMatched = matched.filter((candidate) => candidate.action !== "wait");
    const blockedReason = targets.topicIds.size === 0 && targets.eventIds.size === 0 && targets.knowledgeIds.size === 0
      ? "排期缺少稳定 T#/事件号/KP-ID，禁止靠同科或标题猜测执行对象"
      : matched.length === 0
        ? "稳定目标未映射到 open 事件，先修排期或错题关联"
        : matched.every((candidate) => candidate.state === "cooling" && candidate.action === "wait")
          ? "目标仍在冷却且无事件级补轴资格，先核对到期日与复检处方冲突"
          : null;
    return {
      id: item.id,
      date: item.date,
      status: item.gateStatus,
      priority: item.priority,
      subject: item.subject,
      title: item.title,
      topicIds: [...targets.topicIds],
      eventIds: [...targets.eventIds],
      knowledgeIds: [...targets.knowledgeIds],
      candidateKeys: actionableMatched.map((candidate) => `#${candidate.eventId}${candidate.topicId ? `/T#${candidate.topicId}` : ""}`),
      deferredCandidateKeys: matched.filter((candidate) => candidate.action === "wait")
        .map((candidate) => `#${candidate.eventId}${candidate.topicId ? `/T#${candidate.topicId}` : ""}`),
      blockedReason,
    };
  });

  // 指定 P0 不受跨科分散上限影响；普通候选只使用剩余展示位。
  const mandatoryCandidates = candidates.filter((item) => item.mandatory);
  const optionalCandidates = candidates.filter((item) => !item.mandatory);
  const selectedCandidates = [
    ...mandatoryCandidates,
    ...diversifyCandidates(optionalCandidates, Math.max(0, limit - mandatoryCandidates.length)),
  ];

  return {
    signal,
    replanned: shouldReplan(signal),
    focusMinimumMet,
    currentSubject,
    subjectStreak,
    requiredP0,
    hardGateActive: requiredP0.length > 0,
    hardGateBlocked: requiredP0.some((item) => item.blockedReason),
    candidates: selectedCandidates,
    deferredCandidates,
    coolingCount: deferredCandidates.length,
    rule: requiredP0.length
      ? "先完成今日/逾期的指定 P0 验收单；同科其他题不得冲抵。硬闸清空后，再按可销账收益跨科重排"
      : "先处理事件已可销账或事件一次通过可销账者；主题冷却与事件销账分开，周 P0 只作权重，同科连续两题或完成当科最小动作后跨科重排",
  };
}

function subjectPortrait(portrait = {}, subject = null) {
  const filter = (item) => !subject || item.subject === subject;
  return {
    counts: portrait.counts ?? {},
    bySubject: (portrait.bySubject ?? []).filter(filter),
    byKnowledgePoint: (portrait.byKnowledgePoint ?? []).filter(filter).slice(0, 12),
    unmatched: (portrait.unmatched ?? []).filter(filter).slice(0, 12),
  };
}

function compactMemories(rows = [], limit = 20) {
  return rows.slice(0, limit).map((row) => ({ category: row.category ?? null, fact: text(row.fact, 280), updatedAt: row.updated_at ?? null }));
}

function sanitizeTargets(targets = {}) {
  return Object.fromEntries(Object.entries(targets).filter(([key]) => !String(key).startsWith("_")));
}

function targetNotes(targets = {}) {
  return Object.entries(targets)
    .filter(([key, value]) => String(key).startsWith("_") && typeof value === "string" && value.trim())
    .map(([key, value]) => ({ key, text: text(value, 500) }));
}

function currentFactClaims(study) {
  return Object.fromEntries(SUBJECTS.map((subject) => {
    const item = study.bySubject?.[subject] ?? {};
    return [subject, {
      total: Number(item.total ?? 0),
      latestDate: item.latestDate ?? null,
      latestChapter: item.latestChapter ?? null,
    }];
  }));
}

function staleMemoryReasons(fact, currentFacts) {
  const value = String(fact ?? "");
  const reasons = [];
  for (const subject of SUBJECTS) {
    const observed = currentFacts[subject] ?? { total: 0 };
    const zeroClaim = new RegExp(`${subject}.{0,10}(?:零流水|0\\s*流水|从未|没有(?:学习|开张|记录)|未开张|尚未开张)`, "u");
    if (observed.total > 0 && zeroClaim.test(value)) reasons.push(`${subject}实时流水=${observed.total}`);
  }
  return reasons;
}

export function reconcileCoachContextFacts({ studyLogs = [], memories = [] } = {}) {
  const study = summarizeStudyLogs(studyLogs);
  const currentFacts = currentFactClaims(study);
  const accepted = [];
  const quarantined = [];
  for (const item of compactMemories(memories, memories.length || 20)) {
    const reasons = staleMemoryReasons(item.fact, currentFacts);
    if (reasons.length) quarantined.push({ ...item, reasons });
    else accepted.push(item);
  }
  return {
    study,
    currentFacts,
    memories: accepted.slice(0, 20),
    quarantined: quarantined.slice(0, 20),
    memoryOverflow: accepted.length > 20 || quarantined.length > 20,
    rule: "实时事实轴覆盖历史叙述；冲突记忆只供审计，不得进入建议或当前状态判断",
  };
}

function compactMessages(rows = [], limit = 6) {
  return rows.slice(0, limit).reverse().map((row) => ({ role: row.role, content: text(row.content, 280) }));
}

export function buildCoachContext({ assessment, studyLogs, errorSummary = null, eventProofs = new Map(), memories = [], messages = [], weeklyMarkdown = "" }) {
  const engine = assessment.coachEngine;
  const reconciled = reconcileCoachContextFacts({ studyLogs, memories });
  const weeklyPriorities = extractWeeklyPriorities(weeklyMarkdown);
  const reviewSchedule = scheduleItems(assessment.reviewSchedule, { route: "cuoti-fupan", dimension: "application" });
  return {
    schemaVersion: 2,
    skill: "coach-pc",
    referenceDate: assessment.referenceDate,
    dates: assessment.dates,
    round: currentRound(assessment.rounds, assessment.referenceDate),
    targets: sanitizeTargets(assessment.targets),
    study: reconciled.study,
    factPolicy: {
      rule: reconciled.rule,
      currentFacts: reconciled.currentFacts,
      quarantinedMemoryCount: reconciled.quarantined.length,
      targetNotes: targetNotes(assessment.targets),
    },
    weeklyPriorities,
    errorBook: assessment.errorBook,
    askPoints: assessment.askPoints,
    recite: assessment.recite,
    schedule: scheduleItems(assessment.reviewSchedule),
    crossSubjectReview: buildCrossSubjectReviewPool({
      topics: engine.topicStates?.items ?? [],
      events: errorSummary?.events ?? [],
      eventProofs,
      schedule: reviewSchedule,
      weeklyPriorities,
      referenceDate: assessment.referenceDate,
    }),
    // [gpt] 复检题无论由 coach 直出还是转 cuoti，展示前都共用同一确定性 Gate。
    questionIntegrity: questionIntegrityContext(),
    decision: {
      controller: engine.controller,
      today: engine.dispatch?.today ?? [],
      examRisks: engine.examRisk?.topRisks ?? [],
      lossHotspots: (engine.examForecast?.hotspots ?? []).slice(0, 8),
      rootBlockers: (engine.knowledgeGraph?.activeBlockedTargets ?? []).slice(0, 8),
      caveat: engine.caveat,
    },
    memories: reconciled.memories,
    quarantinedMemories: reconciled.quarantined,
    memoryOverflow: reconciled.memoryOverflow,
    messages: compactMessages(messages),
    messageOverflow: messages.length > 6,
  };
}

export function buildCuotiContext({ assessment, errorSummary, eventProofs = new Map(), subject = null, calibration = null, weeklyMarkdown = "", routing = {} }) {
  const engine = assessment.coachEngine;
  const allTopics = engine.topicStates?.items ?? [];
  const allOpenEvents = (errorSummary?.events ?? [])
    .filter((item) => item.status === "open")
    .sort((left, right) => String(right.logDate).localeCompare(String(left.logDate)) || right.id - left.id);
  const weeklyPriorities = extractWeeklyPriorities(weeklyMarkdown);
  const crossSubjectSchedule = scheduleItems(assessment.reviewSchedule, { route: "cuoti-fupan", dimension: "application", upcomingLimit: 30 });
  const crossSubjectReview = buildCrossSubjectReviewPool({
    topics: allTopics,
    events: allOpenEvents,
    eventProofs,
    schedule: crossSubjectSchedule,
    weeklyPriorities,
    referenceDate: assessment.referenceDate,
    routing: { focusSubject: subject, ...routing },
  });
  const routedTopicIds = new Set(crossSubjectReview.candidates.map((item) => Number(item.topicId)).filter(Boolean));
  const routedEventIds = new Set(crossSubjectReview.candidates.map((item) => Number(item.eventId)).filter(Boolean));
  // [gpt] 无聚焦科目时只展开跨科候选的底层主题和事件；完整五科清单仍可按需钻取，避免重规划快照反而变成长账本。
  const topics = allTopics.filter((item) => subject ? item.subject === subject : routedTopicIds.has(Number(item.id)));
  const events = allOpenEvents.filter((item) => subject ? item.subject === subject : routedEventIds.has(Number(item.id)));
  return {
    schemaVersion: 2,
    skill: "cuoti-fupan",
    referenceDate: assessment.referenceDate,
    subject,
    dates: assessment.dates,
    round: currentRound(assessment.rounds, assessment.referenceDate),
    weeklyPriorities,
    schedule: scheduleItems(assessment.reviewSchedule, { route: "cuoti-fupan", dimension: "application", subject }),
    questionIntegrity: questionIntegrityContext(),
    judgmentResult: judgmentResultContext(),
    crossSubjectReview,
    topicCounts: engine.topicStates?.counts ?? {},
    dueTopicIds: (engine.topicStates?.due ?? []).filter((item) => subject ? item.subject === subject : routedTopicIds.has(Number(item.id))).map((item) => item.id),
    topics: topics.map(compactTopic),
    openEvents: events,
    portrait: subjectPortrait(engine.failurePortrait, subject),
    calibration: subject ? calibration?.stumblePredictionBySubject?.[subject] ?? null : calibration?.groups?.["栽点"] ?? null,
    overflow: { topics: topics.length > 80, events: events.length > 120 },
  };
}

function daibeiStableTargets(item = {}) {
  const reciteIds = extractDaibeiReciteIds(item.ref, item.title, item.id);
  const { knowledgeIds } = extractScheduleTargetIds({ ref: item.ref, task: item.title });
  return {
    reciteIds,
    knowledgeIds,
    items: [
      ...reciteIds.map((id) => ({ id, kind: "ledger" })),
      ...knowledgeIds.map((id) => ({ id, kind: "knowledge" })),
    ],
  };
}

function scheduleMatchesDaibeiTarget(item, target = {}) {
  const targets = daibeiStableTargets(item);
  return targets.reciteIds.includes(target.reciteId) || targets.knowledgeIds.includes(target.kpId);
}

// [gpt] 2026-08-14：调度顺序固化为等待目标、到期排期、主线续接，模型不再自由改序。
function daibeiSelection({ recovery = null, schedule, study }) {
  if (recovery?.preferred) {
    const matchingSchedule = [...schedule.overdue, ...schedule.dueToday, ...schedule.upcoming]
      .find((item) => item.id === recovery.preferred.targetRef
        || String(recovery.preferred.targetRef).includes(String(item.id))
        || scheduleMatchesDaibeiTarget(item, recovery.preferred));
    return {
      source: "waiting_run",
      blocked: false,
      runId: recovery.preferred.runId,
      targetRef: recovery.preferred.targetRef,
      targetId: recovery.preferred.targetId,
      targetKind: recovery.preferred.targetKind,
      kpId: recovery.preferred.kpId,
      reciteId: recovery.preferred.reciteId,
      scheduleId: matchingSchedule?.id ?? null,
      reason: "已有 waiting_user 且冻结了唯一稳定条目；必须先恢复，不得另选新章。",
    };
  }
  if (recovery?.targetFallback) {
    const matchingSchedule = [...schedule.overdue, ...schedule.dueToday, ...schedule.upcoming]
      .find((item) => item.id === recovery.targetFallback.targetRef
        || String(recovery.targetFallback.targetRef).includes(String(item.id))
        || scheduleMatchesDaibeiTarget(item, recovery.targetFallback));
    return {
      source: "waiting_target_recovered",
      blocked: false,
      runId: null,
      priorRunId: recovery.targetFallback.runId,
      targetRef: recovery.targetFallback.targetRef,
      targetId: recovery.targetFallback.targetId,
      targetKind: recovery.targetFallback.targetKind,
      kpId: recovery.targetFallback.kpId,
      reciteId: recovery.targetFallback.reciteId,
      scheduleId: matchingSchedule?.id ?? null,
      reason: "旧 waiting Run 含跨题结果，已隔离旧遥测；只继承冻结目标到新 Run，不复用污染结果。",
    };
  }
  const priority = { P0: 0, P1: 1, P2: 2 };
  const due = [
    ...schedule.overdue.map((item) => ({ ...item, scheduleState: "overdue" })),
    ...schedule.dueToday.map((item) => ({ ...item, scheduleState: "due_today" })),
  ].sort((left, right) => (priority[left.priority] ?? 9) - (priority[right.priority] ?? 9)
    || String(left.date ?? "").localeCompare(String(right.date ?? ""))
    || String(left.id ?? "").localeCompare(String(right.id ?? "")));
  if (due.length) {
    const targets = daibeiStableTargets(due[0]);
    const target = targets.items.length === 1 ? targets.items[0] : null;
    return {
      source: "due_schedule",
      blocked: targets.items.length !== 1,
      runId: null,
      targetRef: due[0].id,
      targetId: target?.id ?? null,
      targetKind: target?.kind ?? null,
      kpId: target?.kind === "knowledge" ? target.id : null,
      reciteId: target?.kind === "ledger" ? target.id : null,
      scheduleId: due[0].id,
      reason: targets.items.length === 1
        ? `${due[0].scheduleState}/${due[0].priority ?? "P?"} 的稳定排期先于自由续章。`
        : `到期排期 ${due[0].id} 未绑定唯一带背目标（挂账条目 ID 或 KP-ID）；禁止猜题冲抵，先修排期。`,
    };
  }
  const recentGuided = study?.recent?.find((item) => item.recitationMode === "带背") ?? null;
  return {
    source: "mainline",
    blocked: false,
    runId: null,
    targetRef: null,
    targetId: null,
    targetKind: null,
    kpId: null,
    reciteId: null,
    scheduleId: null,
    anchor: recentGuided?.chapter ?? null,
    reason: recentGuided?.chapter
      ? `无等待目标和到期排期；从最近一次系统带背“${recentGuided.chapter}”之后续接。`
      : "无等待目标和到期排期；按本科蓝本主线从首个未覆盖答题单元开始。",
  };
}

export function buildDaibeiContext({ assessment, studyLogs, subject = null, recovery = null, weeklyMarkdown = "" }) {
  const engine = assessment.coachEngine;
  const reciteItems = (engine.reciteMemory?.items ?? []).filter((item) => !subject || item.subject === subject);
  // [gpt] 先按科目筛再排序；不能过滤“全局前 N”，否则某科可能被别科挤到空结果。
  const topDropRisk = [...reciteItems]
    .sort((left, right) => Number(right.dropRisk ?? 0) - Number(left.dropRisk ?? 0)
      || String(left.dueDate ?? "").localeCompare(String(right.dueDate ?? ""))
      || String(left.id).localeCompare(String(right.id)))
    .slice(0, 12);
  const study = summarizeStudyLogs(studyLogs, { subject });
  const schedule = scheduleItems(assessment.reviewSchedule, {
    route: "daibei-pc",
    dimension: "recall",
    subject,
    strictSubject: Boolean(subject),
  });
  const selection = daibeiSelection({ recovery, schedule, study });
  return {
    schemaVersion: 1,
    skill: "daibei-pc",
    referenceDate: assessment.referenceDate,
    subject,
    dates: assessment.dates,
    round: currentRound(assessment.rounds, assessment.referenceDate),
    study,
    weeklyPriorities: extractWeeklyPriorities(weeklyMarkdown),
    schedule,
    recovery: recovery ? {
      preferred: recovery.preferred,
      targetFallback: recovery.targetFallback,
      openCount: recovery.openRuns?.length ?? 0,
      ignoredCount: recovery.ignored?.length ?? 0,
    } : null,
    selection: {
      rule: "waiting_run > overdue_or_due_schedule > mainline",
      ...selection,
    },
    // [gpt] 2026-08-12：带背复检若临时采用选择题，也不能绕过共享题面 Gate。
    questionIntegrity: questionIntegrityContext(),
    recite: {
      counts: { ...(assessment.recite?.counts ?? {}), ...(engine.reciteMemory?.counts ?? {}) },
      selectedCounts: {
        items: reciteItems.length,
        active: reciteItems.filter((item) => item.status === "active").length,
        due: reciteItems.filter((item) => item.dueDate && item.dueDate <= assessment.referenceDate).length,
        highRisk: reciteItems.filter((item) => Number(item.dropRisk ?? 0) >= 70).length,
      },
      linkDebt: engine.reciteMemory?.linkDebt ?? null,
      topDropRisk,
      due: reciteItems.filter((item) => item.dueDate && item.dueDate <= assessment.referenceDate).slice(0, 20),
      oldestActive: (assessment.recite?.oldestActive ?? []).filter((item) => !subject || item.subject === subject).slice(0, 12),
      withdrawnReviewCandidates: (assessment.recite?.withdrawnReviewCandidates ?? []).filter((item) => !subject || item.subject === subject).slice(0, 8),
    },
    subjectPortrait: subjectPortrait(engine.failurePortrait, subject),
    controller: engine.controller,
  };
}

export function buildAskContext({ referenceDate, subject = null, studyLogs = [], errorSummary = null }) {
  return {
    schemaVersion: 1,
    skill: "ask-pc",
    referenceDate,
    subject,
    study: summarizeStudyLogs(studyLogs, { subject }),
    questionIntegrity: questionIntegrityContext(),
    activeTopics: (errorSummary?.activeTopics ?? []).filter((item) => !subject || item.subject === subject).slice(0, 12),
    awaitingColdReviewTopics: (errorSummary?.awaitingColdReviewTopics ?? []).filter((item) => !subject || item.subject === subject).slice(0, 8),
  };
}

export function buildLunshuContext({ referenceDate, kind, studyLogs = [], subjective, schedule }) {
  const subjects = kind === "case" ? ["刑法", "民法"] : ["法理", "宪法", "法制史"];
  const relevantRows = studyLogs.filter((row) => subjects.includes(row.subject));
  const track = subjective?.capabilityProfile?.tracks?.[kind] ?? null;
  return {
    schemaVersion: 1,
    skill: "lunshu-pc",
    referenceDate,
    kind,
    study: summarizeStudyLogs(relevantRows),
    schedule: scheduleItems(schedule, { route: "lunshu-pc", dimension: "application" }),
    questionIntegrity: questionIntegrityContext(),
    counts: subjective?.counts ?? {},
    scores: subjective?.scores ?? {},
    defects: (subjective?.defects ?? subjective?.activeDefects ?? []).slice?.(0, 20) ?? [],
    capability: track,
    propagation: subjective?.propagation ?? null,
    issues: subjective?.issues ?? [],
  };
}

function lineStudy(study) {
  return Object.entries(study?.bySubject ?? {}).map(([subject, value]) => {
    const latest = value.recentChapters.map((item) => `${item.chapter}(${item.date})`).join("、") || "无";
    return `- ${subject}：${value.total} 条 / ${value.uniqueChapters} 个章节标签 / 最近 ${latest}`;
  });
}

function lineSchedule(schedule) {
  // [gpt] 2026-08-12：把状态与优先级直接展示给执行 Skill，避免模型自行比日期时漏掉逾期 P0。
  const items = [
    ...(schedule?.overdue ?? []).map((item) => ({ item, status: "逾期" })),
    ...(schedule?.dueToday ?? []).map((item) => ({ item, status: "今日" })),
    ...(schedule?.upcoming ?? []).map((item) => ({ item, status: "未来" })),
  ];
  return items.length
    ? items.map(({ item, status }) => `- [${status}]${item.priority ? `[${item.priority}]` : ""} ${item.id ?? "?"} ${item.date ?? "?"} ${item.subject ?? ""} ${item.title}`)
    : ["- 无匹配结构化排期"];
}

function lineCrossSubjectReview(pool) {
  if (!pool?.candidates?.length) {
    return pool?.coolingCount
      ? [`- 当前无通过冷却资格的可执行事件；已隔离 ${pool.coolingCount} 条冷却事件，不参与本轮排序`]
      : ["- 无可路由 open 事件；如与事实不符，先检查 outbox 与事件级 proof"];
  }
  const lines = pool.candidates.map((item) => {
    const closure = item.state === "ready-to-absorb" ? "事件已达销账门槛"
      : item.canAbsorbAfterPass && item.topicCooling
        ? `事件本题通过可销账；主题冷却至 ${item.topicEarliestDate}，本轮不推进 stable`
        : item.canAbsorbAfterPass ? "事件本题通过可销账"
          : item.estimatedPassesToAbsorb == null ? "先钻取 proof"
            : `预计至少还需 ${item.estimatedPassesToAbsorb} 次合格证据`;
    return `- [${item.subject}] #${item.eventId}${item.topicId ? `/T#${item.topicId}` : ""} ${item.title}｜${closure}｜${item.scheduleStatus}${item.weeklyPriority ? `/${item.weeklyPriority}` : ""}｜score ${item.score}`;
  });
  if (pool.coolingCount) lines.push(`- 已隔离 ${pool.coolingCount} 条冷却事件，不参与本轮排序`);
  return lines;
}

function lineRequiredP0(pool) {
  if (!pool?.requiredP0?.length) return ["- 无到期或逾期的指定错题 P0；按跨科收益池执行"];
  return pool.requiredP0.map((item) => {
    const targets = [
      ...item.topicIds.map((id) => `T#${id}`),
      ...item.eventIds.map((id) => `#${id}`),
      ...item.knowledgeIds.map((id) => id),
    ].join("/") || "无稳定目标";
    const mapping = item.candidateKeys.length ? item.candidateKeys.join("、") : "未映射";
    const deferred = item.deferredCandidateKeys?.length ? `｜冷却隔离 ${item.deferredCandidateKeys.join("、")}` : "";
    return `- [${item.status === "overdue" ? "逾期" : "今日"}][P0] ${item.id} ${targets}｜候选 ${mapping}${deferred}${item.blockedReason ? `｜BLOCK：${item.blockedReason}` : "｜必须先验收，其他题不可冲抵"}`;
  });
}

export function formatSkillContext(context) {
  const lines = [`交互会话快照 v${context.schemaVersion}｜${context.skill}｜北京 ${context.referenceDate}`];
  if (context.execution?.runId) {
    lines.push(`Skill Run：${context.execution.runId}`);
    lines.push(`执行硬闸：${context.execution.rule}`);
    lines.push(`- 材料命令追加：${context.execution.materialFlag}`);
    lines.push(`- 检查点：${context.execution.commands.checkpoint}`);
    lines.push(`- 收口：${context.execution.commands.end}`);
  }
  if (context.dataFreshness && !context.dataFreshness.complete) {
    lines.push(`⚠️ 可靠 outbox 尚有 ${context.dataFreshness.pending} 条待同步：先运行 cuoti.mjs sync 并重跑快照，当前数据库状态不得称为最新。`);
  }
  if (context.subject) lines.push(`科目：${context.subject}`);
  if (context.kind) lines.push(`题型：${context.kind}`);
  if (context.round) lines.push(`轮次：${context.round.name}（${context.round["窗口"] ?? "?"}）`);

  if (context.skill === "cuoti-fupan" && context.intake) {
    lines.push("", "【新错题轻量摄取】", `- ${context.rule}`);
    return lines.join("\n");
  }

  if (context.skill === "coach-pc") {
    lines.push("", "【学习进度】", ...lineStudy(context.study), "", "【本周优先级】");
    lines.push(`【事实裁决】${context.factPolicy.rule}`);
    if (context.factPolicy.quarantinedMemoryCount) lines.push(`- 已隔离 ${context.factPolicy.quarantinedMemoryCount} 条与实时流水冲突的历史叙述，不得用于当前判断。`);
    if (context.factPolicy.targetNotes.length) lines.push(`- 静态目标说明 ${context.factPolicy.targetNotes.length} 条仅作历史/条件备注；当前状态仍以上述实时事实为准。`);
    lines.push(...(context.weeklyPriorities.length ? context.weeklyPriorities.map((item) => `- [${item.priority}] ${item.title}${item.details.length ? `｜${item.details.join("；")}` : ""}`) : ["- 无可解析优先级；需要时读 weekly-draft 原文"]));
    lines.push("", `【错题】open事件 ${context.errorBook.eventCounts.open} / 活跃主题 ${context.errorBook.activeTopics} / 待冷检 ${context.errorBook.awaitingColdReviewTopics}`);
    lines.push(`【带背】active ${context.recite.counts.active} / 可复检 ${context.recite.counts.actionable}`);
    lines.push(`【控制器】${context.decision.controller.mode}｜${context.decision.controller.reason}`);
    lines.push(`【今日候选】${context.decision.today.map((item) => `[${item.priority}]${item.subject}·${item.title}`).join("；") || "无"}`);
    lines.push("", "【跨科销账机会】", ...lineCrossSubjectReview(context.crossSubjectReview));
    lines.push(`- 路由规则：${context.crossSubjectReview.rule}`);
    lines.push("", "【命题完整性 Gate】", `- ${context.questionIntegrity.rule}`, `- 命令：${context.questionIntegrity.command}`);
    lines.push("", "【结构化排期】", ...lineSchedule(context.schedule));
    lines.push("", "【长期记忆】", ...(context.memories.length ? context.memories.map((item) => `- ${item.category ? `[${item.category}] ` : ""}${item.fact}`) : ["- 无"]));
    if (context.memoryOverflow) lines.push("- ⚠️ 仅显示最近 20 条；若结论依赖更早约定，运行 coach.mjs ledger 钻取。");
    lines.push("", "【近对话】", ...(context.messages.length ? context.messages.map((item) => `- ${item.role}: ${item.content}`) : ["- 无"]));
    return lines.join("\n");
  }

  if (context.skill === "cuoti-fupan") {
    lines.push("", `【跨科重规划】signal=${context.crossSubjectReview.signal} / 当前科 ${context.crossSubjectReview.currentSubject ?? "无"} / 连续 ${context.crossSubjectReview.subjectStreak} / 最小动作 ${context.crossSubjectReview.focusMinimumMet ? "已完成" : "未标记"}`);
    lines.push("", "【指定 P0 硬闸】", ...lineRequiredP0(context.crossSubjectReview));
    lines.push(...lineCrossSubjectReview(context.crossSubjectReview));
    lines.push(`- ${context.crossSubjectReview.rule}`);
    lines.push("", "【命题完整性 Gate】", `- ${context.questionIntegrity.rule}`, `- 命令：${context.questionIntegrity.command}`);
    if (context.judgmentResult) {
      lines.push("", "【判题证据卡 Gate】", `- ${context.judgmentResult.rule}`, `- 命令：${context.judgmentResult.command}`);
      // [claude] 2026-08-26：schema 随开场一起下发，取消“翻源码或照抄旧样例”这条唯一出路。
      lines.push(`- ${context.judgmentResult.templateRule}`);
      lines.push(`- 模板（schemaVersion=${context.judgmentResult.schemaVersion}）：${JSON.stringify(context.judgmentResult.template)}`);
    }
    lines.push("", `【主题】${context.topics.length} 个；到期 ${context.dueTopicIds.join(",") || "无"}`);
    for (const item of context.topics) lines.push(`- T#${item.id} ${item.title}｜${item.state}/${item.masteryStatus}｜open ${item.eventCounts?.open ?? 0}｜最早 ${item.nextProbe?.earliestDate ?? "?"}｜${item.nextProbe?.variantKind ?? "?"}/${item.nextProbe?.probeAxis ?? "?"}`);
    lines.push("", `【open 原始事件】${context.openEvents.length} 条`);
    for (const event of context.openEvents) lines.push(`- #${event.id} ${event.logDate} T#${event.topicIds.join("/") || "未归类"}｜${text(event.knowledge, 260)}`);
    lines.push("", "【结构化排期】", ...lineSchedule(context.schedule));
    if (context.calibration) lines.push("", `【栽点校准】N=${context.calibration.countable} / 命中率 ${context.calibration.hitRate ?? "—"}%｜${context.calibration.advice}`);
    return lines.join("\n");
  }

  if (context.skill === "daibei-pc") {
    lines.push("", "【调度裁决】");
    lines.push(`- 固定顺序：${context.selection.rule}`);
    lines.push(`- 当前：${context.selection.source}${context.selection.source === "waiting_run" && context.selection.runId ? `｜恢复 ${context.selection.runId}` : ""}${context.selection.source === "waiting_target_recovered" && context.selection.runId ? `｜新建 ${context.selection.runId}` : ""}${context.selection.priorRunId ? `｜隔离旧 Run ${context.selection.priorRunId}` : ""}${context.selection.scheduleId ? `｜排期 ${context.selection.scheduleId}` : ""}${context.selection.reciteId ? `｜条目 ${context.selection.reciteId}` : ""}${context.selection.kpId ? `｜知识点 ${context.selection.kpId}` : ""}`);
    lines.push(`- ${context.selection.blocked ? "BLOCK｜" : ""}${context.selection.reason}`);
    lines.push("", "【带背进度线】");
    const trail = context.study.trail;
    lines.push(`- 我带过：${trail?.guided.map((item) => `${item.chapter}(${item.date})`).join("、") || "无"}`);
    lines.push(`- 云自背：${trail?.selfRecite.map((item) => `${item.chapter}(${item.date})`).join("、") || "无"}`);
    if (trail?.truncated) lines.push("- ⚠️ 进度线超过 120 个章节标签；需钻取原 study_log 后再判缺口。");
    lines.push("", `【带背状态·本科】active ${context.recite.selectedCounts.active} / 条目 ${context.recite.selectedCounts.items} / 到期 ${context.recite.selectedCounts.due} / 高风险 ${context.recite.selectedCounts.highRisk}`);
    for (const item of context.recite.topDropRisk) lines.push(`- ${item.id} ${item.subject}·${item.title}｜风险 ${item.dropRisk ?? item.riskScore ?? "?"}｜到期 ${item.dueDate ?? "?"}`);
    lines.push("", "【命题完整性 Gate】", `- ${context.questionIntegrity.rule}`, `- 命令：${context.questionIntegrity.command}`);
    lines.push("", "【结构化排期】", ...lineSchedule(context.schedule), "", "【本周优先级】");
    lines.push(...(context.weeklyPriorities.length ? context.weeklyPriorities.map((item) => `- [${item.priority}] ${item.title}`) : ["- 无"]));
    return lines.join("\n");
  }

  if (context.skill === "ask-pc") {
    lines.push("", "【本科进度】", ...lineStudy(context.study));
    lines.push("", "【命题完整性 Gate】", `- ${context.questionIntegrity.rule}`, `- 命令：${context.questionIntegrity.command}`);
    lines.push("", "【相关活跃主题】", ...(context.activeTopics.length ? context.activeTopics.map((item) => `- T#${item.id} ${item.title}｜open ${item.eventCounts.open}`) : ["- 无"]));
    return lines.join("\n");
  }

  if (context.skill === "lunshu-pc") {
    lines.push("", "【相关科目进度】", ...lineStudy(context.study));
    lines.push("", `【主观题样本】案例 ${context.counts.cases ?? 0} / 论述 ${context.counts.essays ?? 0} / 重写 ${context.counts.rewrites ?? 0} / active病灶 ${context.counts.activeDefects ?? 0}`);
    const draft = context.capability?.draft;
    if (draft) lines.push(`【首稿画像】样本 ${draft.observedPractices}｜${draft.qualified ? "达到画像门槛" : "低样本，只看原始证据"}`);
    lines.push("", "【命题完整性 Gate】", `- ${context.questionIntegrity.rule}`, `- 命令：${context.questionIntegrity.command}`);
    lines.push("", "【结构化排期】", ...lineSchedule(context.schedule));
    return lines.join("\n");
  }

  return JSON.stringify(context, null, 2);
}
