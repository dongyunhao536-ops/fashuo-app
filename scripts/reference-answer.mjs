#!/usr/bin/env node
// [gpt] 2026-08-24：lunshu 参考答案加载器；只有真实加载的内容才能给 Run 绑定 referenceHash。
import { pathToFileURL } from "node:url";
import { loadReferenceAnswer, referenceEvidenceRef } from "./lib/reference-answer.mjs";
import { recordReferenceAnswerBinding } from "./lib/skill-run.mjs";

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

export function main(argv = process.argv.slice(2)) {
  const options = flags(argv);
  if (!options.run) throw new Error("reference-answer 需要 --run SR-...");
  if (!options.type || !options.question) throw new Error("reference-answer 需要 --type case|essay --question <题号>");
  const result = loadReferenceAnswer({
    type: options.type,
    year: options.year,
    question: options.question,
    referenceFile: options.file,
    sourceLabel: options.label,
  });
  if (result.state !== "found") {
    console.log(JSON.stringify(result, null, 2));
    return 2;
  }
  const evidenceRef = referenceEvidenceRef(result, {
    type: options.type,
    year: options.year,
    question: options.question,
  });
  recordReferenceAnswerBinding({
    runId: options.run,
    referenceHash: result.referenceHash,
    evidenceRef,
  });
  const output = { ...result, runId: options.run, evidenceRef, gradingBound: true };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`REFERENCE_ANSWER_BOUND｜${options.run}｜${result.referenceHash}｜${evidenceRef}`);
    console.log(result.answer);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
