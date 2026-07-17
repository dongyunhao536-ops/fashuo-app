// 一次性：验证 coach_message / coach_memory 经 PostgREST(service_role) 可读写（迁移005 grant+重载是否生效）。
// 跑法：node --env-file=.env.local scripts/probe-coach-mem.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const MARK = "__probe_mem__";
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

// coach_message：插两条对话 → 读回
let e = (await sb.from("coach_message").insert([
  { role: "user", content: MARK + "云说" },
  { role: "assistant", content: MARK + "教练答" },
])).error;
if (e) fail("coach_message 插入失败（grant/缓存？）：" + e.message);
const msgs = (await sb.from("coach_message").select("role, content").like("content", MARK + "%").order("id", { ascending: false })).data ?? [];
if (msgs.length !== 2) fail(`coach_message 读回期望 2，实得 ${msgs.length}`);
console.log("✓ coach_message 可读写（对话连续性）");

// coach_memory：插一条事实 → 读回
e = (await sb.from("coach_memory").insert({ fact: MARK + "五战", category: "画像" })).error;
if (e) fail("coach_memory 插入失败：" + e.message);
const mem = (await sb.from("coach_memory").select("fact, category").like("fact", MARK + "%")).data ?? [];
if (mem.length !== 1) fail(`coach_memory 读回期望 1，实得 ${mem.length}`);
console.log("✓ coach_memory 可读写（长期记忆）");

// 清理
e = (await sb.from("coach_message").delete().like("content", MARK + "%")).error;
if (e) fail("清理 coach_message 失败：" + e.message);
e = (await sb.from("coach_memory").delete().like("fact", MARK + "%")).error;
if (e) fail("清理 coach_memory 失败：" + e.message);
console.log("✓ 已清理测试行\n\n✅ 教练记忆表通路 OK：service_role 可读写 coach_message / coach_memory。");
