// 一次性：验证 study_error 闭环 DB 路径（迁移004 后 status 列经 PostgREST 可读 + open过滤 + 销账update）。
// 不调 LLM；纯验 coach.ts 闭环逻辑依赖的 DB 操作。跑法：node --env-file=.env.local scripts/probe-coach-loop.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const MARK = "__probe_loop__";
const today = new Date().toISOString().slice(0, 10);
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

// 1) 插两条未吸收（默认 status=open）：一条带 kp_id，一条不带
const { error: insErr } = await sb.from("study_error").insert([
  { log_date: today, subject: "刑法", kp_id: "PROBE-KP", knowledge: MARK + "甲", source: "probe", raw_input: MARK },
  { log_date: today, subject: "刑法", kp_id: null, knowledge: MARK + "乙", source: "probe", raw_input: MARK },
]);
if (insErr) fail("插入失败（status 列/缓存重载可能没生效）：" + insErr.message);

// 2) status=open 过滤（loadLedger 的读法）应查到 2 条
const open1 = (await sb.from("study_error").select("knowledge, status").eq("status", "open").like("knowledge", MARK + "%")).data ?? [];
if (open1.length !== 2) fail(`open 过滤期望 2 条，实得 ${open1.length}`);
console.log("✓ status=open 过滤读到 2 条（status 列经 PostgREST 可读）");

// 3) 销账：把带 kp_id 的标 absorbed（coach 手动/自动退场的 update 路径）
const { error: upErr } = await sb.from("study_error")
  .update({ status: "absorbed", absorbed_via: "manual", absorbed_at: new Date().toISOString() })
  .eq("status", "open").eq("kp_id", "PROBE-KP").like("knowledge", MARK + "%");
if (upErr) fail("销账 update 失败：" + upErr.message);

// 4) 再查 open 应只剩 1 条（被吸收的退场了）
const open2 = (await sb.from("study_error").select("knowledge").eq("status", "open").like("knowledge", MARK + "%")).data ?? [];
if (open2.length !== 1) fail(`销账后 open 期望 1 条，实得 ${open2.length}`);
console.log("✓ 销账后 open 只剩 1 条（吸收的已退出未吸收清单）");

// 5) 清理
const { error: delErr } = await sb.from("study_error").delete().eq("source", "probe");
if (delErr) fail("清理失败，请手动删 source='probe'：" + delErr.message);
console.log("✓ 已清理测试行");
console.log("\n✅ 闭环 DB 路径 OK：status 列可读、open 过滤成立、销账 update 生效。");
