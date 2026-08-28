#!/usr/bin/env node
// [gpt] 2026-08-12：Skill Run 状态机 CLI；退出码 2 表示执行步骤硬闸未通过。

import { pathToFileURL } from "node:url";
import {
  DEFAULT_WAITING_USER_IDLE_MINUTES,
  SkillRunGateError,
  buildSkillExecutionContext,
  checkpointSkillRun,
  endSkillRun,
  expireIdleWaitingSkillRuns,
  readSkillRunEvents,
  recordManualSkillStep,
  reconstructSkillRuns,
  startSkillRun,
  summarizeSkillRuns,
} from "./lib/skill-run.mjs";
import { findGuardNotInvokedRuns, readSkillTurnEvents, summarizeSkillTurns } from "./lib/skill-turn-guard.mjs";

function flags(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`无法识别的位置参数：${arg}`);
    const key = arg.slice(2);
    if (key === "json") output[key] = true;
    else {
      const value = args[++index];
      if (value == null || String(value).startsWith("--")) throw new Error(`${arg} 需要一个值`);
      output[key] = value;
    }
  }
  return output;
}

function doneSteps(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function printRun(run, json = false) {
  if (json) return console.log(JSON.stringify({ run, execution: buildSkillExecutionContext(run) }, null, 2));
  console.log(`SKILL_RUN_STARTED｜${run.runId}｜${run.skill}`);
  console.log(`阶段：${Object.keys(buildSkillExecutionContext(run).phases).join("|")}`);
  console.log(`材料检索追加：--run ${run.runId}`);
}

export function main(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  const options = flags(rest);
  if (command === "start") {
    // [gpt] 2026-08-14：带背轻入口必须把明确对象交给状态机冻结。
    const run = startSkillRun({
      skill: options.skill,
      subject: options.subject,
      kind: options.kind,
      referenceDate: options.date,
      source: "skill-run-cli",
      entryMode: options.skill === "daibei-pc" ? "direct" : null,
      targetRef: options.target,
      runPurpose: options.purpose ?? "learning",
      resultRoute: options["result-route"] ?? options.resultRoute ?? null,
    });
    printRun(run, options.json);
    return 0;
  }
  if (command === "step") {
    const run = recordManualSkillStep({
      runId: options.run,
      step: options.step,
      evidenceRef: options.ref,
    });
    if (options.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`SKILL_STEP_RECORDED｜${run.runId}｜${options.step}=pass`);
    return 0;
  }
  if (command === "checkpoint") {
    const run = checkpointSkillRun({
      runId: options.run,
      phase: options.phase,
      done: doneSteps(options.done),
      evidenceRef: options.ref,
      artifactHash: options.hash,
    });
    if (options.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`SKILL_CHECKPOINT_PASS｜${run.runId}｜${options.phase}`);
    return 0;
  }
  if (command === "end") {
    const run = endSkillRun({
      runId: options.run,
      phase: options.phase,
      outcome: options.outcome ?? "completed",
      done: doneSteps(options.done),
      evidenceRef: options.ref,
      artifactHash: options.hash,
      handoffSkill: options.to,
      handoffReason: options.reason,
    });
    if (options.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`SKILL_RUN_ENDED｜${run.runId}｜${run.end.outcome}${run.end.phase ? `/${run.end.phase}` : ""}`);
    return 0;
  }
  if (command === "abort") {
    const run = endSkillRun({
      runId: options.run,
      outcome: "aborted",
      evidenceRef: options.ref,
      abortReason: options.reason,
      abortSource: options.source,
    });
    if (options.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`SKILL_RUN_ENDED｜${run.runId}｜aborted`);
    return 0;
  }
  if (command === "reap") {
    const idleMinutes = Number(options["idle-minutes"] ?? DEFAULT_WAITING_USER_IDLE_MINUTES);
    const result = expireIdleWaitingSkillRuns({ idleMinutes });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`SKILL_RUN_REAPED｜expired=${result.expired.length}｜idle=${result.timeoutMinutes}m`);
    return 0;
  }
  if (command === "status") {
    expireIdleWaitingSkillRuns();
    const parsed = readSkillRunEvents();
    if (parsed.issues.length) throw new Error(`Skill Run 遥测有 ${parsed.issues.length} 个结构错误`);
    const run = reconstructSkillRuns(parsed.events).get(options.run);
    if (!run) throw new Error(`找不到 Skill Run：${options.run}`);
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }
  if (command === "check") {
    const days = Number(options.days ?? 2);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days 必须是 1-90 的整数");
    const now = new Date();
    expireIdleWaitingSkillRuns({ now });
    const end = options.end ?? new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    if (!/^20\d{2}-\d{2}-\d{2}$/u.test(end)) throw new Error("--end 必须是 YYYY-MM-DD 北京日");
    const start = new Date(new Date(`${end}T00:00:00Z`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const runLog = readSkillRunEvents();
    const turnLog = readSkillTurnEvents();
    const summary = summarizeSkillRuns(runLog, { nowIso: now.toISOString(), windowStart: start, windowEnd: end });
    const host = summarizeSkillTurns(turnLog, {
      nowIso: now.toISOString(),
      windowStart: start,
      windowEnd: end,
      runInput: runLog,
    });
    host.guardNotInvokedRuns = findGuardNotInvokedRuns(runLog, turnLog, { windowStart: start, windowEnd: end });
    host.counts.guardNotInvoked = host.guardNotInvokedRuns.length;
    // [gpt] 保留既有 Run 摘要字段，追加 host，避免即时诊断再次看不见“整个 Skill 都没启动”。
    console.log(JSON.stringify({ ...summary, host }, null, 2));
    const needsAttention = summary.issues.length
      || host.issues.length
      || summary.counts.stale
      || summary.counts.gateFailures
      || summary.counts.invalidHandoffs
      || summary.counts.unresolvedHandoffs
      || host.coverage.state !== "observed"
      || host.counts.failed
      || host.counts.unchecked
      || host.counts.guardErrors
      || host.counts.guardNotInvoked;
    return needsAttention ? 1 : 0;
  }
  // [gpt] 2026-08-28：未知动作不得打印帮助后成功退出；续用由原 --run 与宿主身份绑定完成。
  if (!["help", "--help", "-h"].includes(command)) {
    const hint = command === "resume"
      ? "没有 resume 子命令；中断后在宿主已绑定原 Run 的前提下，直接给后续命令传原 --run；状态不明先用 status --run 查询"
      : "使用 help 查看支持的命令";
    throw new Error(`未知 Skill Run 命令：${command}；${hint}`);
  }
  console.log("用法：node scripts/skill-run.mjs <start|step|checkpoint|end|abort|reap|status|check> ...");
  console.log("  start --skill <ask-pc|coach-pc|cuoti-fupan|daibei-pc|lunshu-pc|yingyu-pc> [--subject 科目 --kind 类型 --date 北京日 --purpose learning|diagnostic|simulation --json]");
  console.log("        daibei-pc 轻入口必须额外给 --target <稳定章节/设问/条目>；只给科目请改用 skill-context.mjs daibei <科目>");
  console.log("        daibei 自背进度用 --kind progress；用户明确只记录不抽查时才用 --kind progress-only，均以 --phase progress 收口");
  console.log("        进度当天的顺手抽查不建 Run：直接跑 question-integrity（不带 --run）出题，不 checkpoint/不 end、四个账本都不写；跨日冷复检才用 --kind recall + --phase result");
  console.log("        kind=recall 的 --target 必须本身可写回：KP-ID（如 LS-0012）走 knowledge，挂账条目 ID（如 L12）走 ledger；给章节名一类自由文本会在 start 阻断，只能换成真实 ID，加 --result-route 也救不回来");
  console.log("        --result-route knowledge|ledger 用于目标同时含两类 ID 时指定走哪条，或显式复核推断；它校验目标类型，不放宽目标要求");
  console.log("        ⚠️ --kind recall-sameday 与 --phase probe 仅供历史 Run 回放兼容，不得新建；当日抽查走上面的无 Run 路径");
  console.log("  step --run <SR-...> --step <手工步骤> [--ref 证据引用]");
  console.log("  checkpoint --run <SR-...> --phase <阶段> [--done 手工步骤,... --hash Gate题面sha256 --ref 证据引用]");
  console.log("  end --run <SR-...> --phase <阶段> [--done 手工步骤,... --hash Gate产物sha256 --ref 证据引用] / --outcome handoff --to <Skill> --reason <原因>");
  console.log("  abort --run <SR-...> [--reason 中止原因] [--source user|model|guard|system|reconstruction|unattributed]（无人能归因时显式记 unattributed）");
  console.log("  reap [--idle-minutes 30 --json]（仅把超时 waiting_user 系统收口为 aborted，不记用户 fail、不改学习事实）");
  console.log("  status --run <SR-...> / check [--days 2 --end YYYY-MM-DD]");
  console.log("  中断续用：没有 resume 命令；宿主绑定原 Run 后，后续命令直接传原 --run，已结束 Run 不可复用");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof SkillRunGateError ? 2 : 1;
  }
}
