// 确定性评估事实快照：量化 v3 + DB 事实轴 + 四本本地台账，一次采齐后再由 pinggu-pc 下判断。
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { summarizeAskPoints } from "./lib/ask-point-summary.mjs";
import { parseDailyLedger, parseReviewSchedule, parseSubjectiveLedger } from "./lib/assessment-ledgers.mjs";
import { summarizeErrorBookRows } from "./lib/error-book-summary.mjs";
import { summarizeReviewProof } from "./lib/error-taxonomy.mjs";
import { buildLearningCoachSnapshot } from "./lib/learning-coach.mjs";
import { buildKnowledgeCatalog, loadAnkiExtract } from "./lib/knowledge-catalog.mjs";
import {
  appendMockCalibrationForecasts,
  assertValidProbabilityForecastLedger,
  parseProbabilityForecastLedger,
  summarizeProbabilityForecastLedger,
} from "./lib/forecast-ledger.mjs";
import { beijingDate, parseReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";
import { buildQuantV3 } from "../src/lib/quant-v3.mjs";

const DAY = 86400000;
const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    result[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function requiredFile(file) {
  if (!existsSync(file)) throw new Error(`评估事实源缺失：${file}`);
  return readFileSync(file, "utf8");
}

function dateMinus(date, days) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * DAY).toISOString().slice(0, 10);
}

function dateDistance(from, to) {
  return Math.ceil((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function extractExamOutline() {
  const source = requiredFile("src/lib/exam-outline.gen.ts");
  const literal = source.match(/export const EXAM_OUTLINE\s*=\s*("(?:\\.|[^"\\])*")\s*;/s)?.[1];
  if (!literal) throw new Error("无法从 src/lib/exam-outline.gen.ts 读取 EXAM_OUTLINE");
  return JSON.parse(literal);
}

async function fetchAll(build, label, pageSize = 500) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const response = await build(from, from + pageSize - 1);
    if (response.error) throw new Error(`评估事实源读取失败：${label}=${response.error.message}`);
    rows.push(...(response.data ?? []));
    if (!response.data || response.data.length < pageSize) break;
  }
  return rows;
}

function summarizeStudy(logs, referenceDate) {
  const day7 = dateMinus(referenceDate, 6);
  const day30 = dateMinus(referenceDate, 29);
  const subjects = [...new Set(logs.map((row) => row.subject ?? "未分类"))].sort();
  const bySubject = Object.fromEntries(subjects.map((subject) => {
    const rows = logs.filter((row) => (row.subject ?? "未分类") === subject);
    const activities = Object.fromEntries([...new Set(rows.map((row) => row.activity ?? "未知"))].sort().map((activity) => [activity, rows.filter((row) => (row.activity ?? "未知") === activity).length]));
    return [subject, {
      total: rows.length,
      last7d: rows.filter((row) => String(row.log_date) >= day7).length,
      last30d: rows.filter((row) => String(row.log_date) >= day30).length,
      latestDate: rows.map((row) => String(row.log_date ?? "")).sort().at(-1) ?? null,
      uniqueChapterLabels: new Set(rows.map((row) => row.chapter).filter(Boolean)).size,
      activities,
    }];
  }));
  return {
    counts: { total: logs.length, last7d: logs.filter((row) => String(row.log_date) >= day7).length, last30d: logs.filter((row) => String(row.log_date) >= day30).length },
    bySubject,
  };
}

export async function collectAssessment(referenceDate) {
  const [logs, errors, errorBookRows, reviews, askRows, knowledgePointRows, knowledgeEvidence, knowledgeObjectLinks, knowledgeRelations] = await Promise.all([
    fetchAll((from, to) => db.from("study_log").select("id, subject, chapter, activity, accuracy, log_date, raw_input, feeling").order("id").range(from, to), "study_log"),
    fetchAll((from, to) => db.from("study_error").select("id, subject, knowledge, status, absorbed_at, log_date, kp_id, source").in("status", ["open", "absorbed"]).order("id").range(from, to), "study_error"),
    fetchAll((from, to) => db.from("error_book_v2").select("study_error_id, log_date, event_subject, event_kp_id, knowledge, event_status, absorbed_at, role, root_cause_code, failure_pattern_code, diagnosis_status, evidence_anchor, topic_id, topic_subject, topic_kp_id, chapter, section, topic_title, classification_status, mastery_status").order("study_error_id").range(from, to), "error_book_v2"),
    fetchAll((from, to) => db.from("error_review").select("id, topic_id, review_date, result, angle, evidence_anchor, note, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds").order("id").range(from, to), "error_review"),
    fetchAll((from, to) => db.from("ask_point_v2").select("id, subject, kp_id, question_type, step_stuck, confusion, status, effective_status, ttl_until, source, created_at, updated_at, resolved_at, resolution_note").order("id").range(from, to), "ask_point_v2"),
    fetchAll((from, to) => db.from("knowledge_point_v2").select("kp_id, subject, parent_kp, name, page, src_line, kaofa, zhenti_freq, zhenti_years, keypoints, anki_note_ids, anki_match_level, state_authority, legacy_mastery_ignored, catalog_updated_at").order("kp_id").range(from, to), "knowledge_point_v2"),
    fetchAll((from, to) => db.from("knowledge_evidence").select("id, operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id, cold, prompt_integrity, variant_kind, transfer_level, assessment_context, duration_seconds, failure_pattern_code, diagnosis_status, evidence_anchor, note, created_at").order("id").range(from, to), "knowledge_evidence"),
    fetchAll((from, to) => db.from("knowledge_object_link").select("id, operation_id, source_kind, source_id, kp_id, role, match_method, link_status, confidence, evidence_anchor, created_by, created_at, updated_at").order("id").range(from, to), "knowledge_object_link"),
    fetchAll((from, to) => db.from("knowledge_relation").select("id, operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage, strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by, created_at, updated_at").order("id").range(from, to), "knowledge_relation"),
  ]);

  const reciteParsed = parseReciteLedger(requiredFile(".local/带背挂账.md"), { referenceDate });
  const recite = summarizeReciteLedger(reciteParsed);
  if (recite.counts.errors) throw new Error(`评估事实源读取失败：带背挂账有 ${recite.counts.errors} 个结构错误`);
  const schedule = parseReviewSchedule(requiredFile(".local/复盘排期.md"), { referenceDate });
  if (schedule.counts.errors) throw new Error(`评估事实源读取失败：复盘排期有 ${schedule.counts.errors} 个结构错误`);
  const daily = parseDailyLedger(requiredFile(".local/日报台账.md"), { referenceDate });
  const subjective = parseSubjectiveLedger(requiredFile(".local/主观题台账.md"), { referenceDate });
  const probabilityForecastFile = ".local/概率预测台账.md";
  const probabilityForecasts = existsSync(probabilityForecastFile)
    ? summarizeProbabilityForecastLedger(
      assertValidProbabilityForecastLedger(parseProbabilityForecastLedger(readFileSync(probabilityForecastFile, "utf8")), "评估"),
      { referenceDate },
    )
    : null;
  const config = JSON.parse(requiredFile("config/coach.json"));
  const ankiExtract = loadAnkiExtract();
  const knowledgeCatalog = buildKnowledgeCatalog(knowledgePointRows, ankiExtract.notes);
  const examOutline = extractExamOutline();
  const quantV3 = buildQuantV3({ logs, errors, referenceDate, examOutline });
  const errorSummary = summarizeErrorBookRows(errorBookRows);
  const monthStart = `${referenceDate.slice(0, 7)}-01`;
  const ask = summarizeAskPoints(askRows, { referenceDate, periodStart: monthStart, periodEnd: referenceDate });
  const review30Start = dateMinus(referenceDate, 29);
  const reviews30 = reviews.filter((review) => String(review.review_date) >= review30Start && String(review.review_date) <= referenceDate);
  // [gpt] 2026-08-10：评估层只读重算迁移证明，不把旧 pass 或提示后通过等价成 stable 证据。
  const reviewProofs = [...new Set(reviews.map((review) => review.topic_id))]
    .map((topicId) => ({ topicId, ...summarizeReviewProof(reviews.filter((review) => review.topic_id === topicId)) }));
  const examDate = config["考试日期"];
  const baseDeadline = config["基础结业死线"];
  const coachEngine = buildLearningCoachSnapshot({
    referenceDate,
    errorSummary,
    reviews,
    reciteParsed,
    quantV3,
    studyLogs: logs,
    targets: config["目标分"],
    mockRecords: config["模拟分记录"]?.["记录"] ?? [],
    examDate,
    knowledgeCatalog,
    knowledgeEvidence,
    knowledgeObjectLinks,
    knowledgeRelations,
    errorBookRows,
    // [gpt] 2026-08-10：同一份唯一排期同时供派单占位与干预响应重算，避免另建效果真相账。
    reviewSchedule: schedule,
    dispatchLimit: 3,
  });

  return {
    // [gpt] 2026-08-10：v5 在 subjective 下新增内部 capabilityProfile / propagation 派生视图。
    schemaVersion: 7, // [gpt] 2026-08-10：新增分层概率门槛、概率预测台账与 Brier 校准视图。
    referenceDate,
    dates: {
      examDate,
      daysToExam: dateDistance(referenceDate, examDate),
      baseDeadline,
      daysToBaseDeadline: dateDistance(referenceDate, baseDeadline),
      firstMock: config["首次模拟"],
      daysToFirstMock: dateDistance(referenceDate, config["首次模拟"]),
    },
    targets: config["目标分"],
    rounds: config["轮次表"],
    quantV3,
    study: summarizeStudy(logs, referenceDate),
    errorBook: {
      eventCounts: errorSummary.eventCounts,
      masteryCounts: errorSummary.masteryCounts,
      activeTopics: errorSummary.activeTopics.length,
      awaitingColdReviewTopics: errorSummary.awaitingColdReviewTopics.length,
      unclassifiedEvents: errorSummary.unclassifiedEvents.length,
      recurrentTopics: errorSummary.topics.filter((topic) => topic.recurrent).length,
      topActive: errorSummary.activeTopics.slice(0, 10).map((topic) => ({ id: topic.id, subject: topic.subject, title: topic.title, eventTotal: topic.eventTotal, openEvents: topic.eventCounts.open, masteryStatus: topic.masteryStatus, latestOpenDate: topic.latestOpenDate })),
    },
    coldReviews: {
      total: reviews.length,
      last30d: reviews30.length,
      last30dByResult: Object.fromEntries(["pass", "partial", "fail", "void"].map((result) => [result, reviews30.filter((review) => review.result === result).length])),
      qualifyingTransferPasses: reviewProofs.reduce((sum, proof) => sum + proof.qualifyingPassCount, 0),
      legacyPasses: reviewProofs.reduce((sum, proof) => sum + proof.legacyPassCount, 0),
      stableProofTopics: reviewProofs.filter((proof) => proof.stable).length,
      latestDate: reviews.map((review) => String(review.review_date ?? "")).sort().at(-1) ?? null,
    },
    askPoints: {
      counts: ask.counts,
      active: ask.activePoints.length,
      month: ask.period,
      oldestActive: ask.activePoints.slice(0, 5),
    },
    recite: {
      counts: recite.counts,
      bySubject: recite.bySubject,
      oldestActive: recite.oldestActive.map((entry) => ({ id: entry.id, subject: entry.subject, title: entry.title, lastTouchedOn: entry.lastTouchedOn, ageDays: entry.ageDays })),
      withdrawnReviewCandidates: recite.withdrawnReviewCandidates.map((entry) => ({ id: entry.id, subject: entry.subject, title: entry.title, lastTouchedOn: entry.lastTouchedOn })),
      flow30d: summarizeReciteTransitions(reciteParsed, { start: dateMinus(referenceDate, 29), end: referenceDate }),
    },
    knowledgePoints: {
      catalog: knowledgeCatalog.counts,
      catalogIssues: knowledgeCatalog.issues.slice(0, 50),
      evidence: knowledgeEvidence.length,
      objectLinks: knowledgeObjectLinks.length,
      relations: knowledgeRelations.length,
      anki: {
        available: ankiExtract.available,
        path: ankiExtract.path,
        notes: ankiExtract.notes.length,
        issue: ankiExtract.issue,
      },
    },
    dailyExecution: daily,
    reviewSchedule: {
      counts: schedule.counts,
      overdue: schedule.overdue.slice(0, 20),
      dueToday: schedule.dueToday,
      upcoming: schedule.upcoming.slice(0, 20),
      issues: schedule.issues,
    },
    subjective,
    coachEngine,
    probabilityForecasts,
    sources: {
      database: ["study_log", "study_error", "error_book_v2", "error_review", "ask_point_v2", "knowledge_point_v2", "knowledge_evidence", "knowledge_object_link", "knowledge_relation"],
      local: [".local/带背挂账.md", ".local/日报台账.md", ".local/复盘排期.md", ".local/主观题台账.md", existsSync(probabilityForecastFile) ? probabilityForecastFile : null, "config/coach.json", "src/lib/exam-outline.gen.ts", ankiExtract.path].filter(Boolean),
    },
  };
}

export function formatAssessmentSnapshot(snapshot) {
  const q = snapshot.quantV3;
  const e = snapshot.errorBook;
  const r = snapshot.recite;
  const d = snapshot.dailyExecution;
  const s = snapshot.reviewSchedule;
  const w = snapshot.subjective;
  const c = snapshot.coachEngine;
  const probabilityForecasts = snapshot.probabilityForecasts;
  const subjectProbabilities = c.examForecast.calibration.mock.subjects
    .filter((item) => item.projection?.attainmentProbability != null)
    .map((item) => `${item.subject}${item.projection.attainmentProbability}%[${item.projection.probabilityBand.join("-")}]`)
    .join(" / ");
  return [
    `评估事实快照（北京 ${snapshot.referenceDate}，schema v${snapshot.schemaVersion}，量化 v${q.version}）`,
    `距首次模拟 ${snapshot.dates.daysToFirstMock} 天 / 基础结业 ${snapshot.dates.daysToBaseDeadline} 天 / 初试 ${snapshot.dates.daysToExam} 天`,
    `量化：综合 ${q.overall.index} / 专业课 ${q.overall.proIndex} / 最弱 ${q.overall.weakest.subject}${q.overall.weakest.ability} / 英语 ${q.overall.english.ability}`,
    `错题：open事件 ${e.eventCounts.open} / 累计已吸收事件 ${e.eventCounts.absorbed}；活跃主题 ${e.activeTopics} / 待冷检 ${e.awaitingColdReviewTopics} / stable ${e.masteryCounts.stable}`,
    `带背：active ${r.counts.active} / 可复检 ${r.counts.actionable} / 撤池 ${r.counts.withdrawn}；近30天流水 新挂${r.flow30d.byEvent.new}/撤${r.flow30d.byEvent.withdraw}/重挂${r.flow30d.byEvent.rehang}/移交${r.flow30d.byEvent.transfer}`,
    `日报：${d.counts.days} 个日块，严格完成 ${d.counts.completed}/${d.counts.total || "无可判证据"}，断链 ${d.gaps.length} 段，最新 ${d.latestDate ?? "无"}`,
    `排期：逾期 ${s.counts.overdue} / 今日 ${s.counts.dueToday} / 未来 ${s.counts.upcoming}（结构化 ${s.counts.canonical}，旧格式 ${s.counts.legacy}）`,
    `主观题：案例 ${w.counts.cases} / 论述 ${w.counts.essays} / 挂病灶 ${w.counts.activeDefects}；首稿均分 ${w.scores.averageDraft ?? "无样本"}/15，最新稿均分 ${w.scores.averageLatest ?? "无样本"}/15`,
    `教练状态：强化 ${c.topicStates.counts.reinforcing} / 冷却 ${c.topicStates.counts.cooling} / 稳定 ${c.topicStates.counts.stable} / 长期保持 ${c.topicStates.counts.maintenance}；主题到期 ${c.topicStates.due.length} / 带背到期 ${c.reciteMemory.counts.due}`,
    `知识点：激活 ${c.knowledgeStates.counts.activated}/${c.knowledgeStates.counts.total} / 可派单 ${c.knowledgeStates.counts.dispatchEligible} / 今日已衰减 ${c.knowledgeStates.counts.decayed} / 稳定 ${c.knowledgeStates.counts.activatedByStage.stable} / 考试就绪 ${c.knowledgeStates.counts.examReady}；图谱前置 ${c.knowledgeGraph.counts.confirmedPrerequisites} / 活跃受阻 ${c.knowledgeGraph.counts.activeBlockedTargets}`,
    `考试风险：${c.examRisk.topRisks.map((item) => `${item.subject}${item.riskScore}`).join(" / ") || "无"}（调度分，校准=${c.examRisk.calibration.status}）`,
    `失分前瞻：${c.examForecast.hotspots.slice(0, 3).map((item) => `${item.kpId}:${item.lossRiskIndex}`).join(" / ") || "无已观测点"}（压力排序，非概率；校准=${c.examForecast.calibration.status}/${c.examForecast.calibration.rankingConfidence}）`,
    `达标预测：${subjectProbabilities || c.examForecast.calibration.mock.reason}；概率回测=${probabilityForecasts ? `${probabilityForecasts.calibrationStatus}/N${probabilityForecasts.counts.resolved}/Brier ${probabilityForecasts.overall.brierScore ?? "—"}` : "尚未建账"}`,
    `控制器：${c.controller.mode}（${c.controller.reason}）｜${c.controller.policyText}`,
    "已写 .local/assessment-snapshot.json；pinggu-pc 只据该快照下结论，缺失字段不得脑补。",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = flags(process.argv.slice(2));
  const referenceDate = options.today && options.today !== true ? String(options.today) : beijingDate();
  const snapshot = await collectAssessment(referenceDate);
  mkdirSync(".local", { recursive: true });
  // [gpt] 2026-08-10：只有跨过 N>=6 门槛的概率才自动留账；同一模考证据日期集合幂等，不按每天重复灌样本。
  const probabilityForecastFile = ".local/概率预测台账.md";
  const currentForecastLedger = existsSync(probabilityForecastFile) ? readFileSync(probabilityForecastFile, "utf8") : "";
  const recorded = appendMockCalibrationForecasts(currentForecastLedger, snapshot.coachEngine.examForecast.calibration.mock, {
    referenceDate,
    targetDate: snapshot.dates.examDate,
  });
  if (recorded.additions.length) writeFileSync(probabilityForecastFile, recorded.markdown, "utf8");
  if (recorded.markdown) {
    snapshot.probabilityForecasts = summarizeProbabilityForecastLedger(parseProbabilityForecastLedger(recorded.markdown), { referenceDate });
    if (!snapshot.sources.local.includes(probabilityForecastFile)) snapshot.sources.local.push(probabilityForecastFile);
  }
  writeFileSync(".local/assessment-snapshot.json", `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatAssessmentSnapshot(snapshot));
}
