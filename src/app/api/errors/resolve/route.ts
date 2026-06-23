import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/errors/resolve —— 错题本手动收口（2026-06-22）。
 * 入参：{ subject: string|null, knowledge: string, action: "absorb" | "dismiss" }
 *   absorb  → 云说"我会了"：把该 (subject, knowledge) 的所有 open study_error 标 absorbed（手动退场）
 *   dismiss → "这条不是错/记错了"：标 dismissed，从未吸收清单移除（不再喂教练）
 * 解决"教练没问、自己没说懂 → 错题永远挂着"——给云一个随时清的口子。
 * 鉴权由 src/proxy.ts 统一网关处理。
 */

export async function POST(req: Request) {
  let body: { subject?: string | null; knowledge?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const subject = body.subject ?? null;
  const knowledge = (body.knowledge ?? "").trim();
  const action = body.action;
  if (!knowledge) return Response.json({ error: "knowledge 不能为空" }, { status: 400 });
  if (action !== "absorb" && action !== "dismiss") {
    return Response.json({ error: "action 必须是 absorb 或 dismiss" }, { status: 400 });
  }

  const patch =
    action === "absorb"
      ? { status: "absorbed", absorbed_via: "manual", absorbed_at: new Date().toISOString() }
      : { status: "dismissed", absorbed_via: "manual_dismiss", absorbed_at: new Date().toISOString() };

  let q = supabaseAdmin.from("study_error").update(patch).eq("status", "open").eq("knowledge", knowledge);
  q = subject == null ? q.is("subject", null) : q.eq("subject", subject);
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[/api/errors/resolve] 失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: "该条已处理过或不存在", kind: "stale" }, { status: 409 });
  }
  return Response.json({ ok: true, action, cleared: data.length });
}
