#!/usr/bin/env node
// [gpt] 2026-08-11：六个高频交互 skill 的单次、新鲜、只读启动快照。
// [gpt] 2026-08-12：cuoti 支持无锁科启动，并接收会话内跨科重规划信号。
// [gpt] 2026-08-12：启动快照自动建立 Skill Run 并落 context_loaded；业务数据读取仍保持只读。

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collectAssessment } from "./assessment.mjs";
import { summarizeErrorBookRows } from "./lib/error-book-summary.mjs";
import { parseReviewSchedule, parseSubjectiveLedger } from "./lib/assessment-ledgers.mjs";
import { calibrateJudgments } from "./lib/judgment-calibration.mjs";
import { parseJudgmentLedger } from "./lib/judgment-ledger.mjs";
import { beijingDate } from "./lib/recite-ledger.mjs";
import { loadEventAbsorptionProofs } from "./lib/error-absorption.mjs";
import { STUDY_SUBJECT_ALIASES, STUDY_SUBJECTS, normalizeStudySubject } from "./lib/study-subject.mjs";
import {
  buildSkillExecutionContext,
  findDaibeiRecovery,
  recordAutomaticSkillStep,
  resumeDaibeiSkillRun,
  startSkillRun,
} from "./lib/skill-run.mjs";
import {
  buildAskContext,
  buildCoachContext,
  buildCuotiContext,
  buildDaibeiContext,
  buildLunshuContext,
  formatSkillContext,
} from "./lib/skill-context.mjs";

const MODES = ["coach", "cuoti", "daibei", "ask", "lunshu"];
export function parseSkillContextOptions(args) {
  const output = {
    json: false,
    subject: null,
    kind: null,
    date: null,
    currentSubject: null,
    subjectStreak: 0,
    focusMinimumMet: false,
    signal: "startup",
    runId: null,
    track: true,
    intake: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") output.json = true;
    else if (arg === "--subject") output.subject = args[++index];
    else if (arg === "--type") output.kind = args[++index];
    else if (arg === "--date") output.date = args[++index];
    else if (arg === "--current-subject") output.currentSubject = args[++index];
    else if (arg === "--subject-streak") output.subjectStreak = Number(args[++index]);
    else if (arg === "--focus-minimum-met") output.focusMinimumMet = true;
    else if (arg === "--signal") output.signal = args[++index];
    else if (arg === "--run") output.runId = args[++index];
    else if (arg === "--no-track") output.track = false;
    else if (arg === "--intake") output.intake = true;
    else if ((STUDY_SUBJECTS.includes(arg) || STUDY_SUBJECT_ALIASES.has(arg)) && !output.subject) output.subject = arg;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  output.subject = normalizeStudySubject(output.subject);
  output.currentSubject = normalizeStudySubject(output.currentSubject);
  if (output.subject && !STUDY_SUBJECTS.includes(output.subject)) throw new Error(`未知科目：${output.subject}`);
  if (output.currentSubject && !STUDY_SUBJECTS.includes(output.currentSubject)) throw new Error(`未知当前科目：${output.currentSubject}`);
  if (!Number.isInteger(output.subjectStreak) || output.subjectStreak < 0) throw new Error("--subject-streak 需要非负整数");
  if (!["startup", "continue", "too-little", "switch", "pass", "partial", "fail", "absorbed", "new-error"].includes(output.signal)) {
    throw new Error(`未知重规划信号：${output.signal}`);
  }
  if (output.kind && !["case", "essay"].includes(output.kind)) throw new Error("--type 只接受 case 或 essay");
  return output;
}

function runtimeDb() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 Supabase 运行态配置");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchAll(build, label, pageSize = 500) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const response = await build(from, from + pageSize - 1);
    if (response.error) throw new Error(`${label}读取失败：${response.error.message}`);
    rows.push(...(response.data ?? []));
    if (!response.data || response.data.length < pageSize) break;
  }
  return rows;
}

function local(path, fallback = "") {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

function pendingOutbox() {
  const rows = local(".local/cuoti-pending.jsonl").split(/\r?\n/).filter((line) => line.trim());
  return { pending: rows.length, complete: rows.length === 0 };
}

function studyRows(db) {
  return fetchAll(
    (from, to) => db.from("study_log")
      .select("id, log_date, subject, chapter, activity, accuracy, feeling, raw_input")
      .order("id")
      .range(from, to),
    "学习流水",
  );
}

function errorRows(db) {
  return fetchAll(
    (from, to) => db.from("error_book_v2")
      .select("study_error_id, log_date, event_subject, event_kp_id, knowledge, event_status, absorbed_at, role, root_cause_code, failure_pattern_code, diagnosis_status, topic_id, topic_subject, topic_kp_id, chapter, section, topic_title, classification_status, mastery_status")
      .order("study_error_id")
      .range(from, to),
    "错题事实层",
  );
}

async function coachContext(db, referenceDate) {
  const [assessment, logs, rows, memoryResponse, messageResponse] = await Promise.all([
    collectAssessment(referenceDate),
    studyRows(db),
    errorRows(db),
    db.from("coach_memory").select("fact, category, updated_at").order("updated_at", { ascending: false }).limit(200),
    db.from("coach_message").select("role, content").order("id", { ascending: false }).limit(20),
  ]);
  if (memoryResponse.error) throw new Error(`长期记忆读取失败：${memoryResponse.error.message}`);
  if (messageResponse.error) throw new Error(`教练对话读取失败：${messageResponse.error.message}`);
  const errorSummary = summarizeErrorBookRows(rows);
  const eventProofs = await loadEventAbsorptionProofs(db, errorSummary.events.filter((item) => item.status === "open"), referenceDate);
  return buildCoachContext({
    assessment,
    studyLogs: logs,
    errorSummary,
    eventProofs,
    memories: memoryResponse.data ?? [],
    messages: messageResponse.data ?? [],
    weeklyMarkdown: local(".local/weekly-draft.md"),
  });
}

async function cuotiContext(db, referenceDate, subject, routing = {}) {
  const [assessment, rows] = await Promise.all([collectAssessment(referenceDate), errorRows(db)]);
  const errorSummary = summarizeErrorBookRows(rows);
  const eventProofs = await loadEventAbsorptionProofs(db, errorSummary.events.filter((item) => item.status === "open"), referenceDate);
  const judgmentMarkdown = local(".local/判断台账.md");
  const calibration = judgmentMarkdown
    ? calibrateJudgments(parseJudgmentLedger(judgmentMarkdown, { referenceDate }), { referenceDate })
    : null;
  return buildCuotiContext({
    assessment,
    errorSummary,
    eventProofs,
    subject,
    routing,
    calibration,
    weeklyMarkdown: local(".local/weekly-draft.md"),
  });
}

async function daibeiContext(db, referenceDate, subject, recovery = null) {
  const [assessment, logs] = await Promise.all([collectAssessment(referenceDate), studyRows(db)]);
  return buildDaibeiContext({ assessment, studyLogs: logs, subject, recovery, weeklyMarkdown: local(".local/weekly-draft.md") });
}

async function askContext(db, referenceDate, subject) {
  const [logs, rows] = await Promise.all([studyRows(db), errorRows(db)]);
  return buildAskContext({ referenceDate, subject, studyLogs: logs, errorSummary: summarizeErrorBookRows(rows) });
}

async function lunshuContext(db, referenceDate, kind) {
  const [logs] = await Promise.all([studyRows(db)]);
  const schedule = parseReviewSchedule(local(".local/复盘排期.md", "# 复盘排期\n"), { referenceDate });
  if (schedule.counts.errors) throw new Error(`复盘排期有 ${schedule.counts.errors} 个结构错误`);
  const subjective = parseSubjectiveLedger(local(".local/主观题台账.md", "# 主观题台账\n"), { referenceDate });
  return buildLunshuContext({ referenceDate, kind, studyLogs: logs, subjective, schedule });
}

export async function main(argv) {
  const [mode, ...rest] = argv;
  if (!MODES.includes(mode)) {
    console.log("用法：node --env-file=.env.local scripts/skill-context.mjs <coach|cuoti|daibei|ask|lunshu> [科目] [--intake] [--type case|essay] [--date 北京日] [--signal ...] [--current-subject 科目] [--subject-streak N] [--focus-minimum-met] [--run SR-...] [--no-track] [--json]");
    return;
  }
  const parsed = parseSkillContextOptions(rest);
  const referenceDate = parsed.date ?? beijingDate();
  if (["daibei", "ask"].includes(mode) && !parsed.subject) throw new Error(`${mode} 启动必须指定科目`);
  if (parsed.intake && mode !== "cuoti") throw new Error("--intake 只用于 cuoti 新错题摄取");
  if (parsed.intake && !parsed.subject) throw new Error("cuoti --intake 启动必须指定科目");
  if (mode === "lunshu" && !parsed.kind) throw new Error("lunshu 启动必须指定 --type case|essay");
  const startedAt = Date.now();
  // [gpt] 2026-08-14：本科新开带背前先读控制面；只恢复带稳定条目 ID 的 waiting Run，不能被较新的模糊目标覆盖。
  const recovery = mode === "daibei" && !parsed.runId
    ? findDaibeiRecovery({ subject: parsed.subject })
    : null;
  // [gpt] 2026-08-13：当天新错题只需建立受控 Run，不加载跨科复检池；材料仍由后续 material-batch 独立核验。
  const db = parsed.intake ? null : runtimeDb();
  const context = parsed.intake ? {
    schemaVersion: 2,
    skill: "cuoti-fupan",
    referenceDate,
    subject: parsed.subject,
    intake: true,
    rule: "上传几道即错几道；一次批量写回后自动逐题讲解；不加载跨科复检候选。",
  } : mode === "coach" ? await coachContext(db, referenceDate)
    : mode === "cuoti" ? await cuotiContext(db, referenceDate, parsed.subject, {
      currentSubject: parsed.currentSubject,
      subjectStreak: parsed.subjectStreak,
      focusMinimumMet: parsed.focusMinimumMet,
      signal: parsed.signal,
    })
      : mode === "daibei" ? await daibeiContext(db, referenceDate, parsed.subject, recovery)
        : mode === "ask" ? await askContext(db, referenceDate, parsed.subject)
          : await lunshuContext(db, referenceDate, parsed.kind);
  // [gpt] 读快照不隐式写库；若可靠 outbox 仍有待同步项，显式暴露而不是把数据库旧值当最新事实。
  context.dataFreshness = pendingOutbox();
  if (parsed.track) {
    const run = parsed.runId
      ? recordAutomaticSkillStep({
        runId: parsed.runId,
        step: parsed.signal === "startup" ? "context_loaded" : "replanned",
        status: "pass",
        source: "skill-context",
        durationMs: Date.now() - startedAt,
        expectedSkill: context.skill,
      })
      : recovery?.preferred
        ? resumeDaibeiSkillRun({
            runId: recovery.preferred.runId,
            subject: parsed.subject,
          })
        : recovery?.targetFallback
          ? startSkillRun({
            skill: context.skill,
            subject: parsed.subject,
            kind: parsed.kind,
            referenceDate,
            source: "skill-context-target-recovery",
            entryMode: "direct",
            targetRef: recovery.targetFallback.targetRef,
          })
        : (() => {
        const created = startSkillRun({
          skill: context.skill,
          subject: parsed.subject,
          kind: parsed.kind,
          referenceDate,
          source: "skill-context",
          entryMode: mode === "daibei" ? "snapshot" : null,
        });
        return recordAutomaticSkillStep({
          runId: created.runId,
          step: "context_loaded",
          status: "pass",
          source: "skill-context",
          durationMs: Date.now() - startedAt,
          expectedSkill: context.skill,
        });
      })();
    context.execution = buildSkillExecutionContext(run);
    if (context.selection?.source === "waiting_target_recovered") context.selection.runId = run.runId;
    if (context.questionIntegrity?.command) context.questionIntegrity.command += ` --run ${run.runId}`;
    if (context.judgmentResult?.command) context.judgmentResult.command += ` --run ${run.runId}`;
  }
  console.log(parsed.json ? JSON.stringify(context, null, 2) : formatSkillContext(context));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
