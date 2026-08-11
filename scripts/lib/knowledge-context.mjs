// [gpt] 2026-08-10：PC 答疑个人知识上下文 v1。
// 只聚合已经存在的学习事实；个人历史只改变讲解策略，绝不改变教材/真题裁判结论。

import { FAILURE_PATTERNS } from "./knowledge-state.mjs";

export const KNOWLEDGE_CONTEXT_VERSION = "1.1";

const DAY = 86_400_000;
const RELATION_LABELS = Object.freeze({
  prerequisite_forward: "前置关系",
  prerequisite_reverse: "下游关系",
  contrast: "确认的辨析关系",
  supports_forward: "支持关系",
  supports_reverse: "被支持关系",
});

const SOURCE_LABELS = Object.freeze({
  study_error: "错题",
  ask_point: "答疑卡点",
  error_review: "错题复检",
  recite_ledger: "带背表现",
  manual: "手工表现",
  study_log: "学习表现",
  detection_legacy: "历史检测",
});

function snakeOrCamel(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function cleanKpId(value) {
  const kpId = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2,4}-\d{4}$/.test(kpId) ? kpId : null;
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

/** ISO 时间按北京日归档；纯 YYYY-MM-DD 视为已经归一。 */
export function toBeijingDate(value) {
  const text = String(value ?? "").trim();
  if (validDate(text)) return text;
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function inWindow(date, startDate, referenceDate) {
  return Boolean(date && date >= startDate && date <= referenceDate);
}

function clip(value, length = 90) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(1, length - 1))}…`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceId(row) {
  const value = snakeOrCamel(row, "source_id", "sourceId");
  return value == null ? null : String(value);
}

function sourceKind(row) {
  return String(snakeOrCamel(row, "source_kind", "sourceKind") ?? "manual");
}

function linkKey(kind, id) {
  return `${kind}:${String(id ?? "")}`;
}

function buildConfirmedLinkIndex(objectLinks = []) {
  const index = new Map();
  for (const row of objectLinks) {
    if (String(snakeOrCamel(row, "link_status", "linkStatus") ?? "") !== "confirmed") continue;
    const kpId = cleanKpId(snakeOrCamel(row, "kp_id", "kpId"));
    const kind = String(snakeOrCamel(row, "source_kind", "sourceKind") ?? "");
    const id = snakeOrCamel(row, "source_id", "sourceId");
    if (!kpId || !kind || id == null) continue;
    const key = linkKey(kind, id);
    const list = index.get(key) ?? [];
    list.push({
      kpId,
      role: String(row?.role ?? "primary"),
      confidence: Number(row?.confidence ?? 0),
      evidenceAnchor: snakeOrCamel(row, "evidence_anchor", "evidenceAnchor") ?? null,
    });
    index.set(key, list);
  }
  return index;
}

function linkedKps(index, kind, id, { primaryOnly = false } = {}) {
  const rows = index.get(linkKey(kind, id)) ?? [];
  const selected = primaryOnly ? rows.filter((row) => row.role === "primary") : rows;
  return unique((selected.length ? selected : rows).map((row) => row.kpId));
}

function normalizedRelation(row) {
  const prerequisiteKpId = cleanKpId(snakeOrCamel(row, "prerequisite_kp_id", "prerequisiteKpId"));
  const dependentKpId = cleanKpId(snakeOrCamel(row, "dependent_kp_id", "dependentKpId"));
  const relationType = String(snakeOrCamel(row, "relation_type", "relationType") ?? "");
  const relationStatus = String(snakeOrCamel(row, "relation_status", "relationStatus") ?? "");
  if (!prerequisiteKpId || !dependentKpId || relationStatus !== "confirmed") return null;
  if (!['prerequisite', 'supports', 'contrast'].includes(relationType)) return null;
  return { prerequisiteKpId, dependentKpId, relationType };
}

function traversalEdges(relations = []) {
  const adjacency = new Map();
  function add(from, to, kind) {
    const list = adjacency.get(from) ?? [];
    list.push({ to, kind });
    adjacency.set(from, list);
  }
  for (const raw of relations) {
    const row = normalizedRelation(raw);
    if (!row) continue;
    if (row.relationType === "contrast") {
      add(row.prerequisiteKpId, row.dependentKpId, "contrast");
      add(row.dependentKpId, row.prerequisiteKpId, "contrast");
    } else if (row.relationType === "prerequisite") {
      add(row.prerequisiteKpId, row.dependentKpId, "prerequisite_forward");
      add(row.dependentKpId, row.prerequisiteKpId, "prerequisite_reverse");
    } else {
      add(row.prerequisiteKpId, row.dependentKpId, "supports_forward");
      add(row.dependentKpId, row.prerequisiteKpId, "supports_reverse");
    }
  }
  return adjacency;
}

function pathScore(path) {
  if (!path.length) return 1_000;
  const first = path[0]?.kind;
  const relationBonus = first === "contrast" ? 60 : first?.startsWith("prerequisite") ? 40 : 20;
  return 900 - path.length * 100 + relationBonus;
}

// [gpt] 2026-08-10：两个同类点共享一个 supports 父节点，只能证明结构同属，
// 不能单独证明个人错误高度相关；直接 supports 或含 prerequisite/contrast 的路径仍保留。
function isStrongContextPath(path) {
  return path.length <= 1 || path.some((edge) => !edge.kind.startsWith("supports_"));
}

export function buildKnowledgeNeighborhood({ currentKpIds = [], relations = [], maxDepth = 2 } = {}) {
  const starts = unique(currentKpIds.map(cleanKpId));
  const adjacency = traversalEdges(relations);
  const best = new Map();
  const queue = starts.map((kpId) => ({ kpId, originKpId: kpId, nodes: [kpId], edges: [] }));
  for (const item of queue) best.set(item.kpId, { ...item, depth: 0, score: 1_000 });

  while (queue.length) {
    const current = queue.shift();
    if (current.edges.length >= maxDepth) continue;
    for (const edge of adjacency.get(current.kpId) ?? []) {
      if (current.nodes.includes(edge.to)) continue;
      const candidate = {
        kpId: edge.to,
        originKpId: current.originKpId,
        nodes: [...current.nodes, edge.to],
        edges: [...current.edges, edge],
      };
      if (!isStrongContextPath(candidate.edges)) continue;
      const score = pathScore(candidate.edges);
      const known = best.get(edge.to);
      if (known && (known.depth < candidate.edges.length || known.score >= score)) continue;
      const stored = { ...candidate, depth: candidate.edges.length, score };
      best.set(edge.to, stored);
      queue.push(candidate);
    }
  }
  return best;
}

function primaryEventKps({ eventId, directKpId, topicRows, linkIndex }) {
  const eventPrimary = linkedKps(linkIndex, "study_error", eventId, { primaryOnly: true });
  if (eventPrimary.length) return eventPrimary;
  const direct = cleanKpId(directKpId);
  if (direct) return [direct];
  for (const row of topicRows) {
    const topicId = snakeOrCamel(row, "topic_id", "topicId");
    const topicPrimary = linkedKps(linkIndex, "error_topic", topicId, { primaryOnly: true });
    if (topicPrimary.length) return topicPrimary;
    const topicKp = cleanKpId(snakeOrCamel(row, "topic_kp_id", "topicKpId"));
    if (topicKp) return [topicKp];
  }
  return [];
}

function buildErrorEvents(errorRows, linkIndex, startDate, referenceDate) {
  const grouped = new Map();
  for (const row of errorRows ?? []) {
    const id = snakeOrCamel(row, "study_error_id", "studyErrorId");
    if (id == null) continue;
    const key = String(id);
    const known = grouped.get(key) ?? { base: row, topicRows: [] };
    known.topicRows.push(row);
    grouped.set(key, known);
  }

  const events = [];
  for (const [id, group] of grouped) {
    const base = group.base;
    const date = toBeijingDate(snakeOrCamel(base, "log_date", "logDate"));
    const status = String(snakeOrCamel(base, "event_status", "eventStatus") ?? "open");
    if (!inWindow(date, startDate, referenceDate) || status === "dismissed") continue;
    const eventLinks = linkedKps(linkIndex, "study_error", id);
    const topicKpIds = [];
    const topics = group.topicRows.map((row) => {
      const topicId = snakeOrCamel(row, "topic_id", "topicId");
      const linked = topicId == null ? [] : linkedKps(linkIndex, "error_topic", topicId);
      const directTopicKp = cleanKpId(snakeOrCamel(row, "topic_kp_id", "topicKpId"));
      topicKpIds.push(...linked, directTopicKp);
      return {
        id: topicId == null ? null : String(topicId),
        title: snakeOrCamel(row, "topic_title", "topicTitle") ?? null,
        pattern: snakeOrCamel(row, "failure_pattern_code", "failurePatternCode") ?? null,
        diagnosisStatus: String(snakeOrCamel(row, "diagnosis_status", "diagnosisStatus") ?? "pending"),
        rootCauseNote: snakeOrCamel(row, "root_cause_note", "rootCauseNote") ?? null,
        masteryStatus: String(snakeOrCamel(row, "mastery_status", "masteryStatus") ?? "open"),
        classificationStatus: String(snakeOrCamel(row, "classification_status", "classificationStatus") ?? "pending"),
        kpIds: unique([...linked, directTopicKp]),
      };
    });
    const directEventKp = cleanKpId(snakeOrCamel(base, "event_kp_id", "eventKpId"));
    const primaryKpIds = primaryEventKps({ eventId: id, directKpId: directEventKp, topicRows: group.topicRows, linkIndex });
    const kpIds = unique([...eventLinks, directEventKp, ...topicKpIds]);
    if (!kpIds.length) continue;
    const summary = snakeOrCamel(base, "knowledge", "knowledge")
      ?? snakeOrCamel(base, "raw_input", "rawInput")
      ?? topics.find((topic) => topic.title)?.title
      ?? "已记录错题";
    events.push({
      key: `study_error:${id}`,
      kind: "study_error",
      id,
      date,
      status,
      summary: clip(summary),
      kpIds,
      primaryKpIds: primaryKpIds.length ? primaryKpIds : kpIds.slice(0, 1),
      topicKpIds: unique(topicKpIds),
      topics,
      patterns: unique(topics.map((topic) => topic.pattern)),
      sourceKind: "study_error",
      sourceId: id,
    });
  }
  return events;
}

function buildAskEvents(askPoints, linkIndex, startDate, referenceDate) {
  const events = [];
  for (const row of askPoints ?? []) {
    const id = row?.id == null ? null : String(row.id);
    if (!id) continue;
    const status = String(row?.effective_status ?? row?.effectiveStatus ?? row?.status ?? "open");
    if (["dismissed", "superseded", "expired"].includes(status)) continue;
    const date = toBeijingDate(row?.created_at ?? row?.createdAt);
    if (!inWindow(date, startDate, referenceDate)) continue;
    const mapped = linkedKps(linkIndex, "ask_point", id);
    const direct = cleanKpId(row?.kp_id ?? row?.kpId);
    const kpIds = unique([...mapped, direct]);
    if (!kpIds.length) continue;
    events.push({
      key: `ask_point:${id}`,
      kind: "ask_point",
      id,
      date,
      status,
      summary: clip(row?.confusion ?? row?.raw_question ?? row?.rawQuestion ?? "未收口答疑卡点"),
      kpIds,
      primaryKpIds: kpIds.slice(0, 1),
      topicKpIds: [],
      topics: [],
      patterns: [],
      sourceKind: "ask_point",
      sourceId: id,
    });
  }
  return events;
}

function evidenceKey(row, index) {
  const operationId = snakeOrCamel(row, "operation_id", "operationId");
  if (operationId) return `knowledge_evidence:${operationId}`;
  return `knowledge_evidence:${sourceKind(row)}:${sourceId(row) ?? "none"}:${snakeOrCamel(row, "evidence_date", "evidenceDate") ?? "none"}:${row?.dimension ?? "none"}:${index}`;
}

function buildEvidenceEvents(knowledgeEvidence, startDate, referenceDate, representedSources) {
  const events = [];
  for (let index = 0; index < (knowledgeEvidence ?? []).length; index++) {
    const row = knowledgeEvidence[index];
    const result = String(row?.result ?? "");
    const promptIntegrity = String(snakeOrCamel(row, "prompt_integrity", "promptIntegrity") ?? "clean");
    const diagnosisStatus = String(snakeOrCamel(row, "diagnosis_status", "diagnosisStatus") ?? "pending");
    if (!["fail", "partial"].includes(result) || promptIntegrity === "invalid" || diagnosisStatus === "rejected") continue;
    const date = toBeijingDate(snakeOrCamel(row, "evidence_date", "evidenceDate"));
    if (!inWindow(date, startDate, referenceDate)) continue;
    const kind = sourceKind(row);
    const id = sourceId(row);
    if (id != null && representedSources.has(linkKey(kind, id))) continue;
    const kpId = cleanKpId(snakeOrCamel(row, "kp_id", "kpId"));
    if (!kpId) continue;
    const pattern = snakeOrCamel(row, "failure_pattern_code", "failurePatternCode") ?? null;
    events.push({
      key: evidenceKey(row, index),
      kind: "knowledge_evidence",
      id: snakeOrCamel(row, "operation_id", "operationId") ?? id ?? String(index + 1),
      date,
      status: result,
      summary: clip(row?.note ?? snakeOrCamel(row, "evidence_anchor", "evidenceAnchor") ?? `${row?.dimension ?? "表现"}/${result}`),
      kpIds: [kpId],
      primaryKpIds: [kpId],
      topicKpIds: [],
      topics: [],
      patterns: pattern ? [pattern] : [],
      patternStatuses: pattern ? { [pattern]: diagnosisStatus } : {},
      sourceKind: kind,
      sourceId: id,
      dimension: row?.dimension ?? null,
      cold: Boolean(row?.cold),
    });
  }
  return events;
}

function relationReason(entry) {
  if (!entry?.edges?.length) return "同一知识点";
  const labels = unique(entry.edges.map((edge) => RELATION_LABELS[edge.kind] ?? edge.kind));
  return entry.edges.length === 1 ? labels[0] : `${entry.edges.length}跳确认关系：${labels.join(" → ")}`;
}

function rankEvent(event, neighborhood, currentSet) {
  const topicDirect = event.topicKpIds.some((kpId) => currentSet.has(kpId));
  const primaryDirect = event.primaryKpIds.some((kpId) => currentSet.has(kpId));
  if (topicDirect) return { score: 1_200, reason: "长期错误主题覆盖当前知识点", matchedKpId: event.topicKpIds.find((kpId) => currentSet.has(kpId)), path: [] };
  if (primaryDirect) return { score: 1_150, reason: "同一知识点", matchedKpId: event.primaryKpIds.find((kpId) => currentSet.has(kpId)), path: [] };
  let best = null;
  for (const kpId of event.kpIds) {
    const entry = neighborhood.get(kpId);
    if (!entry || entry.depth === 0) continue;
    const candidate = { score: entry.score, reason: relationReason(entry), matchedKpId: kpId, path: entry.nodes };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function topicCandidates(events, neighborhood) {
  const grouped = new Map();
  for (const event of events.filter((item) => item.kind === "study_error")) {
    for (const topic of event.topics) {
      if (!topic.id) continue;
      // [gpt] A multi-topic error can be recalled because one topic is relevant.
      // Do not let a separately mapped, unrelated topic hitchhike on that event.
      if (topic.kpIds.length && !topic.kpIds.some((kpId) => neighborhood.has(kpId))) continue;
      const known = grouped.get(topic.id) ?? {
        id: topic.id,
        title: topic.title,
        events: new Map(),
        patterns: new Set(),
        primaryKpIds: new Set(),
        confirmedEvents: new Set(),
        pendingEvents: new Set(),
        rootCauseNotes: [],
        masteryStatuses: new Set(),
      };
      known.title ??= topic.title;
      known.events.set(event.key, event);
      event.primaryKpIds.forEach((kpId) => known.primaryKpIds.add(kpId));
      if (topic.pattern) known.patterns.add(topic.pattern);
      known.masteryStatuses.add(topic.masteryStatus);
      if (topic.diagnosisStatus === "confirmed") known.confirmedEvents.add(event.key);
      else if (topic.diagnosisStatus === "pending") known.pendingEvents.add(event.key);
      if (topic.rootCauseNote) known.rootCauseNotes.push({ text: topic.rootCauseNote, confirmed: topic.diagnosisStatus === "confirmed", date: event.date });
      grouped.set(topic.id, known);
    }
  }

  return [...grouped.values()].map((item) => {
    const eventCount = item.events.size;
    const confirmedFailures = item.confirmedEvents.size;
    const distinctKnowledgePoints = item.primaryKpIds.size;
    const recurrent = confirmedFailures >= 3 && distinctKnowledgePoints >= 2;
    const suspected = eventCount >= 2;
    const retired = [...item.masteryStatuses].some((status) => ["stable", "archived"].includes(status));
    const notes = item.rootCauseNotes.sort((left, right) => right.date.localeCompare(left.date));
    const rootCause = notes.find((note) => note.confirmed)?.text ?? notes[0]?.text ?? null;
    const diagnosisStatus = retired ? "retired" : confirmedFailures > 0 ? "confirmed" : "pending";
    return {
      kind: "error_topic",
      id: item.id,
      title: item.title ?? `错题主题 T${item.id}`,
      rootCause,
      diagnosisStatus,
      recurrence: recurrent ? "recurring" : suspected ? "suspected" : "single",
      eventCount,
      confirmedFailures,
      pendingFailures: item.pendingEvents.size,
      distinctKnowledgePoints,
      patterns: [...item.patterns],
      evidence: [...item.events.values()]
        .map((event) => ({ key: event.key, date: event.date, kpIds: event.primaryKpIds }))
        .sort((left, right) => right.date.localeCompare(left.date)),
      score: (retired ? -100 : 0) + confirmedFailures * 30 + eventCount * 10 + distinctKnowledgePoints * 8 + (rootCause ? 12 : 0),
    };
  }).sort((left, right) => right.score - left.score || String(right.evidence[0]?.date ?? "").localeCompare(String(left.evidence[0]?.date ?? "")));
}

function patternCandidates(events, portrait, currentSubjects) {
  const grouped = new Map();
  for (const event of events) {
    for (const pattern of event.patterns ?? []) {
      if (!(pattern in FAILURE_PATTERNS)) continue;
      const key = `${event.key}:${pattern}`;
      const known = grouped.get(pattern) ?? { pattern, evidence: new Map(), confirmed: new Set(), pending: new Set(), kpIds: new Set() };
      if (!known.evidence.has(key)) known.evidence.set(key, event);
      event.primaryKpIds.forEach((kpId) => known.kpIds.add(kpId));
      let status = event.patternStatuses?.[pattern] ?? null;
      if (!status && event.kind === "study_error") {
        const rows = event.topics.filter((topic) => topic.pattern === pattern);
        status = rows.some((row) => row.diagnosisStatus === "confirmed") ? "confirmed" : "pending";
      }
      if (status === "confirmed") known.confirmed.add(event.key);
      else known.pending.add(event.key);
      grouped.set(pattern, known);
    }
  }

  return [...grouped.values()].map((item) => {
    const eventCount = new Set([...item.evidence.values()].map((event) => event.key)).size;
    const confirmedFailures = item.confirmed.size;
    const distinctKnowledgePoints = item.kpIds.size;
    const profile = (portrait?.bySubject ?? [])
      .filter((scope) => currentSubjects.has(scope.subject))
      .flatMap((scope) => scope.patterns ?? [])
      .find((candidate) => candidate.pattern === item.pattern) ?? null;
    const retired = profile?.status === "retired";
    const recurrent = confirmedFailures >= 3 && distinctKnowledgePoints >= 2;
    return {
      kind: "failure_pattern",
      code: item.pattern,
      label: FAILURE_PATTERNS[item.pattern].label,
      focus: FAILURE_PATTERNS[item.pattern].focus,
      diagnosisStatus: retired ? "retired" : confirmedFailures > 0 ? "confirmed" : "pending",
      recurrence: recurrent ? "recurring" : eventCount >= 2 ? "suspected" : "single",
      eventCount,
      confirmedFailures,
      pendingFailures: item.pending.size,
      distinctKnowledgePoints,
      evidence: [...item.evidence.values()].map((event) => ({ key: event.key, date: event.date, kpIds: event.primaryKpIds })),
      score: (retired ? -100 : 0) + confirmedFailures * 30 + eventCount * 10 + distinctKnowledgePoints * 8,
    };
  }).sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
}

function sourceLabel(event) {
  if (event.kind === "study_error") return `错题 E${event.id}`;
  if (event.kind === "ask_point") return `答疑卡点 A${event.id}`;
  const prefix = SOURCE_LABELS[event.sourceKind] ?? "表现证据";
  return event.sourceId == null ? prefix : `${prefix} ${event.sourceId}`;
}

function chooseTeachingAction({ rootBlockers, topicProfiles, patternProfiles, neighborhood }) {
  if (rootBlockers.length) {
    const blocker = rootBlockers[0];
    return {
      kind: "prerequisite",
      route: "ask-pc",
      focus: `先补根前置 ${blocker.kpId}${blocker.name ? `「${blocker.name}」` : ""} 到 ${blocker.requiredStage}，再回到当前题。`,
      reason: `该前置阻塞 ${blocker.unblocks?.length ?? 1} 个当前目标。`,
    };
  }
  const topic = topicProfiles.find((item) => item.recurrence !== "single" && item.diagnosisStatus !== "retired");
  const topicPattern = topic?.patterns?.find((code) => code in FAILURE_PATTERNS);
  if (topicPattern) {
    return { kind: "error_topic", route: "ask-pc", focus: FAILURE_PATTERNS[topicPattern].focus, reason: `命中长期主题 T${topic.id}。` };
  }
  const pattern = patternProfiles.find((item) => item.diagnosisStatus !== "retired" && item.recurrence !== "single");
  if (pattern) return { kind: "failure_pattern", route: "ask-pc", focus: pattern.focus, reason: `近窗命中「${pattern.label}」${pattern.eventCount}次。` };
  const contrast = [...neighborhood.values()].find((item) => item.edges?.some((edge) => edge.kind === "contrast"));
  if (contrast) {
    return { kind: "contrast", route: "ask-pc", focus: "用一个明确区分轴做正反辨析，不重复分别背两段定义。", reason: "当前点存在已确认的辨析邻点。" };
  }
  return null;
}

function rootBlockersForCurrent(knowledgeGraph, currentSet) {
  const blockers = new Map();
  for (const node of knowledgeGraph?.byKnowledgePoint ?? []) {
    if (!currentSet.has(node.kpId)) continue;
    for (const blocker of node.blockers ?? []) {
      if (!blocker.root) continue;
      const known = blockers.get(blocker.kpId) ?? { ...blocker, unblocks: [] };
      known.unblocks.push({ kpId: node.kpId, name: node.name, path: blocker.path });
      blockers.set(blocker.kpId, known);
    }
  }
  return [...blockers.values()].sort((left, right) => right.unblocks.length - left.unblocks.length || right.strength - left.strength || left.kpId.localeCompare(right.kpId));
}

export function buildPersonalKnowledgeContext({
  currentKpIds = [],
  referenceDate,
  windowDays = 30,
  maxDepth = 2,
  limit = 3,
  catalog = { items: [] },
  relations = [],
  objectLinks = [],
  askPoints = [],
  errorRows = [],
  knowledgeEvidence = [],
  knowledgeStates = { items: [] },
  knowledgeGraph = null,
  failurePortrait = null,
} = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("windowDays 必须是正整数");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) throw new Error("maxDepth 必须是 0-4 整数");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");

  const catalogById = new Map((catalog?.items ?? []).map((item) => [item.kpId, item]));
  const stateById = new Map((knowledgeStates?.items ?? []).map((item) => [item.kpId, item]));
  const requested = unique(currentKpIds.map(cleanKpId));
  const current = requested.filter((kpId) => catalogById.has(kpId));
  const missing = requested.filter((kpId) => !catalogById.has(kpId));
  if (!current.length) throw new Error("没有可用的当前知识点");
  const currentSet = new Set(current);
  const currentSubjects = new Set(current.map((kpId) => catalogById.get(kpId)?.subject).filter(Boolean));
  const startDate = shiftDate(referenceDate, -(windowDays - 1));
  const linkIndex = buildConfirmedLinkIndex(objectLinks);
  const neighborhood = buildKnowledgeNeighborhood({ currentKpIds: current, relations, maxDepth });

  const errorEvents = buildErrorEvents(errorRows, linkIndex, startDate, referenceDate);
  const askEvents = buildAskEvents(askPoints, linkIndex, startDate, referenceDate);
  const representedSources = new Set([
    ...errorEvents.map((event) => linkKey("study_error", event.id)),
    ...askEvents.map((event) => linkKey("ask_point", event.id)),
  ]);
  const evidenceEvents = buildEvidenceEvents(knowledgeEvidence, startDate, referenceDate, representedSources);
  const relevant = [...errorEvents, ...askEvents, ...evidenceEvents]
    .map((event) => {
      const relevance = rankEvent(event, neighborhood, currentSet);
      return relevance ? { ...event, relevance, sourceLabel: sourceLabel(event) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.relevance.score - left.relevance.score || right.date.localeCompare(left.date) || left.key.localeCompare(right.key));

  const topics = topicCandidates(relevant, neighborhood);
  const patterns = patternCandidates(relevant, failurePortrait, currentSubjects);
  const rootBlockers = rootBlockersForCurrent(knowledgeGraph, currentSet);
  const teachingAction = chooseTeachingAction({ rootBlockers, topicProfiles: topics, patternProfiles: patterns, neighborhood });
  const diagnosisCandidates = [
    ...topics.filter((item) => item.recurrence !== "single" || item.rootCause),
    ...patterns.filter((item) => item.recurrence !== "single"),
  ].sort((left, right) => right.score - left.score);

  return {
    version: KNOWLEDGE_CONTEXT_VERSION,
    referenceDate,
    window: { days: windowDays, startDate, endDate: referenceDate },
    currentKnowledgePoints: current.map((kpId) => {
      const point = catalogById.get(kpId);
      const state = stateById.get(kpId);
      return {
        kpId,
        subject: point?.subject ?? null,
        name: point?.name ?? null,
        parentKp: point?.parentKp ?? null,
        stage: state?.stage ?? "unseen",
        activated: Boolean(state?.activated),
      };
    }),
    missingKnowledgePoints: missing,
    neighborhood: [...neighborhood.values()].filter((item) => item.depth > 0).map((item) => ({
      kpId: item.kpId,
      name: catalogById.get(item.kpId)?.name ?? null,
      subject: catalogById.get(item.kpId)?.subject ?? null,
      distance: item.depth,
      path: item.nodes,
      relationPath: item.edges.map((edge) => RELATION_LABELS[edge.kind] ?? edge.kind),
    })).sort((left, right) => left.distance - right.distance || left.kpId.localeCompare(right.kpId)),
    recentSimilarEvents: relevant.slice(0, limit).map((event) => ({
      key: event.key,
      source: event.sourceLabel,
      sourceKind: event.sourceKind,
      sourceId: event.sourceId,
      date: event.date,
      status: event.status,
      summary: event.summary,
      kpIds: event.kpIds,
      primaryKpIds: event.primaryKpIds,
      reason: event.relevance.reason,
      matchedKpId: event.relevance.matchedKpId,
      path: event.relevance.path,
      patterns: event.patterns,
    })),
    counts: {
      relevantEvents: relevant.length,
      displayedEvents: Math.min(limit, relevant.length),
      errorEvents: relevant.filter((event) => event.kind === "study_error").length,
      askPoints: relevant.filter((event) => event.kind === "ask_point").length,
      performanceEvidence: relevant.filter((event) => event.kind === "knowledge_evidence").length,
    },
    diagnosisCandidates,
    rootBlockers,
    teachingAction,
    policy: {
      verdictBoundary: "个人历史只影响讲解策略，不得改变《考试分析》、讲义、真题的裁判结论。",
      evidenceBoundary: "普通提问、dismissed/superseded/expired 卡点、void/invalid 证据和未确认映射不进入上下文。",
      diagnosisBoundary: "两次只称疑似重复；至少三次确认失败且跨两个知识点才称反复模式；具体病根仍以用户认领为准。",
    },
  };
}

function diagnosisLabel(item) {
  const state = item.diagnosisStatus === "retired" ? "已退役" : item.diagnosisStatus === "confirmed" ? "已确认" : "候选";
  const recurrence = item.recurrence === "recurring" ? "反复模式" : item.recurrence === "suspected" ? "疑似重复" : "单次";
  return `${state}·${recurrence}`;
}

export function formatPersonalKnowledgeContext(context) {
  const lines = [
    `个人知识上下文 v${context?.version ?? "?"}｜北京 ${context?.referenceDate ?? "?"}｜近 ${context?.window?.days ?? "?"} 日`,
    "边界：个人历史只影响讲解策略，不改变教材与真题裁判。",
    "",
    `当前：${(context?.currentKnowledgePoints ?? []).map((item) => `${item.kpId} [${item.subject ?? "未分类"}] ${item.name ?? "未命名"}（${item.stage}）`).join("；") || "无"}`,
  ];
  if (context?.rootBlockers?.length) {
    lines.push(`根前置：${context.rootBlockers.map((item) => `${item.kpId}${item.name ? ` ${item.name}` : ""}（须到 ${item.requiredStage}）`).join("；")}`);
  }
  lines.push("", "近窗高度相关表现：");
  if (!context?.recentSimilarEvents?.length) lines.push("- 暂无达到强关联门槛的个人表现；不制造历史关联。");
  for (const event of context?.recentSimilarEvents ?? []) {
    lines.push(`- ${event.date}｜${event.source}｜${event.summary}｜关联理由：${event.reason}`);
  }
  lines.push("", "共同模式：");
  if (!context?.diagnosisCandidates?.length) lines.push("- 暂无达到重复门槛的共同模式。");
  for (const item of (context?.diagnosisCandidates ?? []).slice(0, 3)) {
    if (item.kind === "error_topic") {
      lines.push(`- ${diagnosisLabel(item)}｜T${item.id} ${item.title}｜${item.eventCount}次/涉及${item.distinctKnowledgePoints}点${item.rootCause ? `｜具体诊断：${item.rootCause}` : ""}`);
    } else {
      lines.push(`- ${diagnosisLabel(item)}｜${item.label}｜${item.eventCount}次/涉及${item.distinctKnowledgePoints}点`);
    }
  }
  if (context?.teachingAction) lines.push("", `本轮教学动作：${context.teachingAction.focus}（${context.teachingAction.reason}）`);
  lines.push("", `口径：${context?.policy?.diagnosisBoundary ?? "具体病根以用户认领为准。"}`);
  return lines.join("\n");
}
