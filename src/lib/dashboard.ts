import { supabaseAdmin } from "./supabase";
import { getErrorBook, type ErrorItem } from "./errorbook";

/**
 * 仪表盘数据聚合（RSC 直接调，无需 HTTP 中转）。今日页以【答疑 + 教练】为中心：
 *   1. Hero ：距 2026-12-21 初试天数
 *   2. 答疑 ：开放卡点数 + 最近一条 confusion
 *   3. 教练 ：错题本未吸收条数
 *   4. 待办 ：events pending 按 type 分组计数
 *   5. Top5 ：错题本（=弱项，study_error 聚合，与教练错题tab/errors页同源）
 */

export interface DashboardData {
  hero: { examDate: string; daysLeft: number };
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  top5: ErrorItem[];
}

const EXAM_DATE = "2026-12-21";

export async function getDashboard(): Promise<DashboardData> {
  const today = new Date();

  const [askLatest, askCount, eventsPending, errors] = await Promise.all([
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
    getErrorBook(),
  ]);

  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(EXAM_DATE).getTime() - today.getTime()) / 86400000),
  );

  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  return {
    hero: { examDate: EXAM_DATE, daysLeft },
    ask: {
      openCount: askCount.count ?? 0,
      lastConfusion: askLatest.data?.[0]?.confusion ?? null,
    },
    coach: { openErrors: errors.length },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    top5: errors.slice(0, 5),
  };
}
