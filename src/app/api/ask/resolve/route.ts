import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/ask/resolve —— 答疑卡点手动收口（2026-07-01）。
 * 入参：{ id: number, action: "clarify" | "dismiss" }
 *   clarify → 云说"这个点我打通了"：标 clarified，退出未收口（不再注入答疑记忆/教练/周报需关注）
 *   dismiss → "这条不算卡点/记岔了"：标 dismissed，移噪
 * 此前 clarified 无任何入口可达——卡点只会被同考点新答疑顶掉(superseded)或 90 天 TTL 过期，
 * 首页"答疑未收口"计数只涨不消。这是补上的收口口子。鉴权由 src/proxy.ts 统一网关处理。
 */

export async function POST(req: Request) {
  let body: { id?: number; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id 不合法" }, { status: 400 });
  if (action !== "clarify" && action !== "dismiss") {
    return Response.json({ error: "action 必须是 clarify 或 dismiss" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("ask_summary")
    .update({
      status: action === "clarify" ? "clarified" : "dismissed",
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolution_note: action === "clarify" ? "APP 手动确认已打通" : "APP 手动确认不算卡点",
    })
    .eq("id", id)
    .eq("status", "open")
    .select("id");
  if (error) {
    console.error("[/api/ask/resolve] 失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: "该条已处理过或不存在", kind: "stale" }, { status: 409 });
  }
  return Response.json({ ok: true, action });
}
