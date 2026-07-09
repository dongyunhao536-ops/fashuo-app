// node --env-file=.env.local scripts/weekly.mjs data [--week YYYY-MM-DD]
// node --env-file=.env.local scripts/weekly.mjs save --file <叙事.md> [--week YYYY-MM-DD]
// PC 端周报生产（weekly-pc skill 专用）：算本周真实数据 + 把【我(Opus)火力全开写的高质量叙事】
// 写进共享 weekly_report（upsert on week_start）。APP /weekly 页只读它展示（周报=PC 生产、APP 展示）。
// 事实源与 src/lib/weekly-review.ts 完全对齐（同口径），叙事零编造只据真实数据。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const STUDY_ACTIVITIES = new Set(["听课", "做题", "背诵", "带背"]); // "学了什么"只认实打实学习动作(含带背·云2026-07-07要求计入)

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
  const sinceTs = bjDayStartTs(weekStart);
  // 上界=下周一0点（北京时）：查当前周不影响（未来无数据），查历史周（pinggu-pc 逐周趋势）必须封顶，否则把之后的数据全卷进来
  const untilTs = bjDayStartTs(new Date(new Date(weekStart + "T00:00:00Z").getTime() + 7 * DAY).toISOString().slice(0, 10));
  const [study, ask, evC, evP, usage, absorbed, openErr, prior] = await Promise.all([
    db.from("study_log").select("subject, chapter, activity, feeling").gte("log_date", weekStart).lte("log_date", weekEnd),
    db.from("ask_summary").select("subject, confusion, question_type, status").gte("created_at", sinceTs).lt("created_at", untilTs),
    db.from("events").select("type").gte("created_at", sinceTs).lt("created_at", untilTs),
    db.from("events").select("type").eq("status", "pending"),
    db.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs).lt("ts", untilTs),
    db.from("study_error").select("subject, knowledge, absorbed_at").eq("status", "absorbed").gte("absorbed_at", sinceTs).lt("absorbed_at", untilTs),
    db.from("study_error").select("subject, knowledge, log_date").eq("status", "open"),
    db.from("weekly_report").select("week_start, content").lt("week_start", weekStart).order("week_start", { ascending: false }).limit(1),
  ]);

  const studyRows = study.data ?? [];
  const studyMap = new Map();
  for (const s of studyRows) {
    if (!SUBJECTS.includes(s.subject) || !STUDY_ACTIVITIES.has(s.activity) || !s.chapter) continue;
    const row = studyMap.get(s.subject) ?? { chapters: new Set(), activities: new Set() };
    row.chapters.add(String(s.chapter)); row.activities.add(s.activity); studyMap.set(s.subject, row);
  }
  const studied = [...studyMap.entries()].map(([subject, v]) => ({ subject, chapters: [...v.chapters], activities: [...v.activities] }));

  // 带背/背诵学习效果（feeling·掌握轨迹）：喂复盘层定"下周精度重点"；不卡章节（小结行 chapter=null 也收）
  const effects = studyRows
    .filter((s) => SUBJECTS.includes(s.subject) && s.feeling)
    .map((s) => ({ subject: s.subject, chapter: s.chapter ?? null, activity: s.activity ?? "", feeling: String(s.feeling) }));
  const pr = prior.data?.[0];
  const priorReport = pr ? { weekStart: String(pr.week_start), content: String(pr.content ?? "").slice(0, 1500) } : null;

  const absorbedErrors = (absorbed.data ?? []).filter((r) => r.knowledge).map((r) => ({ subject: r.subject ?? "未分类", knowledge: String(r.knowledge) }));

  // 错题本 open 聚合（同 getErrorBook：频次×新近）
  const agg = new Map();
  for (const r of openErr.data ?? []) {
    if (!r.knowledge) continue;
    const key = `${r.subject ?? "未分类"}::${r.knowledge}`;
    const cur = agg.get(key) ?? { subject: r.subject ?? null, knowledge: String(r.knowledge), n: 0, last: "" };
    cur.n++; const d = String(r.log_date ?? ""); if (d > cur.last) cur.last = d; agg.set(key, cur);
  }
  const weakTop = [...agg.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).slice(0, 8);

  const askPoints = (ask.data ?? []).filter((a) => a.confusion && a.status === "open").slice(0, 10)
    .map((a) => ({ subject: a.subject, confusion: String(a.confusion), type: a.question_type ?? null }));

  const createdByType = {};
  for (const e of evC.data ?? []) createdByType[e.type] = (createdByType[e.type] ?? 0) + 1;

  let totalUsd = 0; const routeUsd = new Map();
  for (const u of usage.data ?? []) { const c = Number(u.est_cost_usd ?? 0); totalUsd += c; routeUsd.set(u.route, (routeUsd.get(u.route) ?? 0) + c); }

  return {
    weekStart, weekEnd,
    activity: { asks: (ask.data ?? []).length, coachLogs: studyRows.length },
    studied, effects, priorReport, solved: { absorbedErrors }, weak: { top: weakTop }, askPoints,
    inbox: { createdByType, pendingBacklog: (evP.data ?? []).length },
    cost: { totalUsd, byRoute: [...routeUsd.entries()].map(([route, usd]) => ({ route, usd })).sort((a, b) => b.usd - a.usd) },
  };
}

function formatData(r) {
  const L = [`【本周真实使用数据 ${r.weekStart} ~ ${r.weekEnd}】`,
    `· 活动量：答疑 ${r.activity.asks} 次 / 教练打卡 ${r.activity.coachLogs} 条`, `· 学了什么：`];
  if (r.studied.length) for (const s of r.studied) L.push(`  - ${s.subject}：${s.chapters.join("、") || "（未记章节）"}${s.activities.length ? "　[" + s.activities.join("/") + "]" : ""}`);
  else L.push(`  - （本周无学习流水记录）`);
  if (r.effects?.length) { L.push(`· 带背/学习效果（掌握轨迹，据此定下周精度重点）：`); for (const e of r.effects) L.push(`  - ${e.subject}${e.chapter ? "·" + e.chapter : ""}【${e.activity}】：${e.feeling}`); }
  L.push(`· 解决了什么：本周吸收错题 ${r.solved.absorbedErrors.length} 个${r.solved.absorbedErrors.length ? "：" + r.solved.absorbedErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、") : ""}`);
  L.push(`· 需关注：`);
  L.push(`  - 错题本（=弱项，未吸收）：${r.weak.top.map((w) => `${w.subject ?? "未分类"}·${w.knowledge}${w.n > 1 ? `(×${w.n})` : ""}`).join("、") || "（暂无）"}`);
  L.push(`  - 答疑未收口卡点：${r.askPoints.map((a) => `${a.subject}${a.type ? "·" + a.type : ""} ${a.confusion}`).join("；") || "（无）"}`);
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
    model: "pc-opus-4.8", cost_usd: 0, generated_at: new Date().toISOString(),
  }, { onConflict: "week_start" });
  if (error) { console.error("✗ weekly_report 写入失败：" + error.message); process.exit(1); }
  console.log(`✅ 已写入共享 weekly_report（${r.weekStart}~${r.weekEnd}，PC 生产·¥0）。APP /weekly 叙事卡即刻展示这份。`);
} else {
  console.log("用法：node --env-file=.env.local scripts/weekly.mjs <data|save> [--week YYYY-MM-DD] [--file 叙事.md]");
}
