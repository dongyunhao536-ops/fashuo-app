// node --env-file=.env.local scripts/verify-schema.mjs
// 用 service_role 通过 PostgREST 探所有表是否就位
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
// api_usage 必须在列：它是成本日熔断的命脉表，缺了 recordUsage 静默失败 +
// getTodaySpendUsd fail-open 返 0 → 熔断静默失效、预算能被烧穿（migrations/002）。
const tables = [
  "content_mirror",
  "kp_state",
  "detection_log",
  "study_log",
  "ask_summary",
  "events",
  "api_usage",
];

let ok = 0;
for (const t of tables) {
  const { error, count } = await sb.from(t).select("*", { count: "exact", head: true });
  if (error) {
    console.log(`✗ ${t.padEnd(16)} — ${error.message}`);
  } else {
    console.log(`✓ ${t.padEnd(16)} — rows: ${count ?? 0}`);
    ok++;
  }
}
console.log(`\n${ok}/${tables.length} tables ready.`);
process.exit(ok === tables.length ? 0 : 1);
