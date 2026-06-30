import { supabaseAdmin } from "./supabase";

/**
 * 仪表盘数据聚合（RSC 直接调，无需 HTTP 中转）。
 *
 * 背诵模块下线后（2026-06-29，云改用 Anki app）今日页重做为【答疑 + 教练】为中心，
 * 原背诵衍生数据（每日清单/掌握度雷达/检测热力/今日检测）全部撤掉：
 *   1. Hero ：距 2026-12-21 初试天数
 *   2. 答疑 ：开放卡点数 + 最近一条 confusion
 *   3. 教练 ：未吸收自报错题数（study_error open）
 *   4. 待办 ：events pending 按 type 分组计数
 *   5. Top5 ：错次最多的弱项考点（kp_state，mastered=false；教练账本同口径）
 */

export interface DashboardData {
  hero: { examDate: string; daysLeft: number };
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  top5: { kp_id: string; subject: string; name: string; error_count: number }[];
}

const EXAM_DATE = "2026-12-21";

export async function getDashboard(): Promise<DashboardData> {
  const today = new Date();

  const [askLatest, askCount, eventsPending, openErr, top5] = await Promise.all([
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
      .from("study_error")
      .select("*", { count: "exact", head: true })
      .eq("status", "open"),
    supabaseAdmin
      .from("kp_state")
      .select("kp_id, subject, ext, error_count")
      .gt("error_count", 0)
      .eq("mastered", false) // 已强化退场，与弱项页/教练 Top5 同口径
      .order("error_count", { ascending: false })
      .limit(5),
  ]);

  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(EXAM_DATE).getTime() - today.getTime()) / 86400000),
  );

  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const top5List = (top5.data ?? []).map((k) => ({
    kp_id: k.kp_id,
    subject: k.subject,
    name: (k.ext as { name?: string })?.name ?? k.kp_id,
    error_count: k.error_count,
  }));

  return {
    hero: { examDate: EXAM_DATE, daysLeft },
    ask: {
      openCount: askCount.count ?? 0,
      lastConfusion: askLatest.data?.[0]?.confusion ?? null,
    },
    coach: { openErrors: openErr.count ?? 0 },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    top5: top5List,
  };
}
