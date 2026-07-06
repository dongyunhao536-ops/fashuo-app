import { supabaseAdmin } from "./supabase";
import { getErrorBook, type ErrorItem } from "./errorbook";
import { bjDateStr, bjWeekMonday, bjDayStart } from "./dates";

/**
 * 仪表盘数据聚合（RSC 直接调，无需 HTTP 中转）。今日页 = 每日实时进度 + 答疑/教练入口。
 * PC 主系统时代（2026-07-06）：APP 端定位=应急+全量展示，今日页要能一眼看到【今天/本周真实进度】。
 *   1. Hero ：距 2026-12-21 初试 + 距 2026-09-30 基础结业死线
 *   2. 今日 ：今天学了什么(study_log log_date=今天) + 今天吸收错题数
 *   3. 本周 ：本周吸收数 + 打卡条数
 *   4. 各科进度：学习流水聚合的已铺开章节（每科）
 *   5. 答疑/教练/待办入口 + Top5 错题本（=弱项）
 */

export interface DashboardData {
  hero: { examDate: string; daysLeft: number; daysToBase: number };
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  today: { studied: { subject: string; chapter: string | null; activity: string }[]; absorbed: number };
  week: { absorbed: number; logs: number };
  progress: { subject: string; chapters: string[] }[];
  top5: ErrorItem[];
}

const EXAM_DATE = "2026-12-21";
const BASE_DEADLINE = "2026-09-30";
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

export async function getDashboard(): Promise<DashboardData> {
  const now = new Date();
  const todayStr = bjDateStr(now);
  const weekStart = bjWeekMonday(now);

  const [askLatest, askCount, eventsPending, errors, todayLog, todayAbs, weekAbs, weekLog, progRows] =
    await Promise.all([
      supabaseAdmin.from("ask_summary").select("confusion").eq("status", "open").order("created_at", { ascending: false }).limit(1),
      supabaseAdmin.from("ask_summary").select("*", { count: "exact", head: true }).eq("status", "open"),
      supabaseAdmin.from("events").select("type").eq("status", "pending"),
      getErrorBook(),
      supabaseAdmin.from("study_log").select("subject, chapter, activity").eq("log_date", todayStr),
      supabaseAdmin.from("study_error").select("*", { count: "exact", head: true }).eq("status", "absorbed").gte("absorbed_at", bjDayStart(todayStr)),
      supabaseAdmin.from("study_error").select("*", { count: "exact", head: true }).eq("status", "absorbed").gte("absorbed_at", bjDayStart(weekStart)),
      supabaseAdmin.from("study_log").select("*", { count: "exact", head: true }).gte("log_date", weekStart),
      supabaseAdmin.from("study_log").select("subject, chapter, activity, log_date").not("chapter", "is", null).order("log_date", { ascending: false }).limit(400),
    ]);
  const STUDY_ACT = new Set(["听课", "做题", "背诵"]); // 各科进度只认实打实学习动作，复盘/其他不算"铺开章节"

  const daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE).getTime() - now.getTime()) / DAY));
  const daysToBase = Math.ceil((new Date(BASE_DEADLINE).getTime() - now.getTime()) / DAY);

  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const studied = (todayLog.data ?? []).map((r) => ({
    subject: (r.subject as string | null) ?? "未识别",
    chapter: (r.chapter as string | null) ?? null,
    activity: (r.activity as string | null) ?? "其他",
  }));

  // 各科已铺开章节（学习流水聚合，最近在前，每科最多 8 章）
  const progMap = new Map<string, string[]>();
  for (const r of progRows.data ?? []) {
    const subj = r.subject as string;
    const ch = r.chapter as string | null;
    if (!SUBJECTS.includes(subj) || !ch || !STUDY_ACT.has((r.activity as string | null) ?? "")) continue;
    const arr = progMap.get(subj) ?? [];
    if (!arr.includes(ch) && arr.length < 8) arr.push(ch);
    progMap.set(subj, arr);
  }
  const progress = SUBJECTS.flatMap((s) => {
    const ch = progMap.get(s);
    return ch?.length ? [{ subject: s, chapters: ch }] : [];
  });

  return {
    hero: { examDate: EXAM_DATE, daysLeft, daysToBase },
    ask: { openCount: askCount.count ?? 0, lastConfusion: askLatest.data?.[0]?.confusion ?? null },
    coach: { openErrors: errors.length },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    today: { studied, absorbed: todayAbs.count ?? 0 },
    week: { absorbed: weekAbs.count ?? 0, logs: weekLog.count ?? 0 },
    progress,
    top5: errors.slice(0, 5),
  };
}
