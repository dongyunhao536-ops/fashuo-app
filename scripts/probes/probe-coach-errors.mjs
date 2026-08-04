// 一次性：验证 study_error 通过 PostgREST（service_role）可读写 + loadLedger 查询形态成立。
// 不调 LLM、不依赖 runCoach（那是 TS）；纯验 DB 通路（grant + schema reload 是否生效）。
// 跑法：node --env-file=.env.local scripts/probe-coach-errors.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MARK = "__probe_err__";
const today = new Date().toISOString().slice(0, 10);
const since14 = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);

// 1) 插入两条测试错题（一条带 kp_id 模拟匹配上、一条 null 模拟未匹配）
const { error: insErr } = await sb.from("study_error").insert([
  { log_date: today, subject: "刑法", kp_id: "PROBE-KP", knowledge: MARK + "正当防卫", source: "probe", raw_input: MARK },
  { log_date: today, subject: "刑法", kp_id: null, knowledge: MARK + "说不清的点", source: "probe", raw_input: MARK },
]);
if (insErr) {
  console.error("✗ 插入失败（grant/缓存重载可能没生效）：", insErr.message);
  process.exit(1);
}
console.log("✓ 插入 2 条测试错题");

// 2) 按 loadLedger 的查询形态读回（近14天）
const { data, error: selErr } = await sb
  .from("study_error")
  .select("subject, kp_id, knowledge")
  .gte("log_date", since14);
if (selErr) {
  console.error("✗ 查询失败：", selErr.message);
  process.exit(1);
}
const mine = (data ?? []).filter((r) => String(r.knowledge).startsWith(MARK));
console.log(`✓ 查回 ${mine.length} 条本次测试行（总 ${data?.length ?? 0} 条在近14天窗）`);
console.log("  样本：", JSON.stringify(mine));

// 3) 清理测试行（source='probe'）
const { error: delErr } = await sb.from("study_error").delete().eq("source", "probe");
if (delErr) {
  console.error("⚠️ 清理失败，请手动删 source='probe' 的行：", delErr.message);
  process.exit(1);
}
console.log("✓ 已清理测试行");

if (mine.length === 2) {
  console.log("\n✅ PostgREST 通路 OK：service_role 可读写 study_error，loadLedger 查询形态成立。");
} else {
  console.error("\n✗ 读回行数不符（期望 2），排查 grant/缓存。");
  process.exit(1);
}
