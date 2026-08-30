#!/usr/bin/env node
// [claude] 2026-08-30：错题复盘一题一命令的执行器。
//
// 起因：2026-08-30 周日冷启动，第 1 题往返 41 次、第 2 题在写回阶段连撞 6 次 BLOCK，
// 云两次点名「太慢」。复盘下来慢的不是模型也不是网络，是**契约要靠试错才知道**：
//   ① start --target 漏写 E#<事件号> → target 冻结后不可改 → classify --run 永远签不上
//      diagnosis_recorded → 该 Run 死锁，只能 abort（第 2 题就是这么废掉的，最贵的一条）
//   ② --diagnosis 必须与 --pattern 同时给
//   ③ confirmed/rejected 判题卡必须逐字保留本 Run 原始 candidates；rejected 还必须列全
//   ④ --context timed 必须带 --seconds
//   ⑤ 答案键里出现题面没有的 A/B/C/D 会被判成选项污染
//   ⑥ 教材/讲义证据锚点要「页码+行号」，真题要「年份+法硕/法律硕士+题号」才过正则
//   ⑦ 一个 Run 只绑一份 PASS 题面，追问必须新建 Run
// 这些全部可以在跑之前判掉。校验逻辑在 `lib/fupan-spec.mjs`（那里可测），
// 本文件只负责三件事：把 `FupanSpecError` 翻译成 `FUPAN_BLOCK` + 退出码 2；
// 把每题的多次往返压成 ask / judge / claim 三条命令；把本次调用产出的全部
// 上屏 artifact 收进单一「整块照贴」区（见 flushPaste 的头注）。
//
// 用法（务必带 --env-file，且由调用方 export 身份变量）：
//   node --env-file=.env.local scripts/fupan.mjs ask   --spec <出题.json>
//   node --env-file=.env.local scripts/fupan.mjs judge --spec <判分.json>
//   node --env-file=.env.local scripts/fupan.mjs claim --spec <认领.json>
//
// 本文件不新增任何写库路径，全部通过既有 CLI 落账，回执原样透传。
// 它的定位是**提前满足契约**，不是绕过契约：判闸口径一条都不碰。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  FupanSpecError,
  assertAskSpec,
  assertClaimSpec,
  assertJudgeSpec,
  buildClaimDiagnosis,
  buildMaterialBatchArgs,
  parseRunId,
  parseSpecPath,
  requireGatePass,
} from "./lib/fupan-spec.mjs";

function run(script, args, { quiet = false } = {}) {
  const out = execFileSync(process.execPath, ["--env-file=.env.local", `scripts/${script}`, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!quiet) process.stdout.write(out);
  return out;
}

function readSpec(argv) {
  const path = parseSpecPath(argv);
  return { path, spec: JSON.parse(readFileSync(path, "utf8")) };
}

function beijingDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// [claude] 2026-08-30：宿主 Stop 守卫在一个 turn 里只挑**一个** Run 校验展示
// （同 turn 有事件、lastEventAt 最大的那个）：waiting_user 查题面 artifact，
// completed/result 查判题卡 artifact。一个 turn 同时收口旧 Run 又新开一题时，
// 挑中哪个无法在模型侧可靠预判——2026-08-30 连栽三次（题面加空行、判题卡压缩、
// 认领终态卡漏贴），每次都是整条消息被打回重发，云连续三轮点名「又重复输出」。
// 结论：不要猜守卫挑谁，把本次调用产出的**全部** artifact 收进一个块，整块照贴。
const PASTE_BLOCKS = [];
function queuePaste(label, text) {
  PASTE_BLOCKS.push({ label, text: String(text ?? "").trim() });
}
function flushPaste() {
  if (!PASTE_BLOCKS.length) return;
  console.log("\n██████ 以下整块逐字贴进回复，一个字都不许改、不许压缩、不许只挑一段 ██████");
  console.log("（守卫只认字节；漏贴其中任何一段都会被判 display_drift 并强制重发整条消息）");
  for (const block of PASTE_BLOCKS) {
    console.log(`\n──── ${block.label} ────`);
    console.log(block.text);
  }
  console.log("\n██████ 以上整块结束 ██████");
}

// ── ask：建 Run → 查材料 → 过题面 Gate → 落预测 → 签 question ─────────

function commandAsk(argv) {
  const { spec } = readSpec(argv);
  assertAskSpec(spec);

  const started = run("skill-run.mjs", ["start", "--skill", "cuoti-fupan", "--kind", spec.kind ?? "recheck",
    "--target", spec.target, "--json"], { quiet: true });
  const runId = parseRunId(started);

  // [claude] 2026-08-30：一次 material-batch 查完，别逐条起子进程。
  // 仓库 SKILL.md 复检流程第 2 条与现役入口 §六 都明写「一次批量查完」。
  const materialArgs = buildMaterialBatchArgs(spec.materialQueries, runId);
  if (materialArgs) run("cuoti.mjs", materialArgs, { quiet: true });

  const gateArgs = ["check", "--type", spec.type, "--stem", spec.stem, "--answer", spec.answer, "--run", runId];
  if (spec.originalAnswer) gateArgs.push("--original-answer", spec.originalAnswer);
  const gate = run("question-integrity.mjs", gateArgs, { quiet: true });
  const hash = requireGatePass(gate, "QUESTION_INTEGRITY_PASS",
    `题面 Gate 未通过；改写题面后重跑 ask（本 Run 已建，改题请换新 Run）\n${gate}`);

  let predictionId = null;
  if (spec.prediction) {
    const added = run("judgment-ledger.mjs", ["add", "--type", "栽点", "--prediction", spec.prediction,
      "--subject", spec.subject ?? "法制史", "--ref", spec.target.match(/T#\d+/u)[0],
      "--verify-date", spec.verifyDate ?? beijingDate(),
      "--basis", spec.basis ?? "见判断台账"], { quiet: true });
    predictionId = added.match(/J\d{4}/u)?.[0] ?? null;
  }

  run("skill-run.mjs", ["checkpoint", "--run", runId, "--phase", "question", "--hash", hash,
    "--ref", spec.target], { quiet: true });

  // [claude] 2026-08-30：预测号必须随出题一起打出来。用 grep 去台账里"找回"预测号，
  // 曾把同为 T#90 的一条排期类预测 J0057 误判成本题预测并写了 miss（当场发现并订正）。
  console.log(`FUPAN_ASK_READY｜run=${runId}｜hash=${hash}｜prediction=${predictionId ?? "无"}`);
  queuePaste("题面", spec.stem);
  return 0;
}

// ── judge：证据卡 Gate → review 写回 →（pass 可销账并收口 / 否则等认领）──

function commandJudge(argv) {
  const { spec } = readSpec(argv);
  const result = assertJudgeSpec(spec);

  const cardPath = spec.cardPath ?? `.local/judgment-${spec.review.topicId}-${beijingDate()}.json`;
  writeFileSync(cardPath, JSON.stringify(spec.judgment, null, 2), "utf8");

  const gate = run("judgment-result.mjs", ["check", "--run", spec.run, "--file", cardPath], { quiet: true });
  const hash = requireGatePass(gate, "JUDGMENT_RESULT_PASS", `证据卡 Gate 未通过\n${gate}`, { hashFrom: "first-line" });

  const reviewArgs = ["review", String(spec.review.topicId), result,
    "--variant", spec.review.variant, "--axis", spec.review.axis,
    "--context", spec.review.context ?? "practice",
    "--event", String(spec.review.event), "--dimension", spec.review.dimension ?? "application",
    "--angle", spec.review.angle, "--anchor", spec.review.anchor, "--run", spec.run];
  if (spec.review.seconds) reviewArgs.push("--seconds", String(spec.review.seconds));
  if (spec.review.sameSession) reviewArgs.push("--same-session");
  if (spec.review.cued) reviewArgs.push("--cued");
  if (spec.review.note) reviewArgs.push("--note", spec.review.note);
  if (spec.review.pattern) reviewArgs.push("--pattern", spec.review.pattern, "--diagnosis", spec.review.diagnosis);
  const reviewOut = run("cuoti.mjs", reviewArgs, { quiet: true });
  process.stdout.write(reviewOut.split("\n").filter((line) => /暂存|已确认同步|销账门槛|暂不可销账|计数起点/u.test(line)).join("\n") + "\n");

  if (spec.resolvePrediction) {
    run("judgment-ledger.mjs", ["resolve", spec.resolvePrediction.id, spec.resolvePrediction.outcome], { quiet: true });
  }

  if (result === "pass") {
    if (/已达销账门槛/u.test(reviewOut)) run("cuoti.mjs", ["absorb", String(spec.review.event), "--run", spec.run]);
    run("skill-run.mjs", ["end", "--run", spec.run, "--phase", "result", "--done", "response_verified",
      "--hash", hash, "--ref", spec.ref ?? `T#${spec.review.topicId}/E#${spec.review.event}`], { quiet: true });
    console.log(`FUPAN_JUDGE_DONE｜run=${spec.run}｜已收口`);
  } else {
    run("skill-run.mjs", ["checkpoint", "--run", spec.run, "--phase", "diagnosis_question", "--hash", hash,
      "--ref", spec.ref ?? `T#${spec.review.topicId}/E#${spec.review.event} 病根待认领`], { quiet: true });
    console.log(`FUPAN_JUDGE_PENDING｜run=${spec.run}｜card=${cardPath}｜等云认领病根后跑 claim`);
  }
  queuePaste("判题证据卡", gate.split("\n").slice(1).join("\n"));
  if (spec.thenAsk && result === "pass") commandAsk(["--spec", spec.thenAsk]);
  return 0;
}

// ── claim：云认领病根 → classify 写回 → 重出终态卡 → 收口 ─────────────

function commandClaim(argv) {
  const { spec } = readSpec(argv);
  assertClaimSpec(spec);
  const card = JSON.parse(readFileSync(spec.cardPath, "utf8"));
  card.diagnosis = buildClaimDiagnosis(card, spec);
  if (spec.verdict) card.verdict = spec.verdict;
  writeFileSync(spec.cardPath, JSON.stringify(card, null, 2), "utf8");

  run("cuoti.mjs", ["classify", String(spec.event), "--topic", spec.topic, "--diagnosis", spec.status,
    "--pattern", spec.pattern, "--run", spec.run], { quiet: true });
  const gate = run("judgment-result.mjs", ["check", "--run", spec.run, "--file", spec.cardPath], { quiet: true });
  const hash = requireGatePass(gate, "JUDGMENT_RESULT_PASS", `终态证据卡 Gate 未通过\n${gate}`, { hashFrom: "first-line" });
  run("skill-run.mjs", ["end", "--run", spec.run, "--phase", "result", "--done", "response_verified",
    "--hash", hash, "--ref", spec.ref ?? `T#${card.targetRef} 病根${spec.status}`], { quiet: true });
  console.log(`FUPAN_CLAIM_DONE｜run=${spec.run}｜病根 ${spec.status}｜已收口`);
  // [claude] 2026-08-30：认领后的终态卡也必须逐字上屏。漏贴一次就被守卫判 judgment_display_drift
  // 打回重发（本轮实测），而且 Run 收口后 judgment-result 不能再带 --run 复现，只能无 --run 重渲染。
  queuePaste("病根终态卡", gate.split("\n").slice(1).join("\n"));
  if (spec.thenAsk) commandAsk(["--spec", spec.thenAsk]);
  return 0;
}

const [, , command, ...argv] = process.argv;
try {
  if (command === "ask") process.exitCode = commandAsk(argv);
  else if (command === "judge") process.exitCode = commandJudge(argv);
  else if (command === "claim") process.exitCode = commandClaim(argv);
  else {
    console.log("用法：node --env-file=.env.local scripts/fupan.mjs <ask|judge|claim> --spec <规格.json>");
    console.log("  ask   规格：{target:'T#124/E#116 描述', kind, materialQueries:[], type, stem, answer, originalAnswer, prediction, basis, subject}");
    console.log("        materialQueries 每项写 \"关键词\" 或 { query, refine }，整批合成一次 material-batch");
    console.log("  judge 规格：{run, judgment:{…证据卡…}, review:{topicId,result,variant,axis,context,seconds,event,dimension,angle,anchor,note}, resolvePrediction:{id,outcome}}");
    console.log("  claim 规格：{run, event, topic, cardPath, status:confirmed|rejected, claimIndex, pattern, recognitionRef, verdict}");
    console.log("⚠️ target 必须写成 T#<主题>/E#<事件>，冻结后不可改；漏写会让 classify --run 永远签不上，Run 只能 abort。");
    console.log("⚠️ judge/claim 规格可给 thenAsk <出题.json>，把「收口＋下一题」并成一次调用。");
    process.exitCode = 0;
  }
  flushPaste();
} catch (error) {
  if (error instanceof FupanSpecError) {
    console.error(`FUPAN_BLOCK｜${error.message}`);
    process.exitCode = 2;
  } else {
    const detail = error?.stdout?.toString?.() || error?.stderr?.toString?.() || "";
    if (detail) process.stderr.write(detail);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
