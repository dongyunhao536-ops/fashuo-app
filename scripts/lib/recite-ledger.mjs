import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { FAILURE_PATTERNS } from "./knowledge-state.mjs";

const SUBJECTS = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const ENTRY_HEADING = /^###\s+([A-Z]\d+)[｜|]([^｜|]+)[｜|](.+)$/;
const DATE_TOKEN = /(?<!\d)(?:(20\d{2})-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/g;
const TRANSITION = /<!--\s*recite-transition-v1\s+({[^\r\n]*})\s*-->/g;
const TRANSITION_EVENTS = new Set(["new", "withdraw", "rehang", "transfer", "route-recognition"]);
// [gpt] 2026-08-24：Anki 已停用；旧流水只读兼容，禁止继续生产新的 route-anki。
const LEGACY_TRANSITION_EVENTS = new Set(["route-anki"]);
const PARSEABLE_TRANSITION_EVENTS = new Set([...TRANSITION_EVENTS, ...LEGACY_TRANSITION_EVENTS]);
// [gpt] 2026-08-10：复检证据与迁移状态分离；两者都留在同一本 Markdown 事实账中。
const EVIDENCE_EVENT = /<!--\s*recite-evidence-v2\s+({[^\r\n]*})\s*-->/g;
const EVIDENCE_DIMENSIONS = new Set(["understanding", "recall"]);
const EVIDENCE_RESULTS = new Set(["pass", "partial", "fail", "void"]);
const PROMPT_INTEGRITY = new Set(["clean", "cued", "invalid"]);
const DIAGNOSIS_STATUSES = new Set(["pending", "confirmed", "rejected"]);

function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function resolveDate(year, month, day, referenceDate) {
  if (year) {
    const value = `${year}-${month}-${day}`;
    return validDate(value) ? value : null;
  }
  const refYear = Number(referenceDate.slice(0, 4));
  let value = `${refYear}-${month}-${day}`;
  if (!validDate(value)) return null;
  // 跨年账本通常只写 MM-DD；相对参考日未来超过 45 天时归入上一年。
  const futureDays = (new Date(`${value}T00:00:00Z`) - new Date(`${referenceDate}T00:00:00Z`)) / 86400000;
  if (futureDays > 45) value = `${refYear - 1}-${month}-${day}`;
  return validDate(value) ? value : null;
}

function datesIn(text, referenceDate) {
  const dates = [];
  for (const match of text.matchAll(DATE_TOKEN)) {
    const value = resolveDate(match[1], match[2], match[3], referenceDate);
    if (value) dates.push(value);
  }
  return dates;
}

function markerStatusFromTitle(title) {
  if (/带背侧结案/.test(title)) return "transferred";
  const markers = [];
  for (const match of title.matchAll(/重挂/g)) markers.push({ index: match.index, status: "active" });
  for (const match of title.matchAll(/撤(?!梯)(?:账)?[\s*]*(?:20\d{2}-)?\d{2}-\d{2}/g)) {
    markers.push({ index: match.index, status: "withdrawn" });
  }
  markers.sort((a, b) => a.index - b.index);
  return markers.at(-1)?.status ?? null;
}

function statusFromField(field) {
  const plain = stripMarkdown(field);
  const match = plain.match(/状态[：:]\s*([^｜|]+)/);
  if (!match) return null;
  const state = match[1].trim();
  if (/^带背侧结案|^结案/.test(state)) return "transferred";
  if (/^撤/.test(state)) return "withdrawn";
  if (/^(?:重)?挂/.test(state)) return "active";
  return null;
}

function routeFor(entry) {
  if (entry.status === "transferred") return "transferred";
  if (/挑错式再认轨|挑错轻滚轨|recognition[_ -]?light[_ -]?roll/i.test(`${entry.title}\n${entry.fieldLine}`)) return "recognition_light_roll";
  if (/主轨移交\s*Anki|已转\s*Anki\s*轨|转\s*Anki\s*轨/i.test(`${entry.title}\n${entry.fieldLine}`)) return "legacy_anki";
  return "daibei";
}

function dayDistance(from, to) {
  if (!from || !to) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function declaredSubjectCounts(markdown) {
  if (markdown.includes("recite-ledger: ignore-heading-counts")) return null;
  const heading = markdown.split(/\r?\n/).find((line) => /^##\s*挂账中/.test(line));
  if (!heading) return null;
  const counts = {};
  for (const match of heading.matchAll(/(刑法|民法|法理|宪法|法制史)\s*(\d+)/g)) counts[match[1]] = Number(match[2]);
  return Object.keys(counts).length ? counts : null;
}

function parseTransitions(markdown, issues) {
  const transitions = [];
  const operationIds = new Set();
  for (const match of String(markdown ?? "").matchAll(TRANSITION)) {
    const line = String(markdown).slice(0, match.index).split(/\r?\n/).length;
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch (error) {
      issues.push({ severity: "error", code: "invalid_transition_json", id: null, line, message: `迁移流水 JSON 损坏：${error.message}` });
      continue;
    }
    const transition = {
      operationId: String(value.operationId ?? ""),
      date: String(value.date ?? ""),
      event: String(value.event ?? ""),
      entryId: String(value.entryId ?? ""),
      fromStatus: value.fromStatus == null ? null : String(value.fromStatus),
      toStatus: value.toStatus == null ? null : String(value.toStatus),
      fromRoute: value.fromRoute == null ? null : String(value.fromRoute),
      toRoute: value.toRoute == null ? null : String(value.toRoute),
      evidence: value.evidence == null ? null : String(value.evidence),
      note: value.note == null ? null : String(value.note),
      line,
      sequence: transitions.length,
    };
    if (!transition.operationId) issues.push({ severity: "error", code: "transition_missing_operation_id", id: transition.entryId || null, line, message: "迁移流水缺 operationId" });
    else if (operationIds.has(transition.operationId)) issues.push({ severity: "error", code: "duplicate_transition_operation", id: transition.entryId || null, line, message: `迁移 operationId 重复：${transition.operationId}` });
    operationIds.add(transition.operationId);
    if (!validDate(transition.date)) issues.push({ severity: "error", code: "invalid_transition_date", id: transition.entryId || null, line, message: `迁移日期无效：${transition.date}` });
    if (!PARSEABLE_TRANSITION_EVENTS.has(transition.event)) issues.push({ severity: "error", code: "invalid_transition_event", id: transition.entryId || null, line, message: `未知迁移事件：${transition.event}` });
    if (!/^[A-Z]\d+$/.test(transition.entryId)) issues.push({ severity: "error", code: "invalid_transition_entry", id: transition.entryId || null, line, message: `迁移条目 ID 无效：${transition.entryId}` });
    transitions.push(transition);
  }
  return transitions;
}

function parseEvidenceEvents(markdown, issues, referenceDate) {
  const evidenceEvents = [];
  const operationIds = new Set();
  for (const match of String(markdown ?? "").matchAll(EVIDENCE_EVENT)) {
    const line = String(markdown).slice(0, match.index).split(/\r?\n/).length;
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch (error) {
      issues.push({ severity: "error", code: "invalid_evidence_json", id: null, line, message: `复检证据 JSON 损坏：${error.message}` });
      continue;
    }
    const failurePatternCode = value.failurePatternCode == null || value.failurePatternCode === "" ? null : String(value.failurePatternCode);
    const diagnosisStatus = failurePatternCode ? String(value.diagnosisStatus ?? "pending") : null;
    const event = {
      operationId: String(value.operationId ?? ""),
      entryId: String(value.entryId ?? ""),
      date: String(value.date ?? ""),
      dimension: String(value.dimension ?? "recall"),
      result: String(value.result ?? ""),
      cold: value.cold,
      promptIntegrity: String(value.promptIntegrity ?? "clean"),
      failurePatternCode,
      diagnosisStatus,
      evidenceAnchor: value.evidenceAnchor == null ? null : String(value.evidenceAnchor),
      note: value.note == null ? null : String(value.note),
      line,
      sequence: evidenceEvents.length,
    };
    if (!event.operationId) issues.push({ severity: "error", code: "evidence_missing_operation_id", id: event.entryId || null, line, message: "复检证据缺 operationId" });
    else if (operationIds.has(event.operationId)) issues.push({ severity: "error", code: "duplicate_evidence_operation", id: event.entryId || null, line, message: `复检证据 operationId 重复：${event.operationId}` });
    operationIds.add(event.operationId);
    if (!/^[A-Z]\d+$/.test(event.entryId)) issues.push({ severity: "error", code: "invalid_evidence_entry", id: event.entryId || null, line, message: `复检证据条目 ID 无效：${event.entryId}` });
    if (!validDate(event.date)) issues.push({ severity: "error", code: "invalid_evidence_date", id: event.entryId || null, line, message: `复检证据日期无效：${event.date}` });
    else if (event.date > referenceDate) issues.push({ severity: "warning", code: "evidence_after_reference_date", id: event.entryId || null, line, message: `复检证据 ${event.date} 晚于本次参考日 ${referenceDate}` });
    if (!EVIDENCE_DIMENSIONS.has(event.dimension)) issues.push({ severity: "error", code: "invalid_evidence_dimension", id: event.entryId || null, line, message: `带背证据不支持维度：${event.dimension}` });
    if (!EVIDENCE_RESULTS.has(event.result)) issues.push({ severity: "error", code: "invalid_evidence_result", id: event.entryId || null, line, message: `未知复检结果：${event.result}` });
    if (typeof event.cold !== "boolean") issues.push({ severity: "error", code: "invalid_evidence_cold", id: event.entryId || null, line, message: "复检证据 cold 必须是布尔值" });
    if (!PROMPT_INTEGRITY.has(event.promptIntegrity)) issues.push({ severity: "error", code: "invalid_prompt_integrity", id: event.entryId || null, line, message: `未知题干完整性：${event.promptIntegrity}` });
    if ((event.result === "void") !== (event.promptIntegrity === "invalid")) issues.push({ severity: "error", code: "void_prompt_mismatch", id: event.entryId || null, line, message: "作废结果必须对应 invalid 题干，invalid 题干也必须记 void" });
    if (event.cold === true && event.promptIntegrity !== "clean") issues.push({ severity: "error", code: "cold_prompt_mismatch", id: event.entryId || null, line, message: "有提示或作废题不能记作冷检" });
    if (["fail", "partial"].includes(event.result) && event.promptIntegrity !== "invalid" && !failurePatternCode) issues.push({ severity: "error", code: "failure_pattern_required", id: event.entryId || null, line, message: "失败或半对证据必须记录栽点类型；尚未确认时用 diagnosisStatus=pending" });
    if (failurePatternCode && !(failurePatternCode in FAILURE_PATTERNS)) issues.push({ severity: "error", code: "invalid_failure_pattern", id: event.entryId || null, line, message: `未知栽点类型：${failurePatternCode}` });
    if (failurePatternCode && !DIAGNOSIS_STATUSES.has(diagnosisStatus)) issues.push({ severity: "error", code: "invalid_diagnosis_status", id: event.entryId || null, line, message: `未知诊断状态：${diagnosisStatus}` });
    if (!event.evidenceAnchor) issues.push({ severity: "error", code: "evidence_anchor_required", id: event.entryId || null, line, message: "复检证据必须给出教材、题目或账本行锚点" });
    evidenceEvents.push(event);
  }
  return evidenceEvents;
}

/**
 * 解析 `.local/带背挂账.md`。Markdown 仍是唯一事实源；本函数只建立可审计的只读视图。
 */
export function parseReciteLedger(markdown, { referenceDate = beijingDate() } = {}) {
  if (!validDate(referenceDate)) throw new Error(`referenceDate 必须是 YYYY-MM-DD：${referenceDate}`);
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const entries = [];
  const issues = [];

  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(ENTRY_HEADING);
    if (!heading) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end++;
    const blockLines = lines.slice(index + 1, end);
    const block = blockLines.join("\n");
    const fieldLine = blockLines.find((line) => /^-\s*挂(?:\s|\*)/.test(line)) ?? "";
    const title = stripMarkdown(heading[3]);
    const titleStatus = markerStatusFromTitle(title);
    const fieldStatus = statusFromField(fieldLine);
    const status = titleStatus ?? fieldStatus ?? "unknown";
    const fieldDates = datesIn(fieldLine, referenceDate);
    const openedMatch = fieldLine.match(/^-\s*挂\s+[*]*(?:(20\d{2})-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
    const lastMatch = fieldLine.match(/最后碰\s+[*]*(?:(20\d{2})-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
    const allDates = datesIn(`${lines[index]}\n${block}`, referenceDate).filter((date) => date <= referenceDate);
    const openedOn = openedMatch ? resolveDate(openedMatch[1], openedMatch[2], openedMatch[3], referenceDate) : fieldDates[0] ?? null;
    const explicitLast = lastMatch ? resolveDate(lastMatch[1], lastMatch[2], lastMatch[3], referenceDate) : null;
    const lastTouchedOn = explicitLast ?? allDates.sort().at(-1) ?? openedOn;
    const entry = {
      id: heading[1],
      subject: stripMarkdown(heading[2]),
      title,
      line: index + 1,
      fieldLine,
      openedOn,
      lastTouchedOn,
      lastTouchedSource: explicitLast ? "field" : lastTouchedOn ? "inferred" : "missing",
      status,
      statusSource: titleStatus ? "title" : fieldStatus ? "field" : "missing",
      route: null,
      ageDays: dayDistance(lastTouchedOn, referenceDate),
      block,
    };
    entry.route = routeFor(entry);
    entries.push(entry);

    if (!SUBJECTS.has(entry.subject)) issues.push({ severity: "error", code: "invalid_subject", id: entry.id, line: entry.line, message: `未知科目「${entry.subject}」` });
    if (status === "unknown") issues.push({ severity: "error", code: "unknown_status", id: entry.id, line: entry.line, message: "无法从标题或字段确定当前状态" });
    if (!entry.openedOn && entry.status === "active") issues.push({ severity: "warning", code: "missing_opened_on", id: entry.id, line: entry.line, message: "活动挂账缺挂账日，当前只可做有限统计" });
    if (!entry.lastTouchedOn) issues.push({ severity: "warning", code: "missing_last_touched", id: entry.id, line: entry.line, message: "缺最后碰日期，不能参与最久未碰排序" });
    if (entry.openedOn && entry.lastTouchedOn && entry.lastTouchedOn < entry.openedOn) issues.push({ severity: "warning", code: "last_before_open", id: entry.id, line: entry.line, message: `最后碰 ${entry.lastTouchedOn} 早于挂账 ${entry.openedOn}` });
    if (titleStatus && fieldStatus && titleStatus !== fieldStatus) issues.push({ severity: "warning", code: "status_conflict", id: entry.id, line: entry.line, message: `标题状态 ${titleStatus} 与字段状态 ${fieldStatus} 冲突；按标题最新迁移标记解释` });
  }

  const byId = new Map();
  for (const entry of entries) {
    const group = byId.get(entry.id) ?? [];
    group.push(entry);
    byId.set(entry.id, group);
  }
  for (const [id, group] of byId) {
    if (group.length > 1) issues.push({ severity: "error", code: "duplicate_id", id, line: group[0].line, message: `ID 重复 ${group.length} 次（行 ${group.map((entry) => entry.line).join("、")}）` });
  }
  const records = [...byId.values()].map((group) => group[0]);
  const transitions = parseTransitions(markdown, issues);
  const evidenceEvents = parseEvidenceEvents(markdown, issues, referenceDate);
  const recordById = new Map(records.map((entry) => [entry.id, entry]));
  for (const transition of transitions) {
    if (!recordById.has(transition.entryId)) issues.push({ severity: "error", code: "transition_unknown_entry", id: transition.entryId, line: transition.line, message: "迁移流水引用了不存在的条目" });
  }
  for (const event of evidenceEvents) {
    const entry = recordById.get(event.entryId);
    if (!entry) issues.push({ severity: "error", code: "evidence_unknown_entry", id: event.entryId, line: event.line, message: "复检证据引用了不存在的条目" });
    else {
      entry.explicitEvidence ??= [];
      entry.explicitEvidence.push(event);
    }
  }
  const latestByEntry = new Map();
  for (const transition of transitions) {
    const current = latestByEntry.get(transition.entryId);
    if (!current || transition.date > current.date || (transition.date === current.date && transition.sequence > current.sequence)) latestByEntry.set(transition.entryId, transition);
  }
  for (const [id, transition] of latestByEntry) {
    const entry = recordById.get(id);
    if (!entry) continue;
    if (transition.toStatus && entry.status !== transition.toStatus) issues.push({ severity: "error", code: "transition_status_drift", id, line: transition.line, message: `最新迁移目标 ${transition.toStatus} 与当前状态 ${entry.status} 不一致` });
    if (transition.toRoute && entry.route !== transition.toRoute) issues.push({ severity: "error", code: "transition_route_drift", id, line: transition.line, message: `最新迁移目标轨 ${transition.toRoute} 与当前轨 ${entry.route} 不一致` });
  }

  const declaredCounts = declaredSubjectCounts(markdown);
  if (declaredCounts) {
    for (const [subject, declared] of Object.entries(declaredCounts)) {
      const actual = records.filter((entry) => entry.subject === subject && entry.status === "active").length;
      if (declared !== actual) issues.push({ severity: "warning", code: "header_count_mismatch", id: null, line: null, message: `标题写 ${subject} ${declared}，结构化条目为 ${actual}` });
    }
  }

  return { referenceDate, entries, records, transitions, evidenceEvents, issues, declaredCounts };
}

export function summarizeReciteTransitions(parsed, { start = null, end = null } = {}) {
  const transitions = (parsed.transitions ?? []).filter((transition) => (!start || transition.date >= start) && (!end || transition.date <= end));
  const byEvent = Object.fromEntries([...PARSEABLE_TRANSITION_EVENTS].map((event) => [event, transitions.filter((transition) => transition.event === event).length]));
  return {
    start,
    end,
    total: transitions.length,
    byEvent,
    transitions: [...transitions].sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence),
  };
}

export function summarizeReciteLedger(parsed, { oldestLimit = 5, withdrawnLimit = 3 } = {}) {
  const records = parsed.records ?? [];
  const active = records.filter((entry) => entry.status === "active");
  const actionable = active.filter((entry) => entry.route === "daibei");
  const recognition = active.filter((entry) => entry.route === "recognition_light_roll");
  const legacyRoutes = active.filter((entry) => entry.route === "legacy_anki");
  const withdrawn = records.filter((entry) => entry.status === "withdrawn");
  const transferred = records.filter((entry) => entry.status === "transferred");
  const sortOldest = (rows) => [...rows].sort((a, b) => {
    if (!a.lastTouchedOn && !b.lastTouchedOn) return a.id.localeCompare(b.id, "en", { numeric: true });
    if (!a.lastTouchedOn) return 1;
    if (!b.lastTouchedOn) return -1;
    return a.lastTouchedOn.localeCompare(b.lastTouchedOn) || a.id.localeCompare(b.id, "en", { numeric: true });
  });
  const bySubject = Object.fromEntries([...SUBJECTS].map((subject) => [subject, actionable.filter((entry) => entry.subject === subject).length]));
  return {
    referenceDate: parsed.referenceDate,
    counts: {
      records: records.length,
      active: active.length,
      actionable: actionable.length,
      recognition: recognition.length,
      legacyRoutes: legacyRoutes.length,
      withdrawn: withdrawn.length,
      transferred: transferred.length,
      transitions: (parsed.transitions ?? []).length,
      evidenceEvents: (parsed.evidenceEvents ?? []).length,
      unknown: records.filter((entry) => entry.status === "unknown").length,
      errors: parsed.issues.filter((issue) => issue.severity === "error").length,
      warnings: parsed.issues.filter((issue) => issue.severity === "warning").length,
    },
    bySubject,
    oldestActive: sortOldest(actionable).slice(0, oldestLimit),
    withdrawnReviewCandidates: sortOldest(withdrawn).slice(0, withdrawnLimit),
    issues: parsed.issues,
  };
}

export function readReciteLedger(file, options = {}) {
  return parseReciteLedger(readFileSync(file, "utf8"), options);
}

export function reciteEntryLabel(entry) {
  return `${entry.id} ${entry.subject}·${entry.title}`;
}

export function formatReciteLedgerSummary(summary) {
  const counts = summary.counts;
  const subjectText = Object.entries(summary.bySubject).filter(([, count]) => count > 0).map(([subject, count]) => `${subject}${count}`).join(" / ") || "无";
  const oldest = summary.oldestActive.map((entry) => `${entry.id} ${entry.subject}(${entry.lastTouchedOn ?? "日期缺失"}，${entry.ageDays ?? "?"}天)`).join("、") || "无";
  const withdrawn = summary.withdrawnReviewCandidates.map((entry) => `${entry.id} ${entry.subject}(${entry.lastTouchedOn ?? "日期缺失"})`).join("、") || "无";
  return [
    `带背账本快照（北京 ${summary.referenceDate}）`,
    `挂账 ${counts.active}：带背可复检 ${counts.actionable}（${subjectText}） / 挑错轻滚 ${counts.recognition}${counts.legacyRoutes ? ` / 待迁旧轨 ${counts.legacyRoutes}` : ""}；已撤池 ${counts.withdrawn}；移交其他轨 ${counts.transferred}`,
    `最久未碰候选：${oldest}`,
    `已撤池轮抽候选：${withdrawn}`,
    `迁移流水：${counts.transitions} 条（只作流量审计，当前状态仍以上述 Markdown 条目为准）`,
    `复检证据流水：${counts.evidenceEvents} 条（结果、检验条件与栽点画像的机器事实）`,
    `账本校验：错误 ${counts.errors} / 警告 ${counts.warnings}`,
  ].join("\n");
}

export function applyTransition(markdown, parsed, { id, event, date, evidence, note }) {
  const entry = parsed.records.find((record) => record.id === id);
  if (!entry) throw new Error(`未找到带背条目：${id}`);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = entry.line - 1;
  let end = headingIndex + 1;
  while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end += 1;
  const fieldIndex = lines.findIndex((line, index) => index > headingIndex && index < end && /^-\s*挂(?:\s|\*)/.test(line));
  if (fieldIndex < 0 && event !== "new") throw new Error(`${id} 缺状态字段行，不能安全迁移`);
  const mmdd = date.slice(5);
  const fromStatus = event === "new" ? null : entry.status;
  const fromRoute = event === "new" ? null : entry.route;
  let toStatus = entry.status;
  let toRoute = entry.route;
  let statusText = null;
  let headingMarker = "";

  if (event === "new") {
    if (entry.status !== "active") throw new Error(`new 事件只适用于新建的 active 条目，当前为 ${entry.status}`);
  } else if (event === "withdraw") {
    if (entry.status !== "active") throw new Error(`withdraw 要求当前 active，${id} 当前为 ${entry.status}`);
    toStatus = "withdrawn";
    statusText = `撤 ${mmdd}${note ? `（${note}）` : ""}`;
    headingMarker = ` → 撤 ${mmdd}`;
  } else if (event === "rehang") {
    if (entry.status !== "withdrawn") throw new Error(`rehang 要求当前 withdrawn，${id} 当前为 ${entry.status}`);
    toStatus = "active";
    toRoute = "daibei";
    statusText = `重挂 ${mmdd}${note ? `（${note}）` : ""}`;
    headingMarker = ` → ${mmdd} 重挂`;
  } else if (event === "transfer") {
    if (entry.status === "transferred") throw new Error(`${id} 已是 transferred`);
    if (!note) throw new Error("transfer 必须用 --note 写明接收轨");
    toStatus = "transferred";
    toRoute = "transferred";
    statusText = `带背侧结案·移交${note}`;
    headingMarker = " → 带背侧结案";
  } else if (event === "route-recognition") {
    if (entry.status !== "active" || !["daibei", "legacy_anki"].includes(entry.route)) {
      throw new Error(`route-recognition 要求 active:daibei 或 active:legacy_anki，${id} 当前为 ${entry.status}:${entry.route}`);
    }
    toRoute = "recognition_light_roll";
    statusText = `挂（转挑错式再认轨·周中轻滚${note ? `：${note}` : ""}）`;
    headingMarker = " → 转挑错式再认轨";
  } else if (event === "route-anki") {
    throw new Error("route-anki 已于 2026-08-24 停用；改用 route-recognition");
  } else {
    throw new Error(`未知 event：${event}`);
  }

  if (headingMarker) lines[headingIndex] = `${lines[headingIndex]}${headingMarker}`;
  if (statusText) {
    let field = lines[fieldIndex];
    if (/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/.test(field)) field = field.replace(/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/, `最后碰 **${mmdd}**`);
    else field = `${field.trimEnd()} ｜ 最后碰 **${mmdd}**`;
    if (/状态[：:]\s*[^｜|]+/.test(field)) field = field.replace(/状态[：:]\s*[^｜|]+/, `状态：${statusText}`);
    else field = `${field.trimEnd()} ｜ 状态：${statusText}`;
    lines[fieldIndex] = field;
  }

  const transition = {
    operationId: randomUUID(),
    date,
    event,
    entryId: id,
    fromStatus,
    toStatus,
    fromRoute,
    toRoute,
    evidence,
    note: note || null,
  };
  const hasSection = lines.some((line) => /^##\s+迁移流水（机器读取/.test(line));
  const suffix = `${hasSection ? "" : "\n## 迁移流水（机器读取·append-only）\n\n> 这里只记流量审计；条目当前状态仍是唯一状态事实。已有事件不得改写或删除。\n"}\n<!-- recite-transition-v1 ${JSON.stringify(transition)} -->`;
  return { markdown: `${lines.join("\n").trimEnd()}${suffix}\n`, transition };
}

function evidenceResultLabel(result) {
  return { pass: "✓", partial: "半✓", fail: "✗", void: "作废" }[result] ?? result;
}

/**
 * [gpt] 2026-08-10：一次写入人读复检行与机器证据流水；backfill 只为给既有复检补结构化证据。
 */
export function applyEvidenceEvent(markdown, parsed, {
  id,
  date,
  dimension = "recall",
  result,
  cold = false,
  promptIntegrity = "clean",
  failurePatternCode = null,
  diagnosisStatus = null,
  evidenceAnchor,
  note = null,
  backfill = false,
}) {
  const entry = parsed.records.find((record) => record.id === id);
  if (!entry) throw new Error(`未找到带背条目：${id}`);
  if (typeof cold !== "boolean") throw new Error("cold 必须是布尔值");
  const event = {
    operationId: randomUUID(),
    entryId: id,
    date,
    dimension,
    result,
    cold,
    promptIntegrity,
    // [gpt] 2026-08-12：题面作废不是学生栽点，统一清除用户病因并固化教练责任。
    failurePatternCode: result === "void" ? null : failurePatternCode || null,
    diagnosisStatus: result === "void" ? null : failurePatternCode ? (diagnosisStatus || "pending") : null,
    evidenceAnchor,
    note: result === "void"
      ? ["responsibility=teacher", "valid_attempt=false", "user_error=false", "cooldown_advanced=false", note].filter(Boolean).join("；")
      : note || null,
  };
  const probeIssues = [];
  parseEvidenceEvents(`<!-- recite-evidence-v2 ${JSON.stringify(event)} -->`, probeIssues, parsed.referenceDate);
  const errors = probeIssues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));

  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  // void 不代表完成一次有效“碰过”，不能刷新最后碰或冷却基线；只在正文与流水留教练事故审计。
  if (!backfill) {
    const headingIndex = entry.line - 1;
    let end = headingIndex + 1;
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end += 1;
    const fieldIndex = lines.findIndex((line, index) => index > headingIndex && index < end && /^-\s*挂(?:\s|\*)/.test(line));
    if (fieldIndex < 0) throw new Error(`${id} 缺状态字段行，不能安全记录复检`);
    const mmdd = date.slice(5);
    if (result !== "void" && date >= (entry.lastTouchedOn ?? "")) {
      if (/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/.test(lines[fieldIndex])) lines[fieldIndex] = lines[fieldIndex].replace(/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/, `最后碰 **${mmdd}**`);
      else lines[fieldIndex] = `${lines[fieldIndex].trimEnd()} ｜ 最后碰 **${mmdd}**`;
    }
    const checkLabel = dimension === "understanding" ? "理解检验" : cold ? "冷复检" : "复检";
    const patternText = event.failurePatternCode ? `；栽点：${FAILURE_PATTERNS[event.failurePatternCode].label}（${event.diagnosisStatus}）` : "";
    const noteText = event.note ? `；${event.note}` : "";
    lines.splice(end, 0, `- **${checkLabel}（${mmdd}）**：${evidenceResultLabel(result)}${patternText}${noteText}；锚点：${evidenceAnchor}`);
  }

  const hasSection = lines.some((line) => /^##\s+复检证据流水（机器读取/.test(line));
  const suffix = `${hasSection ? "" : "\n## 复检证据流水（机器读取·append-only）\n\n> 每条记录一次实际检验及其条件；已有事件不得改写或删除，更正请追加新事件。\n"}\n<!-- recite-evidence-v2 ${JSON.stringify(event)} -->`;
  return { markdown: `${lines.join("\n").trimEnd()}${suffix}\n`, event };
}
