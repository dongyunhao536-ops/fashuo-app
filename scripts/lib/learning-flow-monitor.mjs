// [gpt] 2026-08-11：PC 主系统学习数据流监控只判断可验证的记录、传输与状态迁移，不把低学习量伪装成系统故障。

const SEVERITY_WEIGHT = Object.freeze({ info: 0, warning: 1, error: 2 });

export const DEFAULT_FLOW_THRESHOLDS = Object.freeze({
  localOutboxWarnMinutes: 15,
  localOutboxErrorMinutes: 24 * 60,
  ingestStaleMinutes: 15,
  reviewRequestStaleDays: 3,
  candidateStaleDays: 7,
  skillRunStaleMinutes: 24 * 60,
  skillStartupWarnMs: 5000,
  skillTurnUncheckedMinutes: 60,
  // [gpt] 2026-08-17：英语阅读的答案键与长难句互动若间隔超过一天，说明教学尾段被事后补签而非同场完成；只告警不阻断。
  readingLongSentenceWarnMinutes: 24 * 60,
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
    skill_run_telemetry_unreadable: "修复 Skill Run JSONL 的结构错误；不要删除损坏行来伪造连续审计。",
    skill_run_stale: "打开对应 run 状态，确认是继续、handoff 还是 aborted；不得把未收口运行伪装成完成。",
    skill_waiting_orphaned: "核对孤儿 waiting_user 的真实会话去向；继续时显式恢复原 Run，不再继续时按事实 aborted，禁止直接改监控数字。",
    skill_gate_failed: "按 run 的 missing 步骤补真实工具回执后重跑硬闸；不要手工签自动步骤。",
    daibei_phase_kind_mismatch: "按用户真实意图重建正确 Run：progress 只按 progress 收口，recall 必须进入 question/result，禁止用 plan 降级。",
    daibei_post_progress_probe_missing: "自背进度已落账但未进入首道抽查；不要重复写流水，直接按当轮标准启动 question Run。",
    skill_startup_slow: "下钻各 Skill 的 context_loaded 耗时，优先合并重复读取或缩短非必要上下文。",
    skill_turn_guard_unreadable: "修复 Codex Skill 宿主守卫 JSONL；不要删除坏行来制造合规。",
    skill_turn_guard_error: "按 guardErrors 的 producerHost/hookEventName/failureCode 修复载荷或脚本；守卫 fail-open 期间不把覆盖记为正常。",
    skill_turn_unchecked: "检查 hook 是否已信任且正常触发；未经过 Stop 审计的命中请求不能算已覆盖。",
    skill_turn_noncompliant: "按 session/turn 打开对应 Run；缺 Run 就补完整 Skill，未收口就完成硬闸，不得只改监控记录。",
    skill_turn_guard_unobserved: "按 producerHost 检查对应宿主观察器：Codex 核对 /hooks 信任，Claude 核对项目 Hook 与身份注入；未观测前不得声称覆盖已启用。",
    skill_guard_not_invoked: "按 producerHost/sessionId/turnId 核对为何已有学习 Run 却没有 prompt_routed；先恢复宿主观察器，再继续该路径。",
    english_long_sentence_delay: "核对英语阅读 Run 中 answer_key_checked 到 long_sentence_reviewed 的时间间隔；同场讲解应紧跟判分，超过阈值说明教学尾段可能被事后补做，需回到原篇完成长难句互动后再收口。",
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
  for (const issue of groupedIssues(facts.skillExecution?.issues, { domain: "skill_execution", label: "Skill Run 遥测" })) {
    mergeIssue(issues, issue);
  }
  for (const issue of groupedIssues(facts.skillTurnCoverage?.issues, { domain: "skill_execution", label: "Skill 宿主守卫" })) {
    mergeIssue(issues, issue.code === "skill_turn_telemetry_unreadable" ? { ...issue, code: "skill_turn_guard_unreadable" } : issue);
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

  const skillExecution = facts.skillExecution ?? { counts: {}, startupLatencyMs: {}, bySkill: {} };
  if (number(skillExecution.counts?.stale)) mergeIssue(issues, {
    code: "skill_run_stale",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.counts.stale),
    message: `Skill Run 有 ${skillExecution.counts.stale} 项超过 ${thresholds.skillRunStaleMinutes} 分钟仍未显式收口。`,
    examples: (skillExecution.staleRuns ?? []).slice(0, 5).map((item) => `${item.runId}:${item.skill}`),
  });
  if (number(skillExecution.counts?.orphanedWaiting)) mergeIssue(issues, {
    code: "skill_waiting_orphaned",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.counts.orphanedWaiting),
    message: `Skill Run 有 ${skillExecution.counts.orphanedWaiting} 项 waiting_user 超过 ${thresholds.skillRunStaleMinutes} 分钟未收到续接证据；已纳入完整率分母但保留可恢复状态。`,
    examples: (skillExecution.orphanedWaitingRuns ?? []).slice(0, 5).map((item) => `${item.runId}:${item.skill}`),
  });
  if (number(skillExecution.counts?.gateFailures)) mergeIssue(issues, {
    code: "skill_gate_failed",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.counts.gateFailures),
    message: `Skill 执行硬闸在窗口内阻断 ${skillExecution.counts.gateFailures} 次；阻断本身是保护，但重复命中说明流程仍在漏步。`,
    examples: (skillExecution.gateFailureExamples ?? []).slice(0, 5).map((item) => `${item.runId}:${item.phase ?? item.step ?? "?"}`),
  });
  // [gpt] 2026-08-21：业务写入成功不能掩盖带背阶段错配或“记完即停”的用户路径断链。
  if (number(skillExecution.counts?.daibeiPhaseKindMismatches)) mergeIssue(issues, {
    code: "daibei_phase_kind_mismatch",
    severity: "error",
    domain: "skill_execution",
    count: number(skillExecution.counts.daibeiPhaseKindMismatches),
    message: `带背有 ${skillExecution.counts.daibeiPhaseKindMismatches} 个 Run 的 kind 与结束 phase 不一致，不能计为干净收口。`,
    examples: (skillExecution.daibeiPhaseKindMismatchExamples ?? []).slice(0, 5).map((item) => `${item.runId}:${item.kind}->${item.phase}`),
  });
  if (number(skillExecution.counts?.daibeiPostProgressProbeMissing)) mergeIssue(issues, {
    code: "daibei_post_progress_probe_missing",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.counts.daibeiPostProgressProbeMissing),
    message: `带背有 ${skillExecution.counts.daibeiPostProgressProbeMissing} 次自背进度落账后超过宽限期仍未进入首道抽查。`,
    examples: (skillExecution.daibeiPostProgressProbeMissingExamples ?? []).slice(0, 5).map((item) => `${item.runId}:${item.subject}/${item.targetRef}`),
  });
  if (number(skillExecution.counts?.invalidHandoffs)) mergeIssue(issues, {
    code: "skill_handoff_invalid",
    severity: "error",
    domain: "skill_execution",
    count: number(skillExecution.counts.invalidHandoffs),
    message: `Skill 有 ${skillExecution.counts.invalidHandoffs} 次 handoff 缺目标或可核对原因。`,
  });
  if (number(skillExecution.counts?.unresolvedHandoffs)) mergeIssue(issues, {
    code: "skill_handoff_unresolved",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.counts.unresolvedHandoffs),
    message: `Skill 有 ${skillExecution.counts.unresolvedHandoffs} 次已转手但目标 Run 未启动，跨 Skill 闭环断链。`,
    examples: (skillExecution.unresolvedHandoffExamples ?? []).slice(0, 5).map((item) => `${item.runId}:${item.skill}->${item.handoffSkill}`),
  });
  if (number(skillExecution.startupLatencyMs?.p95) > thresholds.skillStartupWarnMs) mergeIssue(issues, {
    code: "skill_startup_slow",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillExecution.startupLatencyMs.samples),
    message: `Skill 启动快照 p95 ${skillExecution.startupLatencyMs.p95}ms，超过 ${thresholds.skillStartupWarnMs}ms 阈值。`,
  });
  const englishLongSentenceDelays = (skillExecution.englishLongSentenceDelays ?? []).filter((item) => (
    item.delayMinutes != null && item.delayMinutes >= thresholds.readingLongSentenceWarnMinutes
  ));
  if (englishLongSentenceDelays.length) mergeIssue(issues, {
    code: "english_long_sentence_delay",
    severity: "warning",
    domain: "skill_execution",
    count: englishLongSentenceDelays.length,
    message: `英语阅读有 ${englishLongSentenceDelays.length} 场的答案键到长难句讲解间隔超过 ${thresholds.readingLongSentenceWarnMinutes} 分钟，教学尾段可能被事后补签而非同场完成。`,
    examples: englishLongSentenceDelays.slice(0, 5).map((item) => `${item.runId}:${item.delayMinutes}m`),
  });
  const skillTurnCoverage = facts.skillTurnCoverage ?? { counts: {}, compliance: {}, failuresByCode: {} };
  if (skillTurnCoverage.coverage?.state === "unobserved") mergeIssue(issues, {
    code: "skill_turn_guard_unobserved",
    severity: "warning",
    domain: "skill_execution",
    message: "当前窗口未观察到任何宿主 Hook 事件；Skill 覆盖尚不能确认已生效。",
  });
  if (number(skillTurnCoverage.counts?.guardNotInvoked)) mergeIssue(issues, {
    code: "skill_guard_not_invoked",
    severity: "error",
    domain: "skill_execution",
    count: number(skillTurnCoverage.counts.guardNotInvoked),
    message: `有 ${skillTurnCoverage.counts.guardNotInvoked} 个学习 Run 已启动但同一宿主/session/turn 没有 prompt_routed，观察器可能整段未调用。`,
    examples: (skillTurnCoverage.guardNotInvokedRuns ?? []).slice(0, 5).map((item) => `${item.producerHost}:${item.runId}/${item.skill}`),
  });
  if (number(skillTurnCoverage.counts?.guardErrors)) mergeIssue(issues, {
    code: "skill_turn_guard_error",
    severity: "error",
    domain: "skill_execution",
    count: number(skillTurnCoverage.counts.guardErrors),
    message: `宿主守卫进程已启动但内部失败 ${skillTurnCoverage.counts.guardErrors} 次；会话已 fail-open，不能把它算作已审计。`,
    examples: (skillTurnCoverage.guardErrors ?? []).slice(0, 5).map((item) => `${item.producerHost}:${item.hookEventName}/${item.failureCode}`),
  });
  if (number(skillTurnCoverage.counts?.unchecked)) mergeIssue(issues, {
    code: "skill_turn_unchecked",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillTurnCoverage.counts.unchecked),
    message: `Skill 宿主守卫有 ${skillTurnCoverage.counts.unchecked} 个已路由请求超过 ${thresholds.skillTurnUncheckedMinutes} 分钟仍无 Stop 审计。`,
    examples: (skillTurnCoverage.examples ?? []).filter((item) => item.failureCode === "unchecked").slice(0, 5).map((item) => `${item.turnId}:${item.expectedSkill}`),
  });
  if (number(skillTurnCoverage.counts?.failed)) mergeIssue(issues, {
    code: "skill_turn_noncompliant",
    severity: "warning",
    domain: "skill_execution",
    count: number(skillTurnCoverage.counts.failed),
    message: `Skill 宿主守卫有 ${skillTurnCoverage.counts.failed} 个命中请求在一次自动续跑后仍无合规 Run。`,
    examples: (skillTurnCoverage.examples ?? []).filter((item) => item.failureCode !== "unchecked").slice(0, 5).map((item) => `${item.turnId}:${item.expectedSkill}/${item.failureCode}`),
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
      skillExecution,
      skillTurnCoverage,
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
    `- Skill：启动 ${number(m.skillExecution.counts?.runs)} / 干净收口 ${number(m.skillExecution.compliance?.closedCleanly)} / 原始完整率 ${m.skillExecution.compliance?.rawRate ?? "—"}% / 活跃 ${number(m.skillExecution.counts?.active)}（孤儿等待 ${number(m.skillExecution.counts?.orphanedWaiting)}） / 过期未收口 ${number(m.skillExecution.counts?.stale)}；启动 p50/p95 ${m.skillExecution.startupLatencyMs?.p50 ?? "—"}/${m.skillExecution.startupLatencyMs?.p95 ?? "—"}ms`,
    `- Skill 宿主：覆盖 ${m.skillTurnCoverage.coverage?.state === "observed" ? "已观测" : "未观测"}；命中 ${number(m.skillTurnCoverage.counts?.routed)} / 已审 ${number(m.skillTurnCoverage.counts?.checked)} / 自动保护 ${number(m.skillTurnCoverage.counts?.protected)} / 最终失败 ${number(m.skillTurnCoverage.counts?.failed)} / 漏审 ${number(m.skillTurnCoverage.counts?.unchecked)}；合规率 ${m.skillTurnCoverage.compliance?.rate ?? "—"}%；Prompt→Stop p50/p95 ${m.skillTurnCoverage.turnLatencyMs?.p50 ?? "—"}/${m.skillTurnCoverage.turnLatencyMs?.p95 ?? "—"}ms`,
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
