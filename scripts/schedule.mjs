// 复盘排期的结构化入口；唯一事实源仍是 .local/复盘排期.md。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beijingDate } from "./lib/recite-ledger.mjs";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    result[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function clean(value) {
  return String(value ?? "").replace(/[\r\n|]/g, (char) => char === "|" ? "／" : " ").replace(/\s+/g, " ").trim();
}

function requireValue(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`缺少 --${key}`);
  return clean(value);
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const file = options.file && options.file !== true ? String(options.file) : ".local/复盘排期.md";
const today = options.today && options.today !== true ? String(options.today) : beijingDate();
const markdown = existsSync(file) ? readFileSync(file, "utf8") : "# 复盘排期\n";

if (command === "summary" || command === "check") {
  const parsed = parseReviewSchedule(markdown, { referenceDate: today });
  if (options.json) console.log(JSON.stringify(parsed, null, 2));
  else {
    console.log(`复盘排期（北京 ${today}）：逾期 ${parsed.counts.overdue} / 今日 ${parsed.counts.dueToday} / 未来 ${parsed.counts.upcoming} / 已完成 ${parsed.counts.completed}`);
    for (const item of [...parsed.overdue, ...parsed.dueToday, ...parsed.upcoming].slice(0, 12)) {
      const state = item.dueDate < today ? "逾期" : item.dueDate === today ? "今日" : "待办";
      console.log(`- ${state} ${item.dueDate} [${item.priority}] ${item.id} ${item.task}`);
    }
    console.log(`结构校验：错误 ${parsed.counts.errors} / 警告 ${parsed.counts.warnings}；结构化 ${parsed.counts.canonical} / 旧格式 ${parsed.counts.legacy}`);
  }
  if (command === "check" && parsed.counts.errors) process.exitCode = 1;
} else if (command === "add") {
  const date = requireValue(options, "date");
  const priority = requireValue(options, "priority").toUpperCase();
  const type = requireValue(options, "type");
  const task = requireValue(options, "task");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new Error("--date 必须是 YYYY-MM-DD");
  if (!/^P[0-2]$/.test(priority)) throw new Error("--priority 只能是 P0/P1/P2");
  const id = options.id && options.id !== true ? clean(options.id) : `R${date.replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const ref = options.ref && options.ref !== true ? ` | ref=${clean(options.ref)}` : "";
  const section = markdown.includes("## 结构化排期（机器读取）") ? "" : "\n## 结构化排期（机器读取）\n\n> 新条目只用下列格式；旧散文保留作历史证据，不再复制第二份状态。\n";
  const line = `- [ ] ${date} | ${priority} | id=${id} | type=${type} | task=${task}${ref}`;
  writeFileSync(file, `${markdown.trimEnd()}${section}\n${line}\n`, "utf8");
  console.log(`✅ 已加入复盘排期：${id} ${date} [${priority}] ${task}`);
} else if (command === "done") {
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? clean(process.argv[3]) : requireValue(options, "id");
  const result = requireValue(options, "result");
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const indexes = lines.map((line, index) => line.includes(`| id=${id} |`) ? index : -1).filter((index) => index >= 0);
  if (indexes.length !== 1) throw new Error(indexes.length ? `排期 ID 重复：${id}` : `未找到排期 ID：${id}`);
  const index = indexes[0];
  if (/^- \[x\]/i.test(lines[index])) throw new Error(`排期已完成：${id}`);
  lines[index] = lines[index].replace(/^- \[ \]/, "- [x]") + ` | completed=${today} | result=${result}`;
  writeFileSync(file, `${lines.join("\n").trimEnd()}\n`, "utf8");
  console.log(`✅ 已完成复盘排期：${id}（${today}）${result}`);
} else {
  console.error("用法：node scripts/schedule.mjs <summary|check|add|done> [--json] [--today YYYY-MM-DD]");
  console.error("  add --date YYYY-MM-DD --priority P0 --type 错题复检 --task \"...\" [--ref T#1]");
  console.error("  done <ID> --result \"通过/未过及证据\"");
  process.exitCode = 2;
}
