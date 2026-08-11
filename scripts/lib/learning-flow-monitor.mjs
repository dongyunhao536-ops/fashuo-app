// [gpt] 2026-08-11：PC 主系统学习数据流监控只判断可验证的记录、传输与状态迁移，不把低学习量伪装成系统故障。

const SEVERITY_WEIGHT = Object.freeze({ info: 0, warning: 1, error: 2 });

export const DEFAULT_FLOW_THRESHOLDS = Object.freeze({
  localOutboxWarnMinutes: 15,
  localOutboxErrorMinutes: 24 * 60,
  ingestStaleMinutes: 15,
  reviewRequestStaleDays: 3,
  candidateStaleDays: 7,
});

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validTime(value) {
  const timestamp = new Date(value ?? "").getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function ageMinutes(value, nowMs) {
  const timestamp = validTime(value);
  return timestamp == null ? null : Math.max(0, Math.floor((nowMs - timestamp) / 60000));
}

function ageDays(value, nowMs) {
  const minutes = ageMinutes(value, nowMs);
  return minutes == null ? null : Math.floor(minutes / 1440);
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows ?? []) {
    const key = String(row?.[field] ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function mergeIssue(map, issue) {
  const key = String(issue.code);
  const incoming = {
    code: key,
    severity: issue.severity ?? "warning",
    domain: issue.domain ?? "data_flow",
    count: Math.max(1, number(issue.count) || 1),
    message: String(issue.message ?? key),
    examples: [...new Set((issue.examples ?? []).filter(Boolean).map(String))].slice(0, 5),
  };
  const current = map.get(key);
  if (!current) {
    map.set(key, incoming);
    return;
  }
  current.count += incoming.count;
  if (SEVERITY_WEIGHT[incoming.severity] > SEVERITY_WEIGHT[current.severity]) current.severity = incoming.severity;
  current.examples = [...new Set([...current.examples, ...incoming.examples])].slice(0, 5);
}

function groupedIssues(rows, { domain, label }) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const code = String(row.code ?? row.issue_code ?? "unknown_issue");
    const severity = row.severity === "error" ? "error" : row.severity === "info" ? "info" : "warning";
    const key = `${code}|${severity}`;
    const group = groups.get(key) ?? { code, severity, count: 0, examples: [] };
    group.count += 1;
    const entity = row.entity_id ?? row.id ?? (row.line ? `L${row.line}` : null);
    if (entity != null && group.examples.length < 5) group.examples.push(String(entity));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    domain,
    message: `${label}：${group.code} ×${group.count}`,
  }));
}

function oldestAge(rows, field, nowMs, unit) {
  const ages = (rows ?? []).map((row) => unit(row?.[field], nowMs)).filter((value) => value != null);
  return ages.length ? Math.max(...ages) : null;
}

function dateRange(start, end) {
  if (!start || !end || start > end) return [];
  const rows = [];
  for (let cursor = start; cursor <= end; cursor = new Date(new Date(`${cursor}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)) {
    rows.push(cursor);
  }
  return rows;
}

function dailyRecords(facts) {
  const studyLogs = facts.studyLogs ?? [];
  const attempts = facts.attempts ?? [];
  const evidence = facts.knowledgeEvidence ?? [];
  const errorEvents = facts.errorEvents ?? [];
  const reviews = facts.reviews ?? [];
  const ingestHistory = facts.ingestHistory ?? [];
  return dateRange(facts.windowStart, facts.windowEnd).map((date) => ({
    date,
    studyLogs: studyLogs.filter((row) => row.log_date === date).length,
    learningAttempts: attempts.filter((row) => row.attempt_date === date).length,
    knowledgeEvidence: evidence.filter((row) => row.evidence_date === date).length,
    errorEvents: errorEvents.filter((row) => row.log_date === date).length,
    errorReviews: reviews.filter((row) => row.review_date === date).length,
    ingestOperations: ingestHistory.filter((row) => row.beijing_date === date).length,
  }));
}

function actionableIssue(code) {
  const actions = {
    study_log_missing_attempt: "按 operation_id 重试本地 outbox，确认父流水与子尝试在同一次重放中共同成功。",
    study_log_expected_without_operation_id: "修复尝试型 study_log 的生产入口，禁止缺 operation_id 的部分写入。",
    ingest_failed: "先处理失败 ingest 并保留原 operation_id 重试；不要手工补造业务行。",
    ingest_stuck_applying: "检查中断的 ingest，确认业务行后再以同 operation_id 安全重放。",
    ingest_queued_stale: "检查 PC 到数据库的同步链，清理长期 queued 状态。",
    local_outbox_backlog: "运行 outbox pending/sync，逐项核对失败原因；不得直接清空缓冲文件。",
    learning_attempt_missing_projection: "检查 attempt 到 knowledge_evidence 的同事务投影，按原 operation_id 重放。",
    orphan_learning_attempt_projection: "核对孤立知识证据的 source_id，修复引用后再参与能力状态计算。",
    recite_primary_link_ambiguous: "人工确认带背条目的唯一 primary KP，related 只能作辅助链接。",
    recite_evidence_unlinked: "优先给已有复检证据的带背条目补 confirmed primary KP 映射。",
    unclassified_error_event: "把未归类错题事件并入稳定主题；无法确定时保留 pending，不做猜测映射。",
    learning_schedule_overdue: "交由日报/周报重新安排逾期任务；只记学习执行欠账，不触发系统修复。",
    legacy_missing_date: "给仍需执行的旧排期补明确日期；纯历史散文保留为证据，不强行结构化。",
  };
  return actions[code] ?? `核对 ${code} 的事实源与消费者状态，修复后用同口径复跑监控。`;
}

export function evaluateLearningFlow(facts = {}, options = {}) {
  const thresholds = { ...DEFAULT_FLOW_THRESHOLDS, ...(options.thresholds ?? {}) };
  const nowIso = facts.nowIso ?? new Date().toISOString();
  const nowMs = validTime(nowIso) ?? Date.now();
  const issues = new Map();

  for (const issue of groupedIssues(facts.qualityIssues, { domain: "data_integrity", label: "数据库质量视图" })) {
    mergeIssue(issues, issue);
  }
  for (const issue of groupedIssues(facts.schedule?.issues, { domain: "schedule_ledger", label: "复盘排期结构" })) {
    mergeIssue(issues, issue);
  }
  for (const issue of groupedIssues(facts.recite?.issues, { domain: "recite_ledger", label: "带背账本结构" })) {
    mergeIssue(issues, issue);
  }

  if (facts.localOutbox?.parseError) {
    mergeIssue(issues, {
      code: "local_outbox_unreadable",
      severity: "error",
      domain: "transport",
      message: "本地 outbox 无法完整解析；为防丢账必须停止同步并先修复格式。",
    });
  }

  const outboxRows = facts.localOutbox?.operations ?? [];
  const oldestOutboxMinutes = oldestAge(outboxRows, "ts", nowMs, ageMinutes);
  if (outboxRows.length && oldestOutboxMinutes != null) {
    const severity = oldestOutboxMinutes >= thresholds.localOutboxErrorMinutes
      ? "error"
      : oldestOutboxMinutes >= thresholds.localOutboxWarnMinutes ? "warning" : "info";
    mergeIssue(issues, {
      code: "local_outbox_backlog",
      severity,
      domain: "transport",
      count: outboxRows.length,
      message: `本地 outbox 待同步 ${outboxRows.length} 项，最老 ${oldestOutboxMinutes} 分钟。`,
      examples: outboxRows.slice(0, 5).map((row) => row.operation_id),
    });
  }

  const unresolvedIngest = facts.ingestOperations ?? [];
  const failedIngest = unresolvedIngest.filter((row) => row.status === "failed");
  if (failedIngest.length && !issues.has("ingest_failed")) mergeIssue(issues, {
    code: "ingest_failed",
    severity: "error",
    domain: "transport",
    count: failedIngest.length,
    message: `数据库 ingest 失败 ${failedIngest.length} 项。`,
    examples: failedIngest.slice(0, 5).map((row) => row.operation_id),
  });
  for (const status of ["queued", "applying"]) {
    const rows = unresolvedIngest.filter((row) => row.status === status);
    const oldestMinutes = oldestAge(rows, status === "applying" ? "last_attempt_at" : "first_seen_at", nowMs, ageMinutes);
    const code = status === "queued" ? "ingest_queued_stale" : "ingest_stuck_applying";
    if (rows.length && oldestMinutes != null && oldestMinutes >= thresholds.ingestStaleMinutes && !issues.has(code)) {
      mergeIssue(issues, {
        code,
        severity: "warning",
        domain: "transport",
        count: rows.length,
        message: `${status} ingest ${rows.length} 项，最老 ${oldestMinutes} 分钟。`,
        examples: rows.slice(0, 5).map((row) => row.operation_id),
      });
    }
  }

  const pendingEvents = facts.pendingEvents ?? [];
  const knownKpIds = new Set(facts.knownKpIds ?? []);
  const reviewRequests = pendingEvents.filter((row) => row.type === "复验请求");
  const badReviewRequests = reviewRequests.filter((row) => !row.kp_id || !knownKpIds.has(row.kp_id));
  if (badReviewRequests.length) mergeIssue(issues, {
    code: "review_request_invalid_kp",
    severity: "error",
    domain: "workflow_queue",
    count: badReviewRequests.length,
    message: `复验请求有 ${badReviewRequests.length} 项缺少有效 KP 指向，无法被消费者兑现。`,
    examples: badReviewRequests.slice(0, 5).map((row) => row.id),
  });
  const oldestReviewDays = oldestAge(reviewRequests, "created_at", nowMs, ageDays);
  if (reviewRequests.length && oldestReviewDays != null && oldestReviewDays >= thresholds.reviewRequestStaleDays) {
    mergeIssue(issues, {
      code: "review_request_stale",
      severity: "warning",
      domain: "workflow_queue",
      count: reviewRequests.length,
      message: `复验请求最老 ${oldestReviewDays} 天仍未消费。`,
      examples: reviewRequests.slice(0, 5).map((row) => row.id),
    });
  }
  const candidates = pendingEvents.filter((row) => ["弱项候选", "心得候选", "已强化"].includes(row.type));
  const oldestCandidateDays = oldestAge(candidates, "created_at", nowMs, ageDays);
  if (candidates.length && oldestCandidateDays != null && oldestCandidateDays >= thresholds.candidateStaleDays) {
    mergeIssue(issues, {
      code: "candidate_event_stale",
      severity: "warning",
      domain: "workflow_queue",
      count: candidates.length,
      message: `待确认候选最老 ${oldestCandidateDays} 天仍未流转。`,
      examples: candidates.slice(0, 5).map((row) => row.id),
    });
  }

  const expiredAskPoints = (facts.askPoints ?? []).filter((row) => row.effective_status === "expired");
  if (expiredAskPoints.length) mergeIssue(issues, {
    code: "ask_point_expired_open",
    severity: "warning",
    domain: "workflow_queue",
    count: expiredAskPoints.length,
    message: `答疑卡点有 ${expiredAskPoints.length} 项过期后仍保持 open。`,
    examples: expiredAskPoints.slice(0, 5).map((row) => row.id),
  });

  const unclassified = number(facts.errorSummary?.unclassifiedEvents);
  if (unclassified) mergeIssue(issues, {
    code: "unclassified_error_event",
    severity: "warning",
    domain: "classification",
    count: unclassified,
    message: `错题事件有 ${unclassified} 项尚未归入长期主题。`,
  });

  const mapping = facts.reciteMapping?.counts ?? {};
  if (number(mapping.ambiguousLinks)) mergeIssue(issues, {
    code: "recite_primary_link_ambiguous",
    severity: "error",
    domain: "knowledge_mapping",
    count: number(mapping.ambiguousLinks),
    message: `带背条目有 ${mapping.ambiguousLinks} 项存在 primary KP 歧义。`,
  });
  if (number(mapping.evidenceUnlinked)) mergeIssue(issues, {
    code: "recite_evidence_unlinked",
    severity: "warning",
    domain: "knowledge_mapping",
    count: number(mapping.evidenceUnlinked),
    message: `带背条目有 ${mapping.evidenceUnlinked} 项已有证据但尚未接入唯一 primary KP。`,
  });

  if (number(facts.schedule?.counts?.overdue)) mergeIssue(issues, {
    code: "learning_schedule_overdue",
    severity: "warning",
    domain: "learning_execution",
    count: number(facts.schedule.counts.overdue),
    message: `结构化排期有 ${facts.schedule.counts.overdue} 项已逾期未结案；这是学习执行状态，不冒充系统写入故障。`,
  });

  const attempts = facts.attempts ?? [];
  const issueList = [...issues.values()].sort((a, b) => (
    SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
      || b.count - a.count
      || a.code.localeCompare(b.code)
  ));
  const errorCount = issueList.filter((issue) => issue.severity === "error").length;
  const warningCount = issueList.filter((issue) => issue.severity === "warning").length;
  const status = errorCount ? "degraded" : warningCount ? "attention" : "healthy";

  return {
    schemaVersion: 2,
    observedAt: nowIso,
    windowStart: facts.windowStart ?? null,
    windowEnd: facts.windowEnd ?? null,
    status,
    summary: { errors: errorCount, warnings: warningCount, infos: issueList.filter((issue) => issue.severity === "info").length },
    metrics: {
      records: {
        studyLogs: number(facts.studyLogCount),
        studyLogsExpectingAttempts: number(facts.expectedStudyLogCount),
        learningAttempts: number(facts.attemptCount ?? attempts.length),
        validLearningAttempts: number(facts.validAttemptCount ?? attempts.filter((row) => row.result !== "void").length),
        attemptsBySource: countBy(attempts, "source_kind"),
        attemptsByResult: countBy(attempts, "result"),
        reviews: number(facts.reviewCount),
        knowledgeEvidence: number(facts.knowledgeEvidenceCount),
        daily: dailyRecords(facts),
      },
      transport: {
        localOutboxPending: outboxRows.length,
        localOutboxOldestMinutes: oldestOutboxMinutes,
        ingestUnresolvedByStatus: countBy(unresolvedIngest, "status"),
      },
      workflow: {
        pendingEvents: pendingEvents.length,
        pendingEventsByType: countBy(pendingEvents, "type"),
        reviewRequestOldestDays: oldestReviewDays,
        candidateOldestDays: oldestCandidateDays,
        askPointsActive: (facts.askPoints ?? []).filter((row) => row.active).length,
        askPointsExpiredOpen: expiredAskPoints.length,
        activeErrorTopics: number(facts.errorSummary?.activeTopics),
        awaitingColdReviewTopics: number(facts.errorSummary?.awaitingColdReviewTopics),
        unclassifiedErrorEvents: unclassified,
      },
      ledgers: {
        schedule: facts.schedule?.counts ?? {},
        scheduleExecution: facts.scheduleExecution?.counts ?? {},
        recite: facts.recite?.counts ?? {},
      },
      knowledgeMapping: mapping,
    },
    issues: issueList,
  };
}

export function formatLearningFlowReport(report) {
  const statusLabel = { healthy: "健康", attention: "需关注", degraded: "异常" }[report.status] ?? report.status;
  const m = report.metrics;
  const lines = [
    `# 学习数据流监控｜${report.windowStart} ~ ${report.windowEnd}`,
    "",
    `- 判定：**${statusLabel}**（错误 ${report.summary.errors} / 警告 ${report.summary.warnings}）`,
    `- 记录：study_log ${m.records.studyLogs} 条，其中声明尝试 ${m.records.studyLogsExpectingAttempts}；learning_attempt ${m.records.learningAttempts} 条（有效 ${m.records.validLearningAttempts}）`,
    `- 传输：本地 outbox ${m.transport.localOutboxPending} 条；数据库未决 ingest ${Object.values(m.transport.ingestUnresolvedByStatus).reduce((sum, value) => sum + value, 0)} 条`,
    `- 流转：待办 ${m.workflow.pendingEvents} 条；答疑有效 open ${m.workflow.askPointsActive}；未归类错题事件 ${m.workflow.unclassifiedErrorEvents}；待冷检主题 ${m.workflow.awaitingColdReviewTopics}`,
    `- 接线：带背唯一主链接 ${number(m.knowledgeMapping.linked)}/${number(m.knowledgeMapping.items)}；已有证据未接线 ${number(m.knowledgeMapping.evidenceUnlinked)}；primary 歧义 ${number(m.knowledgeMapping.ambiguousLinks)}`,
    "",
    "## 异常与关注项",
    "",
  ];
  if (!report.issues.length) lines.push("- 无。当前只说明已观察到的数据流一致，不推断学习量或掌握度。");
  for (const issue of report.issues) {
    lines.push(`- [${issue.severity}] ${issue.code}｜${issue.message}${issue.examples.length ? `｜例：${issue.examples.join("、")}` : ""}`);
  }
  return lines.join("\n");
}

export function buildWeeklyFlowReview({ flowReport, weekStart, weekEnd }) {
  const weeklyIssues = [...flowReport.issues];
  const status = flowReport.status;
  const daily = flowReport.metrics.records.daily ?? [];
  const activeDays = daily.filter((row) => Object.entries(row).some(([key, value]) => key !== "date" && Number(value) > 0)).length;

  const priorityIssues = weeklyIssues
    .filter((issue) => issue.severity !== "info")
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.count - a.count)
    .slice(0, 3);
  const recommendations = priorityIssues.length
    ? priorityIssues.map((issue) => ({ code: issue.code, action: actionableIssue(issue.code) }))
    : [{ code: "keep_baseline", action: "本周数据流稳定，保持现有口径继续观察；不为制造进化而强行改系统。" }];
  const statusLabel = { healthy: "健康", attention: "需关注", degraded: "异常" }[status] ?? status;
  const reportWithWeeklyIssues = { ...flowReport, status, issues: weeklyIssues };
  const content = [
    `# PC 学习数据流周检｜${weekStart} ~ ${weekEnd}`,
    "",
    `## 判定：${statusLabel}`,
    "",
    `- 数据口径：学习动作发生时实时落账，本监控只在周一分析；本周 7 个北京日中 ${activeDays} 天有结构化记录`,
    `- 周内记录：study_log ${flowReport.metrics.records.studyLogs}；声明尝试 ${flowReport.metrics.records.studyLogsExpectingAttempts}；learning_attempt ${flowReport.metrics.records.learningAttempts}`,
    `- 周末状态：本地 outbox ${flowReport.metrics.transport.localOutboxPending}；未决 ingest ${Object.values(flowReport.metrics.transport.ingestUnresolvedByStatus).reduce((sum, value) => sum + value, 0)}；未归类错题事件 ${flowReport.metrics.workflow.unclassifiedErrorEvents}`,
    "",
    "## 每日记录",
    "",
    "| 北京日 | 学习流水 | 尝试 | 知识证据 | 错题事件 | 复检 | ingest |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...daily.map((row) => `| ${row.date} | ${row.studyLogs} | ${row.learningAttempts} | ${row.knowledgeEvidence} | ${row.errorEvents} | ${row.errorReviews} | ${row.ingestOperations} |`),
    "",
    "## 下周系统动作",
    "",
    ...recommendations.map((item, index) => `${index + 1}. ${item.action}（${item.code}）`),
    "",
    "## 证据",
    "",
    formatLearningFlowReport(reportWithWeeklyIssues),
  ].join("\n");

  return {
    schemaVersion: 2,
    weekStart,
    weekEnd,
    status,
    activeDays,
    dailyRecords: daily,
    recommendations,
    flowReport,
    content,
  };
}
