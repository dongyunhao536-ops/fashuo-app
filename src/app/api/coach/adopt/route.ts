import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/coach/adopt —— 回写教练③规划建议的处置（采纳率埋点，BUILD_PLAN 🔖 待补埋点之一）。
 * 入参：{ logId: number, decision: "采纳" | "改一改" | "不按" }
 * 写 study_log.plan_decision；周报据此算"调度建议采纳率"。
 *
 * 红线无关，纯状态回写，零 LLM 花费。幂等：重复点同一 logId 覆盖最新选择。
 */

export const maxDuration = 20;

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

const VALID = ["采纳", "改一改", "不按"];

export async function POST(req: Request) {

  let body: { logId?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const logId =
    typeof body.logId === "number" && Number.isFinite(body.logId) ? body.logId : null;
  const decision = typeof body.decision === "string" ? body.decision.trim() : "";

  if (logId == null) return Response.json({ error: "logId 不能为空" }, { status: 400 });
  if (!VALID.includes(decision)) {
    return Response.json({ error: "decision 必须是 采纳/改一改/不按" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("study_log")
    .update({ plan_decision: decision })
    .eq("id", logId);

  if (error) {
    console.error("[/api/coach/adopt] 写入失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }
  return Response.json({ ok: true, logId, decision });
}
