// node --env-file=.env.local scripts/weekly.mjs data [--week YYYY-MM-DD]
// node --env-file=.env.local scripts/weekly.mjs save --file <叙事.md> [--week YYYY-MM-DD]
// PC 端周报生产（weekly-pc skill 专用）：算本周真实数据 + 把【我(Opus)火力全开写的高质量叙事】
// 写进共享 weekly_report（upsert on week_start）。APP /weekly 页只读它展示（周报=PC 生产、APP 展示）。
// 学习流水与事件窗口沿用 src/lib/weekly-review.ts；PC 端额外读取 v2 主题/冷复检证据，
// 避免把“销账一次事件”误写成“解决一个长期弱项”。叙事零编造，只据真实数据。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { summarizeErrorBookRows } from "./lib/error-book-summary.mjs";
import { normalizeReviewEvidence } from "./lib/error-taxonomy.mjs";
import { parseReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";
import { summarizeAskPoints } from "./lib/ask-point-summary.mjs";
import { parseReviewSchedule, summarizeScheduleExecution } from "./lib/assessment-ledgers.mjs";
import { reciteEvidenceFromLinks, summarizeKnowledgeEvidence } from "./lib/knowledge-state.mjs";
import { buildReciteMemoryModel } from "./lib/learning-coach.mjs";
import { buildLearningController } from "./lib/learning-controller.mjs";

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"]; // 英语进周报叙事(2026-07-10 起)；量化v3(dashboard.ts)仍五科不动
const STUDY_ACTIVITIES = new Set(["听课", "看书", "做题", "背诵"]);
// [gpt] 2026-08-16：新流水统一存“背诵”；读取旧“带背/自背”时也折叠到同一展示活动。
const canonicalActivity = (activity) => activity === "带背" || activity === "自背" ? "背诵" : activity;
const cut = (value, limit = 90) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

function bjWeekMonday(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const dow = bj.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - diff)).toISOString().slice(0, 10);
}
const weekEndOf = (s) => new Date(new Date(s + "T00:00:00Z").getTime() + 6 * DAY).toISOString().slice(0, 10);
const bjDayStartTs = (ymd) => new Date(ymd + "T00:00:00+08:00").toISOString();
function parseFlags(args) { const o = {}; for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith("--")) ? args[++i] : true; return o; }

// 与 buildWeeklyReview 同口径聚合本周真实数据
async function buildReview(weekStart) {
  const weekEnd = weekEndOf(weekStart);
  const reciteParsed = parseReciteLedger(readFileSync(".local/带背挂账.md", "utf8"), { referenceDate: weekEnd });
  const reciteSummary = summarizeReciteLedger(reciteParsed);
  const reciteFlow = summarizeReciteTransitions(reciteParsed, { start: weekStart, end: weekEnd });
  if (reciteSummary.counts.errors) throw new Error(`周报事实源读取失败：带背账本有 ${reciteSummary.counts.errors} 个结构错误；先运行 node scripts/daibei-ledger.mjs audit`);
  const scheduleFile = ".local/复盘排期.md";
  if (!existsSync(scheduleFile)) throw new Error(`周报事实源读取失败：缺 ${scheduleFile}`);
  const schedule = parseReviewSchedule(readFileSync(scheduleFile, "utf8"), { referenceDate: weekEnd });
  if (schedule.counts.errors) throw new Error(`周报事实源读取失败：复盘排期有 ${schedule.counts.errors} 个结构错误；先运行 node scripts/schedule.mjs check --today ${weekEnd}`);
  const scheduleExecution = summarizeScheduleExecution(schedule, { start: weekStart, end: weekEnd });
  const controller = buildLearningController({ schedule, referenceDate: weekEnd });
  const sinceTs = bjDayStartTs(weekStart);
  // 上界=下周一0点（北京时）：查当前周不影响（未来无数据），查历史周（pinggu-pc 逐周趋势）必须封顶，否则把之后的数据全卷进来
  const untilTs = bjDayStartTs(new Date(new Date(weekStart + "T00:00:00Z").getTime() + 7 * DAY).toISOString().slice(0, 10));
  const [study, ask, evC, evP, usage, absorbed, errorBook, reviews, prior, knowledgeEvidence, knowledgeLinks] = await Promise.all([
    db.from("study_log").select("subject, chapter, activity, feeling").gte("log_date", weekStart).lte("log_date", weekEnd),
    db.from("ask_point_v2").select("id, subject, kp_id, question_type, step_stuck, confusion, status, effective_status, ttl_until, source, created_at, updated_at, resolved_at, resolution_note").limit(5000),
    db.from("events").select("type").gte("created_at", sinceTs).lt("created_at", untilTs),
    db.from("events").select("type").eq("status", "pending"),
    db.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs).lt("ts", untilTs),
    db.from("study_error").select("subject, knowledge, absorbed_at").eq("status", "absorbed").gte("absorbed_at", sinceTs).lt("absorbed_at", untilTs),
    db.from("error_book_v2").select("study_error_id, log_date, event_subject, knowledge, event_status, absorbed_at, role, root_cause_code, diagnosis_status, topic_id, topic_subject, chapter, section, topic_title, classification_status, mastery_status").limit(5000),
    db.from("error_review").select("topic_id, review_date, result, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds, angle, evidence_anchor").gte("review_date", weekStart).lte("review_date", weekEnd).limit(5000),
    db.from("weekly_report").select("week_start, content").lt("week_start", weekStart).order("week_start", { ascending: false }).limit(1),
    db.from("knowledge_evidence").select("operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id, cold, prompt_integrity, variant_kind, transfer_level, assessment_context, duration_seconds, failure_pattern_code, diagnosis_status, evidence_anchor, note").gte("evidence_date", weekStart).lte("evidence_date", weekEnd).limit(5000),
    db.from("knowledge_object_link").select("source_kind, source_id, kp_id, role, link_status, confidence, evidence_anchor").eq("source_kind", "recite_ledger").eq("link_status", "confirmed").limit(5000),
  ]);

  const probes = { 学习流水: study, 答疑: ask, 本周事件: evC, 待办: evP, 成本: usage, 销账事件: absorbed, 错题主题: errorBook, 冷复检: reviews, 上周周报: prior, 知识证据: knowledgeEvidence, 带背知识接线: knowledgeLinks };
  const broken = Object.entries(probes).filter(([, response]) => response.error);
  if (broken.length) throw new Error(`周报事实源读取失败：${broken.map(([name, response]) => `${name}=${response.error.message}`).join("；")}`);

  const studyRows = study.data ?? [];
  const studyMap = new Map();
  for (const s of studyRows) {
    const activity = canonicalActivity(s.activity);
    if (!SUBJECTS.includes(s.subject) || !STUDY_ACTIVITIES.has(activity) || !s.chapter) continue;
    const row = studyMap.get(s.subject) ?? { chapters: new Set(), activities: new Set() };
    row.chapters.add(String(s.chapter)); row.activities.add(activity); studyMap.set(s.subject, row);
  }
  const studied = [...studyMap.entries()].map(([subject, v]) => ({ subject, chapters: [...v.chapters], activities: [...v.activities] }));

  // 带背/背诵学习效果（feeling·掌握轨迹）：喂复盘层定"下周精度重点"；不卡章节（小结行 chapter=null 也收）
  const effects = studyRows
    .filter((s) => SUBJECTS.includes(s.subject) && s.feeling)
    .map((s) => ({ subject: s.subject, chapter: s.chapter ?? null, activity: canonicalActivity(s.activity) ?? "", feeling: String(s.feeling) }));
  const pr = prior.data?.[0];
  const priorReport = pr ? { weekStart: String(pr.week_start), content: String(pr.content ?? "").slice(0, 1500) } : null;

  const absorbedErrors = (absorbed.data ?? []).filter((r) => r.knowledge).map((r) => ({ subject: r.subject ?? "未分类", knowledge: cut(r.knowledge) }));

  const errorSummary = summarizeErrorBookRows(errorBook.data ?? []);
  const weakTop = errorSummary.activeTopics.slice(0, 8).map((topic) => ({
    topicId: topic.id,
    subject: topic.subject,
    knowledge: topic.title,
    n: topic.eventTotal,
    openEvents: topic.eventCounts.open,
    absorbedEvents: topic.eventCounts.absorbed,
    masteryStatus: topic.masteryStatus,
    last: topic.latestOpenDate,
  }));
  const topicById = new Map(errorSummary.topics.map((topic) => [topic.id, topic]));
  const unclassifiedBySubject = Object.fromEntries(
    [...new Set(errorSummary.unclassifiedEvents.map((event) => event.subject ?? "未分类"))]
      .map((subject) => [subject, errorSummary.unclassifiedEvents.filter((event) => (event.subject ?? "未分类") === subject).length]),
  );
  const reviewEvidence = (reviews.data ?? []).map((review, sequence) => {
    const normalized = normalizeReviewEvidence(review, sequence);
    return {
      topicId: review.topic_id,
      title: topicById.get(review.topic_id)?.title ?? `T#${review.topic_id}`,
      subject: topicById.get(review.topic_id)?.subject ?? null,
      date: String(review.review_date),
      result: review.result,
      dimension: normalized.dimension,
      cold: normalized.cold,
      promptIntegrity: normalized.promptIntegrity,
      variantKind: normalized.variantKind,
      transferLevel: normalized.transferLevel,
      assessmentContext: normalized.assessmentContext,
      durationSeconds: normalized.durationSeconds,
      qualifyingTransferPass: normalized.qualifyingTransferPass,
      angle: normalized.angle,
      evidenceAnchor: normalized.evidenceAnchor,
      masteryStatus: topicById.get(review.topic_id)?.masteryStatus ?? null,
    };
  });

  const askSummary = summarizeAskPoints(ask.data ?? [], { referenceDate: reciteSummary.referenceDate, periodStart: weekStart, periodEnd: weekEnd });
  const askPoints = askSummary.activePoints.slice(0, 10)
    .map((point) => ({ id: point.id, subject: point.subject, confusion: cut(point.confusion, 160), type: point.questionType ?? null, createdAt: point.createdAt }));

  const createdByType = {};
  for (const e of evC.data ?? []) createdByType[e.type] = (createdByType[e.type] ?? 0) + 1;

  let totalUsd = 0; const routeUsd = new Map();
  for (const u of usage.data ?? []) { const c = Number(u.est_cost_usd ?? 0); totalUsd += c; routeUsd.set(u.route, (routeUsd.get(u.route) ?? 0) + c); }

  // [gpt] 2026-08-10：带背证据只有唯一 confirmed KP 才进入知识层；零/多映射只报债务，不自动猜。
  const reciteMemory = buildReciteMemoryModel(reciteParsed, weekEnd, { objectLinks: knowledgeLinks.data ?? [] });
  const reciteKnowledgeEvidence = reciteEvidenceFromLinks(reciteMemory, knowledgeLinks.data ?? []);
  const knowledgeEvidenceSummary = summarizeKnowledgeEvidence(
    [...(knowledgeEvidence.data ?? []), ...reciteKnowledgeEvidence],
    { start: weekStart, end: weekEnd },
  );

  return {
    weekStart, weekEnd,
    activity: { askPointsCreated: askSummary.period.created, coachLogs: studyRows.length },
    studied, effects, priorReport,
    reciteLedger: {
      snapshotDate: reciteSummary.referenceDate,
      counts: reciteSummary.counts,
      bySubject: reciteSummary.bySubject,
      oldestActive: reciteSummary.oldestActive.map((entry) => ({ id: entry.id, subject: entry.subject, title: cut(entry.title), lastTouchedOn: entry.lastTouchedOn, ageDays: entry.ageDays })),
      withdrawnReviewCandidates: reciteSummary.withdrawnReviewCandidates.map((entry) => ({ id: entry.id, subject: entry.subject, title: cut(entry.title), lastTouchedOn: entry.lastTouchedOn })),
      flow: reciteFlow,
      mapping: {
        counts: reciteMemory.counts,
        debtPreview: reciteMemory.linkDebt.slice(0, 12),
      },
    },
    scheduleExecution, controller,
    knowledgeEvidence: knowledgeEvidenceSummary,
    solved: { absorbedErrors },
    weak: {
      top: weakTop,
      activeTopics: errorSummary.activeTopics.length,
      awaitingColdReviewTopics: errorSummary.awaitingColdReviewTopics.length,
      stableTopics: errorSummary.masteryCounts.stable,
      unclassifiedEvents: errorSummary.unclassifiedEvents.length,
      unclassifiedBySubject,
      awaitingColdReviewTop: errorSummary.awaitingColdReviewTopics.slice(0, 5).map((topic) => ({ topicId: topic.id, subject: topic.subject, title: topic.title, masteryStatus: topic.masteryStatus })),
    },
    review: { evidence: reviewEvidence },
    askPoints,
    askPointClosure: { clarified: askSummary.period.clarified, dismissed: askSummary.period.dismissed, superseded: askSummary.period.superseded, active: askSummary.activePoints.length, expired: askSummary.counts.expired },
    inbox: { createdByType, pendingBacklog: (evP.data ?? []).length },
    cost: { totalUsd, byRoute: [...routeUsd.entries()].map(([route, usd]) => ({ route, usd })).sort((a, b) => b.usd - a.usd) },
  };
}

function formatData(r) {
  const L = [`【本周真实使用数据 ${r.weekStart} ~ ${r.weekEnd}】`,
    `· 活动量：新增答疑卡点 ${r.activity.askPointsCreated} 条（不是答疑次数） / 教练打卡 ${r.activity.coachLogs} 条`, `· 学了什么：`];
  if (r.studied.length) for (const s of r.studied) L.push(`  - ${s.subject}：${s.chapters.join("、") || "（未记章节）"}${s.activities.length ? "　[" + s.activities.join("/") + "]" : ""}`);
  else L.push(`  - （本周无学习流水记录）`);
  if (r.effects?.length) { L.push(`· 背诵/学习效果（掌握轨迹，据此定下周精度重点）：`); for (const e of r.effects) L.push(`  - ${e.subject}${e.chapter ? "·" + e.chapter : ""}【${e.activity}】：${e.feeling}`); }
  L.push(`· 带背挂账当前快照（${r.reciteLedger.snapshotDate}，是当前存量、不是本周新增量）：active ${r.reciteLedger.counts.active} / 可复检 ${r.reciteLedger.counts.actionable} / Anki轨 ${r.reciteLedger.counts.anki} / 已撤池 ${r.reciteLedger.counts.withdrawn} / 移交 ${r.reciteLedger.counts.transferred}`);
  L.push(`  - 分科可复检：${Object.entries(r.reciteLedger.bySubject).filter(([, n]) => n).map(([subject, n]) => `${subject}${n}`).join("/") || "无"}；最久未碰：${r.reciteLedger.oldestActive.map((entry) => `${entry.id} ${entry.subject}·${entry.title}(${entry.lastTouchedOn ?? "?"})`).join("、") || "无"}`);
  L.push(`  - 已撤池轮抽候选：${r.reciteLedger.withdrawnReviewCandidates.map((entry) => `${entry.id} ${entry.subject}·${entry.title}(${entry.lastTouchedOn ?? "?"})`).join("、") || "无"}${r.reciteLedger.counts.warnings ? `；格式警告 ${r.reciteLedger.counts.warnings}` : ""}`);
  L.push(`  - 本周迁移流水：新挂 ${r.reciteLedger.flow.byEvent.new} / 撤池 ${r.reciteLedger.flow.byEvent.withdraw} / 重挂 ${r.reciteLedger.flow.byEvent.rehang} / 移交 ${r.reciteLedger.flow.byEvent.transfer} / 转 Anki ${r.reciteLedger.flow.byEvent["route-anki"]}（只认 append-only 流水；未留流水不倒推）`);
  const mapping = r.reciteLedger.mapping.counts;
  L.push(`  - 带背接线：唯一主链接 ${mapping.linked}/${mapping.items} / 零链接 ${mapping.unlinked} / 主链接歧义 ${mapping.ambiguousLinks}（未接入且有证据 ${mapping.evidenceUnlinked}、在挂 ${mapping.actionableUnlinked}）/ 多链接记录 ${mapping.multiLinked}；无唯一 primary 的证据仍留本地，补映射后再接入知识层`);
  const se = r.scheduleExecution;
  L.push(`· 学习控制器：${r.controller.mode}（${r.controller.reason}）｜${r.controller.policyText}`);
  L.push(`· 结构化排期履约（结案≠掌握）：本周应验收 ${se.counts.planned} / 周末前完成 ${se.counts.completedByEnd} / 周末前未完成 ${se.counts.notCompletedByEnd}；本周实际结案 ${se.counts.completedDuring} / 周末仍压着旧欠账 ${se.counts.backlogOpenAtEnd}`);
  for (const group of se.byRouteDimension.filter((item) => item.planned || item.completedDuring || item.backlogOpenAtEnd)) {
    L.push(`  - ${group.route}/${group.dimension}：应验收 ${group.planned} / 截周完成 ${group.completedByEnd} / 未完成 ${group.notCompletedByEnd} / 本周结案 ${group.completedDuring} / 旧欠账 ${group.backlogOpenAtEnd}`);
  }
  const ke = r.knowledgeEvidence;
  L.push(`· 三维结构化证据（只报事实，不折算掌握率）：观察 ${ke.counts.observed} / 合法 ${ke.counts.valid} / 干净通过 ${ke.counts.cleanPass}（冷检 ${ke.counts.coldCleanPass}）/ 半对或失败 ${ke.counts.setbacks} / 提示后通过 ${ke.counts.cuedPass} / 作废题干 ${ke.counts.voidOrInvalidPrompt}`);
  for (const [dimension, label] of [["understanding", "理解"], ["recall", "复述"], ["application", "应用"]]) {
    const bucket = ke.byDimension[dimension];
    L.push(`  - ${label}：证据 ${bucket.observed} / 干净通过 ${bucket.cleanPass}（冷检 ${bucket.coldCleanPass}）/ 半对或失败 ${bucket.setbacks} / 提示通过 ${bucket.cuedPass}`);
  }
  L.push(`  - 考场迁移证据：L4 干净通过 ${ke.byTransferLevel[4].cleanPass}（冷检 ${ke.byTransferLevel[4].coldCleanPass}）/ 限时干净通过 ${ke.byAssessmentContext.timed.cleanPass} / 成套模考干净通过 ${ke.byAssessmentContext.full_mock.cleanPass}；这是证据计数，不是达成概率`);
  L.push(`· 错题事件闭环：本周销账 ${r.solved.absorbedErrors.length} 条${r.solved.absorbedErrors.length ? "：" + r.solved.absorbedErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、") : ""}（销事件≠主题 stable）`);
  L.push(`· 主题复检：本周 ${r.review.evidence.length} 次${r.review.evidence.length ? "：" + r.review.evidence.map((e) => `${e.subject ?? "未分类"}·${e.title}=${e.result}${e.variantKind ? `/${e.variantKind}/L${e.transferLevel}` : "/legacy"}[${e.qualifyingTransferPass ? "合格迁移" : "留证不升级"}]→${e.masteryStatus ?? "?"}`).join("、") : ""}`);
  L.push(`· 需关注：`);
  L.push(`  - 活跃弱项主题 ${r.weak.activeTopics} 个：${r.weak.top.map((w) => `T#${w.topicId} ${w.subject ?? "未分类"}·${w.knowledge}${w.n > 1 ? `(事件×${w.n})` : ""}${w.absorbedEvents > 0 ? "[复发]" : ""}`).join("、") || "（暂无）"}`);
  const unclassifiedText = Object.entries(r.weak.unclassifiedBySubject ?? {}).map(([subject, count]) => `${subject}${count}`).join("/") || "无";
  L.push(`  - 事件已销但主题待冷检 ${r.weak.awaitingColdReviewTopics} 个：${r.weak.awaitingColdReviewTop.map((w) => `T#${w.topicId} ${w.subject ?? "未分类"}·${w.title}`).join("、") || "（无）"}；stable ${r.weak.stableTopics} 个；未归类事件 ${r.weak.unclassifiedEvents} 条（${unclassifiedText}${r.weak.unclassifiedBySubject?.英语 ? "，转英语私教" : ""}）`);
  L.push(`  - 答疑未收口卡点：${r.askPoints.map((a) => `${a.subject}${a.type ? "·" + a.type : ""} ${a.confusion}`).join("；") || "（无）"}`);
  L.push(`  - 答疑卡点闭环：本周打通 ${r.askPointClosure.clarified} / 移噪 ${r.askPointClosure.dismissed} / 被新卡点顶替 ${r.askPointClosure.superseded}；当前有效 open ${r.askPointClosure.active} / 过期 open ${r.askPointClosure.expired}`);
  L.push(`· 待办筐：本周新增 ${Object.entries(r.inbox.createdByType).map(([t, n]) => `${t}${n}`).join("/") || "无"}；待处理积压 ${r.inbox.pendingBacklog} 条`);
  if (r.priorReport?.content) { L.push(`\n【上一份周报（${r.priorReport.weekStart} 那周）——衔接用：对照上周"下周指导"看本周落实/欠账】`); L.push(r.priorReport.content); }
  return L.join("\n");
}

const cmd = process.argv[2];
const f = parseFlags(process.argv.slice(3));
const weekStart = (f.week && f.week !== true) ? f.week : bjWeekMonday();

if (cmd === "data") {
  const r = await buildReview(weekStart);
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/weekly-data.json", JSON.stringify(r, null, 2));
  console.log(formatData(r));
  console.log(`\n（事实源已存 .local/weekly-data.json；据它写高质量叙事到 .local/weekly-draft.md，再 weekly.mjs save --file .local/weekly-draft.md）`);
} else if (cmd === "save") {
  if (!f.file || f.file === true) { console.error("save 需要 --file <叙事markdown路径>"); process.exit(1); }
  const content = readFileSync(f.file, "utf8").trim();
  if (!content) { console.error("叙事文件为空"); process.exit(1); }
  const r = await buildReview(weekStart);
  const { error } = await db.from("weekly_report").upsert({
    week_start: r.weekStart, week_end: r.weekEnd, content, data_snapshot: r,
    model: "pc-codex", cost_usd: 0, generated_at: new Date().toISOString(),
  }, { onConflict: "week_start" });
  if (error) { console.error("✗ weekly_report 写入失败：" + error.message); process.exit(1); }
  console.log(`✅ 已写入共享 weekly_report（${r.weekStart}~${r.weekEnd}，PC 生产·¥0）。APP /weekly 叙事卡即刻展示这份。`);
} else {
  console.log("用法：node --env-file=.env.local scripts/weekly.mjs <data|save> [--week YYYY-MM-DD] [--file 叙事.md]");
}
