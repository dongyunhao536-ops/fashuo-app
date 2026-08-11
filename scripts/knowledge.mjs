// [gpt] 2026-08-10：知识点事实层 v3 CLI；关系/证据写入先落可靠 outbox，再同步。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildUnmappedErrorLinkRecords,
  buildKnowledgeCatalog,
  loadAnkiExtract,
  searchKnowledgeCatalog,
  suggestKnowledgeLinks,
  suggestReciteKnowledgeLinks,
} from "./lib/knowledge-catalog.mjs";
import {
  buildFailurePortrait,
  buildKnowledgePointStates,
  FAILURE_PATTERNS,
  formatFailurePortrait,
  KNOWLEDGE_DIMENSIONS,
  reciteEvidenceFromLinks,
} from "./lib/knowledge-state.mjs";
import {
  buildKnowledgeGraph,
  formatKnowledgeGraph,
  KNOWLEDGE_RELATION_SOURCES,
  KNOWLEDGE_RELATION_STATUSES,
  KNOWLEDGE_RELATION_TYPES,
  PREREQUISITE_STAGES,
  wouldCreatePrerequisiteCycle,
} from "./lib/knowledge-graph.mjs";
import {
  buildPersonalKnowledgeContext,
  formatPersonalKnowledgeContext,
} from "./lib/knowledge-context.mjs";
import {
  buildKnowledgeMappingAudit,
  buildUnmappedAskLinkRecords,
  directMappingBackfillOperations,
  formatKnowledgeMappingAudit,
} from "./lib/knowledge-mapping.mjs";
import { buildExamLossForecast, formatExamLossForecast } from "./lib/knowledge-forecast.mjs";
import { ASSESSMENT_CONTEXTS, EVIDENCE_VARIANTS, normalizeTransferMetadata } from "./lib/evidence-transfer.mjs";
import { buildReciteMemoryModel } from "./lib/learning-coach.mjs";
import { beijingDate, parseReciteLedger } from "./lib/recite-ledger.mjs";
import { assertScheduleLink, closeScheduleItem } from "./lib/schedule-store.mjs";
import { appendOutbox, readOutbox, syncStudyOutbox } from "./lib/study-outbox.mjs";
import { normalizeLearningAttempt } from "./lib/learning-attempt.mjs";

const OUTBOX = ".local/cuoti-pending.jsonl";
const LINK_KINDS = ["study_error", "error_topic", "error_review", "recite_ledger", "ask_point", "study_log", "manual"];
const LINK_METHODS = ["manual", "legacy_direct", "exact_name", "anki_exact", "anki_section", "fuzzy"];
const LINK_STATUSES = ["pending", "confirmed", "rejected"];
const RESULTS = ["pass", "partial", "fail", "void"];

let database = null;

function db() {
  if (database) return database;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  database = createClient(url, key, { auth: { persistSession: false } });
  return database;
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (args[index + 1] && !args[index + 1].startsWith("--")) options[name] = args[++index];
    else options[name] = true;
  }
  return { positional, options };
}

function positiveInteger(value, fallback, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label}必须是正整数`);
  return number;
}

function confidence(value, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error("--confidence 必须是 0-100 整数");
  return number;
}

function oneOf(value, choices, label) {
  const clean = String(value ?? "");
  if (!choices.includes(clean)) throw new Error(`${label}不合法：${clean || "空"}；可用 ${choices.join("/")}`);
  return clean;
}

function booleanOption(options, key) {
  const value = options[key];
  if (value == null) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} 只接受 true 或 false`);
}

function uniqueKpIds(values) {
  const normalized = values.map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean);
  const invalid = normalized.find((value) => !/^[A-Z]{2,4}-\d{4}$/.test(value));
  if (invalid) throw new Error(`KP-ID 不合法：${invalid}`);
  return [...new Set(normalized)];
}

async function fetchAll(table, columns, order = "id", pageSize = 500) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const response = await db().from(table).select(columns).order(order).range(from, from + pageSize - 1);
    if (response.error) throw new Error(`${table} 读取失败：${response.error.message}`);
    rows.push(...(response.data ?? []));
    if (!response.data || response.data.length < pageSize) break;
  }
  return rows;
}

async function fetchAllWithMissingColumnFallback(table, columns, fallbackColumns, missingColumn, order = "id") {
  try {
    return await fetchAll(table, columns, order);
  } catch (error) {
    // [gpt] 2026-08-10：读路径兼容代码先上线、可选证据列后迁移的短暂窗口；
    // 只对精确缺列错误降级，其他数据库错误继续硬失败。
    const message = String(error?.message ?? error);
    if (!message.includes(`column ${table}.${missingColumn} does not exist`)) throw error;
    return fetchAll(table, fallbackColumns, order);
  }
}

async function countRows(table) {
  const response = await db().from(table).select("id", { count: "exact" }).limit(1);
  if (response.error) throw new Error(`${table} 计数失败：${response.error.message}`);
  return response.count ?? 0;
}

async function loadCatalog() {
  const rows = await fetchAll(
    "knowledge_point_v2",
    "kp_id, subject, parent_kp, name, page, src_line, kaofa, zhenti_freq, zhenti_years, keypoints, anki_note_ids, anki_match_level, state_authority, legacy_mastery_ignored, catalog_updated_at",
    "kp_id",
  );
  const anki = loadAnkiExtract();
  return { catalog: buildKnowledgeCatalog(rows, anki.notes), anki };
}

async function loadRuntime(referenceDate, examDate = null, { includePersonalContext = false } = {}) {
  const errorColumns = includePersonalContext
    ? "study_error_id, operation_id, log_date, event_subject, event_kp_id, knowledge, raw_input, source, event_status, absorbed_at, role, root_cause_code, root_cause_note, failure_pattern_code, diagnosis_status, evidence_anchor, topic_id, topic_subject, topic_kp_id, topic_title, classification_status, mastery_status"
    : "study_error_id, log_date, event_subject, event_kp_id, event_status, role, root_cause_code, failure_pattern_code, diagnosis_status, evidence_anchor, topic_id, topic_subject, topic_kp_id, topic_title";
  const [{ catalog, anki }, evidence, links, relations, errorRows, askPoints] = await Promise.all([
    loadCatalog(),
    fetchAllWithMissingColumnFallback(
      "knowledge_evidence",
      "id, operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id, cold, prompt_integrity, failure_pattern_code, diagnosis_status, variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds, evidence_anchor, note, created_at",
      "id, operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id, cold, prompt_integrity, failure_pattern_code, diagnosis_status, variant_kind, transfer_level, assessment_context, duration_seconds, evidence_anchor, note, created_at",
      "probe_axis",
    ),
    fetchAll("knowledge_object_link", "id, operation_id, source_kind, source_id, kp_id, role, match_method, link_status, confidence, evidence_anchor, created_by, created_at, updated_at"),
    fetchAll("knowledge_relation", "id, operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage, strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by, created_at, updated_at"),
    fetchAll("error_book_v2", errorColumns, "study_error_id"),
    includePersonalContext
      ? fetchAll("ask_point_v2", "id, operation_id, subject, kp_id, question_type, step_stuck, confusion, status, effective_status, active, ttl_until, source, raw_question, evidence_anchor, created_at, updated_at, resolved_at, resolution_note")
      : Promise.resolve([]),
  ]);
  let reciteMemory = buildReciteMemoryModel({ records: [] }, referenceDate, { objectLinks: links });
  let reciteEvidence = [];
  if (existsSync(".local/带背挂账.md")) {
    const parsed = parseReciteLedger(readFileSync(".local/带背挂账.md", "utf8"), { referenceDate });
    reciteMemory = buildReciteMemoryModel(parsed, referenceDate, { objectLinks: links });
    reciteEvidence = reciteEvidenceFromLinks(reciteMemory, links);
  }
  const allEvidence = [...evidence, ...reciteEvidence];
  const states = buildKnowledgePointStates({ catalog, evidence: allEvidence, objectLinks: links, referenceDate, examDate });
  const graph = buildKnowledgeGraph({ catalog, relations, knowledgeStates: states });
  const portrait = buildFailurePortrait({ errorRows, knowledgeEvidence: allEvidence, objectLinks: links, catalog });
  return { catalog, anki, evidence, allEvidence, reciteMemory, reciteEvidence, links, relations, errorRows, askPoints, states, graph, portrait };
}

function cardLine(point) {
  const mode = point.anki.matchLevel === "exact" ? "精确" : point.anki.matchLevel === "section" ? "章节参考" : "无映射";
  const cards = point.anki.references.map((item) => `${item.noteId}${item.title ? `「${item.title.slice(0, 50)}」` : ""}`).join("；") || "无";
  return `Anki：${mode}｜note ${cards}｜仅作材料/重要度参考，不计掌握`;
}

function stateLine(item) {
  const history = item.decayedFrom ? `（历史 ${item.demonstratedStageLabel}）` : "";
  const examReady = item.examReadiness.achieved ? `考试就绪/${item.examReadiness.confidence}` : "考试未就绪";
  return `${item.kpId} [${item.subject}] ${item.name ?? "未命名"}｜今天 ${item.stageLabel}${history}｜${examReady}｜衰减指数 ${item.decay.retentionIndex}｜风险 ${item.riskScore}｜重要度 ${item.importanceScore}｜证据 ${item.evidenceCount}｜到期 ${item.dueDate ?? "未激活"}`;
}

async function syncOutbox(today) {
  const report = await syncStudyOutbox({ db: db(), path: OUTBOX, today });
  if (report.failed.length) {
    console.error(`⚠️ ${report.failed.length} 条同步失败，已保留 outbox：`);
    for (const item of report.failed) console.error(`- ${item.op.operation_id}：${item.error}`);
    return false;
  }
  console.log(`✅ 同步成功 ${report.succeeded.length} 条；outbox 已安全清空成功项。`);
  return true;
}

async function commandStats(options) {
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const [runtime, attemptCount] = await Promise.all([
    loadRuntime(referenceDate, options.exam === true ? null : options.exam),
    countRows("learning_attempt"),
  ]);
  const summary = {
    referenceDate,
    catalog: runtime.catalog.counts,
    anki: { available: runtime.anki.available, path: runtime.anki.path, notes: runtime.anki.notes.length, issue: runtime.anki.issue },
    evidence: { database: runtime.evidence.length, reciteDerived: runtime.reciteEvidence.length },
    attempts: attemptCount,
    // [gpt] 2026-08-10：显式公开接线债；候选仍需人工确认，stats 不自动改映射。
    reciteMapping: { ...runtime.reciteMemory.counts, debtPreview: runtime.reciteMemory.linkDebt.slice(0, 10) },
    links: runtime.links.length,
    graph: runtime.graph.counts,
    states: runtime.states.counts,
    failurePortrait: runtime.portrait.counts,
  };
  console.log(options.json ? JSON.stringify(summary, null, 2) : [
    `知识点事实层（北京 ${referenceDate}）`,
    `目录 ${summary.catalog.total}：Anki 精确 ${summary.catalog.ankiExact} / 章节参考 ${summary.catalog.ankiSection} / 无卡 ${summary.catalog.ankiUnlinked}`,
    `尝试分母 ${summary.attempts}；证据 DB ${summary.evidence.database} + 带背实时派生 ${summary.evidence.reciteDerived}；确认映射 ${runtime.links.filter((row) => row.link_status === "confirmed").length}/${runtime.links.length}`,
    `带背接线：唯一主链接 ${summary.reciteMapping.linked}/${summary.reciteMapping.items} / 零链接 ${summary.reciteMapping.unlinked} / 主链接歧义 ${summary.reciteMapping.ambiguousLinks}（未接入且有证据 ${summary.reciteMapping.evidenceUnlinked}、在挂 ${summary.reciteMapping.actionableUnlinked}）/ 多链接记录 ${summary.reciteMapping.multiLinked}`,
    `状态：激活 ${summary.states.activated} / 可派单 ${summary.states.dispatchEligible} / 时间衰减 ${summary.states.decayed} / 衰减到期 ${summary.states.dueByDecay} / 稳定 ${summary.states.activatedByStage.stable} / 考试就绪 ${summary.states.examReady} / 冲刺通道 ${summary.states.sprintLane}`,
    `图谱：确认前置 ${summary.graph.confirmedPrerequisites} / 涉及知识点 ${summary.graph.involvedKnowledgePoints} / 活跃目标受阻 ${summary.graph.activeBlockedTargets} / 根阻塞 ${summary.graph.rootBlockers} / 环 ${summary.graph.cycles}`,
    `栽点：知识点级确认/观察 ${summary.failurePortrait.activeConfirmed} / 待认领 ${summary.failurePortrait.pending} / 已退役 ${summary.failurePortrait.retired}；科目级确认 ${summary.failurePortrait.subjectActiveConfirmed} / 习惯性 ${summary.failurePortrait.habitual} / 待映射证据 ${summary.failurePortrait.unmatchedEvidence}`,
  ].join("\n"));
}

async function commandSearch(positional, options) {
  const query = positional.join(" ").trim();
  if (!query) throw new Error("search 需要关键词或 kp_id");
  const { catalog } = await loadCatalog();
  const matches = searchKnowledgeCatalog(catalog, query, {
    subject: options.subject === true ? null : options.subject,
    limit: positiveInteger(options.limit, 10, "--limit"),
  });
  if (options.json) return console.log(JSON.stringify(matches, null, 2));
  if (!matches.length) return console.log("没有候选。");
  console.log(matches.map(({ item, matchScore }) => `${item.kpId} [${item.subject}] ${item.name ?? "未命名"}｜匹配 ${matchScore}｜重要度 ${item.importanceScore}｜Anki ${item.anki.matchLevel ?? "无"}`).join("\n"));
}

async function commandShow(positional, options) {
  const kpId = String(positional[0] ?? "").toUpperCase();
  if (!kpId) throw new Error("show 需要 kp_id");
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const runtime = await loadRuntime(referenceDate, options.exam === true ? null : options.exam);
  const point = runtime.catalog.items.find((item) => item.kpId === kpId);
  const state = runtime.states.items.find((item) => item.kpId === kpId);
  const portrait = runtime.portrait.byKnowledgePoint.find((item) => item.kpId === kpId) ?? null;
  const graphNode = runtime.graph.byKnowledgePoint.find((item) => item.kpId === kpId) ?? null;
  if (!point || !state) throw new Error(`知识点不存在：${kpId}`);
  if (options.json) return console.log(JSON.stringify({ point, state, graph: graphNode, portrait }, null, 2));
  console.log([
    stateLine(state),
    `父级：${point.parentKp ?? "无"}｜真题频率 ${point.zhentiFrequency ?? "未标"}｜真题年份 ${point.zhentiYears.join("/") || "无"}`,
    cardLine(point),
    `四维（今天）：理解 ${state.dimensions.understanding.current ? "可依赖" : "不足"}(${state.dimensions.understanding.retentionIndex}) / 复述 ${state.dimensions.recall.current ? "可依赖" : "不足"}(${state.dimensions.recall.retentionIndex}) / 应用 ${state.dimensions.application.current ? "可依赖" : "不足"}(${state.dimensions.application.retentionIndex}) / 稳定 ${state.stability.achieved ? "是" : state.stability.everAchieved ? "历史达到、今天已回落" : "否"}`,
    `考试就绪：${state.examReadiness.achieved ? `是（${state.examReadiness.confidence}）` : "否"}｜L4 冷通过 ${state.examReadiness.highTransferPasses} 次/${state.examReadiness.highTransferDates.length} 天｜限时 ${state.examReadiness.timedPasses}｜成套模考 ${state.examReadiness.fullMockPasses}`,
    graphNode?.directPrerequisites?.length
      ? `前置：${graphNode.directPrerequisites.map((item) => `${item.kpId}须${item.requiredStage}/当前${item.currentStage}${item.meets ? "✓" : "✗"}`).join("；")}`
      : "前置：暂无已确认关系",
    `下一步：${state.nextAction}`,
    portrait?.primaryPattern ? `栽点：${portrait.primaryPattern.statement}` : "栽点：暂无细粒度证据",
  ].join("\n"));
}

async function commandSuggestRecite(options) {
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  if (!existsSync(".local/带背挂账.md")) throw new Error("缺少 .local/带背挂账.md");
  const parsed = parseReciteLedger(readFileSync(".local/带背挂账.md", "utf8"), { referenceDate });
  const [{ catalog }, links] = await Promise.all([
    loadCatalog(),
    fetchAll("knowledge_object_link", "source_kind, source_id, role, link_status"),
  ]);
  const linkedPrimary = new Set(links.filter((row) => row.source_kind === "recite_ledger" && row.role === "primary" && row.link_status === "confirmed").map((row) => String(row.source_id)));
  // [gpt] 2026-08-10：默认只列尚无 confirmed primary 的接线债；--all 才回看已接线记录。
  const records = options.all ? parsed.records : parsed.records.filter((row) => !linkedPrimary.has(String(row.id)));
  let suggestions = suggestReciteKnowledgeLinks(records, catalog, { limitPerRecord: positiveInteger(options.limit, 3, "--limit") });
  if (options.active) suggestions = suggestions.filter((item) => parsed.records.find((row) => row.id === item.sourceId)?.status === "active");
  const minimum = options.min == null || options.min === true ? 0 : Number(options.min);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error("--min 必须是 0-100");
  suggestions = suggestions.map((item) => ({ ...item, candidates: item.candidates.filter((candidate) => candidate.confidence >= minimum) }));
  if (options.matched) suggestions = suggestions.filter((item) => item.candidates.length);
  if (options.json) return console.log(JSON.stringify(suggestions, null, 2));
  console.log(suggestions.map((item) => {
    const candidates = item.candidates.map((candidate) => `${candidate.kpId} ${candidate.name ?? "?"}(${candidate.confidence}%,${candidate.matchMethod},Anki=${candidate.ankiMatchLevel ?? "无"})`).join("；") || "无候选";
    return `${item.sourceId} [${item.subject}] ${item.title}\n  → ${candidates}`;
  }).join("\n"));
}

async function commandSuggestTopics(options) {
  const [topics, { catalog }] = await Promise.all([
    fetchAll("error_topic", "id, subject, title, chapter, section, kp_id, classification_status, mastery_status"),
    loadCatalog(),
  ]);
  const unmapped = options.all ? topics : topics.filter((item) => !item.kp_id);
  let suggestions = suggestReciteKnowledgeLinks(unmapped.map((item) => ({ id: String(item.id), subject: item.subject, title: item.title })), catalog, {
    limitPerRecord: positiveInteger(options.limit, 3, "--limit"),
  }).map((item) => ({ ...item, sourceKind: "error_topic" }));
  const minimum = options.min == null || options.min === true ? 0 : Number(options.min);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error("--min 必须是 0-100");
  suggestions = suggestions.map((item) => ({ ...item, candidates: item.candidates.filter((candidate) => candidate.confidence >= minimum) }));
  if (options.matched) suggestions = suggestions.filter((item) => item.candidates.length);
  if (options.json) return console.log(JSON.stringify(suggestions, null, 2));
  console.log(suggestions.map((item) => {
    const candidates = item.candidates.map((candidate) => `${candidate.kpId} ${candidate.name ?? "?"}(${candidate.confidence}%,${candidate.matchMethod},Anki=${candidate.ankiMatchLevel ?? "无"})`).join("；") || "无候选";
    return `T#${item.sourceId} [${item.subject}] ${item.title}\n  → ${candidates}`;
  }).join("\n") || "没有候选。");
}

function candidateDecisionLabel(status) {
  return {
    catalog_unsupported: "目录不覆盖",
    keep_unmapped: "明确保留未映射",
    no_candidate: "暂无候选",
    ambiguous: "多候选待核",
    strong_candidate: "强候选待核",
    manual_review: "需人工核对",
    weak_only: "仅弱相似",
  }[status] ?? status;
}

function candidateTierLabel(tier) {
  return { strong: "强候选", review: "核对候选", weak: "弱相似" }[tier] ?? tier;
}

// [gpt] 2026-08-10：只读展示仍未映射的错题栽点候选；候选分不等于正确率，绝不自动写 confirmed。
async function commandSuggestErrors(positional, options) {
  const subject = positional.join(" ").trim() || null;
  const recordLimit = positiveInteger(options.limit, 20, "--limit");
  const candidateLimit = positiveInteger(options.candidates, 3, "--candidates");
  const minimum = options.min == null || options.min === true ? 65 : Number(options.min);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error("--min 必须是 0-100");
  const [errorRows, links, { catalog }] = await Promise.all([
    fetchAll(
      "error_book_v2",
      "study_error_id, log_date, event_subject, event_kp_id, knowledge, topic_id, topic_subject, topic_kp_id, topic_title, chapter, section, failure_pattern_code, diagnosis_status, evidence_anchor",
      "study_error_id",
    ),
    fetchAll(
      "knowledge_object_link",
      "id, source_kind, source_id, kp_id, role, match_method, link_status, confidence, evidence_anchor",
    ),
    loadCatalog(),
  ]);
  const records = buildUnmappedErrorLinkRecords(errorRows, links, { subject });
  const shownRecords = records.slice(0, recordLimit);
  const suggestions = suggestKnowledgeLinks(shownRecords, catalog, {
    limitPerRecord: candidateLimit,
    minConfidence: minimum,
  });
  const summary = {
    subject,
    unmatchedObjects: records.length,
    shownObjects: suggestions.length,
    unmatchedEvidence: records.reduce((sum, record) => sum + record.evidence.length, 0),
    minimumConfidence: minimum,
    policy: "只读候选；相似度不是正确率；任何候选都必须人工核对后显式 confirmed",
  };
  if (options.json) return console.log(JSON.stringify({ summary, items: suggestions }, null, 2));

  const lines = [
    `未映射错题证据候选（${subject ?? "全科"}｜对象 ${summary.unmatchedObjects} 个 / 证据 ${summary.unmatchedEvidence} 条）`,
    `展示阈值 ${minimum}；分数只用于候选排序，不是正确率。本命令零写入。`,
  ];
  for (const item of suggestions) {
    const sourceLabel = item.sourceKind === "error_topic" ? `T#${item.sourceId}` : `#${item.sourceId}`;
    const patterns = [...new Set(item.evidence.map((entry) => FAILURE_PATTERNS[entry.failurePatternCode]?.label ?? entry.failurePatternCode))];
    const events = [...new Set(item.evidence.map((entry) => `#${entry.studyErrorId}`))];
    lines.push("", `${sourceLabel} [${item.subject}] ${item.title}`);
    lines.push(`  证据：${events.join("、")}｜${patterns.join("、") || "未标栽点"}｜${candidateDecisionLabel(item.decision.status)}`);
    lines.push(`  判定：${item.decision.reason}`);
    if (item.existingLinks.length) {
      lines.push(`  已有候选链接：${item.existingLinks.map((link) => `${link.kpId}(${link.status},${link.confidence ?? 0})`).join("；")}`);
    }
    if (!item.candidates.length) {
      lines.push(["keep_unmapped", "catalog_unsupported"].includes(item.decision.status)
        ? "  → 按上述边界保留未映射。"
        : "  → 没有达到阈值的目录候选；不要为清零计数硬映射。");
      continue;
    }
    for (const [index, candidate] of item.candidates.entries()) {
      const evidence = candidate.matchEvidence[0];
      const signalLabel = evidence?.signalKind?.startsWith("title") ? "主题标题" : "原题/章节上下文";
      lines.push(`  ${index + 1}. ${candidate.kpId} ${candidate.name ?? "未命名"}｜${candidateTierLabel(candidate.tier)} ${candidate.confidence}｜${candidate.parentKp ?? "无父级"}`);
      lines.push(`     线索：${signalLabel}；${evidence?.reason ?? "文本相似"}`);
    }
    lines.push(`  先核验：node --env-file=.env.local scripts/knowledge.mjs show ${item.candidates[0].kpId}`);
    lines.push(`  人工确认后才可写：node --env-file=.env.local scripts/knowledge.mjs link ${item.sourceKind} ${item.sourceId} <KP-ID> --status confirmed --method manual --confidence 100 --anchor "人工核验:${item.sourceKind}#${item.sourceId}"`);
  }
  if (!suggestions.length) lines.push("", subject ? `${subject}暂无未映射的细粒度错题证据。` : "暂无未映射的细粒度错题证据。");
  if (records.length > shownRecords.length) lines.push("", `另有 ${records.length - shownRecords.length} 个对象未展示；用 --limit 调整。`);
  lines.push("", "跨多个知识点的主题：人工选一个 primary，其余确认链接用 --role related；做题方法主题、目录外科目可以保留未映射。", "confirmed 映射必须带人工核验锚点；没有锚点时 CLI 会拒绝写入。");
  console.log(lines.join("\n"));
}

// [gpt] 2026-08-10：旧答疑卡点的 KP 候选只读生成；普通提问仍不入账，候选永不自动 confirmed。
async function commandSuggestAsks(positional, options) {
  const subject = positional.join(" ").trim() || null;
  const candidateLimit = positiveInteger(options.candidates ?? options.limit, 3, "--candidates");
  const minimum = options.min == null || options.min === true ? 65 : Number(options.min);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error("--min 必须是 0-100");
  const [askPoints, links, { catalog }] = await Promise.all([
    fetchAll("ask_point_v2", "id, subject, kp_id, question_type, step_stuck, confusion, effective_status, active, source, raw_question, evidence_anchor, created_at", "id"),
    fetchAll("knowledge_object_link", "id, source_kind, source_id, kp_id, role, match_method, link_status, confidence, evidence_anchor"),
    loadCatalog(),
  ]);
  const records = buildUnmappedAskLinkRecords(askPoints, links, { subject, includeHistory: Boolean(options.all) });
  const suggestions = suggestKnowledgeLinks(records, catalog, { limitPerRecord: candidateLimit, minConfidence: minimum });
  const summary = {
    subject,
    objects: records.length,
    strong: suggestions.filter((item) => item.decision.status === "strong_candidate").length,
    ambiguous: suggestions.filter((item) => item.decision.status === "ambiguous").length,
    minimumConfidence: minimum,
    policy: "只读候选；答疑文字相似不等于已确认知识点",
  };
  if (options.json) return console.log(JSON.stringify({ summary, items: suggestions }, null, 2));
  const lines = [
    `未映射答疑卡点候选（${subject ?? "全科"}｜对象 ${summary.objects}）`,
    `强候选 ${summary.strong}｜多候选 ${summary.ambiguous}｜阈值 ${minimum}｜零写入`,
  ];
  for (const item of suggestions) {
    lines.push("", `A#${item.sourceId} [${item.subject ?? "未分类"}] ${item.title}`);
    lines.push(`  判定：${candidateDecisionLabel(item.decision.status)}｜${item.decision.reason}`);
    if (item.existingLinks.length) lines.push(`  已有候选：${item.existingLinks.map((link) => `${link.kpId}(${link.status},${link.confidence ?? 0})`).join("；")}`);
    for (const [index, candidate] of item.candidates.entries()) {
      lines.push(`  ${index + 1}. ${candidate.kpId} ${candidate.name ?? "未命名"}｜${candidateTierLabel(candidate.tier)} ${candidate.confidence}｜${candidate.parentKp ?? "无父级"}`);
    }
    if (item.candidates[0]) lines.push(`  人工核验后：node --env-file=.env.local scripts/knowledge.mjs link ask_point ${item.sourceId} <KP-ID> --status confirmed --method manual --confidence 100 --anchor "人工核验:A#${item.sourceId}"`);
  }
  if (!suggestions.length) lines.push("", "暂无符合范围的未映射答疑卡点。");
  console.log(lines.join("\n"));
}

async function loadMappingAudit(subject = null) {
  const [catalogResult, links, askPoints, errorTopics, errorRows, studyErrorTopics] = await Promise.all([
    loadCatalog(),
    fetchAll("knowledge_object_link", "id, source_kind, source_id, kp_id, role, match_method, link_status, confidence, evidence_anchor"),
    fetchAll("ask_point_v2", "id, subject, kp_id, confusion, status, effective_status, active, raw_question", "id"),
    fetchAll("error_topic", "id, subject, chapter, section, kp_id, title, classification_status, mastery_status", "id"),
    fetchAll("study_error", "id, subject, kp_id, knowledge, status", "id"),
    fetchAll("study_error_topic", "study_error_id, topic_id, role", "study_error_id"),
  ]);
  const reciteRecords = existsSync(".local/带背挂账.md")
    ? parseReciteLedger(readFileSync(".local/带背挂账.md", "utf8"), { referenceDate: beijingDate() }).records
    : [];
  return buildKnowledgeMappingAudit({
    catalog: catalogResult.catalog,
    objectLinks: links,
    askPoints,
    errorTopics,
    errorRows,
    studyErrorTopics,
    reciteRecords,
    subject,
  });
}

// [gpt] 2026-08-10：统一显示各事实轴连接率，防止只看总 link 行数掩盖大量未接主点。
async function commandMappingAudit(positional, options) {
  const subject = positional.join(" ").trim() || null;
  const audit = await loadMappingAudit(subject);
  if (options.json) return console.log(JSON.stringify(audit, null, 2));
  console.log(formatKnowledgeMappingAudit(audit, { limit: positiveInteger(options.limit, 20, "--limit") }));
}

// [gpt] 2026-08-10：只迁移来源表已经存在的稳定 kp_id；文本相似候选不走本命令。
async function commandBackfillDirect(positional, options, today) {
  const subject = positional.join(" ").trim() || null;
  const audit = await loadMappingAudit(subject);
  const operations = directMappingBackfillOperations(audit);
  const lines = [
    `稳定直连回填预检（${subject ?? "全科"}）`,
    `可回填 ${operations.length} 条；该批次不包含任何文本/Anki/模型候选。`,
    ...operations.map((op) => `- ${op.sourceKind}:${op.sourceId} → ${op.kpId}｜${op.evidenceAnchor}`),
  ];
  if (!operations.length) lines.push("- 当前没有直连迁移债。");
  if (!booleanOption(options, "apply")) {
    lines.push("", "当前为预览；确认执行需加 --apply，批量暂存需再加 --stage。");
    return console.log(lines.join("\n"));
  }
  const existing = readOutbox(OUTBOX);
  const operationIds = new Set(operations.map((op) => op.operation_id));
  const foreign = existing.filter((op) => !operationIds.has(op.operation_id));
  if (foreign.length && !options.stage) throw new Error(`outbox 还有 ${foreign.length} 条其他待同步操作；请先处理，或用 --apply --stage 仅暂存本批次`);
  const existingIds = new Set(existing.map((op) => op.operation_id));
  const appended = operations.filter((op) => !existingIds.has(op.operation_id)).map((op) => appendOutbox(OUTBOX, op));
  lines.push("", `已暂存 ${appended.length} 条（已存在 ${operations.length - appended.length} 条）。`);
  console.log(lines.join("\n"));
  if (!options.stage && operations.length) await syncOutbox(today);
}

async function commandPortrait(positional, options) {
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const subject = positional.join(" ").trim() || null;
  const runtime = await loadRuntime(referenceDate, options.exam === true ? null : options.exam);
  const subjectProfiles = runtime.portrait.bySubject.filter((item) => !subject || item.subject === subject);
  const pointProfiles = runtime.portrait.byKnowledgePoint.filter((item) => !subject || item.subject === subject);
  if (options.json) return console.log(JSON.stringify({ counts: runtime.portrait.counts, bySubject: subjectProfiles, byKnowledgePoint: pointProfiles, unmatched: runtime.portrait.unmatched }, null, 2));
  const limit = options.limit == null || options.limit === true ? 5 : Number(options.limit);
  console.log(formatFailurePortrait(runtime.portrait, { subject, limit }));
}

function commandPatterns(options) {
  const rows = Object.entries(FAILURE_PATTERNS).map(([code, value]) => ({ code, ...value }));
  if (options.json) return console.log(JSON.stringify(rows, null, 2));
  console.log(rows.map((row) => `${row.code}｜${row.label}｜${row.focus}`).join("\n"));
}

async function commandGraph(positional, options) {
  const kpId = positional[0] ? String(positional[0]).toUpperCase() : null;
  if (kpId && !/^[A-Z]{2,4}-\d{4}$/.test(kpId)) throw new Error("graph 需要合法 KP-ID");
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const runtime = await loadRuntime(referenceDate, options.exam === true ? null : options.exam);
  if (options.json) {
    const nodes = kpId ? runtime.graph.byKnowledgePoint.filter((item) => item.kpId === kpId) : runtime.graph.byKnowledgePoint;
    return console.log(JSON.stringify({ counts: runtime.graph.counts, nodes, rootBlockers: runtime.graph.rootBlockers, cycles: runtime.graph.cycles, issues: runtime.graph.issues, policy: runtime.graph.policy }, null, 2));
  }
  console.log(formatKnowledgeGraph(runtime.graph, { kpId }));
}

// [gpt] 2026-08-10：把当前 KP 周围近窗个人事实聚成答疑可直接注入的只读上下文。
async function commandContext(positional, options) {
  const kpIds = uniqueKpIds(positional);
  if (!kpIds.length) throw new Error("context 至少需要一个 KP-ID");
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const runtime = await loadRuntime(referenceDate, options.exam === true ? null : options.exam, { includePersonalContext: true });
  const context = buildPersonalKnowledgeContext({
    currentKpIds: kpIds,
    referenceDate,
    windowDays: positiveInteger(options.days, 30, "--days"),
    maxDepth: positiveInteger(options.depth, 2, "--depth"),
    limit: positiveInteger(options.limit, 3, "--limit"),
    catalog: runtime.catalog,
    relations: runtime.relations,
    objectLinks: runtime.links,
    askPoints: runtime.askPoints,
    errorRows: runtime.errorRows,
    knowledgeEvidence: runtime.allEvidence,
    knowledgeStates: runtime.states,
    knowledgeGraph: runtime.graph,
    failurePortrait: runtime.portrait,
  });
  console.log(options.json ? JSON.stringify(context, null, 2) : formatPersonalKnowledgeContext(context));
}

async function commandForecast(options) {
  const referenceDate = String(options.today === true || !options.today ? beijingDate() : options.today);
  const configPath = options.config === true || !options.config ? "config/coach.json" : String(options.config);
  if (!existsSync(configPath)) throw new Error(`预测配置不存在：${configPath}`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const examDate = String(options.exam === true || !options.exam ? config["考试日期"] : options.exam);
  const [runtime, studyLogs] = await Promise.all([
    loadRuntime(referenceDate, examDate),
    fetchAll("study_log", "id, subject, chapter, activity, accuracy, log_date"),
  ]);
  const forecast = buildExamLossForecast({
    referenceDate,
    examDate,
    knowledgeStates: runtime.states,
    knowledgeGraph: runtime.graph,
    failurePortrait: runtime.portrait,
    studyLogs,
    targets: config["目标分"] ?? {},
    mockRecords: config["模拟分记录"]?.["记录"] ?? [],
    windowDays: options.window === true || !options.window ? 28 : Number(options.window),
  });
  if (options.json) return console.log(JSON.stringify(forecast, null, 2));
  const limit = positiveInteger(options.limit, 10, "--limit");
  console.log(formatExamLossForecast(forecast, { limit }));
}

async function commandRelate(positional, options, today) {
  const [prerequisiteRaw, dependentRaw] = positional;
  const prerequisiteKpId = String(prerequisiteRaw ?? "").toUpperCase();
  const dependentKpId = String(dependentRaw ?? "").toUpperCase();
  if (!/^[A-Z]{2,4}-\d{4}$/.test(prerequisiteKpId) || !/^[A-Z]{2,4}-\d{4}$/.test(dependentKpId)) {
    throw new Error("relate 用法：relate <前置KP-ID> <目标KP-ID>");
  }
  if (prerequisiteKpId === dependentKpId) throw new Error("知识关系不能自环");
  const relationType = oneOf(options.type ?? "prerequisite", KNOWLEDGE_RELATION_TYPES, "--type");
  const relationStatus = oneOf(options.status ?? "pending", KNOWLEDGE_RELATION_STATUSES, "--status");
  const sourceKind = oneOf(options.source ?? "manual", KNOWLEDGE_RELATION_SOURCES, "--source");
  const requiredStage = relationType === "prerequisite"
    ? oneOf(options.required ?? "understanding", PREREQUISITE_STAGES, "--required")
    : null;
  const strength = positiveInteger(options.strength, 3, "--strength");
  if (strength > 5) throw new Error("--strength 必须是 1-5 整数");
  const relationConfidence = confidence(options.confidence, relationStatus === "confirmed" ? 100 : 70);
  const evidenceAnchor = options.anchor === true ? null : options.anchor;
  if (relationStatus === "confirmed" && !String(evidenceAnchor ?? "").trim()) throw new Error("confirmed 前置关系必须带 --anchor 核验锚点");
  if (relationStatus === "confirmed" && !["manual", "curated", "textbook"].includes(sourceKind)) {
    throw new Error("model/catalog 关系只能作为 pending 候选，不能直接 confirmed");
  }
  const runtime = await loadRuntime(today);
  const catalogIds = new Set(runtime.catalog.items.map((item) => item.kpId));
  if (!catalogIds.has(prerequisiteKpId) || !catalogIds.has(dependentKpId)) throw new Error("关系两端必须都存在于稳定知识目录");
  if (relationType === "prerequisite" && relationStatus === "confirmed") {
    const cycle = wouldCreatePrerequisiteCycle(runtime.relations, prerequisiteKpId, dependentKpId);
    if (!cycle.ok) throw new Error(`该前置会成环：${cycle.cycle?.join(" → ") ?? "无法建立"}`);
  }
  const op = appendOutbox(OUTBOX, {
    op: "knowledge_relation",
    prerequisiteKpId,
    dependentKpId,
    relationType,
    requiredStage,
    strength,
    relationStatus,
    confidence: relationConfidence,
    sourceKind,
    evidenceAnchor,
    note: options.note === true ? null : options.note,
    createdBy: "knowledge-cli",
  });
  console.log(`⏳ 已暂存关系 ${prerequisiteKpId} → ${dependentKpId}（${relationType}/${relationStatus}，op=${op.operation_id}）`);
  if (!options.stage) await syncOutbox(today);
}

async function commandLink(positional, options, today) {
  const [sourceKindRaw, sourceIdRaw, kpIdRaw] = positional;
  const sourceKind = oneOf(sourceKindRaw, LINK_KINDS, "source-kind");
  const sourceId = String(sourceIdRaw ?? "").trim();
  const kpId = String(kpIdRaw ?? "").trim().toUpperCase();
  if (!sourceId || !/^[A-Z]{2,4}-\d{4}$/.test(kpId)) throw new Error("link 用法：link <source-kind> <source-id> <KP-ID>");
  const linkStatus = oneOf(options.status ?? "pending", LINK_STATUSES, "--status");
  const matchMethod = oneOf(options.method ?? "manual", LINK_METHODS, "--method");
  const evidenceAnchor = options.anchor === true ? null : options.anchor;
  // [gpt] 2026-08-10：confirmed 是学习事实，不允许无人工核验锚点的裸确认。
  if (linkStatus === "confirmed" && !String(evidenceAnchor ?? "").trim()) {
    throw new Error("confirmed 映射必须带 --anchor 人工核验锚点；候选预览请先运行 suggest-errors / suggest-topics");
  }
  if (linkStatus === "confirmed" && matchMethod !== "manual") {
    throw new Error("confirmed 映射必须使用 --method manual；exact_name / fuzzy 等算法方法只能保留为 pending 候选");
  }
  const op = appendOutbox(OUTBOX, {
    op: "knowledge_link",
    sourceKind,
    sourceId,
    kpId,
    role: options.role ?? "primary",
    matchMethod,
    linkStatus,
    confidence: confidence(options.confidence, linkStatus === "confirmed" ? 100 : 70),
    evidenceAnchor,
    createdBy: "knowledge-cli",
  });
  console.log(`⏳ 已暂存映射 ${sourceKind}:${sourceId} → ${kpId}（${linkStatus}，op=${op.operation_id}）`);
  if (!options.stage) await syncOutbox(today);
}

async function commandEvidence(positional, options, today) {
  const [kpIdRaw, dimensionRaw, resultRaw] = positional;
  const kpId = String(kpIdRaw ?? "").toUpperCase();
  if (!/^[A-Z]{2,4}-\d{4}$/.test(kpId)) throw new Error("evidence 需要合法 KP-ID");
  const dimension = oneOf(dimensionRaw, KNOWLEDGE_DIMENSIONS, "dimension");
  const routeByDimension = { exposure: "ask-pc", understanding: "ask-pc", recall: "daibei-pc", application: "cuoti-fupan" };
  const result = oneOf(resultRaw, RESULTS, "result");
  const cued = booleanOption(options, "cued");
  const invalidPrompt = booleanOption(options, "invalid-prompt");
  const cold = booleanOption(options, "cold");
  const promptFlags = [cued ? "cued" : null, invalidPrompt ? "invalid" : null].filter(Boolean);
  if (promptFlags.length > 1) throw new Error("--cued 与 --invalid-prompt 不能同时使用");
  const promptIntegrity = invalidPrompt ? "invalid" : cued ? "cued" : "clean";
  if ((result === "void") !== (promptIntegrity === "invalid")) throw new Error("void 必须配 --invalid-prompt，invalid-prompt 也必须使用 void");
  if (cold && promptIntegrity !== "clean") throw new Error("冷检不能同时带提示或无效题干");
  const pattern = options.pattern === true || !options.pattern ? null : oneOf(options.pattern, Object.keys(FAILURE_PATTERNS), "--pattern");
  if (options.diagnosis && !pattern) throw new Error("--diagnosis 必须和 --pattern 一起使用");
  const diagnosisStatus = options.diagnosis === true || !options.diagnosis
    ? "pending"
    : oneOf(options.diagnosis, ["pending", "confirmed", "rejected"], "--diagnosis");
  const variantKind = options.variant === true || !options.variant ? null : oneOf(options.variant, Object.keys(EVIDENCE_VARIANTS), "--variant");
  const assessmentContext = options.context === true || !options.context ? "practice" : oneOf(options.context, Object.keys(ASSESSMENT_CONTEXTS), "--context");
  const durationSeconds = options.seconds === true || !options.seconds ? null : Number(options.seconds);
  const transfer = normalizeTransferMetadata({
    dimension,
    result,
    promptIntegrity,
    cold,
    variantKind,
    transferLevel: variantKind ? EVIDENCE_VARIANTS[variantKind].transferLevel : null,
    assessmentContext,
    durationSeconds,
  });
  const date = String(options.date === true || !options.date ? today : options.date);
  const scheduleId = options.schedule === true ? null : options.schedule;
  const scheduleFile = options["schedule-file"] === true || !options["schedule-file"] ? ".local/复盘排期.md" : String(options["schedule-file"]);
  if (scheduleId) {
    if (!existsSync(scheduleFile)) throw new Error(`排期文件不存在：${scheduleFile}`);
    assertScheduleLink(readFileSync(scheduleFile, "utf8"), scheduleId, {
      kind: "knowledge", targetId: kpId, referenceDate: date, route: routeByDimension[dimension], dimension,
    });
  }
  const op = appendOutbox(OUTBOX, {
    op: "knowledge_evidence",
    kpId,
    date,
    dimension,
    result,
    sourceKind: options.source === true || !options.source ? "manual" : options.source,
    sourceId: options["source-id"] === true ? null : options["source-id"],
    cold,
    promptIntegrity,
    failurePatternCode: pattern,
    diagnosisStatus,
    ...transfer,
    evidenceAnchor: options.anchor === true ? null : options.anchor,
    note: options.note === true ? null : options.note,
  });
  console.log(`⏳ 已暂存 ${kpId} ${dimension}/${result}${cold ? "｜冷检" : ""}${variantKind ? `｜${EVIDENCE_VARIANTS[variantKind].label}/L${transfer.transferLevel}` : ""}${assessmentContext !== "practice" ? `｜${ASSESSMENT_CONTEXTS[assessmentContext].label}${durationSeconds ? ` ${durationSeconds}s` : ""}` : ""}${pattern ? `｜${FAILURE_PATTERNS[pattern].label}` : ""}（op=${op.operation_id}）`);
  if (options.stage) return;
  const synced = await syncOutbox(today);
  if (!synced || !scheduleId) return;
  const markdown = readFileSync(scheduleFile, "utf8");
  assertScheduleLink(markdown, scheduleId, {
    kind: "knowledge", targetId: kpId, referenceDate: date, route: routeByDimension[dimension], dimension,
  });
  // [gpt] 2026-08-10：知识点排期结案同步保留 outcome/cold/prompt，供干预响应派生重算。
  const closed = closeScheduleItem(markdown, scheduleId, {
    date,
    result: `${dimension}/${result}${cold ? "｜冷检" : ""}`,
    outcome: result,
    cold,
    promptIntegrity,
  });
  writeFileSync(scheduleFile, closed, "utf8");
  console.log(`✅ 已结案知识点排期：${scheduleId}`);
}

async function commandAttempt(positional, options, today) {
  const [kpIdRaw, dimension, result] = positional;
  const kpId = kpIdRaw === "-" ? null : String(kpIdRaw ?? "").trim().toUpperCase();
  if (kpId && !/^[A-Z]{2,4}-\d{4}$/.test(kpId)) throw new Error("attempt 的 KP-ID 不合法；未映射请传 -");
  const cold = booleanOption(options, "cold");
  const cued = booleanOption(options, "cued");
  const invalidPrompt = booleanOption(options, "invalid-prompt");
  if (cued && invalidPrompt) throw new Error("--cued 与 --invalid-prompt 不能同时使用");
  const variantKind = options.variant === true || !options.variant ? null : options.variant;
  const transferLevel = variantKind && EVIDENCE_VARIANTS[variantKind]
    ? EVIDENCE_VARIANTS[variantKind].transferLevel
    : null;
  const payload = {
    op: "learning_attempt",
    date: options.date === true || !options.date ? today : String(options.date),
    subject: options.subject === true ? null : options.subject,
    kpId,
    questionRef: options.question === true ? null : options.question,
    sourceKind: options.source === true || !options.source ? "manual" : options.source,
    sourceId: options["source-id"] === true ? null : options["source-id"],
    sessionKey: options.session === true ? null : options.session,
    attemptRole: options.role === true || !options.role ? "primary" : options.role,
    dimension,
    result,
    score: options.score === true ? null : options.score,
    maxScore: options.max === true ? null : options.max,
    cold,
    promptIntegrity: invalidPrompt ? "invalid" : cued ? "cued" : "clean",
    variantKind,
    transferLevel,
    probeAxis: options["probe-axis"] === true ? null : options["probe-axis"],
    assessmentContext: options.context === true || !options.context ? "practice" : options.context,
    durationSeconds: options.seconds === true ? null : options.seconds,
    failurePatternCode: options.pattern === true ? null : options.pattern,
    diagnosisStatus: options.diagnosis === true || !options.diagnosis ? "pending" : options.diagnosis,
    protocol: options.protocol === true ? null : options.protocol,
    protocolVersion: options["protocol-version"] === true ? null : options["protocol-version"],
    interventionEpisodeId: options.episode === true ? null : options.episode,
    observationWindow: options.window === true ? null : options.window,
    evidenceAnchor: options.anchor === true ? null : options.anchor,
    responseExcerpt: options.response === true ? null : options.response,
    note: options.note === true ? null : options.note,
  };
  // [gpt] 先验证再落 outbox，避免缺稳定题号/来源的坏事件永久阻塞同步队列。
  normalizeLearningAttempt({ operation_id: "validate-knowledge-attempt", ...payload }, today);
  const op = appendOutbox(OUTBOX, payload);
  console.log(`⏳ 已暂存学习尝试 ${kpId ?? "未映射"} ${dimension}/${result}（op=${op.operation_id}）`);
  if (!options.stage) await syncOutbox(today);
}

function usage() {
  console.log("用法：node --env-file=.env.local scripts/knowledge.mjs <命令> ...");
  console.log("  stats [--today YYYY-MM-DD --exam YYYY-MM-DD --json]");
  console.log("  search <关键词|KP-ID> [--subject 科目 --limit 10 --json]");
  console.log("  show <KP-ID> [--today YYYY-MM-DD --json]");
  console.log("  portrait [科目] [--today YYYY-MM-DD --json]");
  console.log("  patterns [--json]（列出栽点类型代码与训练焦点）");
  console.log("  graph [KP-ID] [--today YYYY-MM-DD --json]（查看确认前置、阻塞路径和成环审计）");
  console.log("  context <KP-ID...> [--today YYYY-MM-DD --days 30 --depth 2 --limit 3 --json]（近窗个人关联；只影响讲解策略）");
  console.log("  forecast [--today YYYY-MM-DD --exam YYYY-MM-DD --window 28 --limit 10 --json]（考试日失分压力；非概率）");
  console.log("  suggest-recite [--active --all --limit 3 --min 80 --matched --json]（默认只看未定主点；只给候选，不自动确认）");
  console.log("  suggest-topics [--all --limit 3 --min 80 --matched --json]（默认只看尚无 kp_id 的主题）");
  console.log("  suggest-errors [科目] [--limit 20 --candidates 3 --min 65 --json]（只看仍未映射的细粒度错题证据；零写入）");
  console.log("  suggest-asks [科目] [--all --candidates 3 --min 65 --json]（旧答疑卡点候选；零写入）");
  console.log("  mapping-audit [科目] [--limit 20 --json]（统一审计错题/主题/答疑/带背的 confirmed 主点覆盖）");
  console.log("  backfill-direct [科目] [--apply --stage]（只回填来源表已有稳定 kp_id；不使用文本候选）");
  console.log("  link <source-kind> <source-id> <KP-ID> [--status pending|confirmed --method manual|exact_name|anki_exact|anki_section|fuzzy --confidence 0-100 --anchor 锚点 --stage]");
  console.log("  relate <前置KP-ID> <目标KP-ID> [--type prerequisite|supports|contrast --required understanding|recall|application|stable --status pending|confirmed|rejected --source manual|textbook|model --strength 1-5 --confidence 0-100 --anchor 锚点 --note 说明 --stage]");
  console.log("  evidence <KP-ID> <exposure|understanding|recall|application> <pass|partial|fail|void> [--date 北京日 --cold --cued --invalid-prompt --variant original|rule_recall|counterfactual|novel_case|integrated_case|teach_back|invalid --context practice|timed|full_mock --seconds N --pattern 代码 --diagnosis pending|confirmed --anchor 锚点 --note 说明 --schedule 排期ID --stage]");
  console.log("  attempt <KP-ID|-> <exposure|understanding|recall|application> <pass|partial|fail|void> [--subject 科目 --question 稳定题号 --source ... --source-id 稳定来源ID --role primary|rewrite|recheck|followup --score N --max N --cold --cued --invalid-prompt --variant ... --probe-axis ... --context practice|timed|full_mock --seconds N --anchor 锚点 --stage]");
  console.log("    objective_question/subjective_answer 必须同时提供 --question、--source-id、--score、--max；非 manual 来源必须提供 --source-id。");
  console.log("  sync");
}

export async function main(argv) {
  const command = argv[0] ?? "stats";
  const { positional, options } = parseArgs(argv.slice(1));
  const today = String(options.today === true || !options.today ? beijingDate() : options.today);
  if (command === "stats") return commandStats(options);
  if (command === "search") return commandSearch(positional, options);
  if (command === "show") return commandShow(positional, options);
  if (command === "portrait") return commandPortrait(positional, options);
  if (command === "patterns") return commandPatterns(options);
  if (command === "graph") return commandGraph(positional, options);
  if (command === "context") return commandContext(positional, options);
  if (command === "forecast") return commandForecast(options);
  if (command === "suggest-recite") return commandSuggestRecite(options);
  if (command === "suggest-topics") return commandSuggestTopics(options);
  if (command === "suggest-errors") return commandSuggestErrors(positional, options);
  if (command === "suggest-asks") return commandSuggestAsks(positional, options);
  if (command === "mapping-audit") return commandMappingAudit(positional, options);
  if (command === "backfill-direct") return commandBackfillDirect(positional, options, today);
  if (command === "link") return commandLink(positional, options, today);
  if (command === "relate") return commandRelate(positional, options, today);
  if (command === "evidence") return commandEvidence(positional, options, today);
  if (command === "attempt") return commandAttempt(positional, options, today);
  if (command === "sync") return syncOutbox(today);
  usage();
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
