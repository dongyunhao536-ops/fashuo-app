#!/usr/bin/env node
/**
 * #4 G1 不变式对账 —— 抓【静默丢失】的弱项信号。
 *
 * 区别于 11-dataflow-check.sh（陈旧度巡检：抓"event 进了筐但卡住没动"）——本脚本抓"event 从没进来过"：
 *   G1 的 emitEvent 是 best-effort（insert 失败只 console.error 不抛），失败即静默丢一条弱项信号。
 *   陈旧度检查看不到从未存在的行；要抓它，只能拿【硬真值】反向校验【软记录】。
 *
 * 不变式：非 mastered 且 error_count ≥ G1阈值、且【当前档最近一次 failed】的考点（= 客观上正在反复失败），
 *   必有至少一条 kp_id 锚定的弱项候选 event（任何 status/source 都算——dismissed=云看过判非弱项、
 *   consumed=已登记，都说明信号 surface 过）。零 event = G1 信号静默丢了，本脚本报出来。
 *
 * 锚 kp_state（error_count / l*_status，事务性硬真值），不锚 detection_log（fail-open，#1b 后失败可见但仍 best-effort）。
 *   这是 #4「拿硬真值校验软记录」的落地。注意 error_count≥阈值 是 G1「连续 failed」的保守近似
 *   （历史非连续失败也会计数），故再叠加「当前档 failed」收窄为"此刻确在弱项态"，压低误报。
 *
 * 用法：node --env-file=.env.local scripts/reconcile-g1.mjs [--verbose]
 *   退出码 0=无缺口；1=发现缺口（巡检/CI 据此告警）；2=查询失败。
 * 只读、零写、零 LLM、零成本。可挂进运维巡检 cron（与 11-dataflow-check 并列）。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dbUrl || !key) {
  console.error("Missing SUPABASE env（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
  process.exit(2);
}
const sb = createClient(dbUrl, key, { auth: { persistSession: false } });

const cfg = JSON.parse(readFileSync("config/scheduler.json", "utf8"));
const THRESHOLD = cfg?.["G1_背诵失败转弱项"]?.["连续失败阈值"] ?? 2;
const VERBOSE = process.argv.includes("--verbose");

/** 当前档（cur_level=L1/L2/L3）对应的 status 字段值 */
const statusAtCur = (k) => k["l" + String(k.cur_level ?? "L1")[1] + "_status"];

// ① 硬真值：非 mastered + error_count ≥ 阈值 的考点
const { data: failing, error: e1 } = await sb
  .from("kp_state")
  .select("kp_id, subject, ext, error_count, cur_level, l1_status, l2_status, l3_status")
  .eq("mastered", false)
  .gte("error_count", THRESHOLD)
  .order("error_count", { ascending: false });
if (e1) {
  console.error("查 kp_state 失败：", e1.message);
  process.exit(2);
}

// 收窄为"当前档最近一次 failed"（此刻确在弱项态，而非历史失败已恢复）
const failingNow = (failing ?? []).filter((k) => statusAtCur(k) === "failed");
if (failingNow.length === 0) {
  console.log(`✓ 无（非 mastered + error_count ≥ ${THRESHOLD} + 当前档 failed）的考点，无需对账。`);
  process.exit(0);
}

// ② 软记录：这些考点里哪些有过 kp_id 锚定的弱项候选 event（任何 status/source）
//    —— G1 投递必带 kp_id，故按 kp_id 命中即视为"G1 信号 surface 过"。
//    （答疑/教练的自由短语弱项常 kp_id=null，不在此 IN 查范围，不干扰判定。）
const haveEvent = new Set();
const kpIds = failingNow.map((k) => k.kp_id);
for (let i = 0; i < kpIds.length; i += 200) {
  const chunk = kpIds.slice(i, i + 200);
  const { data: evs, error: e2 } = await sb
    .from("events")
    .select("kp_id")
    .eq("type", "弱项候选")
    .in("kp_id", chunk);
  if (e2) {
    console.error("查 events 失败：", e2.message);
    process.exit(2);
  }
  for (const ev of evs ?? []) if (ev.kp_id) haveEvent.add(ev.kp_id);
}

// ③ 缺口 = 正在反复失败、却没有任何弱项 event 的考点
const gaps = failingNow.filter((k) => !haveEvent.has(k.kp_id));

console.log(
  `G1 对账：正在反复失败的考点 ${failingNow.length} 个（非 mastered·error_count≥${THRESHOLD}·当前档 failed），其中缺弱项 event ${gaps.length} 个。\n`,
);
if (gaps.length && VERBOSE) {
  for (const k of gaps) {
    const name = k.ext?.name ?? k.kp_id;
    console.log(
      `  ✗ ${k.subject}·${name}（${k.kp_id}）error_count=${k.error_count} cur=${k.cur_level} ${statusAtCur(k)}`,
    );
  }
  console.log("");
}
if (gaps.length) {
  console.log(`⚠ ${gaps.length} 个反复失败考点【没有任何弱项 event】——疑似 G1 emit 静默丢失。`);
  console.log("  排查：看部署期/对应时段 emitEvent 报错日志。");
  console.log("  补救：对这些考点再背一次（评分会重跑 G1 补投），或手工在待办筐补登记。--verbose 看清单。");
} else {
  console.log("✓ 每个正在反复失败的考点都有弱项 event，G1 信号无静默丢失。");
}
process.exit(gaps.length ? 1 : 0);
