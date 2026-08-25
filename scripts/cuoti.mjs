// node --env-file=.env.local scripts/cuoti.mjs <命令> [参数]
// 错题复盘·出题考核的数据管道（电脑端 skill「cuoti-fupan」专用）。
//
// 数据同步纪律（2026-08-04 收口）：复盘写操作先进入本地 outbox，再立即尝试同步；
// 网络/数据库失败时只保留失败项，下一次写操作或 `sync` 自动重试。显式 `--stage` 才只暂存。
// 出题/判题由电脑端的我=Opus 直接做，不调 APP 的付费 API、不受 ¥1.5/轮预算约束。
//
// 只读命令（随时可跑）：
//   list [科目]            —— 拉错题本 open 行（带 #id、×累计错次、🔁复发），并标出已暂存待同步的
//   topics [科目]          —— 按 v2 长期弱项主题聚合，事件条数与掌握状态分开显示
//   profile [科目]         —— [gpt] 从已确认/待认领栽点证据派生个人错因画像（只读，不是掌握率）
//   proof [科目]           —— [gpt] 重算每个主题的迁移证明、稳定缺口与库内状态偏差
//   triage [科目] [n]      —— 列出尚未关联弱项主题的历史错题事件
//   material <词> [特征词]  —— 在 教材/做题心得/讲义心得/易混库/真题 里检索出题弹药（带页码/行号锚点；[gpt]）
//   recheck                —— 列销账 5-60 天的旧账，突袭抽查名单
// 写操作（先进本地缓冲 .local/cuoti-pending.jsonl）：
//   absorb <id...>         —— 销账（云确认掌握后）；也可 absorb --like <片段> [--subject 刑法]
//   add <科目> <事件说明> [--topic <标准主题> ...] —— 新增错题，可同时结构化归类
//   classify <id> --topic <标准主题> ... [--run SR-ID] —— 给历史错题补分类；认领病根时回写当前 Run（[gpt] 2026-08-13）
//   review <topic-id> <pass|partial|fail|void> ...   —— 记录结构化迁移证据；加 --schedule <排期id> 在证据同步成功后结案排期（[gpt] 有序一致性回写）
//   pending [--clear]      —— 查看待同步缓冲；--clear 清空
//   sync [--dry]           —— 重试 outbox；--dry 只预览不写。写命令加 --stage 可显式延后
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendOutbox,
  readOutbox,
  syncStudyOutbox,
  writeOutbox,
} from "./lib/study-outbox.mjs";
import { assertScheduleLink, closeScheduleItem } from "./lib/schedule-store.mjs";
import { loadEventAbsorptionProofs } from "./lib/error-absorption.mjs";
import { buildFailurePortrait, formatFailurePortrait } from "./lib/knowledge-state.mjs";
import { loadLocalMaterialCorpus, sortMaterialRows } from "./lib/material-corpus.mjs";
import { repeatedMaterialHint } from "./lib/skill-run-recovery.mjs";
import { assertCuotiJudgmentReady, assertSkillRunPrerequisites, readSkillRun, recordAutomaticSkillStep, recordBusinessWriteback, recordWritebackDeferred, validateDaibeiIngestReceipt } from "./lib/skill-run.mjs";
import { buildErrorIntakeBatchOperations, verifyExistingErrorIntakeBatch } from "./lib/error-intake-batch.mjs";
import { normalizeDiagnosisTransition } from "./lib/diagnosis-state.mjs";
import { validateErrorEntry } from "./lib/error-entry.mjs";
import {
  CLASSIFICATION_STATUSES,
  FAILURE_PATTERNS,
  REVIEW_PROBE_AXES,
  REVIEW_VARIANTS,
  ROOT_CAUSES,
  SUBJECTS,
  buildReviewEvidence,
  cleanTopicTitle,
  parseAddArgs,
  parseTopicOptions,
  recommendNextReviewProbe,
  summarizeReviewProof,
  validateDiagnosisStatus,
  validatePersistedDiagnosisStatus,
  validateFailurePattern,
  validateReviewDate,
  validateReviewResult,
  validateRootCause,
} from "./lib/error-taxonomy.mjs";

let db;

const DAY = 86400000;
const PENDING = ".local/cuoti-pending.jsonl";
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日（UTC+8）——别用 UTC，深夜零点后记录会归错天

// ---------- 本地待同步缓冲 ----------
function readPending() {
  return readOutbox(PENDING);
}
function appendPending(op) {
  // [gpt] 2026-08-13：所有 CLI 新错入口共用同一校验器，不能靠调用者记住字段规则。
  return appendOutbox(PENDING, op.op === "new_error" ? validateErrorEntry(op) : op);
}
function clearPending() {
  writeOutbox(PENDING, []);
}

async function fetchAllRows(build, label, pageSize = 500) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const response = await build(from, from + pageSize - 1);
    if (response.error) throw new Error(`读取${label}失败：${response.error.message}`);
    const page = response.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

// ---------- 老错题抽查·本地轮换台账（只记每条"上次抽查时间/次数"，纯本地调度元数据，
//   不进系统、不受同步纪律约束；台账丢了也不影响"永不遗忘"——那样全部退回"从没考过"，照样都会被轮到）----------
const LEDGER = ".local/cuoti-recheck.json";
function readLedger() {
  if (!existsSync(LEDGER)) return {};
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; }
}
function writeLedger(obj) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(obj, null, 2));
}

// ---------- list：错题本 ----------
async function loadTopicLinks(ids) {
  if (!ids.length) return new Map();
  const response = await db
    .from("study_error_topic")
    .select("study_error_id, role, root_cause_code, diagnosis_status, error_topic(id, title, mastery_status, classification_status)")
    .in("study_error_id", ids);
  if (response.error) {
    console.warn(`⚠️ v2 主题读取失败，已降级为旧错题视图：${response.error.message}`);
    return new Map();
  }
  const links = new Map();
  for (const row of response.data ?? []) {
    const current = links.get(row.study_error_id);
    if (!current || row.role === "primary") links.set(row.study_error_id, row);
  }
  return links;
}

async function list(subject) {
  // 拉全生命周期（open+absorbed），据此算【累计】错次与复发（销账不清零，同教练 aggregateErrorBook）
  const { data, error } = await db
    .from("study_error")
    .select("id, subject, kp_id, knowledge, log_date, status, absorbed_at")
    .in("status", ["open", "absorbed"])
    .limit(2000);
  if (error) return fail(error.message);

  const topicLinks = await loadTopicLinks((data ?? []).map((r) => r.id));
  const keyOf = (r) => topicLinks.get(r.id)?.error_topic?.id
    ? `topic:${topicLinks.get(r.id).error_topic.id}`
    : r.kp_id ?? `${r.subject ?? "未分类"}::${r.knowledge}`;
  const agg = new Map();
  for (const r of data ?? []) {
    const k = keyOf(r);
    const cur = agg.get(k) ?? { nOpen: 0, nAbs: 0, last: "" };
    if (r.status === "absorbed") cur.nAbs++;
    else { cur.nOpen++; const d = String(r.log_date ?? ""); if (d > cur.last) cur.last = d; }
    agg.set(k, cur);
  }

  // 已暂存待同步的 id（本地缓冲，尚未落库）
  const staged = new Set(readPending().filter((o) => o.op === "absorb").flatMap((o) => o.ids ?? []));

  let open = (data ?? []).filter((r) => r.status === "open");
  if (subject) open = open.filter((r) => r.subject === subject);
  const rows = open
    .map((r) => { const a = agg.get(keyOf(r)); return { ...r, total: a.nOpen + a.nAbs, recurN: a.nAbs }; })
    .sort((x, y) => y.total - x.total || (x.log_date < y.log_date ? 1 : -1));

  const bySubj = {};
  for (const r of rows) bySubj[r.subject ?? "未分类"] = (bySubj[r.subject ?? "未分类"] ?? 0) + 1;

  console.log(`错题本 open：${rows.length} 条` + (subject ? `（已筛 ${subject}）` : "") +
    "　按科目：" + (Object.entries(bySubj).map(([k, v]) => `${k}${v}`).join(" / ") || "空"));
  console.log("（#id=错题事件；T#id=长期弱项主题；×N=同主题累计错次；🔁×N=销账后复发轮数；⏳=待同步）\n");
  for (const r of rows) {
    const link = topicLinks.get(r.id);
    const topic = link?.error_topic;
    const flags = `${r.total > 1 ? " ×" + r.total : ""}${r.recurN > 0 ? " 🔁复发×" + r.recurN : ""}${staged.has(r.id) ? " ⏳待同步" : ""}`;
    console.log(`#${r.id}  [${r.subject ?? "?"}]${flags}  (${r.log_date})`);
    console.log(topic
      ? `     ↳ T#${topic.id} ${topic.title}｜${ROOT_CAUSES[link.root_cause_code] ?? link.root_cause_code}｜诊断 ${link.diagnosis_status}｜掌握 ${topic.mastery_status}`
      : "     ↳ [待归类] 尚未关联长期弱项主题");
    console.log(`     ${String(r.knowledge).replace(/\s+/g, " ").trim()}`);
  }
  if (!rows.length) console.log("（错题本是空的——没有待复盘的错题）");
  const pend = readPending();
  if (pend.length) console.log(`\n⚠️ outbox 有 ${pend.length} 条上次同步失败/显式暂存的操作——跑 pending 查看、sync 重试。`);
}

// ---------- topics / profile / triage：v2 主题、错因画像与历史待归类池 ----------
async function topics(subject) {
  let topicQuery = db
    .from("error_topic")
    .select("id, subject, chapter, section, kp_id, title, classification_status, mastery_status, created_at, updated_at")
    .order("updated_at", { ascending: false });
  if (subject) topicQuery = topicQuery.eq("subject", subject);
  const topicResponse = await topicQuery;
  if (topicResponse.error) return fail(`读取 v2 弱项主题失败：${topicResponse.error.message}`);
  const topicRows = topicResponse.data ?? [];
  if (!topicRows.length) return console.log(subject ? `${subject}暂无 v2 弱项主题。` : "暂无 v2 弱项主题；先用 classify 或带 --topic 的 add 归类。");

  const topicIds = topicRows.map((row) => row.id);
  const linkResponse = await db
    .from("study_error_topic")
    .select("topic_id, study_error_id, role, root_cause_code, diagnosis_status")
    .in("topic_id", topicIds);
  if (linkResponse.error) return fail(linkResponse.error.message);
  const eventIds = [...new Set((linkResponse.data ?? []).map((row) => row.study_error_id))];
  const eventResponse = eventIds.length
    ? await db.from("study_error").select("id, status, log_date").in("id", eventIds)
    : { data: [], error: null };
  if (eventResponse.error) return fail(eventResponse.error.message);
  const eventById = new Map((eventResponse.data ?? []).map((row) => [row.id, row]));

  console.log(`长期弱项主题：${topicRows.length} 个${subject ? `（${subject}）` : ""}\n`);
  for (const topic of topicRows) {
    const links = (linkResponse.data ?? []).filter((row) => row.topic_id === topic.id);
    const events = links.map((link) => eventById.get(link.study_error_id)).filter(Boolean);
    const counts = Object.fromEntries(["open", "absorbed", "dismissed"].map((status) => [status, events.filter((event) => event.status === status).length]));
    const causes = [...new Set(links.filter((link) => link.diagnosis_status === "confirmed").map((link) => ROOT_CAUSES[link.root_cause_code] ?? link.root_cause_code))];
    console.log(`T#${topic.id} [${topic.subject}] ${topic.title}｜掌握 ${topic.mastery_status}｜分类 ${topic.classification_status}`);
    console.log(`   ${[topic.chapter, topic.section, topic.kp_id].filter(Boolean).join(" · ") || "（章节/考点待补）"}｜事件 open ${counts.open} / absorbed ${counts.absorbed} / dismissed ${counts.dismissed}`);
    console.log(`   病根：${causes.join("、") || "待认领"}\n`);
  }
}

// [gpt] 2026-08-10：从错题/知识证据、confirmed 对象映射与稳定 kp 目录派生画像；不新增画像真相表。
async function profile(rest) {
  const args = [...rest];
  const json = args.includes("--json");
  const jsonIndex = args.indexOf("--json");
  if (jsonIndex !== -1) args.splice(jsonIndex, 1);
  let limitRaw;
  try { limitRaw = takeNamed(args, "--limit"); } catch (error) { return fail(error.message); }
  const limit = limitRaw == null ? 5 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("profile --limit 必须是 1-20 的整数");
  const subject = args.find((arg) => SUBJECTS.includes(arg)) ?? null;
  const unknown = args.filter((arg) => arg !== subject);
  if (unknown.length) return fail(`无法识别的 profile 参数：${unknown.join(" ")}`);

  let errorRows;
  let knowledgeEvidence;
  let objectLinks;
  let points;
  try {
    [errorRows, knowledgeEvidence, objectLinks, points] = await Promise.all([
      fetchAllRows(
        (from, to) => db.from("error_book_v2")
          .select("study_error_id, log_date, event_subject, event_kp_id, topic_id, topic_subject, topic_kp_id, failure_pattern_code, diagnosis_status, evidence_anchor, root_cause_note")
          .order("study_error_id").range(from, to),
        "错题栽点证据",
      ),
      fetchAllRows(
        (from, to) => db.from("knowledge_evidence")
          .select("id, operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id, cold, prompt_integrity, variant_kind, transfer_level, assessment_context, duration_seconds, failure_pattern_code, diagnosis_status, evidence_anchor, note")
          .order("id").range(from, to),
        "知识点表现证据",
      ),
      fetchAllRows(
        (from, to) => db.from("knowledge_object_link")
          .select("id, source_kind, source_id, kp_id, role, link_status")
          .order("id").range(from, to),
        "知识对象映射",
      ),
      fetchAllRows(
        (from, to) => db.from("knowledge_point_v2").select("kp_id, subject, name").order("kp_id").range(from, to),
        "知识点目录",
      ),
    ]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const portrait = buildFailurePortrait({
    errorRows,
    knowledgeEvidence,
    objectLinks,
    catalog: {
      items: points.map((point) => ({ kpId: point.kp_id, subject: point.subject, name: point.name })),
    },
  });
  if (json) {
    const output = subject ? {
      ...portrait,
      filter: { subject },
      byKnowledgePoint: portrait.byKnowledgePoint.filter((item) => item.subject === subject),
      bySubject: portrait.bySubject.filter((item) => item.subject === subject),
      unmatched: portrait.unmatched.filter((item) => item.subject === subject),
    } : portrait;
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(formatFailurePortrait(portrait, { subject, limit }));
}

// [gpt] 2026-08-10：只读重算迁移证明；库内 mastery_status 仅作为待核对缓存展示。
async function proof(rest) {
  const args = [...rest];
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  let topicIdRaw;
  let limitRaw;
  try {
    topicIdRaw = takeNamed(args, "--topic");
    limitRaw = takeNamed(args, "--limit");
  } catch (error) { return fail(error.message); }
  const topicId = topicIdRaw == null ? null : Number(topicIdRaw);
  if (topicIdRaw != null && (!Number.isInteger(topicId) || topicId <= 0)) return fail("proof --topic 需要正整数主题 id");
  const limit = limitRaw == null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail("proof --limit 必须是 1-200 的整数");
  const subject = args.find((arg) => SUBJECTS.includes(arg)) ?? null;
  const unknown = args.filter((arg) => arg !== subject);
  if (unknown.length) return fail(`无法识别的 proof 参数：${unknown.join(" ")}`);

  let topicQuery = db
    .from("error_topic")
    .select("id, subject, title, mastery_status, classification_status")
    .order("id");
  if (subject) topicQuery = topicQuery.eq("subject", subject);
  if (topicId) topicQuery = topicQuery.eq("id", topicId);
  const topicResponse = await topicQuery;
  if (topicResponse.error) return fail(`读取弱项主题失败：${topicResponse.error.message}`);
  const topicRows = topicResponse.data ?? [];
  if (!topicRows.length) return console.log("没有符合条件的弱项主题。");

  let reviewRows;
  let patternRows;
  try {
    [reviewRows, patternRows] = await Promise.all([
      fetchAllRows(
        (from, to) => db.from("error_review")
          // [gpt] 2026-08-10：审计视图保留事件指向与原答/依据 note，避免显示成 null。
          .select("id, topic_id, study_error_id, review_date, result, angle, evidence_anchor, note, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds")
          .in("topic_id", topicRows.map((topic) => topic.id))
          .order("id")
          .range(from, to),
        "复检迁移证据",
      ),
      fetchAllRows(
        (from, to) => db.from("study_error_topic")
          .select("study_error_id, topic_id, failure_pattern_code, diagnosis_status")
          .in("topic_id", topicRows.map((topic) => topic.id))
          .eq("diagnosis_status", "confirmed")
          .order("topic_id")
          .order("study_error_id")
          .range(from, to),
        "已确认栽点",
      ),
    ]);
  } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }

  const rank = { monitoring: 0, stable: 1, open: 2 };
  const items = topicRows.map((topic) => {
    const topicReviews = reviewRows.filter((reviewRow) => reviewRow.topic_id === topic.id);
    const summary = summarizeReviewProof(topicReviews);
    const confirmedFailurePatterns = [...new Set(patternRows
      .filter((row) => row.topic_id === topic.id && row.failure_pattern_code)
      .map((row) => row.failure_pattern_code))].sort();
    return {
      topicId: topic.id,
      subject: topic.subject,
      title: topic.title,
      classificationStatus: topic.classification_status,
      storedMasteryStatus: topic.mastery_status,
      computedMasteryStatus: summary.status,
      statusMismatch: topic.mastery_status !== summary.status,
      confirmedFailurePatterns,
      nextProbe: recommendNextReviewProbe(topicReviews, {
        referenceDate: today,
        failurePatternCode: confirmedFailurePatterns[0] ?? null,
      }),
      ...summary,
    };
  }).sort((left, right) => Number(right.statusMismatch) - Number(left.statusMismatch)
    || Number(right.substantiveCount > 0) - Number(left.substantiveCount > 0)
    || rank[left.computedMasteryStatus] - rank[right.computedMasteryStatus]
    || left.topicId - right.topicId);
  if (json) return console.log(JSON.stringify({ count: items.length, items }, null, 2));

  console.log(`迁移证明审计：${items.length} 个主题${subject ? `（${subject}）` : ""}；显示前 ${Math.min(limit, items.length)} 个。`);
  console.log("合格通过 = clean + 跨会话 + application + L3+ + 验证轴/角度/锚点；stable 另需跨 7 天、两个结构化验证轴、至少一次 L4+。");
  console.log("下一探针是命题处方，不是现成题目或掌握概率；执行时仍须先做教材/真题证据预检。\n");
  for (const item of items.slice(0, limit)) {
    const mismatch = item.statusMismatch ? ` ⚠️库内=${item.storedMasteryStatus}` : "";
    console.log(`T#${item.topicId} [${item.subject}] ${item.title}｜${item.computedMasteryStatus}${mismatch}`);
    console.log(`   合格迁移 ${item.qualifyingPassCount} 次 / ${item.passDates.length} 个北京日 / 跨度 ${item.spanDays} 天 / 验证轴 ${item.probeAxes.length} / L4+ ${item.hasNovelTransfer ? "有" : "无"}${item.legacyPassCount ? `｜旧 pass ${item.legacyPassCount} 次` : ""}`);
    console.log(`   ${item.blockers.length ? `缺口：${item.blockers.join("；")}` : "证据门槛已满足"}`);
    console.log(`   下一探针：最早 ${item.nextProbe.earliestDate}｜${item.nextProbe.variantKind}/L${item.nextProbe.transferLevel}｜${item.nextProbe.probeAxisLabel}（${item.nextProbe.probeAxis}）`);
    console.log(`   理由：${item.nextProbe.reason}${item.nextProbe.prerequisite ? `；前置：${item.nextProbe.prerequisite}` : ""}\n`);
  }
}

async function triage(rest) {
  const subject = rest.find((arg) => SUBJECTS.includes(arg));
  const n = Number(rest.find((arg) => /^\d+$/.test(arg))) || 20;
  let eventQuery = db
    .from("study_error")
    .select("id, subject, knowledge, status, log_date")
    .in("status", ["open", "absorbed"])
    .order("status", { ascending: false })
    .order("log_date", { ascending: false })
    .limit(3000);
  if (subject) eventQuery = eventQuery.eq("subject", subject);
  const [eventResponse, linkResponse] = await Promise.all([
    eventQuery,
    db.from("study_error_topic").select("study_error_id").limit(5000),
  ]);
  if (eventResponse.error) return fail(eventResponse.error.message);
  if (linkResponse.error) return fail(`读取 v2 关联失败：${linkResponse.error.message}`);
  const linked = new Set((linkResponse.data ?? []).map((row) => row.study_error_id));
  const unclassified = (eventResponse.data ?? []).filter((row) => !linked.has(row.id));
  console.log(`待归类错题事件：${unclassified.length} 条${subject ? `（${subject}）` : ""}；本次显示 ${Math.min(n, unclassified.length)} 条。`);
  console.log("归类：classify <id> --topic <标准主题> [--chapter ... --cause ... --diagnosis pending|confirmed --anchor ...]\n");
  for (const row of unclassified.slice(0, n)) {
    console.log(`#${row.id} [${row.subject ?? "?"}] ${row.status} ${row.log_date}\n   ${String(row.knowledge).replace(/\s+/g, " ").slice(0, 180)}`);
  }
}

// ---------- material：出题弹药检索 ----------
// 第三列＝该 kind 的保底字符配额（前面的 kind 吃不掉后面的，省下的才向后滚）
export const KINDS = [
  ["xinde", "做题心得/讲义心得(马工程·提示·易错·辨析·总结)", 4000],
  ["textbook", "教材重排/机构讲义/法律更新混合库（按路径辨源）", 5000],
  ["yixiao", "易混概念库", 2000],
  ["exam", "真题原卷/随卷参考答案解析", 4000],
  ["zhenti", "真题二次总结/高频/主观题汇总", 3000],
];
const CTX = 2, CLIP = 150, MAX_BLOCKS_PER_KIND = 6;
const PAGE_ANCHOR_PATTERNS = [
  /^\s*=+\s*第\s*(\d+)\s*页\s*=+\s*$/,
  /^\s*[\[(【]?\s*第\s*(\d+)\s*页\s*[\])】]?\s*$/,
  /^\s*(?:page|p\.)\s*(\d+)\s*$/i,
];

export function findNearestPageAnchor(lines, hitIndex, base = 1) {
  for (let i = hitIndex; i >= 0; i -= 1) {
    for (const pattern of PAGE_ANCHOR_PATTERNS) {
      const match = String(lines[i]).match(pattern);
      if (match) return { page: Number(match[1]), line: base + i };
    }
  }
  return null;
}

export function requireMaterialRows(response, kind) {
  if (response?.error) {
    throw new Error(`读取 material 来源 ${kind} 失败：${response.error.message ?? String(response.error)}`);
  }
  return response?.data ?? [];
}

export function clip(s, anchor) {
  const text = String(s).trim();
  if (text.length <= CLIP) return text;
  const hit = anchor ? text.indexOf(anchor) : -1;
  if (hit < 0) return text.slice(0, CLIP) + "…";

  // OCR/解析文本偶有超长行；窗口围绕命中词展开，避免“命中了却看不见词”。
  const width = Math.max(CLIP, anchor.length);
  const roomAroundAnchor = Math.max(0, width - anchor.length);
  let start = Math.max(0, hit - Math.floor(roomAroundAnchor / 2));
  start = Math.min(start, Math.max(0, text.length - width));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function grep(rows, keyword, refine) {
  const blocks = [];
  let totalHits = 0;
  for (const row of rows) {
    const lines = String(row.content).split("\n");
    const base = row.start_line ?? 1;
    const hits = [];
    lines.forEach((ln, i) => { if (ln.includes(keyword) && !/\.{6,}/.test(ln)) hits.push(i); });
    totalHits += hits.length;
    const spans = [];
    for (const i of hits) {
      const from = Math.max(0, i - CTX), to = Math.min(lines.length - 1, i + CTX);
      const cur = spans[spans.length - 1];
      if (cur && from <= cur.to + 1) { cur.to = to; cur.hits.push(i); }
      else spans.push({ from, to, hits: [i] });
    }
    for (const s of spans) {
      const hitSet = new Set(s.hits);
      let refineHit = false;
      const text = [];
      for (let i = s.from; i <= s.to; i++) {
        if (refine && lines[i].includes(refine)) refineHit = true;
        const anchor = hitSet.has(i) ? keyword : (refine && lines[i].includes(refine) ? refine : undefined);
        text.push(`${base + i}${hitSet.has(i) ? "►" : " "} ${clip(lines[i], anchor)}`);
      }
      blocks.push({
        path: row.path,
        lines: s.hits.map((i) => base + i),
        text: text.join("\n"),
        refineHit,
        pageAnchor: findNearestPageAnchor(lines, s.hits[0], base),
      });
    }
  }
  blocks.sort((a, b) => {
    if (refine) { const c = (b.refineHit ? 1 : 0) - (a.refineHit ? 1 : 0); if (c) return c; }
    return b.lines.length - a.lines.length;
  });
  return { blocks, totalHits };
}

export function formatMaterialBlocks(blocks, budget, maxBlocks = MAX_BLOCKS_PER_KIND) {
  const segments = [];
  let used = 0;
  for (const block of blocks.slice(0, maxBlocks)) {
    const page = block.pageAnchor
      ? `｜最近页码：第${block.pageAnchor.page}页（页码锚点行 ${block.pageAnchor.line}）`
      : "";
    let segment = `· ${block.path}${page}\n${block.text}`;
    if (used + segment.length > budget) {
      if (segments.length) break;
      segment = segment.slice(0, budget) + "\n…（本片段过长已截断）";
    }
    segments.push(segment);
    used += segment.length;
  }
  return { segments, used, shown: segments.length };
}

// [gpt] 2026-08-11：输出生成保持纯函数，单查与批量查询共用同一质量路径。
export function buildMaterialOutput(corpus, keyword, refine) {
  if (!keyword) throw new Error("material 需要关键词，如：material 想象竞合 因果");
  const output = [
    `检索「${keyword}${refine ? " + " + refine : ""}」的出题弹药（►=命中行，自动附最近页码/行号锚点）`,
  ];
  if (refine) output.push(`（特征词「${refine}」同时命中的条目已置顶）`);
  // 配额制（2026-07-22 修）：原先四个 kind 共享一个 14000 总预算、超了直接 return，
  // 宽词下 xinde 的合并巨块一段就吃光，教材/易混/真题整段不输出 → 预检"教材锚定"写成"无"＝假阴性。
  // 现在每个 kind 有保底额度，且有命中就至少出一块，绝不整段空手。
  let carry = 0;
  for (const [kind, label, quota] of KINDS) {
    const rows = corpus.get(kind) ?? [];
    const { blocks, totalHits } = grep(rows, keyword, refine);
    output.push("", `───── ${label}　命中 ${totalHits} 行 / ${blocks.length} 片段 ─────`);
    if (!blocks.length) { output.push("（无命中）"); carry += quota; continue; }
    const budget = quota + carry;
    const { segments, used, shown } = formatMaterialBlocks(blocks, budget);
    output.push(...segments);
    if (shown < blocks.length) output.push(`…（本段还有 ${blocks.length - shown} 个片段未显示，换更具体的关键词或加特征词再查）`);
    carry = Math.max(0, budget - used);
  }
  return output.join("\n");
}

export function parseMaterialArgs(args) {
  const positional = [];
  let source = "local";
  let runId = null;
  for (let index = 0; index < (args ?? []).length; index += 1) {
    const arg = args[index];
    if (arg === "--db") source = "db";
    else if (arg === "--run") {
      runId = args[++index];
      if (!runId || String(runId).startsWith("--")) throw new Error("material 的 --run 后需要 Skill Run ID");
    }
    else if (String(arg).startsWith("--")) throw new Error(`material 未知参数：${arg}`);
    else positional.push(arg);
  }
  if (!positional[0]) throw new Error("material 需要关键词，如：material 想象竞合 因果");
  if (positional.length > 2) throw new Error("material 最多接收关键词和一个特征词");
  return { source, runId, queries: [{ keyword: positional[0], refine: positional[1] }] };
}

export function parseMaterialBatchArgs(args) {
  const queries = [];
  let source = "local";
  let runId = null;
  for (let index = 0; index < (args ?? []).length; index += 1) {
    const arg = args[index];
    if (arg === "--db") {
      source = "db";
      continue;
    }
    if (arg === "--run") {
      runId = args[++index];
      if (!runId || String(runId).startsWith("--")) throw new Error("material-batch 的 --run 后需要 Skill Run ID");
      continue;
    }
    if (arg === "--query") {
      const keyword = args[++index];
      if (!keyword || String(keyword).startsWith("--")) throw new Error("material-batch 的 --query 后需要关键词");
      queries.push({ keyword, refine: undefined });
      continue;
    }
    if (arg === "--refine") {
      const refine = args[++index];
      if (!queries.length) throw new Error("material-batch 的 --refine 必须跟在对应 --query 后");
      if (!refine || String(refine).startsWith("--")) throw new Error("material-batch 的 --refine 后需要特征词");
      if (queries.at(-1).refine) throw new Error(`查询「${queries.at(-1).keyword}」只能设置一个 --refine`);
      queries.at(-1).refine = refine;
      continue;
    }
    throw new Error(`material-batch 未知参数：${arg}`);
  }
  if (!queries.length) throw new Error("material-batch 至少需要一个 --query <关键词>");
  return { source, runId, queries };
}

export function buildMaterialBatchOutput(corpus, queries) {
  return queries
    .map(({ keyword, refine }) => buildMaterialOutput(corpus, keyword, refine))
    .join("\n\n══════════ 下一组独立检索 ══════════\n\n");
}

// [claude] 2026-08-25：把每类材料的真实命中数签进 Run，让 ask-pc 的六步预检能从
// 检索回执推导，而不是靠执行者自己填。原先 evidenceRef 只有 queries:N，预检的
// 「心得/易混/教材/真题各命中没有」四项无从校验，只能自签——这正是 8-25 答疑
// 实测里我签了 preflight_checked 却没做预检的口子。
export function summarizeMaterialHits(corpus, queries) {
  const totals = Object.fromEntries(KINDS.map(([kind]) => [kind, 0]));
  for (const { keyword, refine } of queries ?? []) {
    for (const [kind] of KINDS) {
      const { totalHits } = grep(corpus.get(kind) ?? [], keyword, refine);
      totals[kind] += totalHits;
    }
  }
  return totals;
}

export function formatMaterialEvidenceRef(queries, hits) {
  const parts = [`q:${(queries ?? []).length}`];
  for (const [kind] of KINDS) parts.push(`${kind}:${hits?.[kind] ?? 0}`);
  return parts.join("|");
}

export function parseMaterialEvidenceRef(evidenceRef) {
  const out = { queries: 0 };
  for (const [kind] of KINDS) out[kind] = 0;
  for (const part of String(evidenceRef ?? "").split("|")) {
    const [key, rawValue] = part.split(":");
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0) continue;
    if (key === "q" || key === "queries") out.queries = value;
    else if (key in out) out[key] = value;
  }
  return out;
}

async function loadDbMaterialCorpus() {
  const entries = await Promise.all(KINDS.map(async ([kind]) => {
    const response = await db.from("content_mirror").select("path, content, start_line").eq("kind", kind);
    return [kind, sortMaterialRows(requireMaterialRows(response, kind))];
  }));
  return new Map(entries);
}

async function runMaterialQueries({ source, queries, runId = null }) {
  const startedAt = Date.now();
  let corpus;
  try {
    corpus = source === "db"
      ? await loadDbMaterialCorpus()
      : (await loadLocalMaterialCorpus()).corpus;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  console.log(buildMaterialBatchOutput(corpus, queries));
  if (runId) {
    const run = recordAutomaticSkillStep({
      runId,
      step: "materials_checked",
      status: "pass",
      source: "cuoti-material",
      evidenceRef: formatMaterialEvidenceRef(queries, summarizeMaterialHits(corpus, queries)),
      durationMs: Date.now() - startedAt,
    });
    // [claude] 2026-08-24：在使用现场提醒，比写进 skill 文档管用。
    if (queries.length === 1) {
      const hint = repeatedMaterialHint(run?.events ?? []);
      if (hint) console.error(`ℹ️ ${hint}`);
    }
  }
}

async function material(args) {
  try {
    await runMaterialQueries(parseMaterialArgs(args));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function materialBatch(args) {
  try {
    await runMaterialQueries(parseMaterialBatchArgs(args));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// [gpt] 2026-08-10：CLI 先验门槛；outbox 同步时还会重新取事实证据，防止暂存后状态变化或手改缓冲。
async function absorptionProofsOrFail(rows) {
  let proofs;
  try {
    proofs = await loadEventAbsorptionProofs(db, rows, today);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return null;
  }
  const blocked = rows
    .map((row) => proofs.get(Number(row.id)))
    .filter((proof) => !proof?.eligible);
  if (blocked.length) {
    console.error("✗ 销账证据门槛未满足：");
    for (const proof of blocked) console.error(`   #${proof?.eventId ?? "?"} ${proof?.blockers.join("；") ?? "证据不可读"}`);
    process.exitCode = 1;
    return null;
  }
  return proofs;
}

// ---------- absorb：证据门槛通过后暂存销账到本地缓冲 ----------
async function absorb(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  if (rest[0] === "--like") {
    const like = rest[1];
    if (!like) return fail('absorb --like 需要片段，如：absorb --like 盗窃既遂 --subject 刑法');
    const si = rest.indexOf("--subject");
    const subject = si !== -1 ? rest[si + 1] : null;
    let sel = db.from("study_error").select("id, subject, knowledge, log_date, status").eq("status", "open").ilike("knowledge", `%${like}%`);
    if (subject) sel = sel.eq("subject", subject);
    const { data: hit, error } = await sel;
    if (error) return fail(error.message);
    if (!hit?.length) return console.log(`没有匹配「${like}」的 open 错题，未暂存。`);
    const proofs = await absorptionProofsOrFail(hit);
    if (!proofs) return;
    appendPending({ op: "absorb", ids: hit.map((r) => r.id), note: `模糊「${like}」`, items: hit.map((r) => `[${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 50)}`) });
    console.log(`⏳ 已暂存待同步·销账 ${hit.length} 条（模糊「${like}」）：`);
    for (const r of hit) console.log(`   #${r.id} [${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 60)}`);
    if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
    return sync([]);
  }
  const ids = rest.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return fail("absorb 需要错题 id（见 list），如：absorb 22  或  absorb --like 片段");
  const { data: rows, error } = await db.from("study_error").select("id, subject, knowledge, log_date, status").in("id", ids);
  if (error) return fail(error.message);
  const openRows = (rows ?? []).filter((r) => r.status === "open");
  const notOpen = ids.filter((id) => !openRows.some((r) => r.id === id));
  if (!openRows.length) return console.log("这些 id 里没有 open 状态的错题（可能已销账/不存在），未暂存。");
  const proofs = await absorptionProofsOrFail(openRows);
  if (!proofs) return;
  appendPending({ op: "absorb", ids: openRows.map((r) => r.id), items: openRows.map((r) => `[${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 50)}`) });
  console.log(`⏳ 已暂存待同步·销账 ${openRows.length} 条：`);
  for (const r of openRows) console.log(`   #${r.id} [${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 60)}`);
  if (notOpen.length) console.log(`（跳过非 open/不存在：${notOpen.map((x) => "#" + x).join(" ")}）`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync([]);
}

// [gpt] 2026-08-10：行政纠错只恢复原事件，不生成“抽查失败”或复发证据。
async function reopen(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let reason;
  try { reason = takeNamed(rest, "--reason"); } catch (error) { return fail(error.message); }
  if (!String(reason ?? "").trim()) return fail("reopen 必须提供 --reason 审计原因");
  const invalid = rest.filter((arg) => !/^\d+$/.test(String(arg)));
  if (invalid.length) return fail(`无法识别的 reopen 参数：${invalid.join(" ")}`);
  const ids = [...new Set(rest.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return fail("reopen 需要错题 id，如：reopen 102 --reason 教练误销账");
  const { data: rows, error } = await db.from("study_error").select("id, subject, knowledge, status").in("id", ids);
  if (error) return fail(error.message);
  const absorbedRows = (rows ?? []).filter((row) => row.status === "absorbed");
  const skipped = ids.filter((id) => !absorbedRows.some((row) => Number(row.id) === id));
  if (!absorbedRows.length) return console.log("这些 id 里没有 absorbed 状态的错题，未恢复。");
  appendPending({
    op: "reopen_error",
    ids: absorbedRows.map((row) => Number(row.id)),
    reason: String(reason).trim(),
    items: absorbedRows.map((row) => `[${row.subject ?? "?"}] ${String(row.knowledge).slice(0, 50)}`),
  });
  console.log(`⏳ 已暂存待同步·恢复误销账 ${absorbedRows.length} 条：`);
  for (const row of absorbedRows) console.log(`   #${row.id} [${row.subject ?? "?"}] ${String(row.knowledge).slice(0, 60)}`);
  if (skipped.length) console.log(`（跳过非 absorbed/不存在：${skipped.map((id) => `#${id}`).join(" ")}）`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync([]);
}

// ---------- add：暂存新错题到本地缓冲 ----------
// --recur-of <旧错题id>：显式标记"这条是老账复发"。2026-07-22 加——量化 v3 的重犯惩罚原本靠
// 「knowledge 全字符串相同」判重犯，而错题描述中位数 245 字、永不重复，惩罚实际形同虚设（实测
// 51 条只揪出 1 组）。重犯必须在【写入时】显式连线，不能靠事后猜文本相似度（那是伪精度、会错并）。
async function add(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let runId = null;
  try { runId = takeNamed(rest, "--run"); } catch (error) { return fail(error.message); }
  let parsed;
  try { parsed = parseAddArgs(rest); } catch (error) { return fail(error.message); }
  if (parsed.topic && !runId) return fail("带主题的新错题必须提供 --run，确保学习事实具有可追溯宿主身份");
  if (parsed.topic && parsed.topic.diagnosisStatus !== "unassessed") {
    return fail("add 只能新建 diagnosis=unassessed；用户认领/排除必须经当前 Run 的判题 Gate 后用 classify 写入");
  }
  if (parsed.topic) {
    if (["confirmed", "rejected", "untraceable"].includes(parsed.topic.diagnosisStatus)) parsed.topic.diagnosisDecidedRunId = runId;
  }
  const entrySource = parsed.recurOf ? "recurrence" : "direct";
  try {
    appendPending({ op: "new_error", ...parsed, entrySource });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`⏳ 已暂存待同步·新错题：[${parsed.subject}]${parsed.recurOf ? ` 🔁复发（源#${parsed.recurOf}）` : ""} ${parsed.knowledge}`);
  if (parsed.topic) {
    console.log(`   ↳ 主题「${parsed.topic.title}」｜病根 ${ROOT_CAUSES[parsed.topic.rootCauseCode]}｜诊断 ${parsed.topic.diagnosisStatus}`);
  } else if (!parsed.recurOf) {
    console.log("   ↳ 未提供 --topic：事件会保留，但进入 triage 待归类池，不再把整段错题文字冒充长期弱项。");
  }
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync([]);
}

// [gpt] 2026-08-13：一次写一条做题进度和整批截图错题，只同步一次。
async function recordBatch(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let runId = null;
  try { runId = takeNamed(rest, "--run"); } catch (error) { return fail(error.message); }
  const file = rest.shift();
  if (!file) return fail("record-batch 需要 JSON 清单路径");
  if (rest.length) return fail(`无法识别的 record-batch 参数：${rest.join(" ")}`);
  let batch;
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    batch = buildErrorIntakeBatchOperations(manifest, { today });
    if (runId) {
      assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan" });
    }
  } catch (error) {
    return fail(`批次预检失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const topicOperations = batch.operations.filter((operation) => operation.op === "new_error" && operation.topic);
  if (topicOperations.length && !runId) return fail("批次含主题时必须提供 --run，确保学习事实具有可追溯宿主身份");
  if (topicOperations.some((operation) => operation.topic.diagnosisStatus !== "unassessed")) {
    return fail("record-batch 的新错题只能写 diagnosis=unassessed；候选与用户决定不得批量预填");
  }
  for (const operation of topicOperations) {
    if (["confirmed", "rejected", "untraceable"].includes(operation.topic.diagnosisStatus)) operation.topic.diagnosisDecidedRunId = runId;
  }
  for (const operation of batch.operations) appendPending(operation);
  console.log(`⏳ 已暂存批次 ${batch.key}：学习日志 1 条 + 错题 ${batch.errorCount} 条｜${batch.summary}`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  const synced = await sync([]);
  if (!synced) return;
  if (runId) {
    recordBusinessWriteback({
      runId,
      source: "cuoti-record-batch",
      evidenceRef: `batch:${batch.key}:log=1:errors=${batch.errorCount}`,
      expectedSkill: "cuoti-fupan",
      requiredSteps: [],
    });
  }
  console.log(`✅ 批次已核验：只生成一条进度流水；${batch.errorCount} 张题图按 ${batch.errorCount} 道真实错题处理。`);
}

// [gpt] 2026-08-13：复跑历史任务时只核验唯一进度与既有错题，并为同一 intake Run 落业务回执。
async function verifyBatch(rest) {
  let runId = null;
  try { runId = takeNamed(rest, "--run"); } catch (error) { return fail(error.message); }
  const file = rest.shift();
  if (!file) return fail("verify-batch 需要 JSON 清单路径");
  if (!runId) return fail("verify-batch 必须提供 --run SR-ID");
  if (rest.length) return fail(`无法识别的 verify-batch 参数：${rest.join(" ")}`);
  try {
    assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan" });
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const batch = buildErrorIntakeBatchOperations(manifest, { today });
    const [logsResponse, errorsResponse] = await Promise.all([
      db.from("study_log").select("id,log_date,subject,chapter,activity,accuracy")
        .eq("log_date", batch.date).eq("subject", batch.subject).eq("chapter", batch.chapter),
      db.from("study_error").select("id,log_date,subject,knowledge")
        .eq("log_date", batch.date).eq("subject", batch.subject),
    ]);
    if (logsResponse.error) throw new Error(`读取进度流水失败：${logsResponse.error.message}`);
    if (errorsResponse.error) throw new Error(`读取错题事件失败：${errorsResponse.error.message}`);
    const verified = verifyExistingErrorIntakeBatch(manifest, {
      studyLogs: logsResponse.data,
      errors: errorsResponse.data,
    }, { today });
    recordBusinessWriteback({
      runId,
      source: "cuoti-verify-batch",
      evidenceRef: `existing:log#${verified.studyLogId}:errors#${verified.errorIds.join(",")}`,
      expectedSkill: "cuoti-fupan",
      requiredSteps: [],
    });
    console.log(`BATCH_ALREADY_VERIFIED｜log#${verified.studyLogId}｜errors#${verified.errorIds.join(",")}｜${verified.summary}`);
  } catch (error) {
    return fail(`既有批次核验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function classify(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let runId;
  let activeRun = null;
  try { runId = takeNamed(rest, "--run"); } catch (error) { return fail(error.message); }
  if (runId) {
    try {
      activeRun = assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan", steps: ["target_frozen"] });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const studyErrorId = Number(rest.shift());
  if (!Number.isInteger(studyErrorId) || studyErrorId <= 0) return fail("classify 需要错题事件 id，如：classify 81 --topic 监护人顺位");
  // [gpt] 2026-08-13：病根认领只能写回本轮冻结的 E#，禁止用另一个事件的 confirmed 回执解锁当前判题。
  if (activeRun) {
    const frozenRefs = new Set(String(activeRun.steps.target_frozen?.evidenceRef ?? "").match(/(?:T|E)#\d+/gu) ?? []);
    if (!frozenRefs.has(`E#${studyErrorId}`)) return fail(`classify --run 的事件 E#${studyErrorId} 不在本轮 target_frozen 中`);
  }
  let parsed;
  try { parsed = parseTopicOptions(rest, { requireTopic: true }); } catch (error) { return fail(error.message); }
  if (parsed.rest.length) return fail(`无法识别的 classify 参数：${parsed.rest.join(" ")}`);
  if (!runId) return fail("classify 必须提供产生本轮候选的 --run；禁止跨会话认领病根");
  if (!["confirmed", "rejected"].includes(parsed.topic.diagnosisStatus)) {
    return fail("classify 只接受 --diagnosis confirmed|rejected；pending 只在当前 Run artifact，用户明确忘记/不认领请用 mark-untraceable");
  }
  if (["confirmed", "rejected", "untraceable"].includes(parsed.topic.diagnosisStatus)) parsed.topic.diagnosisDecidedRunId = runId;
  try {
    normalizeDiagnosisTransition({
      fromStatus: "unassessed",
      toStatus: parsed.topic.diagnosisStatus,
      decisionRunId: parsed.topic.diagnosisDecidedRunId,
      untraceableAt: parsed.topic.untraceableAt,
      untraceableBy: parsed.topic.untraceableBy,
      untraceableReason: parsed.topic.untraceableReason,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  appendPending({ op: "classify_error", studyErrorId, topic: parsed.topic });
  console.log(`⏳ 已暂存待同步·归类 #${studyErrorId} →「${parsed.topic.title}」｜病根 ${ROOT_CAUSES[parsed.topic.rootCauseCode]}｜诊断 ${parsed.topic.diagnosisStatus}`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  const synced = await sync([]);
  if (!synced) return;
  // [gpt] 2026-08-13：用户认领或排除病根后，用真实归类同步回执解锁 result；pending 仍停在诊断问题阶段。
  if (runId && ["confirmed", "rejected", "untraceable"].includes(parsed.topic.diagnosisStatus)) {
    recordAutomaticSkillStep({
      runId,
      step: "diagnosis_recorded",
      source: "cuoti-classify",
      evidenceRef: `E#${studyErrorId}:diagnosis=${parsed.topic.diagnosisStatus}`,
      expectedSkill: "cuoti-fupan",
    });
  }
}

async function classifyBatch(rest) {
  const stageOnly = rest.includes("--stage");
  const file = rest.find((arg) => arg !== "--stage");
  if (!file) return fail("classify-batch 需要 JSON 文件路径");
  let rows;
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`读取批量归类文件失败：${error.message}`);
  }
  if (!Array.isArray(rows) || !rows.length) return fail("批量归类文件必须是非空 JSON 数组");
  const operations = [];
  try {
    for (const [index, row] of rows.entries()) {
      const studyErrorId = Number(row.studyErrorId);
      if (!Number.isInteger(studyErrorId) || studyErrorId <= 0) throw new Error(`第 ${index + 1} 项 studyErrorId 无效`);
      const title = cleanTopicTitle(row.topic?.title);
      if (!title) throw new Error(`第 ${index + 1} 项缺 topic.title`);
      const classificationStatus = row.topic.classificationStatus ?? "confirmed";
      if (!CLASSIFICATION_STATUSES.includes(classificationStatus)) throw new Error(`第 ${index + 1} 项 classificationStatus 无效`);
      const role = row.topic.role ?? "primary";
      if (!["primary", "related"].includes(role)) throw new Error(`第 ${index + 1} 项 role 无效`);
      operations.push({
        op: "classify_error",
        studyErrorId,
        topic: {
          title,
          chapter: row.topic.chapter ?? null,
          section: row.topic.section ?? null,
          kpId: row.topic.kpId ?? null,
          classificationStatus,
          rootCauseCode: validateRootCause(row.topic.rootCauseCode ?? "unclassified"),
          failurePatternCode: validateFailurePattern(row.topic.failurePatternCode),
          rootCauseNote: row.topic.rootCauseNote ?? null,
          diagnosisStatus: validatePersistedDiagnosisStatus(row.topic.diagnosisStatus ?? "unassessed"),
          evidenceAnchor: row.topic.evidenceAnchor ?? null,
          role,
        },
      });
      if (operations.at(-1).topic.diagnosisStatus !== "unassessed") {
        throw new Error(`第 ${index + 1} 项 classify-batch 只能写 unassessed；用户认领/排除必须走当前 Run 的 classify`);
      }
    }
  } catch (error) { return fail(error.message); }
  for (const op of operations) appendPending(op);
  console.log(`⏳ 已暂存批量归类 ${operations.length} 条（${file}）`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；可先 sync --dry 预览。）");
  await sync([]);
}

// [gpt] 2026-08-25：只有用户明确说忘了/不认领才落不可追溯；断网、Stop 与 Run 中止不得调用。
async function markDiagnosisUntraceable(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let runId;
  let reason;
  let userRef;
  try {
    runId = takeNamed(rest, "--run");
    reason = takeNamed(rest, "--reason");
    userRef = takeNamed(rest, "--user-ref");
  } catch (error) {
    return fail(error.message);
  }
  const studyErrorId = Number(rest.shift());
  if (!Number.isInteger(studyErrorId) || studyErrorId <= 0) return fail("mark-untraceable 需要错题事件 id");
  if (!runId) return fail("mark-untraceable 必须提供当前 --run");
  if (!String(reason ?? "").trim()) return fail("mark-untraceable 必须提供 --reason，记录用户明确决定的内容");
  // [gpt] 2026-08-25：写库入口与判题卡统一要求 user: 原话引用，避免 run_close/Stop 冒充用户决定。
  if (!/^user:\s*\S/iu.test(String(userRef ?? "").trim())) {
    return fail("mark-untraceable 的 --user-ref 必须以 user: 开头并带用户原话或回合引用；Run 中止不能代替");
  }
  if (rest.length) return fail(`无法识别的 mark-untraceable 参数：${rest.join(" ")}`);
  let activeRun;
  try {
    activeRun = assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan", steps: ["target_frozen"] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const frozenRefs = new Set(String(activeRun.steps.target_frozen?.evidenceRef ?? "").match(/(?:T|E)#\d+/gu) ?? []);
  if (!frozenRefs.has(`E#${studyErrorId}`)) return fail(`E#${studyErrorId} 不在本轮 target_frozen 中`);
  const response = await db.from("study_error_topic")
    .select("topic_id, diagnosis_status, role")
    .eq("study_error_id", studyErrorId)
    .eq("role", "primary")
    .maybeSingle();
  if (response.error) return fail(`读取待终结病根失败：${response.error.message}`);
  if (!response.data?.topic_id) return fail(`E#${studyErrorId} 没有唯一 primary 主题关系`);
  const untraceableAt = new Date().toISOString();
  try {
    normalizeDiagnosisTransition({
      fromStatus: response.data.diagnosis_status,
      toStatus: "untraceable",
      decisionRunId: runId,
      untraceableAt,
      untraceableBy: "user",
      untraceableReason: String(reason).trim(),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const staged = appendPending({
    op: "mark_diagnosis_untraceable",
    studyErrorId,
    topicId: Number(response.data.topic_id),
    runId,
    reason: String(reason).trim(),
    userRef: String(userRef).trim(),
    untraceableAt,
  });
  console.log(`⏳ 已暂存用户明确决定：E#${studyErrorId}/T#${response.data.topic_id} → untraceable；错题事件保持原状态`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；同步成功前不能收口 Run。）");
  const synced = await sync([]);
  if (!synced) return;
  recordAutomaticSkillStep({
    runId,
    step: "diagnosis_recorded",
    source: "cuoti-mark-untraceable",
    evidenceRef: `E#${studyErrorId}:diagnosis=untraceable`,
    expectedSkill: "cuoti-fupan",
  });
  console.log(`DIAGNOSIS_UNTRACEABLE｜${runId}｜E#${studyErrorId}/T#${response.data.topic_id}｜operation=${staged.operation_id}`);
}

function takeNamed(rest, name) {
  const index = rest.indexOf(name);
  if (index === -1) return null;
  const value = rest[index + 1];
  if (value == null || String(value).startsWith("--")) throw new Error(`${name} 需要一个值`);
  rest.splice(index, 2);
  return value;
}

async function review(rest) {
  const reviewStartedAt = Date.now();
  const runIndex = rest.indexOf("--run");
  const runId = runIndex === -1 ? null : rest[runIndex + 1];
  if (runIndex !== -1) {
    if (!runId || String(runId).startsWith("--")) return fail("review 的 --run 后需要 Skill Run ID");
    rest = [...rest.slice(0, runIndex), ...rest.slice(runIndex + 2)];
  }
  if (runId) {
    try {
      assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan", steps: ["target_frozen", "materials_checked", "question_integrity_pass"] });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  const sameSession = rest.includes("--same-session");
  const cued = rest.includes("--cued");
  const invalidPrompt = rest.includes("--invalid-prompt");
  rest = rest.filter((arg) => !["--same-session", "--cued", "--invalid-prompt"].includes(arg));
  if (cued && invalidPrompt) return fail("--cued 与 --invalid-prompt 不能同时使用");
  const topicId = Number(rest.shift());
  if (!Number.isInteger(topicId) || topicId <= 0) return fail("review 需要弱项主题 id，如：review 12 pass --angle 变式案例");
  let result;
  try { result = validateReviewResult(rest.shift()); } catch (error) { return fail(error.message); }
  let op;
  try {
    const studyErrorIdRaw = takeNamed(rest, "--event");
    const studyErrorId = studyErrorIdRaw == null ? null : Number(studyErrorIdRaw);
    if (studyErrorIdRaw != null && (!Number.isInteger(studyErrorId) || studyErrorId <= 0)) throw new Error("--event 需要正整数错题 id");
    const failurePatternCode = validateFailurePattern(takeNamed(rest, "--pattern"));
    const diagnosisRaw = takeNamed(rest, "--diagnosis");
    if (diagnosisRaw && !failurePatternCode) throw new Error("--diagnosis 必须和 --pattern 一起使用");
    if (result === "void" && failurePatternCode) throw new Error("作废题只归责教练，不能记录用户 failure pattern");
    // [gpt] 2026-08-10：CLI 先做完整语义预检，坏题干/缺变式不得先进入 outbox。
    const reviewEvidence = buildReviewEvidence({
      result,
      variantKind: takeNamed(rest, "--variant"),
      dimension: takeNamed(rest, "--dimension") ?? undefined,
      cold: !sameSession && !cued && !invalidPrompt,
      promptIntegrity: invalidPrompt ? "invalid" : cued ? "cued" : "clean",
      probeAxis: takeNamed(rest, "--axis"),
      angle: takeNamed(rest, "--angle"),
      evidenceAnchor: takeNamed(rest, "--anchor"),
      assessmentContext: takeNamed(rest, "--context") ?? "practice",
      durationSeconds: takeNamed(rest, "--seconds"),
    });
    const reviewDate = validateReviewDate(takeNamed(rest, "--date") ?? today);
    op = {
      op: "error_review",
      topicId,
      result: reviewEvidence.result,
      studyErrorId,
      date: reviewDate,
      sessionKey: takeNamed(rest, "--session"),
      angle: reviewEvidence.angle,
      evidenceAnchor: reviewEvidence.evidenceAnchor,
      note: takeNamed(rest, "--note"),
      dimension: reviewEvidence.dimension,
      cold: reviewEvidence.cold,
      promptIntegrity: reviewEvidence.promptIntegrity,
      variantKind: reviewEvidence.variantKind,
      transferLevel: reviewEvidence.transferLevel,
      probeAxis: reviewEvidence.probeAxis,
      assessmentContext: reviewEvidence.assessmentContext,
      durationSeconds: reviewEvidence.durationSeconds,
      failurePatternCode,
      diagnosisStatus: validateDiagnosisStatus(diagnosisRaw ?? "pending"),
      ...(result === "void" ? {
        responsibility: "teacher",
        metadata: {
          responsibility: "teacher",
          count_as_valid_attempt: false,
          count_as_user_error: false,
          advance_cooldown: false,
          close_schedule: false,
        },
      } : {}),
    };
  } catch (error) { return fail(error.message); }
  if (["confirmed", "rejected", "untraceable"].includes(op.diagnosisStatus) && !runId) {
    return fail("终态病根 review 必须带 --run，且先由 classify/mark-untraceable 产生 diagnosis_recorded 学习事实回执");
  }
  if (runId) {
    try {
      // [gpt] 2026-08-13：在进入 outbox 前核对题号、结果和病根状态，避免显示卡与真实写回各说一套。
      assertCuotiJudgmentReady({ runId, topicId, result: op.result, diagnosisStatus: op.diagnosisStatus });
      if (["confirmed", "rejected", "untraceable"].includes(op.diagnosisStatus)) {
        assertSkillRunPrerequisites({ runId, expectedSkill: "cuoti-fupan", steps: ["diagnosis_recorded"] });
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const scheduleId = takeNamed(rest, "--schedule");
  const scheduleFile = takeNamed(rest, "--schedule-file") ?? ".local/复盘排期.md";
  if (rest.length) return fail(`无法识别的 review 参数：${rest.join(" ")}`);
  // [gpt] 2026-08-10：远端写证据前先确认排期与 T#主题一一对应。
  if (scheduleId) {
    try {
      if (!existsSync(scheduleFile)) throw new Error(`排期文件不存在：${scheduleFile}`);
      assertScheduleLink(readFileSync(scheduleFile, "utf8"), scheduleId, {
        kind: "topic",
        targetId: topicId,
        referenceDate: op.date,
        route: "cuoti-fupan",
        dimension: op.dimension,
      });
    } catch (error) {
      return fail(`排期关联预校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const staged = appendPending(op);
  const qualifies = op.result === "pass" && op.cold && op.promptIntegrity === "clean" && op.dimension === "application" && op.transferLevel >= 3;
  const reviewKind = op.cold ? "冷复检" : op.result === "void" ? "作废题" : "非冷检";
  console.log(`⏳ 已暂存待同步·T#${topicId} ${reviewKind} ${result}｜${REVIEW_VARIANTS[op.variantKind].label} L${op.transferLevel}${op.assessmentContext !== "practice" ? `｜${op.assessmentContext}/${op.durationSeconds}s` : ""}${op.angle ? `｜角度 ${op.angle}` : ""}${op.failurePatternCode ? `｜定向栽点 ${FAILURE_PATTERNS[op.failurePatternCode].label}` : ""}${op.date ? `｜${op.date}` : ""}${scheduleId ? `｜结案排期 ${scheduleId}` : ""}`);
  if (op.result === "pass" && !qualifies) console.log("ℹ️ 本次通过会留证，但不计入主题 stable：必须是 clean、跨会话、application 且 L3+。");
  if (op.result === "void") console.log("↩ 本次只留教练题面事故审计：不计有效题量、不记用户错误、不推进冷却；原排期保持 open。");
  if (stageOnly) {
    if (scheduleId) console.log(`（已按 --stage 仅暂存；复检证据与排期 ${scheduleId} 均未落。稍后先 sync，再重跑同一 review --schedule 完成安全结案；禁止裸 schedule.mjs done。）`);
    return;
  }
  const synced = await sync([]);
  if (!synced) {
    // [claude] 2026-08-24：同步失败以前只打一行字就 return，Run 上不留任何痕迹，
    // 于是断网被记成"判了题不写回"。现在留痕并给出可直接执行的续跑命令。
    if (runId) {
      try {
        recordWritebackDeferred({
          runId,
          source: "cuoti-review",
          reason: "远端同步失败；复检证据已暂存本地 outbox",
          operationId: staged.operation_id,
          evidenceRef: `T#${topicId}:${op.result}`,
          expectedSkill: "cuoti-fupan",
        });
      } catch (error) {
        console.error(`⚠️ 延迟写回留痕失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.error("⚠️ 复检证据已暂存本地 outbox，但远端同步失败——证据没丢，只是还没落库。");
    console.error(`   网络恢复后续跑：node --env-file=.env.local scripts/cuoti.mjs sync${runId ? ` --run ${runId} --operation ${staged.operation_id}` : ""}`);
    console.error("   不要重跑 review（会重复入账），也不要因此把本轮当作没做。");
    if (scheduleId) console.error(`   排期 ${scheduleId} 未结案；补同步后再核对证据并重跑同一 review --schedule；禁止用无目标的 schedule.mjs done 代替。`);
    return;
  }
  if (scheduleId) {
    try {
      if (!existsSync(scheduleFile)) throw new Error(`排期文件不存在：${scheduleFile}`);
      const currentSchedule = readFileSync(scheduleFile, "utf8");
      assertScheduleLink(currentSchedule, scheduleId, {
        kind: "topic", targetId: topicId, referenceDate: op.date, route: "cuoti-fupan", dimension: op.dimension,
      });
      const closure = closeScheduleItem(currentSchedule, scheduleId, {
        date: op.date,
        result: `${result}${op.angle ? `｜${op.angle}` : ""}`,
        // [gpt] 2026-08-10：把真实复检条件一并回写排期，供干预响应校准；不是只打一个“已完成”勾。
        outcome: op.result,
        cold: op.cold,
        promptIntegrity: op.promptIntegrity,
      });
      if (typeof closure === "string") {
        writeFileSync(scheduleFile, closure, "utf8");
        console.log(`✅ 已结案复盘排期：${scheduleId}（${op.date}）`);
      } else {
        console.log(`↩ 作废题只归责教练；排期 ${scheduleId} 保持 open、冷却不前移，重写并重新过命题 Gate 后再执行。`);
      }
    } catch (error) {
      console.error(`⚠️ 排期结案失败：${scheduleId}：${error instanceof Error ? error.message : String(error)}（复检证据已落库；请先核对原排期目标。单主题修正关联后重跑 review --schedule；整组须逐题留证后用 schedule.mjs done ${scheduleId} --topics <完整T#集合> --evidence-refs <已落库证据引用> --result "..."）`);
      process.exitCode = 1;
    }
  }
  if (runId && process.exitCode !== 1) {
    recordBusinessWriteback({
      runId,
      source: "cuoti-review",
      evidenceRef: `T#${topicId}:${op.result}:diagnosis=${op.diagnosisStatus}`,
      expectedSkill: "cuoti-fupan",
      requiredSteps: ["target_frozen", "materials_checked", "question_integrity_pass", "judgment_output_verified"],
      durationMs: Date.now() - reviewStartedAt,
    });
    // [gpt] 2026-08-13：若本次 review 已带已认领/已排除栽点，业务写回同时留下病根状态回执。
    if (["confirmed", "rejected", "untraceable"].includes(op.diagnosisStatus)) {
      recordAutomaticSkillStep({
        runId,
        step: "diagnosis_recorded",
        source: "cuoti-review",
        evidenceRef: `T#${topicId}:diagnosis=${op.diagnosisStatus}`,
        expectedSkill: "cuoti-fupan",
      });
    }
  }
}

// ---------- pending：查看/清空缓冲 ----------
function pending(rest) {
  if (rest[0] === "--clear") { clearPending(); return console.log("已清空本地待同步缓冲。"); }
  const ops = readPending();
  if (!ops.length) return console.log("本地待同步缓冲为空。");
  console.log(`本地 outbox：${ops.length} 条（同步失败或显式 --stage；运行 sync 可重试）\n`);
  ops.forEach((o, i) => {
    if (o.op === "absorb") console.log(`${i + 1}. 销账 #${(o.ids ?? []).join(" #")}${o.note ? "（" + o.note + "）" : ""}\n   ${(o.items ?? []).join("\n   ")}`);
    else if (o.op === "reopen_error") console.log(`${i + 1}. 恢复误销账 #${(o.ids ?? []).join(" #")}（${o.reason}）\n   ${(o.items ?? []).join("\n   ")}`);
    else if (o.op === "new_error") console.log(`${i + 1}. 新错题 [${o.subject ?? "未分类"}] ${o.knowledge}${o.topic ? ` → 主题「${o.topic.title}」` : " → 待归类"}`);
    else if (o.op === "classify_error") console.log(`${i + 1}. 归类 #${o.studyErrorId} → 主题「${o.topic?.title ?? "?"}」`);
    else if (o.op === "mark_diagnosis_untraceable") console.log(`${i + 1}. 用户明确标记病根不可追溯 E#${o.studyErrorId}/T#${o.topicId}（${o.reason}｜${o.userRef}）`);
    else if (o.op === "error_review") console.log(`${i + 1}. 复检 T#${o.topicId} ${o.result} ${o.variantKind ? `${o.variantKind}/L${o.transferLevel}/${o.probeAxis}` : "legacy"} ${o.date ?? ""}`);
    else if (o.op === "study_log") console.log(`${i + 1}. 学习日志 ${o.date ?? ""} [${o.subject}]${o.chapter ? " " + o.chapter : ""} ${o.activity}${o.accuracy != null ? " " + o.accuracy + "%" : ""}${o.feeling ? "（" + o.feeling + "）" : ""}`);
    else if (o.op === "ask_point") console.log(`${i + 1}. 答疑卡点 [${o.subject}] ${o.confusion}`);
    else if (o.op === "resolve_ask_point") console.log(`${i + 1}. 答疑收口 A#${o.pointId} → ${o.action}`);
    else if (o.op === "knowledge_link") console.log(`${i + 1}. 知识映射 ${o.sourceKind}:${o.sourceId} → ${o.kpId}（${o.linkStatus ?? "pending"}）`);
    else if (o.op === "knowledge_evidence") console.log(`${i + 1}. 知识证据 ${o.kpId} ${o.dimension}/${o.result} ${o.date ?? ""}`);
  });
}

// ---------- sync：逐项幂等落库；只移除成功项 ----------
async function sync(rest) {
  rest = [...rest];
  let runId;
  let operationId;
  try {
    runId = takeNamed(rest, "--run");
    operationId = takeNamed(rest, "--operation");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (Boolean(runId) !== Boolean(operationId)) return fail("sync 的 --run 与 --operation 必须成对提供");
  const dry = rest.includes("--dry");
  rest = rest.filter((arg) => arg !== "--dry");
  if (rest.length) return fail(`无法识别的 sync 参数：${rest.join(" ")}`);
  if (dry && runId) return fail("--dry 不能签 Skill Run 写回");
  const ops = readPending();
  if (!ops.length && !operationId) { console.log("缓冲为空，没有要同步的。"); return true; }
  let trackedRun = null;
  let deferredResume = false;
  if (runId) {
    // [claude] 2026-08-24：原来这里写死 expectedSkill=daibei-pc，于是断网后
    // cuoti 的复检证据虽然躺在 outbox 里，却没有任何路径能把它接回原 Run。
    // 现在按 Run 自身的 skill 决定门槛，cuoti 走延迟写回补同步。
    let existing;
    try {
      existing = readSkillRun(runId);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    deferredResume = existing.skill === "cuoti-fupan" && Boolean(existing.deferredWriteback);
    if (deferredResume) {
      if (existing.deferredWriteback.operationId !== operationId) {
        return fail(`该 Run 待补同步的 operation 是 ${existing.deferredWriteback.operationId}，与 ${operationId} 不符`);
      }
      trackedRun = existing;
    } else {
      try {
        trackedRun = assertSkillRunPrerequisites({
          runId,
          expectedSkill: "daibei-pc",
          steps: ["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded"],
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      if (!String(trackedRun.steps.result_recorded.evidenceRef ?? "").includes(`op=${operationId}`)) {
        return fail(`Skill Run 的本地结果回执与 operation_id 不一致：${operationId}`);
      }
    }
  }
  const absorbIds = [...new Set(ops.filter((o) => o.op === "absorb").flatMap((o) => o.ids ?? []))];
  const reopenIds = [...new Set(ops.filter((o) => o.op === "reopen_error").flatMap((o) => o.ids ?? []))];
  const newErrs = ops.filter((o) => o.op === "new_error");
  const logs = ops.filter((o) => o.op === "study_log");
  const mems = ops.filter((o) => o.op === "coach_memory");
  const classifications = ops.filter((o) => o.op === "classify_error");
  const reviews = ops.filter((o) => o.op === "error_review");
  const askPoints = ops.filter((o) => o.op === "ask_point");
  const askResolutions = ops.filter((o) => o.op === "resolve_ask_point");
  const knowledgeLinks = ops.filter((o) => o.op === "knowledge_link");
  const knowledgeEvidence = ops.filter((o) => o.op === "knowledge_evidence");

  console.log(`${dry ? "【预览·不写库】" : "同步到系统"}：销账 ${absorbIds.length} 条${absorbIds.length ? "（#" + absorbIds.join(" #") + "）" : ""}、恢复误销账 ${reopenIds.length} 条${reopenIds.length ? "（#" + reopenIds.join(" #") + "）" : ""}、新错题 ${newErrs.length} 条、补归类 ${classifications.length} 条、冷复检 ${reviews.length} 条、知识映射 ${knowledgeLinks.length} 条、知识证据 ${knowledgeEvidence.length} 条、答疑卡点 ${askPoints.length} 条、答疑收口 ${askResolutions.length} 条、学习日志 ${logs.length} 条、长期记忆 ${mems.length} 条`);
  if (dry) {
    for (const id of reopenIds) console.log(`   + 恢复误销账 #${id}`);
    for (const e of newErrs) console.log(`   + 错题 [${e.subject ?? "未分类"}] ${e.knowledge}${e.topic ? ` → ${e.topic.title}` : " → 待归类"}`);
    for (const c of classifications) console.log(`   + 归类 #${c.studyErrorId} → ${c.topic?.title}`);
    for (const r of reviews) console.log(`   + 复检 T#${r.topicId} ${r.result} ${r.variantKind ? `${r.variantKind}/L${r.transferLevel}` : "legacy"} ${r.date ?? ""}`);
    for (const l of logs) console.log(`   + 日志 ${l.date ?? ""} [${l.subject}]${l.chapter ? " " + l.chapter : ""} ${l.activity}${l.accuracy != null ? " " + l.accuracy + "%" : ""}${l.feeling ? "（" + l.feeling + "）" : ""}`);
    for (const m of mems) console.log(`   + 记忆 [${m.category ?? "画像"}] ${m.fact}`);
    for (const a of askPoints) console.log(`   + 答疑卡点 [${a.subject}] ${a.confusion}`);
    for (const a of askResolutions) console.log(`   + 答疑收口 A#${a.pointId} → ${a.action}`);
    console.log("（预览完毕，未改动。去掉 --dry 才真正落库。）");
    return true;
  }

  let report = { total: 0, succeeded: [], failed: [] };
  if (ops.length) {
    try {
      report = await syncStudyOutbox({ db, path: PENDING, today });
    } catch (error) {
      fail(`outbox 同步前检查/重写失败：${error instanceof Error ? error.message : String(error)}（原缓冲保留）`);
      return false;
    }
  }
  const count = (kind) => report.succeeded
    .filter(({ result }) => result.kind === kind)
    .reduce((sum, { result }) => sum + result.affected, 0);
  console.log(`✅ 已确认同步：销账 ${count("absorb")} 条、恢复误销账 ${count("reopen_error")} 条、新增错题 ${count("new_error")} 条、补归类 ${count("classify_error")} 条、冷复检 ${count("error_review")} 条、知识映射 ${count("knowledge_link")} 条、知识证据 ${count("knowledge_evidence")} 条、答疑卡点 ${count("ask_point")} 条、答疑收口 ${count("resolve_ask_point")} 条、学习日志 ${count("study_log")} 条、长期记忆 ${count("coach_memory")} 条。`);
  const targetFailed = operationId
    ? report.failed.some(({ op }) => op.operation_id === operationId)
    : false;
  if (report.failed.length) {
    console.error(`⚠️ ${report.failed.length} 项失败，已保留在 outbox，绝未清空：`);
    for (const { op, error } of report.failed) console.error(`   · ${op.operation_id} (${op.op})：${error}`);
    process.exitCode = 1;
    if (!runId || targetFailed) return false;
  }
  if (runId && deferredResume) {
    // [claude] 2026-08-24：断网延迟的复检证据补同步成功——把回执接回原 Run，
    // 让它能正常收口，而不是只能记成 aborted。门槛不变：仍要求这一批真的落库了。
    const stillPending = readPending().some((o) => o.operation_id === operationId);
    if (stillPending) return fail(`operation ${operationId} 仍留在 outbox，未真正落库；修网络后重跑本命令`);
    recordAutomaticSkillStep({
      runId,
      step: "result_recorded",
      source: "cuoti-review-deferred",
      evidenceRef: trackedRun.deferredWriteback.evidenceRef ?? `op=${operationId}`,
      expectedSkill: "cuoti-fupan",
    });
    recordAutomaticSkillStep({
      runId,
      step: "writeback_verified",
      source: "cuoti-sync-deferred",
      evidenceRef: `deferred:${operationId}:applied`,
      expectedSkill: "cuoti-fupan",
    });
    console.log(`SKILL_WRITEBACK_VERIFIED｜${runId}｜${operationId}（延迟写回已补回执，可正常收口）`);
  } else if (runId) {
    const verification = await db.from("ingest_operation")
      .select("operation_id,op_type,status")
      .eq("operation_id", operationId)
      .maybeSingle();
    if (verification.error) return fail(`核验 ingest_operation 失败：${verification.error.message}`);
    try {
      validateDaibeiIngestReceipt({ runId, operationId, receipt: verification.data });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    recordAutomaticSkillStep({
      runId,
      step: "writeback_verified",
      source: "cuoti-sync-ingest",
      evidenceRef: `ingest:${operationId}:applied`,
      expectedSkill: "daibei-pc",
    });
    console.log(`SKILL_WRITEBACK_VERIFIED｜${runId}｜${operationId}`);
  }
  if (report.failed.length) console.log(`目标操作已核验成功；另有 ${report.failed.length} 项仍留在 outbox，稍后继续重试。`);
  else console.log("outbox 已清空；每项均由 operation_id 保证重试不重复。");
  console.log(`（错题本是 Supabase 运行态，APP 实时读库即可见，无需重新部署。若日后复盘产出「心得」入内容库才需 archive 提交+部署。）`);
  return true;
}

// ---------- recheck：老错题全覆盖轮换抽查（云 7-06："每条老题都不会被遗忘、都有可能被抽到"）----------
// 轮换池 = 【全部】已销账老题，【无上限、永不淘汰】。排序 = "最久没碰的优先"
//   （lastTouch = max(销账时间, 上次抽查时间)）→ 考过的沉底、把机会让给还没轮到的 →
//   反复跑下去每一条终会被抽到，绝不漏。刚碰过的先歇 MIN_GAP 天，避免马上重考。
const RECHECK_MIN_GAP = 3 * DAY;
async function recheck(rest) {
  const n = Number(rest.find((x) => /^\d+$/.test(x))) || 6;
  const { data, error } = await db
    .from("study_error").select("id, subject, knowledge, absorbed_at, kp_id")
    .eq("status", "absorbed").not("absorbed_at", "is", null);
  if (error) return fail(error.message);
  const ledger = readLedger();
  const now = Date.now();
  const pool = (data ?? []).map((r) => {
    const led = ledger[r.id];
    const lastTouch = led?.last ? new Date(led.last).getTime() : new Date(r.absorbed_at).getTime();
    return { ...r, lastTouch, sinceDays: Math.floor((now - lastTouch) / DAY), count: led?.count ?? 0, tested: !!led?.last };
  });
  if (!pool.length) return console.log("还没有已销账的老错题——轮换池是空的。");
  const bySince = (a, b) => a.lastTouch - b.lastTouch; // 最久没碰的排前
  const ready = pool.filter((r) => now - r.lastTouch >= RECHECK_MIN_GAP).sort(bySince);
  const draw = (ready.length ? ready : pool.slice().sort(bySince)).slice(0, n);
  const never = pool.filter((r) => !r.tested).length;
  const topicLinks = await loadTopicLinks(draw.map((r) => r.id));

  console.log(`老错题轮换池：共 ${pool.length} 条（【全部已销账老题都在池里，无上限、永不淘汰】）`);
  console.log(`本次抽 ${draw.length} 条——最久没考的优先、考过的沉底让位，反复跑保证【每一条终会被轮到、不遗漏】：\n`);
  for (const r of draw) {
    const tag = r.tested ? `上次考 ${r.sinceDays} 天前·累计抽查 ${r.count} 次` : `销账后 ${r.sinceDays} 天·从没抽查过`;
    console.log(`#${r.id} [${r.subject ?? "?"}]（${tag}）`);
    console.log(`   ${String(r.knowledge).replace(/\s+/g, " ").slice(0, 80)}`);
    const link = topicLinks.get(r.id);
    const topic = link?.error_topic;
    if (topic) console.log(`   ↳ T#${topic.id} ${topic.title}`);
  }
  if (never) console.log(`\n（池里还有 ${never} 条【从没被抽查过】，排最前优先出——一条不漏。抽查后：过了→ pass <id>；没过→ recheck-fail <id> 重新挂账）`);
}

// 记录老题本次抽查【通过】（只写本地轮换台账、不碰系统数据、无需同步）：沉到池底、把机会让给别的
function pass(rest) {
  const ids = rest.map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return fail("pass 需要 id，如：pass 21 23（记录这些老题本次抽查通过）");
  const ledger = readLedger();
  const now = new Date().toISOString();
  for (const id of ids) ledger[id] = { last: now, count: (ledger[id]?.count ?? 0) + 1, result: "pass" };
  writeLedger(ledger);
  console.log(`✅ 已记 ${ids.length} 条老题抽查通过（#${ids.join(" #")}）→ 沉到轮换池底，下次先考还没轮到的。`);
}

// 老题本次抽查【没过】：暂存重新挂账（同步后 open + 🔁 复发）+ 台账记一次（避免它立刻又在老池里冒头）
async function recheckFail(rest) {
  const stageOnly = rest.includes("--stage");
  const ids = rest.filter((arg) => arg !== "--stage").map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return fail("recheck-fail 需要 id，如：recheck-fail 23（老题没过、重新挂账）");
  const { data, error } = await db.from("study_error").select("id, subject, knowledge").in("id", ids);
  if (error) return fail(error.message);
  const ledger = readLedger();
  const now = new Date().toISOString();
  for (const r of data ?? []) {
    appendPending({ op: "new_error", subject: r.subject, knowledge: String(r.knowledge), recurOf: r.id, entrySource: "recurrence", note: `老题抽查没过·复发（源#${r.id}）` });
    ledger[r.id] = { last: now, count: (ledger[r.id]?.count ?? 0) + 1, result: "fail" };
    console.log(`↩ #${r.id} 没过 → 已暂存重新挂账：${String(r.knowledge).slice(0, 50)}`);
  }
  writeLedger(ledger);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后 sync 后会重新挂账并标 🔁 复发。）");
  await sync([]);
}

function fail(msg) { console.error("✗ " + msg); process.exitCode = 1; }

async function main(argv) {
  const [cmd, ...args] = argv;
  const localMaterial = (cmd === "material" || cmd === "material-batch") && !args.includes("--db");
  if (!localMaterial) {
    db = createClient(
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
  }
  switch (cmd) {
    case "list": await list(args[0] && SUBJECTS.includes(args[0]) ? args[0] : undefined); break;
    case "topics": await topics(args[0] && SUBJECTS.includes(args[0]) ? args[0] : undefined); break;
    case "profile": await profile(args); break;
    case "proof": await proof(args); break;
    case "triage": await triage(args); break;
    case "material": await material(args); break;
    case "material-batch": await materialBatch(args); break;
    case "absorb": await absorb(args); break;
    case "reopen": await reopen(args); break;
    case "add": await add(args); break;
    case "record-batch": await recordBatch(args); break;
    case "verify-batch": await verifyBatch(args); break;
    case "classify": await classify(args); break;
    case "mark-untraceable": await markDiagnosisUntraceable(args); break;
    case "classify-batch": await classifyBatch(args); break;
    case "review": await review(args); break;
    case "pending": pending(args); break;
    case "sync": await sync(args); break;
    case "recheck": await recheck(args); break;
    case "pass": pass(args); break;
    case "recheck-fail": await recheckFail(args); break;
    default:
      console.log("用法：node --env-file=.env.local scripts/cuoti.mjs <命令> ...");
      console.log("  只读：list [科目] / topics [科目] / profile [科目] [--limit 1-20] [--json] / proof [科目] [--topic id] [--limit 1-200] [--json] / triage [科目] [n]");
      console.log("        material <词> [特征词] [--db] / material-batch --query <词> [--refine <特征词>] ... [--db]");
      console.log("  老题轮换抽查：recheck [n]（全覆盖·永不淘汰）/ pass <id...>（过了）/ recheck-fail <id...>（没过·重新挂账）");
      console.log("  写：absorb <id...>|--like <片段>（自动校验至少两轴、两条带依据通过，其中至少一次冷检）");
      console.log("      reopen <id...> --reason <审计原因>（只纠正误销账，不伪造失败）");
      console.log("      add <科目> <事件说明> --chapter 章 [--topic 标准主题 --section 节 --kp ID --classification pending|confirmed --cause unclassified --diagnosis unassessed --anchor 锚点 --recur-of id --run SR-ID]");
      console.log("      record-batch <批次.json> [--run SR-ID] [--stage]（一条进度 + N 条截图错题，一次同步）");
      console.log("      verify-batch <批次.json> --run SR-ID（只读核验既有批次，不重复写入）");
      console.log("      classify <事件id> --topic <标准主题> [同上主题参数] [--run SR-ID]");
      console.log('      mark-untraceable <事件id> --run SR-ID --user-ref "user:<用户原话/回合引用>" --reason "用户明确说忘了或不认领"（同 Run 想起可 classify 更正；跨 Run/中止禁用）');
      console.log("      classify-batch <归类计划.json> [--stage]");
      console.log("      review <主题id> <pass|partial|fail|void> --variant original|rule_recall|counterfactual|novel_case|integrated_case|teach_back|invalid --axis 验证轴 [--context practice|timed|full_mock --seconds N --event 错题id --dimension application|recall --pattern 栽点代码 --diagnosis pending|confirmed|rejected|untraceable --same-session --cued --invalid-prompt --angle 角度 --anchor 锚点 --note 说明 --date 北京日 --session 会话键 --schedule 排期id --schedule-file 路径 --run SR-ID]（终态须先有 classify/mark-untraceable 回执）");
      console.log(`  验证轴：${Object.entries(REVIEW_PROBE_AXES).map(([code, item]) => `${code}=${item.label}`).join(" / ")}`);
      console.log(`  病根代码：${Object.entries(ROOT_CAUSES).map(([code, label]) => `${code}=${label}`).join(" / ")}`);
      console.log(`  栽点代码：${Object.entries(FAILURE_PATTERNS).map(([code, item]) => `${code}=${item.label}`).join(" / ")}`);
      console.log("  outbox：pending [--clear] / sync [--dry]；带背 Run 写回核验：sync --run SR-ID --operation UUID");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
