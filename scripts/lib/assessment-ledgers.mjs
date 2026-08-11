import {
  INTERVENTION_OBSERVATION_WINDOWS,
  validateProtocolAssignment,
} from "./intervention-protocols.mjs";
import {
  SUBJECTIVE_ROOT_CAPABILITIES,
  buildSubjectiveAnalytics,
  parseSubjectivePracticeSignals,
} from "./subjective-capability.mjs";

const DAY = 86400000;
const SCHEDULE_ROUTES = new Set(["ask-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "yingyu-pc", "coach-pc"]);
const SCHEDULE_DIMENSIONS = new Set(["exposure", "understanding", "recall", "application"]);
// [gpt] 2026-08-10：排期同时承载一次干预的事前画像与事后结构化结果，供学习系统重算响应率。
const SCHEDULE_OUTCOMES = new Set(["pass", "partial", "fail", "void"]);
const SCHEDULE_PROMPTS = new Set(["clean", "cued", "invalid"]);
const SCHEDULE_PATTERN_SCOPES = new Set(["point", "subject"]);
const SCHEDULE_OBSERVATION_WINDOWS = new Set(INTERVENTION_OBSERVATION_WINDOWS);
// [gpt] 2026-08-10：周计划验收单元必须带稳定来源，控制器才能按 P0/P1/P2 真实降载。
const PLAN_SOURCES = new Set(["weekly", "assessment", "milestone", "coach"]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateDistance(from, to) {
  if (!validDate(from) || !validDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function resolveShortDate(token, referenceDate) {
  const clean = String(token ?? "").replace(/[^0-9-]/g, "");
  if (/^20\d{2}-\d{2}-\d{2}$/.test(clean)) return validDate(clean) ? clean : null;
  const match = clean.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const month = String(Number(match[1])).padStart(2, "0");
  const day = String(Number(match[2])).padStart(2, "0");
  let value = `${referenceDate.slice(0, 4)}-${month}-${day}`;
  if (!validDate(value)) return null;
  const future = dateDistance(referenceDate, value);
  if (future != null && future > 90) value = `${Number(referenceDate.slice(0, 4)) - 1}-${month}-${day}`;
  return validDate(value) ? value : null;
}

function blocks(markdown, heading) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const indexes = [];
  lines.forEach((line, index) => { if (heading.test(line)) indexes.push(index); });
  return indexes.map((start, position) => ({
    line: start + 1,
    heading: lines[start],
    body: lines.slice(start + 1, indexes[position + 1] ?? lines.length).join("\n"),
  }));
}

function field(body, label) {
  const match = String(body).match(new RegExp(`^- \\*\\*${label}\\*\\*[：:]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function parseDailyLedger(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const entries = blocks(markdown, /^##\s+20\d{2}-\d{2}-\d{2}/).map((block) => {
    const date = block.heading.match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
    const dispatch = field(block.body, "派单");
    const settlement = field(block.body, "昨日结算");
    const activity = field(block.body, "今日流水");
    const warning = field(block.body, "断档");
    const priorityCounts = Object.fromEntries(["P0", "P1", "P2"].map((priority) => [priority, (dispatch?.match(new RegExp(`\\[${priority}\\]`, "g")) ?? []).length]));
    const marks = settlement?.match(/✅|⚠️?|❌/gu) ?? [];
    return {
      date,
      line: block.line,
      dispatch,
      settlement,
      activity,
      warning,
      priorityCounts,
      dispatched: priorityCounts.P0 + priorityCounts.P1 + priorityCounts.P2,
      settlementEvidence: marks.length > 0,
      settled: {
        total: marks.length,
        completed: marks.filter((mark) => mark === "✅").length,
        partial: marks.filter((mark) => mark.startsWith("⚠")).length,
        missed: marks.filter((mark) => mark === "❌").length,
      },
    };
  }).filter((entry) => validDate(entry.date));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const dates = new Set(entries.map((entry) => entry.date));
  const gaps = [];
  for (let index = 1; index < entries.length; index++) {
    const gap = dateDistance(entries[index - 1].date, entries[index].date);
    if (gap > 1) gaps.push({ after: entries[index - 1].date, before: entries[index].date, missingDays: gap - 1 });
  }
  const settled = entries.filter((entry) => entry.settlementEvidence).reduce((sum, entry) => ({
    total: sum.total + entry.settled.total,
    completed: sum.completed + entry.settled.completed,
    partial: sum.partial + entry.settled.partial,
    missed: sum.missed + entry.settled.missed,
  }), { total: 0, completed: 0, partial: 0, missed: 0 });
  const latestDate = entries.at(-1)?.date ?? null;
  return {
    referenceDate,
    entries,
    counts: {
      days: entries.length,
      dispatched: entries.reduce((sum, entry) => sum + entry.dispatched, 0),
      ...settled,
    },
    strictExecutionRate: settled.total ? Number((settled.completed / settled.total).toFixed(3)) : null,
    latestDate,
    daysSinceLatest: latestDate ? dateDistance(latestDate, referenceDate) : null,
    gaps,
    uniqueDates: dates.size,
  };
}

function legacyScheduleStatus(line) {
  if (/✅/.test(line) && /(已执行|达成|完成|结案|补齐)/.test(line)) return "completed";
  if (/❌/.test(line) && /(未执行|实际未执行|滚至|仍为\s*0|完败)/.test(line)) return "missed";
  if (/🟡/.test(line) || /部分达成/.test(line)) return "partial";
  return "pending";
}

function parseCanonicalScheduleLine(line, lineNumber) {
  const match = line.match(/^- \[([ xX])\]\s+(20\d{2}-\d{2}-\d{2})\s*\|\s*(P[0-2])\s*\|\s*id=([^|]+)\|\s*type=([^|]+)\|\s*task=([^|]+)(.*)$/);
  if (!match) return null;
  const tail = match[7] ?? "";
  const values = Object.fromEntries([...tail.matchAll(/\|\s*([a-z_]+)=([^|]+)/g)].map((item) => [item[1], item[2].trim()]));
  return {
    id: match[4].trim(),
    dueDate: match[2],
    priority: match[3],
    type: match[5].trim(),
    task: match[6].trim(),
    ref: values.ref ?? null,
    route: values.route ?? null,
    dimension: values.dimension ?? null,
    subject: values.subject ?? null,
    kpId: values.kp ?? null,
    failurePatternCode: values.pattern ?? null,
    failurePatternScope: values.pattern_scope ?? null,
    interventionCode: values.intervention ?? null,
    // [gpt] 2026-08-10：episode/protocol/window 把一次教法与后续多时点冷检串成同一纵向样本。
    interventionEpisodeId: values.episode ?? null,
    protocolCode: values.protocol ?? null,
    protocolVersion: values.protocol_version == null ? null : Number(values.protocol_version),
    observationWindow: values.window ?? null,
    episodeStartedOn: values.episode_start ?? null,
    baselineRisk: values.baseline_risk == null ? null : Number(values.baseline_risk),
    expectedOutcome: values.expect ?? null,
    planId: values.plan_id ?? null,
    planWeek: values.plan_week ?? null,
    planSource: values.plan_source ?? null,
    acceptanceWeight: values.weight == null ? null : Number(values.weight),
    goalId: values.goal_id ?? null,
    status: match[1].toLowerCase() === "x" ? "completed" : "pending",
    completedOn: values.completed ?? null,
    result: values.result ?? null,
    outcome: values.outcome ?? null,
    cold: values.cold == null ? null : values.cold === "true" ? true : values.cold === "false" ? false : values.cold,
    promptIntegrity: values.prompt ?? null,
    source: "canonical",
    line: lineNumber,
    raw: line,
  };
}

export function parseReviewSchedule(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const issues = [];
  let inheritedPriority = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const canonical = parseCanonicalScheduleLine(line, index + 1);
    if (canonical) {
      if (!validDate(canonical.dueDate)) issues.push({ severity: "error", code: "invalid_date", line: index + 1, message: `无效日期 ${canonical.dueDate}` });
      // [gpt] 2026-08-10：route/dimension 是执行路由元数据，成对出现并使用稳定枚举。
      if (Boolean(canonical.route) !== Boolean(canonical.dimension)) {
        issues.push({ severity: "error", code: "incomplete_dispatch_metadata", line: index + 1, message: "route 与 dimension 必须成对出现" });
      }
      if (canonical.route && !SCHEDULE_ROUTES.has(canonical.route)) {
        issues.push({ severity: "error", code: "invalid_route", line: index + 1, message: `未知执行 route：${canonical.route}` });
      }
      if (canonical.dimension && !SCHEDULE_DIMENSIONS.has(canonical.dimension)) {
        issues.push({ severity: "error", code: "invalid_dimension", line: index + 1, message: `未知检验 dimension：${canonical.dimension}` });
      }
      if (canonical.kpId && !/^[A-Z]{2,4}-\d{4}$/.test(canonical.kpId)) {
        issues.push({ severity: "error", code: "invalid_kp", line: index + 1, message: `无效知识点 ID：${canonical.kpId}` });
      }
      if (canonical.failurePatternScope && !SCHEDULE_PATTERN_SCOPES.has(canonical.failurePatternScope)) {
        issues.push({ severity: "error", code: "invalid_pattern_scope", line: index + 1, message: `未知画像范围：${canonical.failurePatternScope}` });
      }
      if (canonical.baselineRisk != null && (!Number.isInteger(canonical.baselineRisk) || canonical.baselineRisk < 0 || canonical.baselineRisk > 100)) {
        issues.push({ severity: "error", code: "invalid_baseline_risk", line: index + 1, message: "baseline_risk 必须是 0-100 整数" });
      }
      // [gpt] 2026-08-10：plan_* 成套出现；一条 canonical 行就是一个可独立验收的计划单元。
      const planFields = [canonical.planId, canonical.planWeek, canonical.planSource].filter((value) => value != null).length;
      if (planFields > 0 && planFields < 3) {
        issues.push({ severity: "error", code: "incomplete_plan_metadata", line: index + 1, message: "plan_id/plan_week/plan_source 必须成套出现" });
      }
      if (canonical.planId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(canonical.planId)) {
        issues.push({ severity: "error", code: "invalid_plan_id", line: index + 1, message: `无效 plan_id：${canonical.planId}` });
      }
      if (canonical.planWeek && (!validDate(canonical.planWeek) || new Date(`${canonical.planWeek}T00:00:00Z`).getUTCDay() !== 1)) {
        issues.push({ severity: "error", code: "invalid_plan_week", line: index + 1, message: "plan_week 必须是周一的 YYYY-MM-DD" });
      }
      if (canonical.planSource && !PLAN_SOURCES.has(canonical.planSource)) {
        issues.push({ severity: "error", code: "invalid_plan_source", line: index + 1, message: `未知 plan_source：${canonical.planSource}` });
      }
      if (canonical.acceptanceWeight != null && (!Number.isInteger(canonical.acceptanceWeight) || canonical.acceptanceWeight < 1 || canonical.acceptanceWeight > 5)) {
        issues.push({ severity: "error", code: "invalid_plan_weight", line: index + 1, message: "weight 必须是 1-5 整数" });
      }
      if (canonical.goalId && !canonical.planId) {
        issues.push({ severity: "error", code: "orphan_goal_id", line: index + 1, message: "goal_id 只能随 plan_* 元数据出现" });
      }
      if (planFields === 3 && validDate(canonical.planWeek) && validDate(canonical.dueDate)) {
        const offset = dateDistance(canonical.planWeek, canonical.dueDate);
        if (offset == null || offset < 0 || offset > 6) {
          issues.push({ severity: "error", code: "plan_due_outside_week", line: index + 1, message: `计划单元到期日 ${canonical.dueDate} 不在所属周 ${canonical.planWeek} 内` });
        }
      }
      // [gpt] 协议字段成组出现；延迟窗口必须知道真实干预起点，不能从计划日期猜。
      const protocolFields = [canonical.interventionEpisodeId, canonical.protocolCode, canonical.protocolVersion, canonical.observationWindow].filter((value) => value != null).length;
      if (protocolFields > 0 && protocolFields < 4) {
        issues.push({ severity: "error", code: "incomplete_intervention_protocol", line: index + 1, message: "episode/protocol/protocol_version/window 必须成套出现" });
      }
      if (canonical.interventionEpisodeId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(canonical.interventionEpisodeId)) {
        issues.push({ severity: "error", code: "invalid_intervention_episode", line: index + 1, message: `无效干预 episode：${canonical.interventionEpisodeId}` });
      }
      if (canonical.observationWindow && !SCHEDULE_OBSERVATION_WINDOWS.has(canonical.observationWindow)) {
        issues.push({ severity: "error", code: "invalid_observation_window", line: index + 1, message: `未知观察窗口：${canonical.observationWindow}` });
      }
      if (canonical.episodeStartedOn && !validDate(canonical.episodeStartedOn)) {
        issues.push({ severity: "error", code: "invalid_episode_start", line: index + 1, message: `无效干预起点：${canonical.episodeStartedOn}` });
      }
      if (canonical.observationWindow && canonical.observationWindow !== "immediate" && !canonical.episodeStartedOn) {
        issues.push({ severity: "error", code: "missing_episode_start", line: index + 1, message: "延迟观察窗口必须带 episode_start" });
      }
      if (protocolFields === 4) {
        const assignment = validateProtocolAssignment({
          code: canonical.protocolCode,
          version: canonical.protocolVersion,
          patternCode: canonical.failurePatternCode,
          route: canonical.route,
          dimension: canonical.dimension,
        });
        if (!assignment.ok) issues.push({ severity: "error", code: "invalid_protocol_assignment", line: index + 1, message: `干预协议与画像/路由不匹配：${assignment.reason}` });
      }
      if (canonical.outcome && !SCHEDULE_OUTCOMES.has(canonical.outcome)) {
        issues.push({ severity: "error", code: "invalid_outcome", line: index + 1, message: `未知干预结果：${canonical.outcome}` });
      }
      if (canonical.cold != null && typeof canonical.cold !== "boolean") {
        issues.push({ severity: "error", code: "invalid_cold", line: index + 1, message: "cold 只允许 true/false" });
      }
      if (canonical.promptIntegrity && !SCHEDULE_PROMPTS.has(canonical.promptIntegrity)) {
        issues.push({ severity: "error", code: "invalid_prompt", line: index + 1, message: `未知提示完整性：${canonical.promptIntegrity}` });
      }
      const structuredOutcomeFields = [canonical.outcome, canonical.cold, canonical.promptIntegrity].filter((value) => value != null).length;
      if (structuredOutcomeFields > 0 && structuredOutcomeFields < 3) {
        issues.push({ severity: "error", code: "incomplete_intervention_outcome", line: index + 1, message: "outcome/cold/prompt 必须成套出现" });
      }
      if (canonical.interventionEpisodeId && canonical.status === "completed" && structuredOutcomeFields !== 3) {
        issues.push({ severity: "error", code: "missing_episode_outcome", line: index + 1, message: "干预 episode 结案必须写结构化 outcome/cold/prompt" });
      }
      if (canonical.observationWindow && canonical.observationWindow !== "immediate" && canonical.status === "completed"
        && canonical.outcome !== "void" && (!canonical.cold || canonical.promptIntegrity !== "clean")) {
        issues.push({ severity: "error", code: "invalid_delayed_observation", line: index + 1, message: "D3/D14/D30 必须是无提示冷检；无效题干只能记 void" });
      }
      if (canonical.observationWindow && canonical.observationWindow !== "immediate" && canonical.status === "completed"
        && validDate(canonical.completedOn) && canonical.completedOn < canonical.dueDate) {
        issues.push({ severity: "error", code: "early_delayed_observation", line: index + 1, message: `${canonical.observationWindow.toUpperCase()} 不能早于 ${canonical.dueDate} 结案` });
      }
      items.push(canonical);
      continue;
    }
    const priority = line.match(/【(P[0-2])(?:-[^】]+)?】/)?.[1];
    if (priority) inheritedPriority = priority;
    const acceptance = line.replace(/^\s*[-*>]+\s*/, "").replace(/[*_`✅❌🟡🔴📌〔〕]/g, "").trim();
    if (!/^验收[①②③④⑤0-9]/.test(acceptance)) continue;
    const dateToken = line.match(/(?<!\d)(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})(?!\d)/)?.[1];
    const dueDate = resolveShortDate(dateToken, referenceDate);
    if (!dueDate) {
      issues.push({ severity: "warning", code: "legacy_missing_date", line: index + 1, message: "含验收字样但未识别出明确日期" });
      continue;
    }
    items.push({
      id: `legacy-L${index + 1}`,
      dueDate,
      priority: priority ?? inheritedPriority ?? "P1",
      type: "legacy",
      task: line.replace(/^\s*[-*>]+\s*/, "").replace(/\s+/g, " ").trim(),
      ref: null,
      route: null,
      dimension: null,
      status: legacyScheduleStatus(line),
      completedOn: null,
      result: null,
      source: "legacy",
      line: index + 1,
      raw: line,
    });
  }
  const ids = new Set();
  for (const item of items.filter((item) => item.source === "canonical")) {
    if (ids.has(item.id)) issues.push({ severity: "error", code: "duplicate_id", line: item.line, message: `排期 ID 重复：${item.id}` });
    ids.add(item.id);
  }
  // [gpt] 同一 episode 的每个时间窗只能有一条，并且协议/画像/对象不可在事后漂移。
  const episodeMetadata = new Map();
  const episodeWindows = new Set();
  for (const item of items.filter((entry) => entry.source === "canonical" && entry.interventionEpisodeId)) {
    const signature = [item.protocolCode, item.protocolVersion, item.failurePatternCode, item.failurePatternScope, item.subject, item.kpId, item.route, item.dimension].join("|");
    const known = episodeMetadata.get(item.interventionEpisodeId);
    if (known != null && known !== signature) {
      issues.push({ severity: "error", code: "intervention_episode_drift", line: item.line, message: `干预 episode ${item.interventionEpisodeId} 的协议或上下文发生漂移` });
    } else episodeMetadata.set(item.interventionEpisodeId, signature);
    const windowKey = `${item.interventionEpisodeId}:${item.observationWindow}`;
    if (episodeWindows.has(windowKey)) {
      issues.push({ severity: "error", code: "duplicate_episode_window", line: item.line, message: `干预 episode ${item.interventionEpisodeId} 重复窗口 ${item.observationWindow}` });
    }
    episodeWindows.add(windowKey);
  }
  // 旧散文无法可靠判断“后来是否被另一段回写结案”，只保留为证据候选；
  // 真正进入行动队列的必须是同文件内的 canonical 条目。
  const open = items.filter((item) => item.source === "canonical" && item.status !== "completed");
  const legacyOpenCandidates = items.filter((item) => item.source === "legacy" && item.status !== "completed");
  const overdue = open.filter((item) => item.dueDate < referenceDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.line - b.line);
  const dueToday = open.filter((item) => item.dueDate === referenceDate);
  const upcoming = open.filter((item) => item.dueDate > referenceDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.line - b.line);
  return {
    referenceDate,
    items,
    open,
    overdue,
    dueToday,
    upcoming,
    legacyOpenCandidates,
    counts: {
      items: items.length,
      canonical: items.filter((item) => item.source === "canonical").length,
      legacy: items.filter((item) => item.source === "legacy").length,
      completed: items.filter((item) => item.status === "completed").length,
      partial: items.filter((item) => item.status === "partial").length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      upcoming: upcoming.length,
      legacyOpenCandidates: legacyOpenCandidates.length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
    issues,
  };
}

// [gpt] 2026-08-10：把“何时计划、何时完成”分开统计；这里只陈述履约事实，不推断掌握度。
export function summarizeScheduleExecution(parsed, { start, end } = {}) {
  if (!validDate(start) || !validDate(end) || start > end) throw new Error("start/end 必须是合法且有序的 YYYY-MM-DD");
  const canonical = (parsed?.items ?? []).filter((item) => item.source === "canonical");
  const completedBy = (item, cutoff) => item.status === "completed" && validDate(item.completedOn) && item.completedOn <= cutoff;
  const dueInWindow = canonical.filter((item) => item.dueDate >= start && item.dueDate <= end);
  const completedByEndItems = dueInWindow.filter((item) => completedBy(item, end));
  const notCompletedByEndItems = dueInWindow.filter((item) => !completedBy(item, end));
  const completedDuringItems = canonical.filter((item) => item.status === "completed" && validDate(item.completedOn) && item.completedOn >= start && item.completedOn <= end);
  const backlogOpenAtEndItems = canonical.filter((item) => item.dueDate < start && !completedBy(item, end));

  const groups = new Map();
  const touch = (item, field) => {
    const route = item.route ?? "unrouted";
    const dimension = item.dimension ?? "unrouted";
    const key = `${route}/${dimension}`;
    const group = groups.get(key) ?? {
      key, route, dimension, planned: 0, completedByEnd: 0, notCompletedByEnd: 0, completedDuring: 0, backlogOpenAtEnd: 0,
    };
    group[field] += 1;
    groups.set(key, group);
  };
  for (const item of dueInWindow) touch(item, "planned");
  for (const item of completedByEndItems) touch(item, "completedByEnd");
  for (const item of notCompletedByEndItems) touch(item, "notCompletedByEnd");
  for (const item of completedDuringItems) touch(item, "completedDuring");
  for (const item of backlogOpenAtEndItems) touch(item, "backlogOpenAtEnd");

  return {
    start,
    end,
    counts: {
      planned: dueInWindow.length,
      completedByEnd: completedByEndItems.length,
      notCompletedByEnd: notCompletedByEndItems.length,
      completedDuring: completedDuringItems.length,
      backlogOpenAtEnd: backlogOpenAtEndItems.length,
    },
    byRouteDimension: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
    completedByEndItems,
    notCompletedByEndItems,
    completedDuringItems,
    backlogOpenAtEndItems,
  };
}

function scoreFrom(body, label) {
  const match = String(body).match(new RegExp(`${label}[^0-9]{0,12}(\\d+(?:\\.\\d+)?)\\s*\\/\\s*15`));
  return match ? Number(match[1]) : null;
}

export function parseSubjectiveLedger(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  const activeText = text.match(/##\s+挂着的病灶([\s\S]*?)(?=\n##\s+)/)?.[1] ?? "";
  const practiceText = text.match(/##\s+练笔记录([\s\S]*?)(?=\n##\s+)/)?.[1] ?? "";
  const resolvedText = text.match(/##\s+已改掉([\s\S]*)$/)?.[1] ?? "";
  const issues = [];
  const parseDefects = (section, status) => blocks(section, /^###\s+[A-Z]\d+[｜|]/).map((block) => {
    const [id, title, detail] = block.heading.replace(/^###\s+/, "").split(/[｜|]/).map((part) => part.trim());
    const firstSeen = block.body.match(/首现\s+(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
    const lastTouched = block.body.match(/最后碰\s+(20\d{2}-\d{2}-\d{2})/)?.[1] ?? firstSeen;
    const rootCode = block.body.match(/^-\s*\*\*底层能力\*\*[：:]\s*([A-Z]\d+)/m)?.[1]?.toUpperCase() ?? null;
    if (rootCode && !Object.hasOwn(SUBJECTIVE_ROOT_CAPABILITIES, rootCode)) {
      issues.push({ severity: "warning", code: "unknown_subjective_root_capability", line: block.line, message: `${id} 使用未知底层能力码：${rootCode}` });
    }
    return { id, title, detail: detail ?? null, status, firstSeen, lastTouched, rootCode, line: block.line };
  });
  const activeDefects = parseDefects(activeText, "active");
  const resolvedDefects = parseDefects(resolvedText, "resolved");
  const practices = blocks(practiceText, /^###\s+20\d{2}-\d{2}-\d{2}[｜|]/).map((block) => {
    const parts = block.heading.replace(/^###\s+/, "").split(/[｜|]/).map((part) => part.trim());
    const date = parts[0];
    const kind = /案例/.test(parts[1] ?? "") ? "案例" : /论述/.test(parts[1] ?? "") ? "论述" : "未知";
    const draftScore = scoreFrom(block.body, "首稿");
    const rewriteScore = scoreFrom(block.body, "重写稿");
    // [gpt] 2026-08-10：结构化画像只读显式字段；旧台账没有字段时保持空画像，不回猜历史表现。
    const signals = parseSubjectivePracticeSignals(block.body, { kind, line: block.line });
    issues.push(...signals.issues);
    if (draftScore == null && rewriteScore == null) issues.push({ severity: "warning", code: "missing_score", line: block.line, message: `${date} 练笔未识别到 15 分制得分` });
    return {
      date,
      kind,
      title: parts.slice(1).join("｜"),
      draftScore,
      rewriteScore,
      latestScore: rewriteScore ?? draftScore,
      improvement: draftScore != null && rewriteScore != null ? Number((rewriteScore - draftScore).toFixed(2)) : null,
      signals,
      line: block.line,
    };
  }).filter((practice) => validDate(practice.date));
  practices.sort((a, b) => a.date.localeCompare(b.date));
  const analytics = buildSubjectiveAnalytics(practices, { defects: [...activeDefects, ...resolvedDefects] });
  issues.push(...analytics.issues);
  const latestPracticeDate = practices.at(-1)?.date ?? null;
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
  const oldestActive = [...activeDefects].sort((a, b) => String(a.lastTouched ?? "9999").localeCompare(String(b.lastTouched ?? "9999")) || a.id.localeCompare(b.id))[0] ?? null;
  return {
    referenceDate,
    activeDefects,
    resolvedDefects,
    practices,
    counts: {
      activeDefects: activeDefects.length,
      resolvedDefects: resolvedDefects.length,
      practices: practices.length,
      cases: practices.filter((practice) => practice.kind === "案例").length,
      essays: practices.filter((practice) => practice.kind === "论述").length,
      rewrites: practices.filter((practice) => practice.rewriteScore != null).length,
      warnings: issues.length,
    },
    scores: {
      averageDraft: average(practices.map((practice) => practice.draftScore).filter((score) => score != null)),
      averageLatest: average(practices.map((practice) => practice.latestScore).filter((score) => score != null)),
      averageImprovement: average(practices.map((practice) => practice.improvement).filter((score) => score != null)),
    },
    oldestActive,
    latestPracticeDate,
    daysSinceLatestPractice: latestPracticeDate ? dateDistance(latestPracticeDate, referenceDate) : null,
    capabilityProfile: analytics.capabilityProfile,
    propagation: analytics.propagation,
    issues,
  };
}
