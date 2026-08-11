// [gpt] 2026-08-10：个人知识图谱二期的对象映射审计。
// 只把已有稳定 kp_id 视为可自动迁移事实；文本候选永远不自动 confirmed。

const KP_ID = /^[A-Z]{2,4}-\d{4}$/;
const TERMINAL_ASK_STATUSES = new Set(["dismissed", "superseded", "expired"]);

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function cleanKpId(value) {
  const kpId = String(value ?? "").trim().toUpperCase();
  return KP_ID.test(kpId) ? kpId : null;
}

function sourceKey(kind, id) {
  return `${kind}:${String(id ?? "")}`;
}

function buildLinkIndex(objectLinks = []) {
  const index = new Map();
  for (const row of objectLinks) {
    const sourceKind = rowValue(row, "sourceKind", "source_kind");
    const sourceId = rowValue(row, "sourceId", "source_id");
    if (!sourceKind || sourceId == null) continue;
    const key = sourceKey(sourceKind, sourceId);
    const list = index.get(key) ?? [];
    list.push({
      kpId: cleanKpId(rowValue(row, "kpId", "kp_id")),
      role: String(rowValue(row, "role", "role") ?? "primary"),
      status: String(rowValue(row, "linkStatus", "link_status") ?? "pending"),
      method: rowValue(row, "matchMethod", "match_method"),
      confidence: rowValue(row, "confidence", "confidence"),
    });
    index.set(key, list);
  }
  return index;
}

function methodTopic(row) {
  return /跨科做题方法|通用做题方法|做题方法/.test(`${row?.chapter ?? ""}/${row?.section ?? ""}`);
}

function eligibleAsk(row) {
  const status = String(rowValue(row, "effectiveStatus", "effective_status") ?? row?.status ?? "open");
  return !TERMINAL_ASK_STATUSES.has(status);
}

function makeRecord({ sourceKind, sourceId, subject, title, directKpId = null, inheritedKpIds = [], eligible = true, excludeReason = null }) {
  return {
    sourceKind,
    sourceId: String(sourceId),
    subject: subject ?? null,
    title: title ?? `${sourceKind}#${sourceId}`,
    directKpId: cleanKpId(directKpId),
    rawDirectKpId: directKpId == null ? null : String(directKpId),
    inheritedKpIds: [...new Set(inheritedKpIds.map(cleanKpId).filter(Boolean))],
    eligible,
    excludeReason,
  };
}

function classifyRecord(record, linkIndex, catalogIds) {
  const links = linkIndex.get(sourceKey(record.sourceKind, record.sourceId)) ?? [];
  const confirmedPrimary = links.filter((link) => link.status === "confirmed" && link.role === "primary" && link.kpId);
  const confirmedOther = links.filter((link) => link.status === "confirmed" && link.role !== "primary" && link.kpId);
  const pending = links.filter((link) => link.status === "pending" && link.kpId);
  const invalidDirect = record.rawDirectKpId && !record.directKpId;
  const directOutsideCatalog = record.directKpId && !catalogIds.has(record.directKpId);
  let status;
  let reason;
  if (!record.eligible) {
    status = "excluded";
    reason = record.excludeReason ?? "不进入当前个人图谱连接范围";
  } else if (invalidDirect || directOutsideCatalog) {
    status = "invalid_direct";
    reason = invalidDirect ? "直连字段不是合法稳定 KP-ID" : "直连 KP-ID 不在当前稳定目录";
  } else if (confirmedPrimary.length > 1) {
    status = "conflict";
    reason = "同一对象存在多个 confirmed primary";
  } else if (confirmedPrimary.length === 1 && record.directKpId && confirmedPrimary[0].kpId !== record.directKpId) {
    status = "conflict";
    reason = `直连 ${record.directKpId} 与 confirmed primary ${confirmedPrimary[0].kpId} 不一致`;
  } else if (confirmedPrimary.length === 1) {
    status = "confirmed_primary";
    reason = "已有 confirmed primary 映射";
  } else if (record.directKpId) {
    status = "direct_backfill";
    reason = "已有稳定 kp_id，但缺显式 confirmed primary；可无推断迁移";
  } else if (record.inheritedKpIds.length === 1) {
    status = "inherited_topic";
    reason = "单次错题可从唯一 primary 长期主题继承知识点";
  } else if (record.inheritedKpIds.length > 1) {
    status = "conflict";
    reason = "单次错题关联多个可继承的 primary 主题知识点";
  } else if (confirmedOther.length) {
    status = "confirmed_related_only";
    reason = "只有 related/reference confirmed，仍缺唯一主点";
  } else if (pending.length) {
    status = "pending_only";
    reason = "已有 pending 候选，尚未人工确认";
  } else {
    status = "unmapped";
    reason = "无稳定直连、confirmed 映射或可继承主题";
  }
  return { ...record, status, reason, links };
}

function summarize(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return { total: items.length, ...counts };
}

export function buildKnowledgeMappingAudit({
  catalog,
  objectLinks = [],
  askPoints = [],
  errorTopics = [],
  errorRows = [],
  studyErrorTopics = [],
  reciteRecords = [],
  subject = null,
} = {}) {
  const catalogIds = new Set((catalog?.items ?? []).map((item) => item.kpId));
  const linkIndex = buildLinkIndex(objectLinks);

  const topicRecords = errorTopics.map((row) => makeRecord({
    sourceKind: "error_topic",
    sourceId: row.id,
    subject: row.subject,
    title: row.title,
    directKpId: rowValue(row, "kpId", "kp_id"),
    eligible: !methodTopic(row),
    excludeReason: methodTopic(row) ? "跨科/通用做题方法主题不硬连单一内容知识点" : null,
  }));
  const topicById = new Map(topicRecords.map((item) => [item.sourceId, item]));
  const inheritedByEvent = new Map();
  for (const relation of studyErrorTopics) {
    if (String(relation.role ?? "primary") !== "primary") continue;
    const eventId = String(rowValue(relation, "studyErrorId", "study_error_id") ?? "");
    const topicId = String(rowValue(relation, "topicId", "topic_id") ?? "");
    const topic = topicById.get(topicId);
    if (!eventId || !topic) continue;
    const topicLinks = linkIndex.get(sourceKey("error_topic", topicId)) ?? [];
    const confirmed = topicLinks.find((link) => link.status === "confirmed" && link.role === "primary")?.kpId;
    const kpId = confirmed ?? topic.directKpId;
    if (!kpId) continue;
    const list = inheritedByEvent.get(eventId) ?? [];
    list.push(kpId);
    inheritedByEvent.set(eventId, list);
  }

  const records = [
    ...topicRecords,
    ...errorRows.map((row) => makeRecord({
      sourceKind: "study_error",
      sourceId: row.id,
      subject: row.subject,
      title: row.knowledge,
      directKpId: rowValue(row, "kpId", "kp_id"),
      inheritedKpIds: inheritedByEvent.get(String(row.id)) ?? [],
      eligible: String(row.status ?? "open") !== "dismissed",
      excludeReason: String(row.status ?? "open") === "dismissed" ? "dismissed 错题只保留审计" : null,
    })),
    ...askPoints.map((row) => makeRecord({
      sourceKind: "ask_point",
      sourceId: row.id,
      subject: row.subject,
      title: row.confusion ?? row.raw_question,
      directKpId: rowValue(row, "kpId", "kp_id"),
      eligible: eligibleAsk(row),
      excludeReason: eligibleAsk(row) ? null : `${row.effective_status ?? row.status} 卡点不进入连接债`,
    })),
    ...reciteRecords.map((row) => makeRecord({
      sourceKind: "recite_ledger",
      sourceId: row.id,
      subject: row.subject,
      title: row.title,
      eligible: Boolean(row.subject && (catalog?.items ?? []).some((item) => item.subject === row.subject)),
      excludeReason: row.subject ? "稳定目录不覆盖该科目" : "带背记录缺少科目",
    })),
  ].filter((item) => !subject || item.subject === subject);

  const items = records.map((record) => classifyRecord(record, linkIndex, catalogIds));
  const bySource = {};
  for (const kind of ["error_topic", "study_error", "ask_point", "recite_ledger"]) {
    bySource[kind] = summarize(items.filter((item) => item.sourceKind === kind));
  }
  const actionable = items.filter((item) => ["direct_backfill", "conflict", "confirmed_related_only", "pending_only", "unmapped", "invalid_direct"].includes(item.status));
  const statusPriority = { conflict: 0, invalid_direct: 1, direct_backfill: 2, pending_only: 3, confirmed_related_only: 4, unmapped: 5 };
  const sourcePriority = { ask_point: 0, recite_ledger: 1, error_topic: 2, study_error: 3 };
  actionable.sort((left, right) => (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9)
    || (sourcePriority[left.sourceKind] ?? 9) - (sourcePriority[right.sourceKind] ?? 9)
    || String(left.sourceId).localeCompare(String(right.sourceId), "zh-CN", { numeric: true }));
  return {
    version: "2.0",
    subject,
    counts: summarize(items),
    bySource,
    actionable,
    items,
    policy: {
      autoConfirmed: false,
      directBackfill: "只有来源表已有合法稳定 kp_id 时，才可用 legacy_direct 无推断回填 confirmed primary。",
      candidateBoundary: "文本/Anki/模型相似度只能生成 pending 候选，必须人工核验后才能 confirmed。",
    },
  };
}

export function directMappingBackfillOperations(audit) {
  const anchors = {
    study_error: "study_error.kp_id",
    error_topic: "error_topic.kp_id",
    ask_point: "ask_summary.kp_id",
  };
  return (audit?.items ?? []).filter((item) => item.status === "direct_backfill" && anchors[item.sourceKind]).map((item) => ({
    op: "knowledge_link",
    operation_id: `backfill:direct-v2:${item.sourceKind}:${item.sourceId}:${item.directKpId}`,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
    kpId: item.directKpId,
    role: "primary",
    matchMethod: "legacy_direct",
    linkStatus: "confirmed",
    confidence: 100,
    evidenceAnchor: anchors[item.sourceKind],
    createdBy: "knowledge-direct-backfill[gpt]",
  }));
}

export function buildUnmappedAskLinkRecords(askPoints = [], objectLinks = [], { subject = null, includeHistory = false } = {}) {
  const linkIndex = buildLinkIndex(objectLinks);
  return askPoints.map((row) => {
    const id = String(row.id ?? "");
    const links = linkIndex.get(sourceKey("ask_point", id)) ?? [];
    return {
      sourceKind: "ask_point",
      sourceId: id,
      subject: row.subject ?? null,
      title: row.confusion ?? row.raw_question ?? `答疑卡点 A#${id}`,
      searchText: row.raw_question ?? "",
      searchTerms: [row.question_type, row.step_stuck ? `步骤${row.step_stuck}` : null].filter(Boolean),
      effectiveStatus: row.effective_status ?? row.status ?? "open",
      active: Boolean(row.active),
      createdAt: row.created_at ?? null,
      existingLinks: links,
      directKpId: cleanKpId(rowValue(row, "kpId", "kp_id")),
    };
  }).filter((record) => record.sourceId
    && (!subject || record.subject === subject)
    && !record.directKpId
    && !TERMINAL_ASK_STATUSES.has(record.effectiveStatus)
    && (includeHistory || record.active || record.effectiveStatus === "open")
    && !record.existingLinks.some((link) => link.status === "confirmed"));
}

export function formatKnowledgeMappingAudit(audit, { limit = 20 } = {}) {
  const label = {
    confirmed_primary: "已接主点",
    direct_backfill: "可安全回填",
    inherited_topic: "主题继承",
    confirmed_related_only: "仅关联点",
    pending_only: "待人工确认",
    unmapped: "尚未建链接",
    conflict: "冲突",
    invalid_direct: "坏直连",
    excluded: "明确排除",
  };
  const lines = [
    `知识对象映射审计 v${audit.version}｜${audit.subject ?? "全科"}`,
    `总对象 ${audit.counts.total}｜已接主点 ${audit.counts.confirmed_primary ?? 0}｜主题继承 ${audit.counts.inherited_topic ?? 0}｜可安全回填 ${audit.counts.direct_backfill ?? 0}｜pending ${audit.counts.pending_only ?? 0}｜未映射 ${audit.counts.unmapped ?? 0}｜冲突 ${audit.counts.conflict ?? 0}`,
    "",
  ];
  for (const [kind, counts] of Object.entries(audit.bySource)) {
    lines.push(`${kind}：${counts.total}｜主点 ${counts.confirmed_primary ?? 0}｜继承 ${counts.inherited_topic ?? 0}｜安全回填 ${counts.direct_backfill ?? 0}｜pending ${counts.pending_only ?? 0}｜未映射 ${counts.unmapped ?? 0}｜排除 ${counts.excluded ?? 0}`);
  }
  lines.push("", "优先处理：");
  for (const item of audit.actionable.slice(0, limit)) {
    lines.push(`- ${item.sourceKind}:${item.sourceId} [${item.subject ?? "未分类"}] ${item.title}｜${label[item.status] ?? item.status}｜${item.reason}`);
  }
  if (!audit.actionable.length) lines.push("- 暂无连接债。");
  if (audit.actionable.length > limit) lines.push(`- 另有 ${audit.actionable.length - limit} 条未展示。`);
  lines.push("", `口径：${audit.policy.directBackfill}`, `边界：${audit.policy.candidateBoundary}`);
  return lines.join("\n");
}
