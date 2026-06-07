import { supabaseAdmin } from "@/lib/supabase";
import { buildDailyPlan, type KpRow } from "@/lib/scheduler";

/**
 * GET /api/schedule?subject=刑法&capacity=30 —— 今日背诵清单（build order ③ 调度器）。
 * 读 kp_state（295 刑法考点）+ pending 复验请求(events G2) → 按优先级排清单。
 * 纯逻辑、零 LLM 花费。无 UI 也可 curl 验证。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const subject = url.searchParams.get("subject") || undefined;
  const capacity = Number(url.searchParams.get("capacity")) || 30;

  try {
    let q = supabaseAdmin.from("kp_state").select("*");
    if (subject) q = q.eq("subject", subject);
    const { data: kps, error } = await q;
    if (error) throw new Error(`kp_state 读取失败：${error.message}`);

    // G2：pending 复验请求的考点ID
    const { data: ev } = await supabaseAdmin
      .from("events")
      .select("kp_id")
      .eq("type", "复验请求")
      .eq("status", "pending");
    const reviewKpIds = (ev ?? [])
      .map((e) => e.kp_id)
      .filter((x): x is string => Boolean(x));

    const plan = buildDailyPlan({
      kps: (kps ?? []) as KpRow[],
      reviewKpIds,
      capacity,
    });

    return Response.json(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/schedule] 失败：", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
