// 一次性：验证 weekly_report 经 PostgREST(service_role) 可读写（迁移006 grant+reload 是否生效）。
// 跑法：node --env-file=.env.local scripts/probe-weekly.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const MARK = "1900-01-01"; // 不可能的真实周，用作探针 week_start
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

let e = (await sb.from("weekly_report").upsert(
  { week_start: MARK, week_end: MARK, content: "__probe__", data_snapshot: { x: 1 }, model: "probe", cost_usd: 0 },
  { onConflict: "week_start" },
)).error;
if (e) fail("upsert 失败（grant/缓存未生效？）：" + e.message);

const row = (await sb.from("weekly_report").select("content, data_snapshot").eq("week_start", MARK).maybeSingle()).data;
if (!row || row.content !== "__probe__" || row.data_snapshot?.x !== 1) fail("读回不一致");
console.log("✓ weekly_report 经 PostgREST 可 upsert/读回（jsonb 快照保住）");

// 再 upsert 同周 → 覆盖（不报唯一冲突）
e = (await sb.from("weekly_report").upsert({ week_start: MARK, week_end: MARK, content: "__probe2__" }, { onConflict: "week_start" })).error;
if (e) fail("同周覆盖失败：" + e.message);
const c = (await sb.from("weekly_report").select("content").eq("week_start", MARK).maybeSingle()).data?.content;
if (c !== "__probe2__") fail("覆盖后内容未更新");
console.log("✓ 同周覆盖刷新 OK");

e = (await sb.from("weekly_report").delete().eq("week_start", MARK)).error;
if (e) fail("清理失败：" + e.message);
console.log("✓ 已清理\n\n✅ weekly_report 通路 OK。");
