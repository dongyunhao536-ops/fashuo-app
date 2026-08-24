#!/usr/bin/env node
// [gpt] 2026-08-12：命题完整性 Gate CLI；污染草稿退出码为 2，安全改写也必须二次复检。

import { pathToFileURL } from "node:url";
import {
  REVIEW_QUESTION_TYPES,
  auditReviewQuestion,
  rewriteReviewQuestion,
} from "./lib/question-integrity.mjs";
import { hashSkillArtifact, readSkillRunEvents, reconstructSkillRuns, recordAutomaticSkillStep } from "./lib/skill-run.mjs";

function parseArgs(argv) {
  const [command = "help", ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`无法识别的位置参数：${arg}`);
    const key = arg.slice(2);
    if (["json", "rewrite"].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      options[key] = value;
    }
  }
  return { command, options };
}

function inputFrom(options) {
  return {
    questionType: options.type,
    stem: options.stem,
    requirements: options.requirements,
    hints: options.hints,
    answerKey: options.answer,
    originalAnswer: options["original-answer"],
  };
}

function printHuman(audit, rewritten = null, draftHash = null) {
  if (audit.ok) {
    console.log("QUESTION_INTEGRITY_PASS｜displayAllowed=true");
    if (draftHash) console.log(`QUESTION_DRAFT_SHA256｜${draftHash}`);
    console.log(audit.displayText);
    return;
  }
  console.error(`QUESTION_INTEGRITY_BLOCK｜${audit.violations.length} 项污染风险｜displayAllowed=false`);
  for (const item of audit.violations) console.error(`- ${item.code} [${item.field}] ${item.message}${item.match ? `｜${item.match}` : ""}`);
  if (!rewritten) return;
  if (rewritten.manualRewriteRequired) {
    console.error("- 题干本体或答案键需要人工修正；修正后必须重新运行 Gate。");
  } else {
    console.error("- 已生成安全改写候选；不得直接展示，必须用下列字段重新运行 Gate 取得 PASS：");
    const safeDraft = {
      questionType: rewritten.draft.questionType,
      stem: rewritten.draft.stem,
      requirements: rewritten.draft.requirements,
      hints: rewritten.draft.hints,
    };
    console.error(JSON.stringify(safeDraft, null, 2));
  }
}

export function main(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const { command, options } = parseArgs(argv);
  if (command !== "check") {
    console.log(`用法：node scripts/question-integrity.mjs check --type <${REVIEW_QUESTION_TYPES.join("|")}> --stem "..." [--requirements "..."] [--hints "..."] [--answer "①③"] [--original-answer "②④"] [--run SR-...] [--rewrite] [--json]`);
    return 0;
  }
  const input = inputFrom(options);
  const audit = auditReviewQuestion(input);
  const draftHash = hashSkillArtifact(audit.displayText);
  const draftLength = audit.displayText.replace(/\r\n/gu, "\n").length;
  if (options.run) {
    const parsed = readSkillRunEvents();
    if (parsed.issues.length) throw new Error(`Skill Run 遥测有 ${parsed.issues.length} 个结构错误`);
    const run = reconstructSkillRuns(parsed.events).get(options.run);
    if (!run) throw new Error(`找不到 Skill Run：${options.run}`);
    // [gpt] 2026-08-12：命题 Gate 只能证明题面未泄露，不能替代材料/参考答案；需要材料的 Skill 必须先有回执。
    if (["ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc"].includes(run.skill) && run.steps.materials_checked?.status !== "pass") {
      throw new Error(`${run.skill} 运行命题 Gate 前缺 materials_checked；先完成材料检索`);
    }
    if (["lunshu-pc", "yingyu-pc"].includes(run.skill) && run.steps.reference_answer_checked?.status !== "pass") {
      throw new Error(`${run.skill} 运行主观命题 Gate 前缺 reference_answer_checked；先核对参考答案/评分标准`);
    }
    // [gpt] 只落展示草稿 hash；答案键和原错答案既不进入 hash，也不进入 Skill Run 日志。
    recordAutomaticSkillStep({
      runId: options.run,
      step: "question_integrity_pass",
      status: audit.ok ? "pass" : "fail",
      source: "question-integrity",
      artifactHash: draftHash,
      artifactLength: draftLength,
      durationMs: Date.now() - startedAt,
    });
  }
  const rewritten = options.rewrite && !audit.ok ? rewriteReviewQuestion(input, audit) : null;
  if (options.json) {
    const safeRewritten = rewritten?.draft
      ? {
        ...rewritten,
        // [gpt] 2026-08-12：白名单输出展示字段，避免答案键进入日志，也不靠未使用解构变量消毒。
        draft: {
          questionType: rewritten.draft.questionType,
          stem: rewritten.draft.stem,
          requirements: rewritten.draft.requirements,
          hints: rewritten.draft.hints,
        },
      }
      : rewritten;
    console.log(JSON.stringify({ audit, draftHash, draftLength, rewritten: safeRewritten }, null, 2));
  }
  else printHuman(audit, rewritten, draftHash);
  return audit.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`QUESTION_INTEGRITY_ERROR｜${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
