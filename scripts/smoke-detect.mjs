#!/usr/bin/env node
/**
 * 检测引擎 L1 端到端烟测（零 LLM 花费）。
 *
 * 验证：
 *   ① generateQuestion(L1) 能从 Anki 取出题目+P1/P2 关键词
 *   ② gradeAnswer(L1, 好答案)  → 干净通过 + 间隔档 ↑ + 难度 ↓
 *   ③ gradeAnswer(L1, 空答案) ×2 → 连续未过 + G1 触发 events 弱项候选
 *   ④ detection_log / kp_state / events 三表都正确写入
 *
 * 用一个固定 kp（XF-0001 刑法的概念，有 1 张 Anki 卡），跑前清掉历史以可重入。
 *
 * 用法：
 *   node --env-file=.env.local --experimental-strip-types scripts/smoke-detect.mjs
 *   （Node 24 默认带 TS strip，不需要 --experimental-strip-types；为兼容旧版加上）
 *
 * 由于 detection.ts 是 ESM/TS，直接靠 Node 的 type stripping 加载。
 */
import { createClient } from "@supabase/supabase-js";

const KP_ID = process.argv[2] || "XF-0001";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE env");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// 1. 清掉该 kp 历史（detection_log + 重置 kp_state + 清 events 弱项候选）
console.log(`\n▶ 清理 ${KP_ID} 的检测历史（可重入烟测）…`);
await sb.from("detection_log").delete().eq("kp_id", KP_ID);
await sb
  .from("events")
  .delete()
  .eq("kp_id", KP_ID)
  .eq("type", "弱项候选")
  .eq("status", "pending");
await sb
  .from("kp_state")
  .update({
    cur_level: "L1",
    interval_idx: 0,
    difficulty: 5,
    l1_status: "untested",
    l2_status: "untested",
    l3_status: "untested",
    mastered: false,
    review_count: 0,
    error_count: 0,
    last_review: null,
    next_due: null,
  })
  .eq("kp_id", KP_ID);
console.log(`✓ 清理完成`);

// 2. 动态 import detection.ts（Node 24 原生支持 TS）
const { generateQuestion, gradeAnswer } = await import("../src/lib/detection.ts");

// 3. 出题
console.log(`\n▶ 出题：generateQuestion(${KP_ID}, L1)`);
const q = await generateQuestion({ kpId: KP_ID, level: "L1" });
console.log(`  question:`, q.question.slice(0, 80) + "...");
console.log(`  answerKey: ${q.answerKey.length} 个关键词，前 3：`, q.answerKey.slice(0, 3));
console.log(`  source: ${q.source} (${q.sourceRef})`);
if (q.answerKey.length === 0) {
  console.error(`✗ answerKey 为空，无法继续烟测（说明 Anki 索引缺失）`);
  process.exit(1);
}

// 4. 用"好答案"（答案 key 拼起来）评分 → 应干净通过
console.log(`\n▶ 评分 case-1：用 answerKey 拼成的完美答案 → 应判 干净通过`);
const goodAnswer = q.answerKey.join("；");
const r1 = await gradeAnswer({
  kpId: KP_ID,
  level: "L1",
  question: q.question,
  userAnswer: goodAnswer,
  answerKey: q.answerKey,
  source: q.source,
  sourceRef: q.sourceRef,
});
console.log(`  grade: ${r1.grade}（${r1.confidence}%） | passed: ${r1.passed}`);
console.log(`  hits: ${r1.hits.length}/${q.answerKey.length} | missing: ${r1.missing.length}`);
console.log(`  state: cur_level ${r1.stateUpdate.prev.cur_level}→${r1.stateUpdate.next.cur_level}, interval_idx ${r1.stateUpdate.prev.interval_idx}→${r1.stateUpdate.next.interval_idx}, difficulty ${r1.stateUpdate.prev.difficulty}→${r1.stateUpdate.next.difficulty}, next_due ${r1.stateUpdate.next.next_due}`);
console.log(`  weakEventEmitted: ${r1.weakEventEmitted}`);

// 5. 用"空 token 答案"评分 → 应判 未过
console.log(`\n▶ 评分 case-2：错误答案 "abc xyz" → 应判 未过`);
const r2 = await gradeAnswer({
  kpId: KP_ID,
  level: "L1",
  question: q.question,
  userAnswer: "abc xyz 完全不相关",
  answerKey: q.answerKey,
  source: q.source,
  sourceRef: q.sourceRef,
});
console.log(`  grade: ${r2.grade}（${r2.confidence}%） | passed: ${r2.passed}`);
console.log(`  state: cur_level ${r2.stateUpdate.prev.cur_level}→${r2.stateUpdate.next.cur_level}, interval_idx ${r2.stateUpdate.prev.interval_idx}→${r2.stateUpdate.next.interval_idx}, difficulty ${r2.stateUpdate.prev.difficulty}→${r2.stateUpdate.next.difficulty}`);
console.log(`  weakEventEmitted: ${r2.weakEventEmitted}（连续失败 1 次，未达阈值不应触发）`);

// 6. 再来一次"错误答案"评分 → 连续 2 次失败 → G1 应触发
console.log(`\n▶ 评分 case-3：再错一次 → 连续 2 次未过 → G1 应触发`);
const r3 = await gradeAnswer({
  kpId: KP_ID,
  level: "L1",
  question: q.question,
  userAnswer: "完全跑题",
  answerKey: q.answerKey,
  source: q.source,
  sourceRef: q.sourceRef,
});
console.log(`  grade: ${r3.grade}（${r3.confidence}%） | passed: ${r3.passed}`);
console.log(`  weakEventEmitted: ${r3.weakEventEmitted} ${r3.weakEventEmitted ? "✓ G1 触发" : "✗ 未触发（异常）"}`);

// 7. 验证三表数据
console.log(`\n▶ 校验落库：`);
const { data: logs } = await sb
  .from("detection_log")
  .select("level, passed, ai_grade, confidence")
  .eq("kp_id", KP_ID)
  .order("ts", { ascending: false });
console.log(`  detection_log: ${logs?.length ?? 0} 条`);
logs?.forEach((l, i) => console.log(`    [${i + 1}] ${l.level} ${l.ai_grade}（${l.confidence}%, passed=${l.passed}）`));

const { data: kpRow } = await sb
  .from("kp_state")
  .select("cur_level, interval_idx, difficulty, l1_status, error_count, review_count, next_due, mastered")
  .eq("kp_id", KP_ID)
  .single();
console.log(`  kp_state:`, kpRow);

const { data: ev } = await sb
  .from("events")
  .select("type, knowledge, payload, status, created_at")
  .eq("kp_id", KP_ID)
  .eq("type", "弱项候选")
  .order("created_at", { ascending: false });
console.log(`  events(弱项候选): ${ev?.length ?? 0} 条`);
ev?.forEach((e, i) => console.log(`    [${i + 1}] ${e.knowledge} | ${e.status} | payload:`, e.payload));

// 8. 断言
const ok =
  r1.grade === "干净通过" &&
  !r2.passed &&
  !r3.passed &&
  r3.weakEventEmitted === true &&
  (ev?.length ?? 0) >= 1;
console.log(`\n═══ 烟测${ok ? "✓ 通过" : "✗ 失败"} ═══`);
process.exit(ok ? 0 : 1);
