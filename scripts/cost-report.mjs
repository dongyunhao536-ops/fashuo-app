// node --env-file=.env.local scripts/cost-report.mjs
// 成本报告：今日 / 本月 API 花费（估算），对比日熔断与月预算。
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const pricing = JSON.parse(readFileSync("config/pricing.json", "utf8"));
const RMB = pricing._汇率 ?? 7.2;
const dailyBudget = Number(process.env.DAILY_BUDGET_USD ?? 3);
const monthlyCeiling = dailyBudget * 30;

const yuan = (usd) => `¥${(usd * RMB).toFixed(2)}`;
const bar = (frac) => {
  const n = Math.min(20, Math.max(0, Math.round(frac * 20)));
  return "█".repeat(n) + "░".repeat(20 - n);
};

const now = new Date();
const dayStart = new Date(now);
dayStart.setHours(0, 0, 0, 0);
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

const { data, error } = await sb
  .from("api_usage")
  .select("ts, route, model, est_cost_usd, output_tokens")
  .gte("ts", monthStart.toISOString())
  .order("ts", { ascending: true });

if (error) {
  console.error("查询 api_usage 失败：", error.message);
  console.error("（如果是 'relation \"api_usage\" does not exist'，先在 SQL Editor 应用 db/migrations/002_api_usage.sql）");
  process.exit(1);
}

const rows = data ?? [];
let todayUsd = 0;
let monthUsd = 0;
const byDay = {};
const byRoute = {};

for (const r of rows) {
  const c = Number(r.est_cost_usd ?? 0);
  monthUsd += c;
  if (new Date(r.ts) >= dayStart) todayUsd += c;
  const d = r.ts.slice(0, 10);
  byDay[d] = (byDay[d] ?? 0) + c;
  byRoute[r.route ?? "?"] = (byRoute[r.route ?? "?"] ?? 0) + c;
}

console.log("═══════════════════════════════════════════");
console.log("  法硕 APP · API 成本报告（估算值）");
console.log("═══════════════════════════════════════════\n");

console.log(`今日   $${todayUsd.toFixed(4)}  ${yuan(todayUsd)}`);
console.log(`  日熔断 $${dailyBudget}  ${bar(todayUsd / dailyBudget)}  ${((todayUsd / dailyBudget) * 100).toFixed(0)}%`);
if (todayUsd >= dailyBudget) console.log("  ⛔ 今日已撞熔断，API 调用会被拒绝到明天 0 点");

console.log(`\n本月   $${monthUsd.toFixed(4)}  ${yuan(monthUsd)}`);
console.log(`  月硬顶 $${monthlyCeiling.toFixed(0)}  ${bar(monthUsd / monthlyCeiling)}  ${((monthUsd / monthlyCeiling) * 100).toFixed(0)}%`);
console.log(`  设计目标区间 ¥150–300/月`);

if (Object.keys(byRoute).length) {
  console.log("\n按用途：");
  for (const [k, v] of Object.entries(byRoute).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} $${v.toFixed(4)}  ${yuan(v)}`);
  }
}

if (Object.keys(byDay).length) {
  console.log("\n按天：");
  for (const [d, v] of Object.entries(byDay)) {
    console.log(`  ${d}  $${v.toFixed(4)}  ${yuan(v)}`);
  }
}

console.log(`\n调用次数：${rows.length}`);
console.log("\n⚠️ 以上为估算（config/pricing.json）。真实账单以七牛云控制台为准；用真实账单校准 pricing.json 后此报告才准。");
