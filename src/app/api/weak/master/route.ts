import { supabaseAdmin } from "@/lib/supabase";
import { emitEvent } from "@/lib/events";

/**
 * POST /api/weak/master —— 弱项「我已会」一键移出（2026-06-23）。
 * 入参：{ kpId: string }
 * 1) 标 mastered=true（弱项页/仪表盘 Top5/教练账本都按 mastered=false 过滤 → 立即退场）。
 * 2) 投「已强化」事件，PC register-events 把 当前弱项.md 对应行移入已强化段，保持档案一致。
 *
 * 背诵模块已下线（2026-06-29）：不再有 L1/L2/L3 复习周期，标掌握即直接退场，无需排期换算。
 * 鉴权由 src/proxy.ts 网关统一处理。
 */

export async function POST(req: Request) {
  let body: { kpId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const kpId = (body.kpId ?? "").trim();
  if (!kpId) return Response.json({ error: "kpId 不能为空" }, { status: 400 });

  const { data: kp } = await supabaseAdmin
    .from("kp_state")
    .select("subject, ext")
    .eq("kp_id", kpId)
    .maybeSingle();
  if (!kp) return Response.json({ error: "考点不存在", kind: "stale" }, { status: 409 });

  const { error } = await supabaseAdmin
    .from("kp_state")
    .update({ mastered: true, updated_at: new Date().toISOString() })
    .eq("kp_id", kpId);
  if (error) {
    console.error("[/api/weak/master] 失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }

  // 投「已强化」→ PC 登记把当前弱项.md 行移入已强化段（弱项有进有出，档案一致）
  await emitEvent({
    type: "已强化",
    subject: (kp.subject as string | null) ?? null,
    kp_id: kpId,
    knowledge: (kp.ext as { name?: string } | null)?.name ?? null,
    anchor: null,
    source: "手动我已会",
    dedupBy: "kp",
  });

  return Response.json({ ok: true, kpId });
}
