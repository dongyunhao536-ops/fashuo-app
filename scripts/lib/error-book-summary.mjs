const MASTERY_ORDER = Object.freeze({ open: 0, monitoring: 1, stable: 2, archived: 3 });

function asId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function eventFromRow(row) {
  return {
    id: asId(row.study_error_id),
    subject: row.event_subject ?? null,
    kpId: row.event_kp_id ?? null,
    knowledge: String(row.knowledge ?? ""),
    logDate: row.log_date == null ? "" : String(row.log_date),
    status: row.event_status ?? "unknown",
    absorbedAt: row.absorbed_at ?? null,
  };
}

function latestDate(events) {
  return events.reduce((latest, event) => event.logDate > latest ? event.logDate : latest, "");
}

/**
 * 把 error_book_v2 的“每个事件×主题一行”视图压成两条互不混淆的轴：
 * 事件轴（open/absorbed/dismissed）与主题轴（open/monitoring/stable/archived）。
 */
export function summarizeErrorBookRows(rows = []) {
  const events = new Map();
  const topics = new Map();

  for (const row of rows) {
    const event = eventFromRow(row);
    if (!event.id) continue;
    const known = events.get(event.id) ?? { ...event, topicIds: new Set() };
    events.set(event.id, known);

    const topicId = asId(row.topic_id);
    if (!topicId) continue;
    known.topicIds.add(topicId);

    const topic = topics.get(topicId) ?? {
      id: topicId,
      subject: row.topic_subject ?? row.event_subject ?? null,
      title: String(row.topic_title ?? "未命名主题"),
      chapter: row.chapter ?? null,
      section: row.section ?? null,
      classificationStatus: row.classification_status ?? "pending",
      masteryStatus: row.mastery_status ?? "open",
      kpId: row.topic_kp_id ?? null,
      linkedKpIds: new Set(),
      events: new Map(),
      confirmedRootCauses: new Set(),
      confirmedFailurePatterns: new Set(),
      pendingFailurePatterns: new Set(),
      primaryEventIds: new Set(),
    };
    topic.events.set(event.id, event);
    if (event.kpId) topic.linkedKpIds.add(String(event.kpId));
    if (row.role === "primary") topic.primaryEventIds.add(event.id);
    if (row.diagnosis_status === "confirmed" && row.root_cause_code && row.root_cause_code !== "unclassified") {
      topic.confirmedRootCauses.add(String(row.root_cause_code));
    }
    if (row.failure_pattern_code && row.diagnosis_status === "confirmed") topic.confirmedFailurePatterns.add(String(row.failure_pattern_code));
    if (row.failure_pattern_code && row.diagnosis_status === "pending") topic.pendingFailurePatterns.add(String(row.failure_pattern_code));
    topics.set(topicId, topic);
  }

  const topicRows = [...topics.values()].map((topic) => {
    const linkedEvents = [...topic.events.values()];
    const eventCounts = Object.fromEntries(
      ["open", "absorbed", "dismissed"].map((status) => [status, linkedEvents.filter((event) => event.status === status).length]),
    );
    const active = eventCounts.open > 0;
    const awaitingColdReview = !active && ["open", "monitoring"].includes(topic.masteryStatus);
    return {
      id: topic.id,
      subject: topic.subject,
      title: topic.title,
      chapter: topic.chapter,
      section: topic.section,
      kpId: topic.kpId ?? (topic.linkedKpIds.size === 1 ? [...topic.linkedKpIds][0] : null),
      linkedKpIds: [...topic.linkedKpIds],
      classificationStatus: topic.classificationStatus,
      masteryStatus: topic.masteryStatus,
      eventCounts,
      eventTotal: linkedEvents.length,
      primaryEventCount: topic.primaryEventIds.size,
      confirmedRootCauses: [...topic.confirmedRootCauses],
      confirmedFailurePatterns: [...topic.confirmedFailurePatterns],
      pendingFailurePatterns: [...topic.pendingFailurePatterns],
      latestEventDate: latestDate(linkedEvents),
      latestOpenDate: latestDate(linkedEvents.filter((event) => event.status === "open")),
      active,
      awaitingColdReview,
      recurrent: linkedEvents.length > 1 || (eventCounts.open > 0 && eventCounts.absorbed > 0),
    };
  }).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.recurrent !== b.recurrent) return a.recurrent ? -1 : 1;
    if (a.eventTotal !== b.eventTotal) return b.eventTotal - a.eventTotal;
    const mastery = (MASTERY_ORDER[a.masteryStatus] ?? 9) - (MASTERY_ORDER[b.masteryStatus] ?? 9);
    if (mastery) return mastery;
    return b.latestEventDate.localeCompare(a.latestEventDate);
  });

  const eventRows = [...events.values()].map((event) => ({
    id: event.id,
    subject: event.subject,
    kpId: event.kpId,
    knowledge: event.knowledge,
    logDate: event.logDate,
    status: event.status,
    absorbedAt: event.absorbedAt,
    topicIds: [...event.topicIds],
  }));
  const eventCounts = Object.fromEntries(
    ["open", "absorbed", "dismissed"].map((status) => [status, eventRows.filter((event) => event.status === status).length]),
  );
  const masteryCounts = Object.fromEntries(
    ["open", "monitoring", "stable", "archived"].map((status) => [status, topicRows.filter((topic) => topic.masteryStatus === status).length]),
  );
  const allUnclassifiedEvents = eventRows.filter((event) => event.topicIds.length === 0);

  return {
    events: eventRows,
    topics: topicRows,
    activeTopics: topicRows.filter((topic) => topic.active),
    awaitingColdReviewTopics: topicRows.filter((topic) => topic.awaitingColdReview),
    unclassifiedEvents: allUnclassifiedEvents.filter((event) => event.status !== "dismissed"),
    dismissedUnclassifiedEvents: allUnclassifiedEvents.filter((event) => event.status === "dismissed"),
    eventCounts,
    masteryCounts,
  };
}

export function topicLabel(topic, { includeSubject = true } = {}) {
  const prefix = includeSubject && topic.subject ? `[${topic.subject}] ` : "";
  return `T#${topic.id} ${prefix}${topic.title}`;
}
