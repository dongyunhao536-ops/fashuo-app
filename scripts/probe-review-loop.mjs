// 一次性：验证概念1（答疑弱项并入教练复习闭环）+ 概念2（讲义拓展→心得候选）的 DB 通路。
// 用真实 events 表跑我新写的那几条查询/更新，确认列名/过滤无误（tsc 查不到 schema 漂移）。
// 跑法：node --env-file=.env.local scripts/probe-review-loop.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const MARK = "__probe_review__正当防卫限度";
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

// —— 概念1：答疑弱项候选（pending, source=答疑）—— 教练账本应能捞到它
let e = (await sb.from("events").insert({
  type: "弱项候选", subject: "刑法", kp_id: null, knowledge: MARK,
  anchor: "2019-48", source: "答疑", payload: {}, status: "pending",
})).error;
if (e) fail("插入答疑弱项候选失败：" + e.message);

// loadLedger 里那条 select（type/status/source 过滤 + order + limit）
const ledger = (await sb.from("events")
  .select("subject, knowledge, anchor, created_at")
  .eq("type", "弱项候选").eq("status", "pending").eq("source", "答疑")
  .order("created_at", { ascending: false }).limit(8)).data ?? [];
if (!ledger.some((r) => r.knowledge === MARK)) fail("教练账本 select 没捞到答疑弱项（概念1读链断）");
console.log("✓ 概念1：答疑弱项候选可被教练账本捞回");

// 吸收销账：absorb 循环里那条 update（ilike + source + type + status → consumed）
const closed = (await sb.from("events")
  .update({ status: "consumed", consumed_at: new Date().toISOString() })
  .eq("type", "弱项候选").eq("status", "pending").eq("source", "答疑")
  .ilike("knowledge", "%正当防卫限度%").eq("subject", "刑法")
  .select("id")).data ?? [];
if (closed.length < 1) fail("吸收销账 update 没命中（概念1闭环断）");
console.log(`✓ 概念1：吸收即销账，answer 弱项 ${closed.length} 条 pending→consumed 退出待办筐`);

// —— 概念2：讲义拓展 → 心得候选（source=讲义拓展, payload.拓展）——
e = (await sb.from("events").insert({
  type: "心得候选", subject: "刑法", kp_id: null, knowledge: MARK + "·心得",
  anchor: "众合讲义P88", source: "讲义拓展",
  payload: { note: "讲义拓展·需≥1次真题背书才入正文（做题心得规则2）", 拓展: true },
  status: "pending",
})).error;
if (e) fail("插入讲义拓展心得候选失败：" + e.message);
const xinde = (await sb.from("events")
  .select("knowledge, source, payload, status")
  .eq("type", "心得候选").eq("source", "讲义拓展").like("knowledge", MARK + "%")).data ?? [];
if (xinde.length !== 1) fail(`心得候选读回期望1，实得${xinde.length}`);
if (xinde[0].payload?.["拓展"] !== true) fail("payload.拓展 标记没存住（待办筐 tag 会不显示）");
console.log("✓ 概念2：讲义拓展心得候选可投递、payload.拓展 标记保住（PC register-events 会进做题心得待观察表）");

// —— 清理：把本次造的 MARK 行删掉（含已 consumed 的）——
e = (await sb.from("events").delete().or(`knowledge.like.${MARK}%,knowledge.eq.${MARK}`)).error;
if (e) fail("清理失败，请手工删 knowledge like '" + MARK + "%' 的 events：" + e.message);
console.log("✓ 已清理测试行\n\n✅ 概念1/2 DB 通路全 OK。");
