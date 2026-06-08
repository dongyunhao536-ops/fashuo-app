import { supabaseAdmin } from "./supabase";
import { buildDailyPlan, type KpRow } from "./scheduler";

/**
 * 仪表盘数据聚合（RSC 直接调，无需 HTTP 中转）。
 * 系统设计/14 §6 G3 仪表 = 账本只读视图；UI 层不写任何状态。
 *
 * 五块数据（对齐效果图 0. 仪表盘）：
 *   1. Hero  ：距 2026-12-21 初试天数 + 今日总学习分钟 + 今日检测次数
 *   2. 双核  ：今日清单完成度 + 答疑开放卡点数 + 最近一条 confusion
 *   3. 雷达  ：五科 kp_state 聚合（mastered 数 / 总数）
 *   4. 待办  ：events pending 按 type 分组计数
 *   5. Top5  ：错次最多的考点
 *   6. 本周  ：近 7 天 detection + study 活动密度
 */

export interface DashboardData {
  hero: {
    examDate: string;
    daysLeft: number;
    todayMinutes: number;
    todayDetections: number;
  };
  cores: {
    plan: {
      total: number;
      done: number;
      bucketCounts: { 复验: number; 到期: number; 新考点: number };
    };
    ask: { openCount: number; lastConfusion: string | null };
  };
  radar: { subject: string; mastered: number; total: number; pct: number }[];
  inbox: { pendingCount: number; byType: Record<string, number> };
  top5: {
    kp_id: string;
    subject: string;
    name: string;
    error_count: number;
    cur_level: string;
  }[];
  weekHeat: { date: string; minutes: number; detections: number }[];
}

const EXAM_DATE = "2026-12-21";
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const PLAN_CAPACITY = 30;

export async function getDashboard(): Promise<DashboardData> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const week0 = daysAgo(6, today); // 含今天往回 7 天

  // 并行拉所有数据
  const [
    kpAll,
    askLatest,
    askCount,
    eventsPending,
    reviewEv,
    top5,
    weekStudy,
    weekDetect,
    todayStudy,
    todayDetect,
  ] = await Promise.all([
    supabaseAdmin.from("kp_state").select("*"),
    supabaseAdmin
      .from("ask_summary")
      .select("confusion, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("ask_summary")
      .select("*", { count: "exact", head: true })
      .eq("status", "open"),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin
      .from("events")
      .select("kp_id")
      .eq("type", "复验请求")
      .eq("status", "pending"),
    supabaseAdmin
      .from("kp_state")
      .select("kp_id, subject, ext, error_count, cur_level")
      .gt("error_count", 0)
      .order("error_count", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("study_log")
      .select("log_date, minutes")
      .gte("log_date", week0),
    supabaseAdmin
      .from("detection_log")
      .select("ts, kp_id")
      .gte("ts", week0 + "T00:00:00"),
    supabaseAdmin.from("study_log").select("minutes").eq("log_date", todayStr),
    supabaseAdmin
      .from("detection_log")
      .select("id, kp_id")
      .gte("ts", todayStr + "T00:00:00")
      .lte("ts", todayStr + "T23:59:59"),
  ]);

  // —— 1. Hero ——
  const todayMinutes = (todayStudy.data ?? []).reduce(
    (s, r) => s + (r.minutes ?? 0),
    0,
  );
  const todayDetections = (todayDetect.data ?? []).length;
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(EXAM_DATE).getTime() - today.getTime()) / 86400000),
  );

  // —— 2. 双核：实算今日清单（复用调度器，保证与背诵 tab 一致）——
  const reviewKpIds = (reviewEv.data ?? [])
    .map((e) => e.kp_id)
    .filter((x): x is string => !!x);
  const plan = buildDailyPlan({
    kps: (kpAll.data ?? []) as KpRow[],
    reviewKpIds,
    capacity: PLAN_CAPACITY,
    today,
  });
  // 完成度：今日 detection_log 触及的不同 kp 数（即"今天背了几个考点"）
  const doneKpIds = new Set((todayDetect.data ?? []).map((d) => d.kp_id));
  const planDone = plan.items.filter((it) => doneKpIds.has(it.kp_id)).length;

  // —— 3. 雷达：按科目聚合 mastered/总数 ——
  const radarMap = new Map<string, { mastered: number; total: number }>();
  for (const s of SUBJECTS) radarMap.set(s, { mastered: 0, total: 0 });
  for (const k of (kpAll.data ?? []) as KpRow[]) {
    const row = radarMap.get(k.subject);
    if (!row) continue;
    row.total++;
    if (k.mastered) row.mastered++;
  }
  const radar = SUBJECTS.map((s) => {
    const row = radarMap.get(s)!;
    const pct = row.total === 0 ? 0 : Math.round((row.mastered / row.total) * 100);
    return { subject: s, mastered: row.mastered, total: row.total, pct };
  });

  // —— 4. 待办筐 ——
  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  // —— 5. Top5 ——
  const top5List = (top5.data ?? []).map((k) => ({
    kp_id: k.kp_id,
    subject: k.subject,
    name: (k.ext as { name?: string })?.name ?? k.kp_id,
    error_count: k.error_count,
    cur_level: k.cur_level,
  }));

  // —— 6. 本周复习密度 ——
  const dayMap = new Map<string, { minutes: number; detections: number }>();
  for (let i = 6; i >= 0; i--) {
    dayMap.set(daysAgo(i, today), { minutes: 0, detections: 0 });
  }
  for (const s of weekStudy.data ?? []) {
    const k = String(s.log_date);
    const row = dayMap.get(k);
    if (row) row.minutes += s.minutes ?? 0;
  }
  for (const d of weekDetect.data ?? []) {
    const k = String(d.ts).slice(0, 10);
    const row = dayMap.get(k);
    if (row) row.detections++;
  }
  const weekHeat = Array.from(dayMap.entries()).map(([date, v]) => ({
    date,
    ...v,
  }));

  return {
    hero: { examDate: EXAM_DATE, daysLeft, todayMinutes, todayDetections },
    cores: {
      plan: {
        total: plan.items.length,
        done: planDone,
        bucketCounts: {
          复验: plan.counts.复验,
          到期: plan.counts.到期,
          新考点: plan.counts.新考点,
        },
      },
      ask: {
        openCount: askCount.count ?? 0,
        lastConfusion: askLatest.data?.[0]?.confusion ?? null,
      },
    },
    radar,
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    top5: top5List,
    weekHeat,
  };
}

function daysAgo(n: number, base: Date): string {
  return new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
}
