// 智能教练决策入口：从现有事实层派生状态、遗忘风险、考试风险与复习队列。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { collectAssessment } from "./assessment.mjs";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";
import { fitDispatchToSchedule, formatLearningCoachSummary } from "./lib/learning-coach.mjs";
import { beijingDate } from "./lib/recite-ledger.mjs";
import { appendScheduleItem } from "./lib/schedule-store.mjs";

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    result[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function integerLimit(value) {
  const parsed = Number(value ?? 3);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) throw new Error("--limit 必须是 1-3 的整数");
  return parsed;
}

function saveSnapshots(assessment) {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/assessment-snapshot.json", `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
  writeFileSync(".local/coach-engine-snapshot.json", `${JSON.stringify(assessment.coachEngine, null, 2)}\n`, "utf8");
}

function dispatchPreview(items) {
  return items.length
    ? items.map((item) => `- [${item.priority}] ${item.subject}·${item.id} ${item.title}｜风险 ${item.score}｜${item.type}`).join("\n")
    : "- 无到期或高风险候选";
}

const command = process.argv[2] ?? "snapshot";
const options = flags(process.argv.slice(3));
const referenceDate = options.today && options.today !== true ? String(options.today) : beijingDate();
const limit = integerLimit(options.limit);
const assessment = await collectAssessment(referenceDate);
saveSnapshots(assessment);
const coach = assessment.coachEngine;

if (command === "snapshot") {
  console.log(options.json ? JSON.stringify(coach, null, 2) : formatLearningCoachSummary(coach));
} else if (command === "dispatch") {
  const file = options.file && options.file !== true ? String(options.file) : ".local/复盘排期.md";
  const originalMarkdown = existsSync(file) ? readFileSync(file, "utf8") : "# 复盘排期\n";
  const schedule = parseReviewSchedule(originalMarkdown, { referenceDate });
  if (schedule.counts.errors) throw new Error(`现有复盘排期有 ${schedule.counts.errors} 个结构错误，拒绝自动派单`);
  const actionable = [...schedule.overdue, ...schedule.dueToday];
  const fitted = fitDispatchToSchedule(coach.dispatch.today, actionable, limit);
  const candidates = fitted.selected;
  const { availableSlots } = fitted;
  if (!options.write) {
    const preview = {
      referenceDate,
      write: false,
      dailyLimit: limit,
      existingActionable: actionable.length,
      availableSlots,
      candidates,
      note: "预览模式：加 --write 才会写入唯一排期事实源 .local/复盘排期.md",
    };
    console.log(options.json ? JSON.stringify(preview, null, 2) : `自动派单预览（北京 ${referenceDate}）：已有逾期/今日 ${actionable.length} 件，可补 ${availableSlots} 件\n${dispatchPreview(candidates)}\n未写盘；加 --write 后才进入日报可消费的结构化排期。`);
  } else {
    let markdown = originalMarkdown;
    const results = [];
    for (const candidate of candidates) {
      const result = appendScheduleItem(markdown, {
        id: candidate.scheduleId,
        date: referenceDate,
        priority: candidate.priority,
        type: candidate.type,
        task: candidate.task,
        ref: candidate.dispatchRef,
      }, { referenceDate, dedupeRefPrefix: `${candidate.baseRef}:` });
      if (result.added) markdown = result.markdown;
      results.push({ ...candidate, added: result.added, reason: result.reason });
    }
    writeFileSync(file, markdown, "utf8");
    const output = {
      referenceDate,
      write: true,
      file,
      added: results.filter((item) => item.added).length,
      skipped: results.filter((item) => !item.added).length,
      results,
    };
    console.log(options.json
      ? JSON.stringify(output, null, 2)
      : `自动派单已处理（北京 ${referenceDate}）：新增 ${output.added} / 幂等跳过 ${output.skipped}\n${dispatchPreview(results)}`);
  }
} else {
  console.error("用法：node scripts/coach-engine.mjs <snapshot|dispatch> [--today YYYY-MM-DD] [--json]");
  console.error("  dispatch [--limit 1-3] [--write] [--file .local/复盘排期.md]");
  process.exitCode = 2;
}
