#!/usr/bin/env node
// [gpt] 2026-08-13：错题判题结果 Gate CLI；PASS 后自动落 Run 回执并输出唯一可展示证据卡。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JudgmentResultValidationError, renderJudgmentCard, validateJudgmentResult } from "./lib/judgment-result.mjs";
import { hashSkillArtifact, recordAutomaticSkillStep } from "./lib/skill-run.mjs";

function flags(args) {
  const output = {};
  for (let index = 0; index < args.length; index++) {
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

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  if (command !== "check") {
    console.log("用法：node scripts/judgment-result.mjs check --file <判题结果.json> [--run SR-...] [--json]");
    return 0;
  }
  const options = flags(rest);
  if (!options.file) throw new Error("check 必须提供 --file <判题结果.json>");
  const startedAt = Date.now();
  // [claude] 2026-08-26：延迟审答案键的 Run，判分前必须先补跑一次带答案键的 Gate。
  //
  // 没有这道闸，`--defer-answer` 就成了「永远不审答案键」的免检通道——间接污染
  // （题干只点正解集或其补集）会一路无人发现。补审在用户作答之后跑，不再泄题。
  if (options.run) {
    const { readSkillRunEvents, reconstructSkillRuns } = await import("./lib/skill-run.mjs");
    const run = reconstructSkillRuns(readSkillRunEvents().events).get(options.run);
    if (run?.steps?.question_integrity_pass?.evidenceRef === "answer_deferred") {
      throw new Error(`${options.run} 的题面 Gate 仍处于 --defer-answer 延迟态；判分前先用同一份题干补跑一次带 --answer/--answer-file 的 question-integrity check --run ${options.run}（不要再加 --checkpoint），PASS 后再判分；若补审 BLOCK，按题面污染走 void --invalid-prompt，责任归教练`);
    }
  }
  const parsed = JSON.parse(readFileSync(options.file, "utf8"));
  const normalized = validateJudgmentResult(parsed);
  const card = renderJudgmentCard(normalized);
  const artifactHash = hashSkillArtifact(card);
  const candidateHash = hashSkillArtifact(JSON.stringify(normalized.diagnosis.candidates));
  if (options.run) {
    recordAutomaticSkillStep({
      runId: options.run,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: `${normalized.targetRef}:${normalized.result}:diagnosis=${normalized.diagnosis.status}`,
      artifactHash,
      artifactLength: card.length,
      candidateHash,
      durationMs: Date.now() - startedAt,
      expectedSkill: "cuoti-fupan",
    });
  }
  if (options.json) console.log(JSON.stringify({ ok: true, normalized, card, artifactHash, candidateHash, artifactLength: card.length }, null, 2));
  else console.log(`JUDGMENT_RESULT_PASS｜sha256=${artifactHash}｜candidates_sha256=${candidateHash}\n${card}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof JudgmentResultValidationError) {
      console.error(`JUDGMENT_RESULT_BLOCK｜${error.issues.length} 项`);
      for (const item of error.issues) console.error(`- ${item.code} [${item.field}] ${item.message}`);
      process.exitCode = 2;
    } else {
      console.error(`JUDGMENT_RESULT_ERROR｜${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
