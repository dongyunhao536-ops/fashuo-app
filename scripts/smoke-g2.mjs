#!/usr/bin/env node
/**
 * G2 闭环烟测（零 LLM 花费）：
 *   ① 手工往 events 插一条 type=复验请求 pending（模拟答疑投递）
 *   ② 调 /api/schedule?subject=刑法 → 该 kp 应出现在【复验】bucket、优先级最高
 *   ③ 验证清单 counts.复验 ≥ 1
 *
 * 用法：
 *   node --env-file=.env.local scripts/smoke-g2.mjs [kpId]
 *   默认 KP_ID=XF-0042
 *
 * 需先起 next dev（npm run dev）。
 */
import { createClient } from "@supabase/supabase-js";

const KP_ID = process.argv[2] || "XF-0042";
const BASE = process.env.DETECT_BASE_URL || "http://localhost:3000";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// ① 清旧 + 插新复验请求
console.log(`▶ 清 ${KP_ID} 的旧 复验请求（可重入）…`);
await sb
  .from("events")
  .delete()
  .eq("type", "复验请求")
  .eq("kp_id", KP_ID)
  .eq("status", "pending");

console.log(`▶ 插入新 复验请求(模拟答疑产出)：${KP_ID}`);
const { error: insErr } = await sb.from("events").insert({
  type: "复验请求",
  subject: "刑法",
  kp_id: KP_ID,
  knowledge: "烟测模拟：答疑澄清后复验",
  source: "答疑",
  payload: { reason: "G2 烟测插入", 触发: "G2 答疑澄清后复验" },
  status: "pending",
});
if (insErr) {
  console.error(`✗ 插入失败:`, insErr.message);
  process.exit(1);
}

// ② 调度
console.log(`\n▶ GET /api/schedule?subject=刑法&capacity=30`);
const r = await fetch(`${BASE}/api/schedule?subject=刑法&capacity=30`);
const plan = await r.json();
if (!r.ok) {
  console.error(`✗ 调度失败:`, plan);
  process.exit(1);
}

console.log(`  stage: ${plan.stage}  date: ${plan.date}`);
console.log(`  counts: ${JSON.stringify(plan.counts)}`);
console.log(`\n  清单（前 6 条）：`);
plan.items.slice(0, 6).forEach((it, i) =>
  console.log(`    [${i + 1}] ${it.bucket.padEnd(3)} ${it.kp_id} ${it.name}  | P=${it.priority} (V=${it.value}, U=${it.urgency}) | freq=${it.zhenti_freq} | ${it.reason}`),
);

// ③ 断言：复验 bucket 含 KP_ID，且排在最前
const review = plan.items.filter((it) => it.bucket === "复验");
const first = plan.items[0];
const ok =
  review.length >= 1 &&
  review.some((it) => it.kp_id === KP_ID) &&
  first?.kp_id === KP_ID;

console.log(`\n  复验 bucket 含 ${KP_ID}: ${review.some((it) => it.kp_id === KP_ID) ? "✓" : "✗"}`);
console.log(`  清单首位是 ${KP_ID}（复验最高优先）: ${first?.kp_id === KP_ID ? "✓" : "✗（首=" + first?.kp_id + " " + first?.bucket + "）"}`);
console.log(`\n═══ G2 烟测${ok ? "✓ 通过" : "✗ 失败"} ═══`);
process.exit(ok ? 0 : 1);
