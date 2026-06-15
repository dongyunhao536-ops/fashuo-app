import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/kp/freq —— 手动改某考点的真题频率（高/中/低）。
 * 入参：{ kpId, freq: '高'|'中'|'低' }
 * 写 kp_state.ext.zhenti_freq + 打 zhenti_freq_manual 标记（防 ai-freq 批量重判覆盖人工值）。
 * 频率即时生效于展示，并影响调度（valueOf 价值分 + 未过退档：高频砸回1天档）。
 * 鉴权由 src/middleware.ts 统一网关处理（未登录 /api/* 被 401）。
 */
const VALID = ["高", "中", "低"];

export async function POST(req: Request) {
  let body: { kpId?: string; freq?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const kpId = (body.kpId ?? "").trim();
  const freq = (body.freq ?? "").trim();
  if (!kpId) return Response.json({ error: "kpId 不能为空" }, { status: 400 });
  if (!VALID.includes(freq)) {
    return Response.json({ error: "freq 必须是 高/中/低" }, { status: 400 });
  }

  const { data: row, error: e1 } = await supabaseAdmin
    .from("kp_state")
    .select("ext")
    .eq("kp_id", kpId)
    .single();
  if (e1 || !row) return Response.json({ error: `找不到考点：${kpId}` }, { status: 404 });

  const ext = {
    ...((row.ext as Record<string, unknown>) ?? {}),
    zhenti_freq: freq,
    zhenti_freq_manual: true,
  };
  const { error: e2 } = await supabaseAdmin
    .from("kp_state")
    .update({ ext, updated_at: new Date().toISOString() })
    .eq("kp_id", kpId);
  if (e2) return Response.json({ error: e2.message }, { status: 502 });

  return Response.json({ ok: true, kpId, freq });
}
