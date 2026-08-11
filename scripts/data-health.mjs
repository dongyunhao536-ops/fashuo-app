// node --env-file=.env.local scripts/data-health.mjs [--json]
// [gpt] 2026-08-10：部署后的一键数据不变量巡检，不输出密钥或远端环境对象。
import { createClient } from "@supabase/supabase-js";
import { evaluateDataHealth } from "./lib/data-health.mjs";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const json = process.argv.includes("--json");
const db = createClient(url, key, { auth: { persistSession: false } });

const activeResponse = await db
  .from("content_mirror_generation")
  .select("generation_id,expected_file_count,expected_row_count,activated_at")
  .eq("status", "active")
  .order("activated_at", { ascending: false });
if (activeResponse.error) throw new Error(`读取 active content generation 失败：${activeResponse.error.message}`);
const activeGenerations = activeResponse.data ?? [];

let mirrorRowCount = 0;
if (activeGenerations.length === 1) {
  const mirrorResponse = await db
    .from("content_mirror")
    .select("id", { count: "exact", head: true })
    .eq("generation_id", activeGenerations[0].generation_id);
  if (mirrorResponse.error) throw new Error(`统计 active content mirror 失败：${mirrorResponse.error.message}`);
  mirrorRowCount = mirrorResponse.count ?? 0;
} else {
  const mirrorResponse = await db.from("content_mirror").select("id", { count: "exact", head: true });
  if (mirrorResponse.error) throw new Error(`统计 content mirror 失败：${mirrorResponse.error.message}`);
  mirrorRowCount = mirrorResponse.count ?? 0;
}

const [stageResponse, qualityResponse, attemptResponse] = await Promise.all([
  db.from("content_mirror_stage").select("generation_id", { count: "exact", head: true }),
  db.from("learning_data_quality_v1").select("issue_code,severity,entity_kind,entity_id,detected_at,detail").order("detected_at", { ascending: false }).limit(1000),
  db.from("learning_attempt").select("id", { count: "exact", head: true }),
]);
for (const [label, response] of [
  ["content_mirror_stage", stageResponse],
  ["learning_data_quality_v1", qualityResponse],
  ["learning_attempt", attemptResponse],
]) {
  if (response.error) throw new Error(`读取 ${label} 失败：${response.error.message}`);
}

const report = evaluateDataHealth({
  activeGenerations,
  mirrorRowCount,
  stageRowCount: stageResponse.count ?? 0,
  qualityIssues: qualityResponse.data ?? [],
  attemptCount: attemptResponse.count ?? 0,
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const m = report.metrics;
  console.log(`数据健康：${report.ok ? "PASS" : "FAIL"}`);
  console.log(`镜像：active ${m.activeGenerationCount} / ${m.activeGenerationId ?? "-"}，行 ${m.mirrorRowCount}/${m.expectedMirrorRows ?? "?"}，stage ${m.stageRowCount}`);
  console.log(`学习尝试：${m.attemptCount}；质量问题：${m.qualityIssueCount}`);
  for (const item of report.errors) console.log(`ERROR ${item.code}｜${item.message}`);
  for (const item of report.warnings) console.log(`WARN  ${item.code}｜${item.message}`);
}

process.exit(report.ok ? 0 : 1);
