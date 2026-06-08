import { supabaseAdmin } from "./supabase";
import { buildDailyPlan, type KpRow } from "./scheduler";

/**
 * 今日背诵清单（RSC 直接调，零 LLM 花费）。
 * 复用调度器 buildDailyPlan，保证背诵 tab 与仪表盘双核入口同源。
 *
 * 流程：读全部 kp_state（可按 subject 过滤）+ pending 复验请求(G2) → 价值加权排清单。
 */
export async function getTodayPlan(subject?: string, capacity = 30) {
  let q = supabaseAdmin.from("kp_state").select("*");
  if (subject) q = q.eq("subject", subject);
  const [{ data: kps, error }, { data: reviewEv }] = await Promise.all([
    q,
    supabaseAdmin
      .from("events")
      .select("kp_id")
      .eq("type", "复验请求")
      .eq("status", "pending"),
  ]);
  if (error) throw new Error(`getTodayPlan 读取 kp_state 失败：${error.message}`);

  const reviewKpIds = (reviewEv ?? [])
    .map((e) => e.kp_id)
    .filter((x): x is string => !!x);

  return buildDailyPlan({
    kps: (kps ?? []) as KpRow[],
    reviewKpIds,
    capacity,
  });
}
