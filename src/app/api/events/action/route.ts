import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/events/action —— 待办筐手机端处理候选。
 * 入参：{ id: number, action: "confirm" | "dismiss" }
 *   confirm → status=confirmed（云收下，待 PC 登记进 markdown；PC 登记脚本只处理 confirmed）
 *   dismiss → status=dismissed（云忽略，不进档案）
 *
 * 系统设计/11：手机不直接改 markdown，只改 Supabase 的 events 状态；PC 唯一登记员去重。
 * 这一步让待办筐从只读变成"云拍板"——飞轮的手机端确认环。
 */

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

export async function POST(req: Request) {

  let body: { id?: number; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const id = Number(body.id);
  const action = body.action;
  if (!Number.isFinite(id)) {
    return Response.json({ error: "id 非法" }, { status: 400 });
  }
  if (action !== "confirm" && action !== "dismiss") {
    return Response.json({ error: "action 必须是 confirm 或 dismiss" }, { status: 400 });
  }

  const status = action === "confirm" ? "confirmed" : "dismissed";
  const { data: updated, error } = await supabaseAdmin
    .from("events")
    .update({ status, consumed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending") // 仅处理仍 pending 的（防重复点击/竞态）
    .select("id");

  if (error) {
    console.error("[/api/events/action] 失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }
  // 0 行命中 = 已在别的设备/标签页处理过（或 id 不存在）——不能回 ok 让前端假确认
  if (!updated || updated.length === 0) {
    return Response.json({ error: "该条已被处理过或不存在", kind: "stale" }, { status: 409 });
  }
  return Response.json({ ok: true, id, status });
}
