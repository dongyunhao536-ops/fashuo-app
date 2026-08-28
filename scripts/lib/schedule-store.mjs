import { parseReviewSchedule } from "./assessment-ledgers.mjs";
import { FAILURE_PATTERNS } from "./knowledge-state.mjs";
import {
  INTERVENTION_OBSERVATION_WINDOWS,
  INTERVENTION_WINDOW_DAYS,
  getInterventionProtocol,
  validateProtocolAssignment,
} from "./intervention-protocols.mjs";
import { assertStructuredReferencesHaveSummary } from "./structured-reference-lint.mjs";

const SCHEDULE_ROUTES = new Set(["ask-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "yingyu-pc", "coach-pc"]);
const SCHEDULE_DIMENSIONS = new Set(["exposure", "understanding", "recall", "application"]);
const SCHEDULE_OUTCOMES = new Set(["pass", "partial", "fail", "void"]);
const SCHEDULE_PROMPTS = new Set(["clean", "cued", "invalid"]);
const SCHEDULE_PATTERN_SCOPES = new Set(["point", "subject"]);
const SCHEDULE_OBSERVATION_WINDOWS = new Set(INTERVENTION_OBSERVATION_WINDOWS);
const PLAN_SOURCES = new Set(["weekly", "assessment", "milestone", "coach"]);
const NEXT_OBSERVATION_WINDOW = Object.freeze({ immediate: "d3", d3: "d14", d14: "d30", d30: null });
const DAY = 86400000;

export function cleanScheduleValue(value) {
  return String(value ?? "")
    .replace(/[\r\n|]/g, (character) => character === "|" ? "／" : " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateItem(item) {
  const normalized = {
    id: cleanScheduleValue(item.id),
    date: cleanScheduleValue(item.date),
    priority: cleanScheduleValue(item.priority).toUpperCase(),
    type: cleanScheduleValue(item.type),
    task: cleanScheduleValue(item.task),
    ref: cleanScheduleValue(item.ref),
    route: cleanScheduleValue(item.route),
    dimension: cleanScheduleValue(item.dimension),
    subject: cleanScheduleValue(item.subject),
    kpId: cleanScheduleValue(item.kpId).toUpperCase(),
    failurePatternCode: cleanScheduleValue(item.failurePatternCode),
    failurePatternScope: cleanScheduleValue(item.failurePatternScope),
    interventionCode: cleanScheduleValue(item.interventionCode),
    // [gpt] 2026-08-10：协议、episode 与窗口是一次纵向干预的不可漂移决策元数据。
    interventionEpisodeId: cleanScheduleValue(item.interventionEpisodeId),
    protocolCode: cleanScheduleValue(item.protocolCode),
    protocolVersion: item.protocolVersion == null || item.protocolVersion === "" ? null : Number(item.protocolVersion),
    observationWindow: cleanScheduleValue(item.observationWindow),
    episodeStartedOn: cleanScheduleValue(item.episodeStartedOn),
    baselineRisk: item.baselineRisk == null || item.baselineRisk === "" ? null : Number(item.baselineRisk),
    expectedOutcome: cleanScheduleValue(item.expectedOutcome),
    // [gpt] 2026-08-10：计划归因元数据让周报承诺、日报派单和结案共用同一个验收单元。
    planId: cleanScheduleValue(item.planId),
    planWeek: cleanScheduleValue(item.planWeek),
    planSource: cleanScheduleValue(item.planSource),
    acceptanceWeight: item.acceptanceWeight == null || item.acceptanceWeight === "" ? null : Number(item.acceptanceWeight),
    goalId: cleanScheduleValue(item.goalId),
  };
  if (!normalized.id) throw new Error("排期缺少 id");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.date)) throw new Error("排期 date 必须是 YYYY-MM-DD");
  if (!/^P[0-2]$/.test(normalized.priority)) throw new Error("排期 priority 只能是 P0/P1/P2");
  if (!normalized.type) throw new Error("排期缺少 type");
  if (!normalized.task) throw new Error("排期缺少 task");
  assertStructuredReferencesHaveSummary(normalized.task, { field: "新增排期 task" });
  if (Boolean(normalized.route) !== Boolean(normalized.dimension)) throw new Error("排期 route 与 dimension 必须成对提供");
  if (normalized.route && !SCHEDULE_ROUTES.has(normalized.route)) throw new Error(`排期 route 不合法：${normalized.route}`);
  if (normalized.dimension && !SCHEDULE_DIMENSIONS.has(normalized.dimension)) throw new Error(`排期 dimension 不合法：${normalized.dimension}`);
  if (normalized.kpId && !/^[A-Z]{2,4}-\d{4}$/.test(normalized.kpId)) throw new Error(`排期 kpId 不合法：${normalized.kpId}`);
  if (normalized.failurePatternCode && !(normalized.failurePatternCode in FAILURE_PATTERNS)) throw new Error(`排期 failurePatternCode 不合法：${normalized.failurePatternCode}`);
  if (normalized.failurePatternScope && !SCHEDULE_PATTERN_SCOPES.has(normalized.failurePatternScope)) throw new Error(`排期 failurePatternScope 不合法：${normalized.failurePatternScope}`);
  if (normalized.failurePatternCode && !normalized.failurePatternScope) throw new Error("排期画像需要同时提供 failurePatternCode/failurePatternScope");
  if (!normalized.failurePatternCode && normalized.failurePatternScope) throw new Error("排期画像需要同时提供 failurePatternCode/failurePatternScope");
  if (normalized.failurePatternScope === "point" && !normalized.kpId) throw new Error("知识点级画像排期必须提供 kpId");
  if (normalized.baselineRisk != null && (!Number.isInteger(normalized.baselineRisk) || normalized.baselineRisk < 0 || normalized.baselineRisk > 100)) throw new Error("排期 baselineRisk 必须是 0-100 整数");
  if (normalized.expectedOutcome && normalized.expectedOutcome !== "clean-pass") throw new Error("排期 expectedOutcome 目前只允许 clean-pass");
  const planFields = [normalized.planId, normalized.planWeek, normalized.planSource].filter(Boolean).length;
  if (planFields > 0 && planFields < 3) throw new Error("计划归因需要同时提供 planId/planWeek/planSource");
  if (normalized.planId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(normalized.planId)) throw new Error(`排期 planId 不合法：${normalized.planId}`);
  if (normalized.planWeek) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.planWeek) || new Date(`${normalized.planWeek}T00:00:00Z`).getUTCDay() !== 1) throw new Error("排期 planWeek 必须是周一的 YYYY-MM-DD");
    const offset = Math.floor((new Date(`${normalized.date}T00:00:00Z`) - new Date(`${normalized.planWeek}T00:00:00Z`)) / DAY);
    if (offset < 0 || offset > 6) throw new Error("计划验收单元 date 必须落在 planWeek 所属周内");
  }
  if (normalized.planSource && !PLAN_SOURCES.has(normalized.planSource)) throw new Error(`排期 planSource 不合法：${normalized.planSource}`);
  if (normalized.acceptanceWeight != null && (!Number.isInteger(normalized.acceptanceWeight) || normalized.acceptanceWeight < 1 || normalized.acceptanceWeight > 5)) throw new Error("排期 acceptanceWeight 必须是 1-5 整数");
  if (normalized.goalId && !normalized.planId) throw new Error("排期 goalId 只能随 planId 使用");
  if (normalized.planId && normalized.acceptanceWeight == null) normalized.acceptanceWeight = 1;
  const protocolFields = [normalized.interventionEpisodeId, normalized.protocolCode, normalized.protocolVersion, normalized.observationWindow].filter((value) => value != null && value !== "").length;
  if (protocolFields > 0 && protocolFields < 4) throw new Error("干预 episode/protocol/protocolVersion/observationWindow 必须成套提供");
  if (normalized.interventionEpisodeId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,100}$/.test(normalized.interventionEpisodeId)) throw new Error(`干预 episode 不合法：${normalized.interventionEpisodeId}`);
  if (normalized.observationWindow && !SCHEDULE_OBSERVATION_WINDOWS.has(normalized.observationWindow)) throw new Error(`干预观察窗口不合法：${normalized.observationWindow}`);
  if (normalized.episodeStartedOn && !/^20\d{2}-\d{2}-\d{2}$/.test(normalized.episodeStartedOn)) throw new Error("episodeStartedOn 必须是 YYYY-MM-DD");
  if (normalized.observationWindow && normalized.observationWindow !== "immediate" && !normalized.episodeStartedOn) throw new Error("延迟观察窗口必须提供 episodeStartedOn");
  if (protocolFields === 4) {
    const assignment = validateProtocolAssignment({
      code: normalized.protocolCode,
      version: normalized.protocolVersion,
      patternCode: normalized.failurePatternCode,
      route: normalized.route,
      dimension: normalized.dimension,
    });
    if (!assignment.ok) throw new Error(`干预协议与画像/路由不匹配：${assignment.reason}`);
  }
  return normalized;
}

function shiftDate(date, days) {
  const timestamp = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(timestamp)) throw new Error(`无法计算干预复检日期：${date}`);
  return new Date(timestamp + days * DAY).toISOString().slice(0, 10);
}

function laterDate(left, right) {
  return left >= right ? left : right;
}

function scheduleById(parsed, id) {
  const matches = parsed.items.filter((item) => item.source === "canonical" && item.id === id);
  if (matches.length > 1) throw new Error(`排期 ID 重复：${id}`);
  if (!matches.length) throw new Error(`未找到排期 ID：${id}`);
  return matches[0];
}

/**
 * [gpt] 2026-08-12：统一抽取排期中的稳定错题目标；支持 T#27/29/30 与 canonical T27，
 * 并保证 T#10 不会误命中 T#108。
 */
export function extractScheduleTargetIds(item = {}) {
  const source = `${item.ref ?? ""} ${item.task ?? item.title ?? ""}`;
  const topicIds = new Set();
  for (const match of source.matchAll(/\bT#?(\d+)((?:\s*\/\s*(?:T#?)?\d+)*)/giu)) {
    topicIds.add(Number(match[1]));
    for (const continuation of match[2].matchAll(/\d+/gu)) topicIds.add(Number(continuation[0]));
  }
  const eventIds = new Set(
    [...source.matchAll(/(?:^|[^A-Za-z0-9])#(\d+)\b/gu)].map((match) => Number(match[1])),
  );
  const knowledgeIds = new Set(source.toUpperCase().match(/\b[A-Z]{2,4}-\d{4}\b/gu) ?? []);
  return { topicIds: [...topicIds], eventIds: [...eventIds], knowledgeIds: [...knowledgeIds] };
}

function taskTargetIds(kind, task) {
  const text = String(task ?? "");
  if (kind === "recite") return [...new Set(text.match(/\b[A-Z]\d+\b/g) ?? [])];
  if (kind === "topic") return extractScheduleTargetIds({ task: text }).topicIds.map((id) => `T${id}`);
  if (kind === "knowledge") return [...new Set(text.match(/\b[A-Z]{2,4}-\d{4}\b/g) ?? [])];
  throw new Error(`未知关联类型：${kind}`);
}

function normalizeLinkTarget(kind, targetId) {
  const raw = cleanScheduleValue(targetId).toUpperCase();
  if (kind === "recite") {
    if (!/^[A-Z]\d+$/.test(raw)) throw new Error(`带背关联 ID 无效：${raw || "(空)"}`);
    return raw;
  }
  if (kind === "topic") {
    const match = raw.match(/^T#?(\d+)$/) ?? raw.match(/^(\d+)$/);
    if (!match) throw new Error(`错题主题关联 ID 无效：${raw || "(空)"}`);
    return `T${match[1]}`;
  }
  if (kind === "knowledge") {
    if (!/^[A-Z]{2,4}-\d{4}$/.test(raw)) throw new Error(`知识点关联 ID 无效：${raw || "(空)"}`);
    return raw;
  }
  throw new Error(`未知关联类型：${kind}`);
}

/**
 * [gpt] 2026-08-10：联动结案前验证“排期对象就是要回写的知识对象”。
 * 自动排期认 canonical ref；人工排期仅在 task 里只出现一个明确对象时允许联动。
 */
export function assertScheduleLink(markdown, scheduleId, { kind, targetId, referenceDate, route = null, dimension = null }) {
  const parsed = parseReviewSchedule(markdown, { referenceDate });
  if (parsed.counts.errors) throw new Error(`现有复盘排期有 ${parsed.counts.errors} 个结构错误，拒绝联动`);
  const id = cleanScheduleValue(scheduleId);
  const item = scheduleById(parsed, id);
  if (item.status === "completed") throw new Error(`排期已完成：${id}`);

  const target = normalizeLinkTarget(kind, targetId);
  // [gpt] 2026-08-28：稳定 KP-ID 不只服务错题/答疑；daibei-pc 的 recall KP 排期仍应保留“带背复检”类型。
  const expectedType = kind === "recite"
    ? /带背/
    : kind === "topic"
      ? /错题/
      : route === "daibei-pc" && dimension === "recall"
        ? /(?:知识点|带背)/
        : /知识点/;
  const kindLabel = kind === "recite" ? "带背" : kind === "topic" ? "错题" : "知识点";
  if (!expectedType.test(item.type)) throw new Error(`排期 ${id} 类型“${item.type}”与 ${kindLabel}联动不匹配`);

  const refPrefix = kind === "recite" ? "coach-engine:recite:" : kind === "topic" ? "coach-engine:topic:" : "coach-engine:knowledge:";
  const expectedRef = `${refPrefix}${target}:`;
  const ref = String(item.ref ?? "");
  if (ref.startsWith(refPrefix) && !ref.startsWith(expectedRef)) {
    throw new Error(`排期 ${id} 关联的是 ${ref}，不是 ${target}`);
  }
  // 旧排期没有路由字段时继续兼容；新排期一旦声明，就必须与执行方和检验维度一致。
  if (route && item.route && item.route !== route) throw new Error(`排期 ${id} route=${item.route}，不能交给 ${route}`);
  if (dimension && item.dimension && item.dimension !== dimension) throw new Error(`排期 ${id} dimension=${item.dimension}，不是 ${dimension}`);

  const ids = taskTargetIds(kind, item.task);
  if (ids.length && !ids.includes(target)) throw new Error(`排期 ${id} 任务正文不包含目标 ${target}`);
  if (kind === "topic" && ids.length > 1) {
    throw new Error(`排期 ${id} 同时包含 ${ids.join("、")}，单条 review 不得提前结清整组；逐题留证后用带完整 --topics 的排期结案命令`);
  }
  if (ref.startsWith(expectedRef)) return item;
  if (ids.length !== 1 || ids[0] !== target) {
    const detail = ids.length > 1 ? `任务同时包含 ${ids.join("、")}` : "缺少可核验的 canonical ref/单一任务 ID";
    throw new Error(`排期 ${id} 无法安全联动 ${target}：${detail}`);
  }
  return item;
}

/**
 * 审计开放排期的引用语义；reciteParsed 传入时额外发现“排期仍开、带背条目已撤/移交”的历史半状态。
 */
export function auditScheduleLinks(markdown, { referenceDate, reciteParsed = null } = {}) {
  const schedule = parseReviewSchedule(markdown, { referenceDate });
  const issues = schedule.issues.map((issue) => ({ ...issue, source: "schedule" }));
  for (const issue of reciteParsed?.issues ?? []) {
    if (issue.severity === "error") issues.push({ ...issue, source: "recite", message: `带背账本：${issue.message}` });
  }
  const reciteById = new Map((reciteParsed?.records ?? []).map((record) => [record.id, record]));

  for (const item of schedule.open) {
    const ref = String(item.ref ?? "");
    const reciteRef = ref.match(/^coach-engine:recite:([A-Z]\d+):/);
    const topicRef = ref.match(/^coach-engine:topic:(T\d+):/);
    const knowledgeRef = ref.match(/^coach-engine:knowledge:([A-Z]{2,4}-\d{4}):/);
    if (reciteRef) {
      try {
        assertScheduleLink(markdown, item.id, { kind: "recite", targetId: reciteRef[1], referenceDate, route: "daibei-pc", dimension: "recall" });
      } catch (error) {
        issues.push({ severity: "error", code: "invalid-recite-link", line: item.line, message: error.message });
        continue;
      }
      if (reciteParsed) {
        const record = reciteById.get(reciteRef[1]);
        if (!record) issues.push({ severity: "error", code: "missing-recite-target", line: item.line, message: `${item.id} 指向不存在的带背条目 ${reciteRef[1]}` });
        else if (record.status !== "active" && !(item.interventionEpisodeId && item.observationWindow !== "immediate")) {
          issues.push({ severity: "error", code: "stale-open-recite-link", line: item.line, message: `${item.id} 仍未结案，但 ${record.id} 已是 ${record.status}` });
        }
      }
    } else if (topicRef) {
      try {
        assertScheduleLink(markdown, item.id, { kind: "topic", targetId: topicRef[1], referenceDate, route: "cuoti-fupan", dimension: "application" });
      } catch (error) {
        issues.push({ severity: "error", code: "invalid-topic-link", line: item.line, message: error.message });
      }
    } else if (knowledgeRef) {
      try {
        const routeByDimension = {
          exposure: "ask-pc",
          understanding: "ask-pc",
          recall: "daibei-pc",
          application: "cuoti-fupan",
        };
        assertScheduleLink(markdown, item.id, {
          kind: "knowledge",
          targetId: knowledgeRef[1],
          referenceDate,
          route: routeByDimension[item.dimension] ?? null,
          dimension: item.dimension,
        });
      } catch (error) {
        issues.push({ severity: "error", code: "invalid-knowledge-link", line: item.line, message: error.message });
      }
    } else if (/带背/.test(item.type)) {
      const ids = taskTargetIds("recite", item.task);
      issues.push({
        severity: "warning",
        code: ids.length === 1 ? "manual-recite-link" : "ambiguous-recite-link",
        line: item.line,
        message: ids.length === 1
          ? `${item.id} 仅靠任务正文关联 ${ids[0]}，建议补 canonical ref`
          : `${item.id} 无法一对一联动：${ids.length ? `任务含 ${ids.join("、")}` : "未识别带背条目 ID"}`,
      });
    } else if (/知识点/.test(item.type)) {
      const ids = taskTargetIds("knowledge", item.task);
      issues.push({
        severity: "warning",
        code: ids.length === 1 ? "manual-knowledge-link" : "ambiguous-knowledge-link",
        line: item.line,
        message: ids.length === 1
          ? `${item.id} 仅靠任务正文关联 ${ids[0]}，建议补 canonical ref`
          : `${item.id} 无法一对一联动：${ids.length ? `任务含 ${ids.join("、")}` : "未识别知识点 ID"}`,
      });
    }
    if (ref.startsWith("coach-engine:") && (!item.route || !item.dimension)) {
      issues.push({
        severity: "warning",
        code: "legacy-missing-dispatch-metadata",
        line: item.line,
        message: `${item.id} 是旧自动排期，缺 route/dimension；仍可执行，但建议由下一次派单自然替换`,
      });
    }
  }

  return {
    schedule,
    issues,
    counts: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      open: schedule.open.length,
    },
  };
}

/**
 * 只生成一个通过 parseReviewSchedule 复验的排期文档；调用方决定何时落盘。
 * dedupeRefPrefix 用于自动派单：同一知识对象已有未完成任务时，不重复追加。
 */
export function appendScheduleItem(markdown, item, { referenceDate, dedupeRefPrefix = null } = {}) {
  const normalized = validateItem(item);
  const before = parseReviewSchedule(markdown, { referenceDate });
  if (before.counts.errors) throw new Error(`现有复盘排期有 ${before.counts.errors} 个结构错误，拒绝追加`);
  if (before.items.some((entry) => entry.source === "canonical" && entry.id === normalized.id)) {
    return { markdown: String(markdown), added: false, reason: "duplicate-id", item: normalized };
  }
  const refPrefix = cleanScheduleValue(dedupeRefPrefix);
  if (refPrefix && before.open.some((entry) => String(entry.ref ?? "").startsWith(refPrefix))) {
    return { markdown: String(markdown), added: false, reason: "open-ref", item: normalized };
  }
  const section = String(markdown).includes("## 结构化排期（机器读取）")
    ? ""
    : "\n## 结构化排期（机器读取）\n\n> 新条目只用下列格式；旧散文保留作历史证据，不再复制第二份状态。\n";
  const route = normalized.route ? ` | route=${normalized.route}` : "";
  const dimension = normalized.dimension ? ` | dimension=${normalized.dimension}` : "";
  const subject = normalized.subject ? ` | subject=${normalized.subject}` : "";
  const ref = normalized.ref ? ` | ref=${normalized.ref}` : "";
  // [gpt] 2026-08-10：把事前画像、目标与风险基线写进同一排期，结案后才能审计“为何派、是否兑现”。
  const kp = normalized.kpId ? ` | kp=${normalized.kpId}` : "";
  const pattern = normalized.failurePatternCode ? ` | pattern=${normalized.failurePatternCode} | pattern_scope=${normalized.failurePatternScope}` : "";
  const intervention = normalized.interventionCode ? ` | intervention=${normalized.interventionCode}` : "";
  const episode = normalized.interventionEpisodeId ? ` | episode=${normalized.interventionEpisodeId}` : "";
  const protocol = normalized.protocolCode ? ` | protocol=${normalized.protocolCode} | protocol_version=${normalized.protocolVersion} | window=${normalized.observationWindow}` : "";
  const episodeStart = normalized.episodeStartedOn ? ` | episode_start=${normalized.episodeStartedOn}` : "";
  const baselineRisk = normalized.baselineRisk == null ? "" : ` | baseline_risk=${normalized.baselineRisk}`;
  const expected = normalized.expectedOutcome ? ` | expect=${normalized.expectedOutcome}` : "";
  const plan = normalized.planId ? ` | plan_id=${normalized.planId} | plan_week=${normalized.planWeek} | plan_source=${normalized.planSource} | weight=${normalized.acceptanceWeight}` : "";
  const goal = normalized.goalId ? ` | goal_id=${normalized.goalId}` : "";
  const line = `- [ ] ${normalized.date} | ${normalized.priority} | id=${normalized.id} | type=${normalized.type} | task=${normalized.task}${route}${dimension}${subject}${kp}${pattern}${intervention}${episode}${protocol}${episodeStart}${baselineRisk}${expected}${plan}${goal}${ref}`;
  const next = `${String(markdown).trimEnd()}${section}\n${line}\n`;
  const after = parseReviewSchedule(next, { referenceDate });
  if (after.counts.errors) throw new Error(`追加后的复盘排期有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, added: true, reason: null, item: normalized };
}

/**
 * [gpt] 2026-08-10：为既有 canonical 排期补齐或纠正执行路由。
 * 只改 route/dimension，保留 ref、completed、result 及未来新增字段，并在落盘前后复验。
 */
export function setScheduleDispatch(markdown, id, { route, dimension, referenceDate }) {
  const cleanId = cleanScheduleValue(id);
  const cleanRoute = cleanScheduleValue(route);
  const cleanDimension = cleanScheduleValue(dimension);
  if (!cleanId) throw new Error("排期 ID 不能为空");
  if (!cleanRoute || !cleanDimension) throw new Error("排期 route 与 dimension 必须成对提供");
  if (!SCHEDULE_ROUTES.has(cleanRoute)) throw new Error(`排期 route 不合法：${cleanRoute}`);
  if (!SCHEDULE_DIMENSIONS.has(cleanDimension)) throw new Error(`排期 dimension 不合法：${cleanDimension}`);

  const before = parseReviewSchedule(markdown, { referenceDate });
  if (before.counts.errors) throw new Error(`现有复盘排期有 ${before.counts.errors} 个结构错误，拒绝修改路由`);
  const item = scheduleById(before, cleanId);
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const index = item.line - 1;
  const preserved = lines[index]
    .replace(/\s*\|\s*route=[^|]*/g, "")
    .replace(/\s*\|\s*dimension=[^|]*/g, "")
    .trimEnd()
    .replace(/\s*\|\s*/g, " | ");
  lines[index] = `${preserved} | route=${cleanRoute} | dimension=${cleanDimension}`;

  const next = `${lines.join("\n").trimEnd()}\n`;
  const after = parseReviewSchedule(next, { referenceDate });
  if (after.counts.errors) throw new Error(`修改路由后的复盘排期有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  const updated = scheduleById(after, cleanId);
  if (updated.route !== cleanRoute || updated.dimension !== cleanDimension) {
    throw new Error(`排期 ${cleanId} 路由回读不一致，拒绝落盘`);
  }
  return next;
}

/**
 * 结案一条结构化排期（打勾 + completed + result）。
 * 与 appendScheduleItem 共用同一解析器口径；调用方决定何时落盘。
 */
export function closeScheduleItem(markdown, id, { date, result, outcome = null, cold = null, promptIntegrity = null }) {
  // [gpt] 2026-08-10：结案前后都走同一解析器，不能把坏排期或坏结果直接落盘。
  const cleanId = cleanScheduleValue(id);
  const cleanDate = cleanScheduleValue(date);
  const cleanResult = cleanScheduleValue(result);
  const cleanOutcome = outcome == null ? null : cleanScheduleValue(outcome);
  const cleanPrompt = promptIntegrity == null ? null : cleanScheduleValue(promptIntegrity);
  if (!cleanId) throw new Error("排期 ID 不能为空");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error("结案日期必须是 YYYY-MM-DD");
  if (!cleanResult) throw new Error("结案结果不能为空");
  const structuredCount = [cleanOutcome, cold, cleanPrompt].filter((value) => value != null).length;
  if (structuredCount > 0 && structuredCount < 3) throw new Error("结构化结案必须同时提供 outcome/cold/promptIntegrity");
  if (cleanOutcome && !SCHEDULE_OUTCOMES.has(cleanOutcome)) throw new Error(`结案 outcome 不合法：${cleanOutcome}`);
  if (cold != null && typeof cold !== "boolean") throw new Error("结案 cold 必须是布尔值");
  if (cleanPrompt && !SCHEDULE_PROMPTS.has(cleanPrompt)) throw new Error(`结案 promptIntegrity 不合法：${cleanPrompt}`);
  if (cleanOutcome === "void" && cleanPrompt !== "invalid") throw new Error("void 结案必须对应 invalid 题干");
  if (cleanPrompt === "invalid" && cleanOutcome !== "void") throw new Error("invalid 题干必须记 void");
  if (cold && cleanPrompt !== "clean") throw new Error("冷检结案必须使用 clean 题干");
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const indexes = lines.map((line, index) => line.includes(`| id=${cleanId} |`) ? index : -1).filter((index) => index >= 0);
  // 重复目标本身就是最精确的结构错误，优先给出可操作诊断。
  if (indexes.length > 1) throw new Error(`排期 ID 重复：${cleanId}`);
  const before = parseReviewSchedule(markdown, { referenceDate: cleanDate });
  if (before.counts.errors) throw new Error(`现有复盘排期有 ${before.counts.errors} 个结构错误，拒绝结案`);
  if (indexes.length === 0) throw new Error(`未找到排期 ID：${cleanId}`);
  const item = scheduleById(before, cleanId);
  // [gpt] 2026-08-12：void 是教练命题失误的审计结果，不是用户完成一次有效复检。
  // 保留原排期与冷却窗口，调用方重写题目、重新过 Gate 后再结案。
  if (cleanOutcome === "void") {
    return {
      markdown: String(markdown),
      closed: false,
      reason: "teacher-invalid-prompt",
      item,
      disposition: {
        responsibility: "teacher",
        countAsValidAttempt: false,
        countAsUserError: false,
        advanceCooldown: false,
        closeSchedule: false,
      },
    };
  }
  if (item.interventionEpisodeId && structuredCount !== 3) throw new Error("干预 episode 结案必须同时提供 outcome/cold/promptIntegrity");
  if (item.observationWindow && item.observationWindow !== "immediate" && cleanDate < item.dueDate) {
    throw new Error(`${item.observationWindow.toUpperCase()} 干预复检最早 ${item.dueDate}，不能提前结案`);
  }
  if (item.observationWindow && item.observationWindow !== "immediate" && cleanOutcome !== "void" && (!cold || cleanPrompt !== "clean")) {
    throw new Error("D3/D14/D30 干预复检必须是 cold=true、prompt=clean 的无提示冷检");
  }
  const index = indexes[0];
  if (/^- \[x\]/i.test(lines[index])) throw new Error(`排期已完成：${cleanId}`);
  const structured = cleanOutcome == null ? "" : ` | outcome=${cleanOutcome} | cold=${cold} | prompt=${cleanPrompt}`;
  const episodeStart = item.interventionEpisodeId && item.observationWindow === "immediate" && !item.episodeStartedOn
    ? ` | episode_start=${cleanDate}`
    : "";
  lines[index] = lines[index].replace(/^- \[ \]/, "- [x]") + `${episodeStart} | completed=${cleanDate} | result=${cleanResult}${structured}`;
  let next = `${lines.join("\n").trimEnd()}\n`;
  let after = parseReviewSchedule(next, { referenceDate: cleanDate });
  if (after.counts.errors) throw new Error(`结案后的复盘排期有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  // [gpt] 只有当前窗口干净通过才继续纵向观察；失败/部分通过立即停止旧策略，释放下一次改策略派单。
  const currentWindow = item.observationWindow;
  const nextWindow = currentWindow ? NEXT_OBSERVATION_WINDOW[currentWindow] : null;
  const advances = cleanOutcome === "pass" && cleanPrompt === "clean" && (currentWindow === "immediate" || cold === true);
  if (item.interventionEpisodeId && nextWindow && advances) {
    const startedOn = item.episodeStartedOn || cleanDate;
    const targetDate = shiftDate(startedOn, INTERVENTION_WINDOW_DAYS[nextWindow]);
    const dueDate = laterDate(targetDate, shiftDate(cleanDate, 1));
    const baseType = String(item.type).replace(/·D(?:3|14|30)冷检$/, "");
    const baseTask = String(item.task).replace(/^【干预复检 D(?:3|14|30)】\s*/, "");
    const protocol = getInterventionProtocol(item.protocolCode, item.protocolVersion);
    const followup = appendScheduleItem(next, {
      id: `${item.interventionEpisodeId}-${nextWindow.toUpperCase()}`,
      date: dueDate,
      priority: nextWindow === "d30" ? "P2" : "P1",
      type: `${baseType}·${nextWindow.toUpperCase()}冷检`,
      task: `【干预复检 ${nextWindow.toUpperCase()}】${baseTask}；只检验“${protocol?.label ?? item.protocolCode}”能否保持，不重复教学`,
      ref: item.ref,
      route: item.route,
      dimension: item.dimension,
      subject: item.subject,
      kpId: item.kpId,
      failurePatternCode: item.failurePatternCode,
      failurePatternScope: item.failurePatternScope,
      interventionCode: item.interventionCode,
      interventionEpisodeId: item.interventionEpisodeId,
      protocolCode: item.protocolCode,
      protocolVersion: item.protocolVersion,
      observationWindow: nextWindow,
      episodeStartedOn: startedOn,
      baselineRisk: item.baselineRisk,
      expectedOutcome: item.expectedOutcome,
    }, { referenceDate: cleanDate });
    next = followup.markdown;
    after = parseReviewSchedule(next, { referenceDate: cleanDate });
    if (after.counts.errors) throw new Error(`追加干预复检后的排期有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  }
  // 保持既有成功路径返回字符串，避免破坏历史调用；只有 void 返回显式“不结案”对象。
  return next;
}
