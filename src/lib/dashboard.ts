import { supabaseAdmin } from "./supabase";
import type { ErrorItem } from "./errorbook";
import { bjDateStr, bjWeekMonday, bjDayStart } from "./dates";

/**
 * 今日页（仪表盘）数据聚合（RSC 直接调）。2026-07-06 重做：清爽 + 量化个人综合能力/各科能力与进度。
 * 量化全部落在【真实数据】上、透明标注依据，不编分：
 *   - 综合备考指数 = 0.7×加权章节进度(按分值权重) + 0.3×错题闭环率(有错题才计入)
 *   - 各科：进度%(已学章/总章·学习流水解析第X章) + 错题(挂账/已吸收) + 掌握度(闭环率，无数据=null)
 */

export interface SubjectStat {
  subject: string;
  weight: number;
  total: number;
  covered: number;
  progress: number; // 0-100
  open: number;
  absorbed: number;
  mastery: number | null; // 错题闭环率 0-100；无错题数据=null
}

export interface DashboardData {
  hero: { examDate: string; daysLeft: number; daysToBase: number };
  overall: { index: number; weightedProgress: number; closure: number | null }; // 综合备考指数
  subjects: SubjectStat[];
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  today: { studied: { subject: string; chapter: string | null; activity: string }[]; absorbed: number };
  week: { absorbed: number; logs: number };
  top5: ErrorItem[];
}

const EXAM_DATE = "2026-12-21";
const BASE_DEADLINE = "2026-09-30";
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const STUDY_ACT = new Set(["听课", "做题", "背诵"]); // "进度"只认实打实学习动作
// 各科《考试分析》总章数（exam-outline.gen.ts）
const TOTAL_CH: Record<string, number> = { 刑法: 21, 民法: 21, 法理: 13, 宪法: 5, 法制史: 7 };
// 科目分值权重（专业基础 刑+民=150；专业综合 法理≈60/宪法≈50/法制史≈40）
const WEIGHT: Record<string, number> = { 刑法: 75, 民法: 75, 法理: 60, 宪法: 50, 法制史: 40 };

const CN = "一二三四五六七八九十";
/** 从学习流水的自由文本章节名解析出「第X章」的章号（中文/阿拉伯数字都认；绪论=第一章）。解析不出=null。 */
function chapterNum(s: string): number | null {
  const m = s.match(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/);
  if (!m) return /绪论/.test(s) ? 1 : null;
  const t = m[1];
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  if (t === "十") return 10;
  if (t.startsWith("二十")) return t === "二十" ? 20 : 20 + CN.indexOf(t[2]) + 1;
  if (t.startsWith("十")) return 10 + CN.indexOf(t[1]) + 1;
  const i = CN.indexOf(t);
  return i >= 0 ? i + 1 : null;
}

export async function getDashboard(): Promise<DashboardData> {
  const now = new Date();
  const todayStr = bjDateStr(now);
  const weekStart = bjWeekMonday(now);

  const [askLatest, askCount, eventsPending, allLog, allErr] = await Promise.all([
    supabaseAdmin.from("ask_summary").select("confusion").eq("status", "open").order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("ask_summary").select("*", { count: "exact", head: true }).eq("status", "open"),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin.from("study_log").select("subject, chapter, activity, log_date").order("log_date", { ascending: false }).limit(1000),
    supabaseAdmin.from("study_error").select("subject, knowledge, status, absorbed_at, log_date").in("status", ["open", "absorbed"]).limit(3000),
  ]);

  const daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE).getTime() - now.getTime()) / DAY));
  const daysToBase = Math.ceil((new Date(BASE_DEADLINE).getTime() - now.getTime()) / DAY);

  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const logs = allLog.data ?? [];
  const errs = allErr.data ?? [];

  // 今日 + 本周
  const studied = logs.filter((r) => r.log_date === todayStr).map((r) => ({
    subject: (r.subject as string | null) ?? "未识别",
    chapter: (r.chapter as string | null) ?? null,
    activity: (r.activity as string | null) ?? "其他",
  }));
  const weekLogs = logs.filter((r) => String(r.log_date) >= weekStart).length;
  const todayStartTs = bjDayStart(todayStr);
  const weekStartTs = bjDayStart(weekStart);
  const todayAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= todayStartTs).length;
  const weekAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= weekStartTs).length;

  // 各科：已学章节（第X章解析·去重）
  const coveredBySubj = new Map<string, Set<number>>();
  for (const r of logs) {
    const subj = r.subject as string;
    const ch = r.chapter as string | null;
    const act = (r.activity as string | null) ?? "";
    if (!SUBJECTS.includes(subj) || !ch || !STUDY_ACT.has(act)) continue;
    const n = chapterNum(ch);
    if (n == null) continue;
    const set = coveredBySubj.get(subj) ?? new Set<number>();
    set.add(n);
    coveredBySubj.set(subj, set);
  }
  // 各科：错题挂账/已吸收
  const errBySubj = new Map<string, { open: number; absorbed: number }>();
  for (const r of errs) {
    const s = (r.subject as string | null) ?? "未分类";
    const e = errBySubj.get(s) ?? { open: 0, absorbed: 0 };
    if (r.status === "absorbed") e.absorbed++;
    else e.open++;
    errBySubj.set(s, e);
  }

  const subjects: SubjectStat[] = SUBJECTS.map((s) => {
    const covered = Math.min(coveredBySubj.get(s)?.size ?? 0, TOTAL_CH[s]);
    const total = TOTAL_CH[s];
    const progress = Math.round((covered / total) * 100);
    const e = errBySubj.get(s) ?? { open: 0, absorbed: 0 };
    const seen = e.open + e.absorbed;
    const mastery = seen > 0 ? Math.round((e.absorbed / seen) * 100) : null;
    return { subject: s, weight: WEIGHT[s], total, covered, progress, open: e.open, absorbed: e.absorbed, mastery };
  });

  // 综合备考指数
  const wSum = SUBJECTS.reduce((a, s) => a + WEIGHT[s], 0);
  const weightedProgress = Math.round(subjects.reduce((a, x) => a + x.weight * x.progress, 0) / wSum);
  const totOpen = subjects.reduce((a, x) => a + x.open, 0);
  const totAbs = subjects.reduce((a, x) => a + x.absorbed, 0);
  const closure = totOpen + totAbs > 0 ? Math.round((totAbs / (totOpen + totAbs)) * 100) : null;
  const index = Math.round(closure != null ? 0.7 * weightedProgress + 0.3 * closure : weightedProgress);

  // 错题本 Top（open 聚合，同 errorbook 口径）
  const openAgg = new Map<string, ErrorItem>();
  for (const r of errs) {
    if (r.status !== "open" || !r.knowledge) continue;
    const subj = (r.subject as string | null) ?? null;
    const key = `${subj ?? "未分类"}::${r.knowledge}`;
    const cur = openAgg.get(key) ?? { subject: subj, knowledge: String(r.knowledge), n: 0, last: "" };
    cur.n++;
    const d = String(r.log_date ?? "");
    if (d > cur.last) cur.last = d;
    openAgg.set(key, cur);
  }
  const openItems = [...openAgg.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1));

  return {
    hero: { examDate: EXAM_DATE, daysLeft, daysToBase },
    overall: { index, weightedProgress, closure },
    subjects,
    ask: { openCount: askCount.count ?? 0, lastConfusion: askLatest.data?.[0]?.confusion ?? null },
    coach: { openErrors: openAgg.size },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    today: { studied, absorbed: todayAbsorbed },
    week: { absorbed: weekAbsorbed, logs: weekLogs },
    top5: openItems.slice(0, 5),
  };
}
