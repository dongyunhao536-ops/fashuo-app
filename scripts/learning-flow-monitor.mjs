// node --env-file=.env.local scripts/learning-flow-monitor.mjs check [--json] [--no-save|--local-only]  # 手动诊断
// node --env-file=.env.local scripts/learning-flow-monitor.mjs weekly [--week YYYY-MM-DD] [--json] [--no-save] # 周一自动分析
// [gpt] 2026-08-11：学习数据随动作实时落账；监控只按周分析，手动 check 仅用于即时诊断。
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseReviewSchedule, summarizeScheduleExecution } from "./lib/assessment-ledgers.mjs";
import { summarizeErrorBookRows } from "./lib/error-book-summary.mjs";
import {
  buildWeeklyFlowReview,
  evaluateLearningFlow,
  formatLearningFlowReport,
} from "./lib/learning-flow-monitor.mjs";
import { buildReciteMemoryModel } from "./lib/learning-coach.mjs";
import { parseReciteLedger, summarizeReciteLedger } from "./lib/recite-ledger.mjs";
import { readOutbox } from "./lib/study-outbox.mjs";

const LOCAL_DIR = ".local/system-observability";
const LOCAL_SNAPSHOT_LOG = `${LOCAL_DIR}/learning-flow.jsonl`;
const OUTBOX_FILE = ".local/cuoti-pending.jsonl";
const SCHEDULE_FILE = ".local/复盘排期.md";
const RECITE_FILE = ".local/带背挂账.md";
const CONFIG_FILE = "config/learning-flow-monitor.json";
const DAY = 86400000;

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    const key = args[index].slice(2);
    flags[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return flags;
}

function assertDate(value, label) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value ?? ""))) throw new Error(`${label} 必须是 YYYY-MM-DD`);
  return String(value);
}

function shiftDate(ymd, days) {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function beijingDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function beijingWeekMonday(ymd) {
  const value = new Date(`${ymd}T00:00:00Z`);
  const day = value.getUTCDay();
  return shiftDate(ymd, -(day === 0 ? 6 : day - 1));
}

function beijingBoundary(ymd) {
  return new Date(`${ymd}T00:00:00+08:00`).toISOString();
}

function beijingDateFromTimestamp(value) {
  const timestamp = new Date(value ?? "").getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) : null;
}

function releaseSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function thresholds() {
  if (!existsSync(CONFIG_FILE)) return {};
  const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith("_")));
}

function requiredEnv() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

async function readAll(label, queryPage, pageSize = 1000) {
  const rows = [];
  for (let page = 0; page < 100; page++) {
    const start = page * pageSize;
    const response = await queryPage(start, start + pageSize - 1);
    if (response.error) throw new Error(`读取 ${label} 失败：${response.error.message}`);
    const batch = response.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`读取 ${label} 超过 100000 行，拒绝用截断样本冒充完整事实`);
}

function ledgerFallback(code, message) {
  return { counts: { errors: 1, warnings: 0 }, issues: [{ code, severity: "error", message }] };
}

function readLocalFacts(referenceDate, windowStart, windowEnd) {
  let localOutbox;
  try {
    localOutbox = { operations: readOutbox(OUTBOX_FILE), parseError: null };
  } catch (error) {
    localOutbox = { operations: [], parseError: error instanceof Error ? error.message : String(error) };
  }

  let scheduleParsed;
  let scheduleExecution = { counts: {} };
  if (!existsSync(SCHEDULE_FILE)) {
    scheduleParsed = ledgerFallback("schedule_ledger_missing", `缺少 ${SCHEDULE_FILE}`);
  } else {
    scheduleParsed = parseReviewSchedule(readFileSync(SCHEDULE_FILE, "utf8"), { referenceDate });
    scheduleExecution = summarizeScheduleExecution(scheduleParsed, { start: windowStart, end: windowEnd });
  }

  let reciteParsed = null;
  let reciteSummary;
  if (!existsSync(RECITE_FILE)) {
    reciteSummary = ledgerFallback("recite_ledger_missing", `缺少 ${RECITE_FILE}`);
  } else {
    reciteParsed = parseReciteLedger(readFileSync(RECITE_FILE, "utf8"), { referenceDate });
    reciteSummary = summarizeReciteLedger(reciteParsed);
  }

  return { localOutbox, scheduleParsed, scheduleExecution, reciteParsed, reciteSummary };
}

async function collectFacts(db, { now, windowStart, windowEnd }) {
  const referenceDate = beijingDate(now);
  const local = readLocalFacts(referenceDate, windowStart, windowEnd);
  const sinceTs = beijingBoundary(windowStart);
  const untilTs = beijingBoundary(shiftDate(windowEnd, 1));
  const [
    qualityIssues,
    ingestOperations,
    ingestHistoryRaw,
    attempts,
    studyLogs,
    knowledgeEvidence,
    weeklyErrorEvents,
    pendingEvents,
    askPoints,
    errorBook,
    reviews,
    kpRows,
    objectLinks,
  ] = await Promise.all([
    readAll("learning_data_quality_v2", (from, to) => db.from("learning_data_quality_v2")
      .select("issue_code,severity,entity_kind,entity_id,detected_at").range(from, to)),
    readAll("unresolved ingest_operation", (from, to) => db.from("ingest_operation")
      .select("operation_id,op_type,status,attempt_count,first_seen_at,last_attempt_at,updated_at")
      .in("status", ["queued", "applying", "failed"]).range(from, to)),
    readAll("weekly ingest_operation", (from, to) => db.from("ingest_operation")
      .select("operation_id,op_type,status,attempt_count,first_seen_at,applied_at")
      .gte("first_seen_at", sinceTs).lt("first_seen_at", untilTs).range(from, to)),
    readAll("learning_attempt", (from, to) => db.from("learning_attempt")
      .select("id,attempt_date,source_kind,result,subject,kp_id,attempt_role")
      .gte("attempt_date", windowStart).lte("attempt_date", windowEnd).range(from, to)),
    readAll("study_log", (from, to) => db.from("study_log")
      .select("id,log_date,operation_id,attempt_expected")
      .gte("log_date", windowStart).lte("log_date", windowEnd).range(from, to)),
    readAll("knowledge_evidence", (from, to) => db.from("knowledge_evidence")
      .select("id,evidence_date,source_kind,result")
      .gte("evidence_date", windowStart).lte("evidence_date", windowEnd).range(from, to)),
    // [gpt] 2026-08-11：逐日计数直接读错题事实表，避免 error_book_v2 的一题多主题展开造成重复计数。
    readAll("weekly study_error", (from, to) => db.from("study_error")
      .select("id,log_date")
      .gte("log_date", windowStart).lte("log_date", windowEnd).range(from, to)),
    readAll("pending events", (from, to) => db.from("events")
      .select("id,type,kp_id,subject,status,created_at").eq("status", "pending").range(from, to)),
    readAll("ask_point_v2", (from, to) => db.from("ask_point_v2")
      .select("id,status,effective_status,active,created_at,updated_at").eq("status", "open").range(from, to)),
    readAll("error_book_v2", (from, to) => db.from("error_book_v2")
      .select("study_error_id,log_date,event_subject,knowledge,event_status,absorbed_at,role,root_cause_code,diagnosis_status,topic_id,topic_subject,chapter,section,topic_title,classification_status,mastery_status")
      .range(from, to)),
    readAll("error_review", (from, to) => db.from("error_review")
      .select("id,review_date,topic_id,result").gte("review_date", windowStart).lte("review_date", windowEnd).range(from, to)),
    readAll("kp_state", (from, to) => db.from("kp_state").select("kp_id").range(from, to)),
    readAll("recite knowledge links", (from, to) => db.from("knowledge_object_link")
      .select("source_kind,source_id,kp_id,role,link_status,confidence,evidence_anchor")
      .eq("source_kind", "recite_ledger").eq("link_status", "confirmed").range(from, to)),
  ]);

  const errorSummaryRaw = summarizeErrorBookRows(errorBook);
  const errorSummary = {
    activeTopics: errorSummaryRaw.activeTopics.length,
    awaitingColdReviewTopics: errorSummaryRaw.awaitingColdReviewTopics.length,
    unclassifiedEvents: errorSummaryRaw.unclassifiedEvents.length,
  };
  const reciteMapping = local.reciteParsed
    ? buildReciteMemoryModel(local.reciteParsed, referenceDate, { objectLinks })
    : { counts: {} };
  const ingestHistory = ingestHistoryRaw.map((row) => ({
    ...row,
    beijing_date: beijingDateFromTimestamp(row.first_seen_at),
  }));

  return {
    nowIso: now.toISOString(),
    windowStart,
    windowEnd,
    qualityIssues,
    ingestOperations,
    ingestHistory,
    localOutbox: local.localOutbox,
    attempts,
    studyLogs,
    knowledgeEvidence,
    knowledgeEvidenceCount: knowledgeEvidence.length,
    errorEvents: weeklyErrorEvents,
    reviews,
    attemptCount: attempts.length,
    validAttemptCount: attempts.filter((row) => row.result !== "void").length,
    studyLogCount: studyLogs.length,
    expectedStudyLogCount: studyLogs.filter((row) => row.attempt_expected).length,
    pendingEvents,
    knownKpIds: kpRows.map((row) => row.kp_id),
    askPoints,
    errorSummary,
    reviewCount: reviews.length,
    schedule: local.scheduleParsed,
    scheduleExecution: local.scheduleExecution,
    recite: local.reciteSummary,
    reciteMapping,
  };
}

function appendLocalSnapshot(report, sha) {
  mkdirSync(dirname(LOCAL_SNAPSHOT_LOG), { recursive: true });
  appendFileSync(LOCAL_SNAPSHOT_LOG, `${JSON.stringify({ ...report, releaseSha: sha })}\n`);
}

async function saveSnapshot(db, report, sha) {
  const { error } = await db.from("learning_flow_snapshot").insert({
    observed_at: report.observedAt,
    beijing_date: beijingDate(new Date(report.observedAt)),
    window_start: report.windowStart,
    window_end: report.windowEnd,
    status: report.status,
    source: "pc",
    release_sha: sha,
    schema_version: report.schemaVersion,
    metrics: report.metrics,
    issues: report.issues,
  });
  if (error) throw new Error(`保存 learning_flow_snapshot 失败：${error.message}`);
}

async function runCheck(db, flags) {
  const now = new Date();
  const end = assertDate(flags.end === true ? null : flags.end ?? beijingDate(now), "--end");
  const start = assertDate(flags.start === true ? null : flags.start ?? shiftDate(end, -6), "--start");
  if (start > end) throw new Error("--start 不能晚于 --end");
  const facts = await collectFacts(db, { now, windowStart: start, windowEnd: end });
  const report = evaluateLearningFlow(facts, { thresholds: thresholds() });
  const sha = releaseSha();
  if (!flags["no-save"]) {
    appendLocalSnapshot(report, sha);
    if (!flags["local-only"]) await saveSnapshot(db, report, sha);
  }
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatLearningFlowReport(report));
  return report;
}

async function runWeekly(db, flags) {
  const now = new Date();
  const today = beijingDate(now);
  const currentWeek = beijingWeekMonday(today);
  const weekStart = assertDate(flags.week === true ? null : flags.week ?? (flags.current ? currentWeek : shiftDate(currentWeek, -7)), "--week");
  if (beijingWeekMonday(weekStart) !== weekStart) throw new Error("--week 必须是北京自然周周一");
  const weekEnd = shiftDate(weekStart, 6);
  const facts = await collectFacts(db, { now, windowStart: weekStart, windowEnd: weekEnd });
  const flowReport = evaluateLearningFlow(facts, { thresholds: thresholds() });
  const weekly = buildWeeklyFlowReview({
    flowReport,
    weekStart,
    weekEnd,
  });
  if (!flags["no-save"]) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    writeFileSync(`${LOCAL_DIR}/weekly-${weekStart}.md`, weekly.content);
    const { content, ...dataSnapshot } = weekly;
    const { error } = await db.from("learning_flow_weekly_review").upsert({
      week_start: weekStart,
      week_end: weekEnd,
      status: weekly.status,
      content,
      data_snapshot: dataSnapshot,
      source: "pc-codex",
      schema_version: weekly.schemaVersion,
      generated_at: now.toISOString(),
    }, { onConflict: "week_start" });
    if (error) throw new Error(`保存 learning_flow_weekly_review 失败：${error.message}`);
  }
  if (flags.json) console.log(JSON.stringify(weekly, null, 2));
  else console.log(weekly.content);
  return weekly;
}

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));
if (!["check", "weekly"].includes(command)) {
  console.error("用法：node --env-file=.env.local scripts/learning-flow-monitor.mjs <check|weekly> [--json] [--no-save|--local-only] [--week YYYY-MM-DD]");
  process.exit(1);
}

try {
  const env = requiredEnv();
  const db = createClient(env.url, env.key, { auth: { persistSession: false } });
  const result = command === "check" ? await runCheck(db, flags) : await runWeekly(db, flags);
  if (result.status === "degraded") process.exitCode = 2;
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
