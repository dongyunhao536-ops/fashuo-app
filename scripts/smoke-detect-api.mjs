#!/usr/bin/env node
/**
 * 走 HTTP 路由的 L1 端到端烟测（next dev 必须先起在 :3000）。
 * 验证：
 *   ① POST /api/detect/generate 返回题目 + answerKey
 *   ② POST /api/detect/grade 三次：好答案过 / 错答案 / 错答案 → 第三次 G1 触发
 *   ③ detection_log / kp_state / events 三表落地正确
 */
import { createClient } from "@supabase/supabase-js";

const KP_ID = process.argv[2] || "XF-0001";
const BASE = process.env.DETECT_BASE_URL || "http://localhost:3000";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function reset() {
  console.log(`▶ 重置 ${KP_ID} 历史…`);
  await sb.from("detection_log").delete().eq("kp_id", KP_ID);
  await sb.from("events").delete().eq("kp_id", KP_ID).eq("type", "弱项候选").eq("status", "pending");
  await sb.from("kp_state").update({
    cur_level: "L1", interval_idx: 0, difficulty: 5,
    l1_status: "untested", l2_status: "untested", l3_status: "untested",
    mastered: false, review_count: 0, error_count: 0,
    last_review: null, next_due: null,
  }).eq("kp_id", KP_ID);
  console.log("✓ 已重置");
}

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) console.error(`✗ ${path} ${r.status}:`, json);
  return { ok: r.ok, status: r.status, json };
}

await reset();

console.log(`\n▶ generate(${KP_ID}, L1)`);
const gen = await postJson("/api/detect/generate", { kpId: KP_ID, level: "L1" });
if (!gen.ok) process.exit(1);
const q = gen.json;
console.log(`  question: ${q.question.slice(0, 60)}…`);
console.log(`  answerKey: ${q.answerKey.length} 个；source: ${q.source}（${q.sourceRef}）`);

console.log(`\n▶ grade case-1：完美答案`);
const goodAns = q.answerKey.join("；");
const r1 = await postJson("/api/detect/grade", {
  kpId: KP_ID, level: "L1", question: q.question, userAnswer: goodAns,
  answerKey: q.answerKey, source: q.source, sourceRef: q.sourceRef,
});
console.log(`  grade=${r1.json.grade}（${r1.json.confidence}%） passed=${r1.json.passed}`);
console.log(`  state: lvl ${r1.json.stateUpdate.prev.cur_level}→${r1.json.stateUpdate.next.cur_level}, idx ${r1.json.stateUpdate.prev.interval_idx}→${r1.json.stateUpdate.next.interval_idx}, D ${r1.json.stateUpdate.prev.difficulty}→${r1.json.stateUpdate.next.difficulty}, due ${r1.json.stateUpdate.next.next_due}`);
console.log(`  weakEventEmitted=${r1.json.weakEventEmitted}（应=false）`);

console.log(`\n▶ grade case-2：错答案 #1`);
const r2 = await postJson("/api/detect/grade", {
  kpId: KP_ID, level: "L1", question: q.question, userAnswer: "abc xyz 完全不相关",
  answerKey: q.answerKey, source: q.source, sourceRef: q.sourceRef,
});
console.log(`  grade=${r2.json.grade}（${r2.json.confidence}%） passed=${r2.json.passed}`);
console.log(`  weakEventEmitted=${r2.json.weakEventEmitted}（首次失败应=false）`);

console.log(`\n▶ grade case-3：错答案 #2 → G1 应触发`);
const r3 = await postJson("/api/detect/grade", {
  kpId: KP_ID, level: "L1", question: q.question, userAnswer: "完全跑题",
  answerKey: q.answerKey, source: q.source, sourceRef: q.sourceRef,
});
console.log(`  grade=${r3.json.grade}（${r3.json.confidence}%） passed=${r3.json.passed}`);
console.log(`  weakEventEmitted=${r3.json.weakEventEmitted} ${r3.json.weakEventEmitted ? "✓ G1 触发" : "✗"}`);

console.log(`\n▶ 落库校验：`);
const { data: logs } = await sb.from("detection_log").select("level, passed, ai_grade, confidence").eq("kp_id", KP_ID).order("ts", { ascending: false });
console.log(`  detection_log: ${logs?.length} 条`);
logs?.forEach((l, i) => console.log(`    [${i + 1}] ${l.level} ${l.ai_grade}（${l.confidence}%）`));

const { data: kpRow } = await sb.from("kp_state").select("cur_level, interval_idx, difficulty, l1_status, error_count, review_count, mastered").eq("kp_id", KP_ID).single();
console.log(`  kp_state:`, kpRow);

const { data: ev } = await sb.from("events").select("type, knowledge, payload, status").eq("kp_id", KP_ID).eq("type", "弱项候选");
console.log(`  events(弱项候选): ${ev?.length}`);
ev?.forEach((e) => console.log(`    ${e.knowledge} | ${e.status} |`, e.payload));

const ok =
  r1.json.grade === "干净通过" &&
  !r2.json.passed &&
  !r3.json.passed &&
  r3.json.weakEventEmitted === true &&
  (ev?.length ?? 0) >= 1;
console.log(`\n═══ 烟测${ok ? "✓ 通过" : "✗ 失败"} ═══`);
process.exit(ok ? 0 : 1);
