#!/usr/bin/env node
// [gpt] 2026-08-12：命题完整性 Gate CLI；污染草稿退出码为 2，安全改写也必须二次复检。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  REVIEW_QUESTION_TYPES,
  auditReviewQuestion,
  rewriteReviewQuestion,
} from "./lib/question-integrity.mjs";
import {
  bindDaibeiTemplateMaterials,
  loadDaibeiAnswerTemplate,
} from "./lib/daibei-answer-template.mjs";
import { checkpointSkillRun, hashSkillArtifact, readSkillRunEvents, reconstructSkillRuns, recordAutomaticSkillStep } from "./lib/skill-run.mjs";

function parseArgs(argv) {
  const [command = "help", ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`无法识别的位置参数：${arg}`);
    const key = arg.slice(2);
    if (["json", "rewrite", "checkpoint", "defer-answer"].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      options[key] = value;
    }
  }
  return { command, options };
}

// [claude] 2026-08-26：答案键必须能走文件，不能只走命令行。
//
// 事故：Gate 的设计前提是「答案键只在教练侧」，但在 Claude Code 这类会把工具调用
// 渲染给用户看的宿主上，命令行**就是用户可见面**。2026-08-26 云截图指出答案被预输入，
// 查下来我这一场每道题的 `--answer "B。清代死刑重案由州县初审……"` 都明文印在他眼前，
// 等于每道题都自带答案。`--answer-file` 让答案键只经磁盘，命令行只出现一个路径。
// [gpt] 2026-08-26：带背现役母版把材料取证与非选择题 Gate 合成一次调用；
// 母版不合格时 fail-closed，答案正文不进入用户可见命令行。
function resolveTemplate(options) {
  if (!options["template-entry"]) return null;
  if (options.type !== "non-choice") throw new Error("--template-entry 当前只支持 non-choice 稳定复述题；选择题仍须单独核验答案键");
  if (options.answer || options["answer-file"] || options["defer-answer"]) {
    throw new Error("--template-entry 已从现役母版读取参考答案，不能再给 --answer/--answer-file/--defer-answer");
  }
  return loadDaibeiAnswerTemplate(options["template-entry"], {
    file: options["template-file"],
  });
}

function readAnswerKey(options, template = null) {
  if (template) return template.answerText;
  if (options["answer-file"]) {
    if (options.answer) throw new Error("--answer 与 --answer-file 只能给一个");
    return readFileSync(options["answer-file"], "utf8").trim();
  }
  return options.answer;
}

function inputFrom(options, template = null) {
  return {
    questionType: options.type,
    stem: options.stem,
    requirements: options.requirements,
    hints: options.hints,
    answerKey: readAnswerKey(options, template),
    originalAnswer: options["original-answer-file"]
      ? readFileSync(options["original-answer-file"], "utf8").trim()
      : options["original-answer"],
    deferAnswerKey: Boolean(options["defer-answer"]),
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
    console.log(`用法：node scripts/question-integrity.mjs check --type <${REVIEW_QUESTION_TYPES.join("|")}> --stem "..." [--requirements "..."] [--hints "..."] [--template-entry <带背母版完整条目键> [--template-file <母版文件>]] [--answer-file <答案键文件>｜--answer "①③"] [--original-answer-file <文件>｜--original-answer "②④"] [--run SR-...] [--checkpoint [--phase question] [--done a,b] [--ref <引用>]] [--rewrite] [--json]`);
    console.log("  --answer-file：答案键只经磁盘，命令行不出现答案。宿主会把工具调用渲染给用户看时必须用它，内联 --answer 等于把答案摆在用户眼前。");
    console.log("  --template-entry：仅用于 daibei-pc 非选择复述题；校验现役《考试分析》母版，在同一次调用中自动签 materials_checked，再审计题面。母版缺失或锚点不完整时拒绝并要求 material-batch 回源。");
    console.log("  --checkpoint：PASS 后顺带签题面 checkpoint，省一次往返。只在这份草稿确定要发时才加；弃稿或还要改就别加，否则会给没上屏的题留下 waiting_user。");
    return 0;
  }
  const template = resolveTemplate(options);
  if (template && options.run) {
    bindDaibeiTemplateMaterials({
      runId: options.run,
      template,
      durationMs: Date.now() - startedAt,
    });
  }
  const input = inputFrom(options, template);
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
      // 延迟态在回执上留痕；judgment-result 只认最新一条，仍为 answer_deferred 就拒判。
      evidenceRef: options["defer-answer"] ? "answer_deferred" : "answer_audited",
      artifactHash: draftHash,
      artifactLength: draftLength,
      durationMs: Date.now() - startedAt,
    });
    // [claude] 2026-08-26：`--checkpoint` 把 Gate 与题面 checkpoint 合成一次往返。
    //
    // 刻意做成**显式开关而不是 PASS 后自动签**：草稿过 Gate 不等于一定会展示（可能还要
    // 换轴、改陷阱、或者干脆弃稿）。自动签会给一道从未上屏的题留下 waiting_user checkpoint，
    // 把 Run 挂死——那是拿一次往返换一个新故障。只有执行者明确说"这一份就是要发的"才签。
    // 阶段闸本身没有放宽：checkpointSkillRun 仍校验 target_frozen/materials_checked，
    // 且 BLOCK 的草稿（audit.ok=false）一律不签。
    if (options.checkpoint && audit.ok) {
      const phase = options.phase ?? "question";
      checkpointSkillRun({
        runId: options.run,
        phase,
        done: options.done ? String(options.done).split(",").map((item) => item.trim()).filter(Boolean) : [],
        artifactHash: draftHash,
        evidenceRef: options.ref ?? null,
      });
      console.log(`SKILL_CHECKPOINT_PASS｜${options.run}｜${phase}`);
    }
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
