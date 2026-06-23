import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/xinde/add —— 手动把【辅导讲义拓展点 / 自己悟到的规律】直接存进心得（2026-06-21；2026-06-22 改为录入即确认）。
 * 入参：{ subject: 刑法|民法|法理|宪法|法制史, rule: string, anchor?: string }
 *
 * 为什么要这条通道：答疑严守「考试分析→真题→教材」证据链，外部讲义拓展点没锚点它【不认】（设计如此）。
 * 但这些拓展点是有价值的补充——给云一个【主动登记】口。
 *
 * 【录入即确认】云手动录入 = 他已经判断过值得留 → 直接 status=confirmed（不用再去待办筐「收下」），
 * PC register-events 自动把 confirmed 心得候选并入 _{科目}做题心得.md 的「待观察」表（需≥1次真题背书才升正文，
 * 做题心得规则2）；同步后 search_xinde 查得到、答疑第①档优先认它。
 * 不直接写 markdown（手机只读档案，红线 #3：登记/去重只在 PC 一处）；故走 events，与答疑沉淀同管线。
 * 鉴权由 src/proxy.ts 统一网关处理（未登录的 /api/* 在网关被 401）。
 */

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

export async function POST(req: Request) {
  let body: { subject?: string; rule?: string; anchor?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const subject = (body.subject ?? "").trim();
  const rule = (body.rule ?? "").trim();
  const anchor = (body.anchor ?? "").trim() || null;

  if (!SUBJECTS.includes(subject)) {
    return Response.json({ error: "请先选科目（决定进哪本做题心得）" }, { status: 400 });
  }
  if (!rule) {
    return Response.json({ error: "拓展点内容不能为空" }, { status: 400 });
  }
  if (rule.length > 500) {
    return Response.json({ error: "一条别超 500 字（拓展点写成可复用的一句规律最好）" }, { status: 400 });
  }

  // 防重：同科目同规律若已在筐里（pending/confirmed）则不重复存
  const { data: dup } = await supabaseAdmin
    .from("events")
    .select("id")
    .eq("type", "心得候选")
    .eq("subject", subject)
    .eq("knowledge", rule)
    .in("status", ["pending", "confirmed"])
    .limit(1);
  if (dup && dup.length) {
    return Response.json({ ok: true, deduped: true });
  }

  // 录入即确认：直接 confirmed，跳过待办筐「收下」；PC register-events 自动并入做题心得「待观察」。
  const { error } = await supabaseAdmin.from("events").insert({
    type: "心得候选",
    subject,
    kp_id: null,
    knowledge: rule,
    anchor,
    source: "讲义拓展",
    payload: { note: "讲义拓展·需≥1次真题背书才入正文（做题心得规则2）", 拓展: true },
    status: "confirmed",
  });
  if (error) {
    console.error("[/api/xinde/add] 写入失败：", error.message);
    return Response.json({ error: "保存失败，稍后重试" }, { status: 502 });
  }
  return Response.json({ ok: true });
}
