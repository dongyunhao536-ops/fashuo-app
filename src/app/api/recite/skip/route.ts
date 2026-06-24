import { supabaseAdmin } from "@/lib/supabase";
import { emitEvent } from "@/lib/events";
import { computeTransition, type Level } from "@/lib/kp-transition";
import type { KpRow } from "@/lib/scheduler";

/**
 * POST /api/recite/skip —— 背诵卡片「一键跳过」（2026-06-24，先只法理）。
 * 入参：{ kpId: string }
 *
 * 跳过 = 当作一次干净通过排进常规复习周期：computeTransition(cur_level, "干净通过")
 *   → 间隔沿 1→3→7→15→30 推进一档、本档标 passed、按需升档、next_due 落常规节奏，
 *   不再近端反复（下次到期才再现）。复用与检测同一套升降档逻辑（kp-transition 单测锁定）。
 * 写一条 detection_log（ai_grade="跳过"）→ 进「今天背了哪些」（独立"跳过"徽标，不计入"通过 X"）；
 *   但周报通过率/覆盖统计排除"跳过"（跳过≠真检测，见 weekly-review）。曾弱且本次达成 mastered 时
 *   仍投「已强化」，与检测口径一致，保持弱项档案有进有出。鉴权由 src/proxy.ts 网关统一处理。
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
    .select(
      "kp_id, subject, ext, cap_level, cur_level, l1_status, l2_status, l3_status, difficulty, interval_idx, mastered, error_count, review_count",
    )
    .eq("kp_id", kpId)
    .maybeSingle();
  if (!kp) return Response.json({ error: "考点不存在", kind: "stale" }, { status: 409 });

  const t = computeTransition(kp as unknown as KpRow, kp.cur_level as Level, "干净通过");
  const update: Record<string, unknown> = {
    cur_level: t.cur_level,
    interval_idx: t.interval_idx,
    difficulty: t.difficulty,
    last_review: t.lastReview,
    next_due: t.nextDue,
    mastered: t.mastered,
    review_count: (kp.review_count as number) + 1,
    error_count: (kp.error_count as number) + t.errorCountDelta, // 通过 → +0
    [t.statusField]: t.statusValue, // "passed"
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin.from("kp_state").update(update).eq("kp_id", kpId);
  if (error) {
    console.error("[/api/recite/skip] 失败：", error.message);
    return Response.json({ error: error.message }, { status: 502 });
  }

  // 写一条「跳过」检测记录 → 进「今天背了哪些」（独立徽标、不计通过；周报已排除"跳过"）
  await supabaseAdmin.from("detection_log").insert({
    kp_id: kpId,
    level: kp.cur_level, // 被"通过"的档（升档前）
    question: null,
    answer: null,
    ai_grade: "跳过",
    passed: true,
    seconds: null,
    model: "手动跳过",
    grep_lines: "",
    confidence: null,
    starred: false,
  });

  // 曾弱 + 本次首达 mastered → 投「已强化」（与检测一致，弱项档案有进有出）
  if (t.shouldEmitStrengthened) {
    await emitEvent({
      type: "已强化",
      subject: (kp.subject as string | null) ?? null,
      kp_id: kpId,
      knowledge: (kp.ext as { name?: string } | null)?.name ?? null,
      anchor: null,
      source: "跳过",
      dedupBy: "kp",
    });
  }

  return Response.json({ ok: true, kpId, nextDue: t.nextDue });
}
