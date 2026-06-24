import { supabaseAdmin } from "@/lib/supabase";
import { emitEvent } from "@/lib/events";
import { masterNowTransition } from "@/lib/kp-transition";
import type { KpRow } from "@/lib/scheduler";

/**
 * POST /api/weak/master —— 弱项「我已会」一键移出（2026-06-23；2026-06-24 接入排期）。
 * 入参：{ kpId: string }
 * 1) 标 mastered=true（弱项页/仪表盘 Top5/教练账本都按 mastered=false 过滤 → 立即退场）。
 * 2) 当作一次干净通过排进常规复习周期（masterNowTransition）：cap 内各档标 passed、间隔推进一档、
 *    next_due 落到常规节奏 —— 不再以"刚失手"的近端间隔在背诵清单里很快重现，而是按通过周期到期再现。
 * 3) 投「已强化」事件，PC register-events 把 当前弱项.md 对应行移入已强化段，保持档案一致。
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
    .select("subject, ext, cap_level, interval_idx, difficulty, review_count")
    .eq("kp_id", kpId)
    .maybeSingle();
  if (!kp) return Response.json({ error: "考点不存在", kind: "stale" }, { status: 409 });

  // 当作干净通过排进常规周期（只读 cap_level/interval_idx/difficulty）
  const t = masterNowTransition(kp as unknown as KpRow);
  const update: Record<string, unknown> = {
    mastered: true,
    cur_level: t.cur_level,
    interval_idx: t.interval_idx,
    difficulty: t.difficulty,
    last_review: t.lastReview,
    next_due: t.nextDue,
    l1_status: t.l1_status,
    review_count: (kp.review_count as number) + 1,
    updated_at: new Date().toISOString(),
  };
  if (t.l2_status) update.l2_status = t.l2_status;
  if (t.l3_status) update.l3_status = t.l3_status;

  const { error } = await supabaseAdmin.from("kp_state").update(update).eq("kp_id", kpId);
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
