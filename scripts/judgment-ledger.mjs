// node --env-file=.env.local scripts/judgment-ledger.mjs <命令> [参数]
// 教练侧判断台账：事前落一条可验证预测 → 到期对账 → 兑现率按类型/科目统计。
// 唯一事实源：.local/判断台账.md（机器读取区，脚本读写，格式被 parseJudgmentLedger 复验）。
//
// 命令：
//   add --type 掌握度|栽点|病根候选|复检期|排期|进度|事实 --prediction "..." \
//       [--subject 科目 --ref T#/X#/L#/排期id --basis "依据" --verify-date YYYY-MM-DD --note "..." --seed]
//   resolve <id> <hit|miss|partial|void> [--note "真值" --date YYYY-MM-DD]
//   due                      —— 已到验证时点仍未对账的预测
//   summary [--json]         —— 兑现率（种子不计分母）
//   calibration [--json]     —— 校准报告：按类型分组兑现率 + 任务量偏差 + 可信执行量系数
//   list [--state pending|due|done] [--type ...] [--json]
//   check                    —— 结构校验；有 error 退出码 1
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beijingDate } from "./lib/recite-ledger.mjs";
import {
  appendJudgment,
  assertValidJudgmentLedger,
  cleanCell,
  parseJudgmentLedger,
  resolveJudgment,
  summarizeJudgmentLedger,
  formatJudgmentLedgerSummary,
} from "./lib/judgment-ledger.mjs";
import { calibrateJudgments, formatCalibrationReport } from "./lib/judgment-calibration.mjs";

// [gpt] 2026-08-10：移除未使用的枚举导入，保持 CLI lint 零告警。

const FILE = ".local/判断台账.md";

function flags(args) {
  const out = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    out[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return out;
}

function requireValue(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`缺少 --${key}`);
  return cleanCell(value);
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const today = options.date && options.date !== true ? String(options.date) : beijingDate();
const file = options.file && options.file !== true ? String(options.file) : FILE;
const markdown = existsSync(file) ? readFileSync(file, "utf8") : null;

function loadMarkdown() {
  if (markdown == null) throw new Error(`判断台账不存在：${file}（先 add 一条初始化）`);
  return markdown;
}

if (command === "add") {
  const result = appendJudgment(markdown ?? "", {
    type: requireValue(options, "type"),
    prediction: requireValue(options, "prediction"),
    subject: options.subject && options.subject !== true ? options.subject : "",
    ref: options.ref && options.ref !== true ? options.ref : "",
    basis: options.basis && options.basis !== true ? options.basis : "",
    verifyDate: options["verify-date"] && options["verify-date"] !== true ? String(options["verify-date"]) : null,
    date: options.date && options.date !== true ? String(options.date) : today,
    seed: Boolean(options.seed),
    note: options.note && options.note !== true ? options.note : "",
  }, { referenceDate: today });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, result.markdown, "utf8");
  console.log(`✅ 已落账预测 ${result.id} [${result.item.type}]${result.item.subject ? ` ${result.item.subject}` : ""}${result.item.ref ? `｜${result.item.ref}` : ""}：${result.item.prediction}${result.item.verifyDate ? `（验证 ${result.item.verifyDate}）` : ""}${result.item.seed ? "（种子·不计兑现率）" : ""}`);
} else if (command === "resolve") {
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? cleanCell(process.argv[3]) : requireValue(options, "id");
  const resultValue = process.argv[4] && !process.argv[4].startsWith("--") ? cleanCell(process.argv[4]) : requireValue(options, "result");
  const result = resolveJudgment(loadMarkdown(), id, resultValue, {
    date: today,
    note: options.note && options.note !== true ? options.note : "",
  });
  writeFileSync(file, result.markdown, "utf8");
  console.log(result.changed ? `✅ 已对账 ${id} → ${resultValue}（${today}）` : `（${id} 早已对账，未改动）`);
} else {
  const parsed = parseJudgmentLedger(loadMarkdown(), { referenceDate: today });
  if (command !== "check") assertValidJudgmentLedger(parsed, command === "calibration" ? "校准" : "读取");
  if (command === "summary") {
    const summary = summarizeJudgmentLedger(parsed, { referenceDate: today });
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(formatJudgmentLedgerSummary(summary));
  } else if (command === "calibration") {
    const report = calibrateJudgments(parsed, { referenceDate: today });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatCalibrationReport(report));
  } else if (command === "due") {
    const due = parsed.items.filter((item) => item.result === "pending" && item.verifyDate && item.verifyDate <= today);
    if (options.json) console.log(JSON.stringify(due, null, 2));
    else if (!due.length) console.log("没有到期未对账的预测。");
    else for (const item of due) console.log(`- ${item.id} [${item.type}]${item.subject ? ` ${item.subject}` : ""}${item.ref ? `｜${item.ref}` : ""} ${item.prediction}（验证 ${item.verifyDate}）`);
  } else if (command === "list") {
    const state = options.state && options.state !== true ? String(options.state) : null;
    const type = options.type && options.type !== true ? String(options.type) : null;
    let items = parsed.items;
    if (type) items = items.filter((item) => item.type === type);
    if (state === "pending") items = items.filter((item) => item.result === "pending" && (!item.verifyDate || item.verifyDate > today));
    else if (state === "due") items = items.filter((item) => item.result === "pending" && item.verifyDate && item.verifyDate <= today);
    else if (state === "done") items = items.filter((item) => item.result !== "pending");
    if (options.json) console.log(JSON.stringify(items, null, 2));
    else for (const item of items) console.log(`- ${item.id} [${item.type}] ${item.result} ${item.date}${item.verifyDate ? `→${item.verifyDate}` : ""} ${item.prediction}`);
  } else if (command === "check") {
    console.log(`判断台账校验：${parsed.items.length} 条，错误 ${parsed.counts.errors}`);
    for (const issue of parsed.issues) console.log(`✗ ${issue.code} [行${issue.line}]：${issue.message}`);
    if (parsed.counts.errors) process.exitCode = 1;
  } else {
    console.error("用法：node scripts/judgment-ledger.mjs <add|resolve|due|summary|calibration|list|check> [--json] [--date YYYY-MM-DD]");
    console.error("  add --type 掌握度|栽点|病根候选|复检期|排期|进度|事实 --prediction \"...\" [--subject --ref --basis --verify-date --note --seed]");
    console.error("  resolve <id> <hit|miss|partial|void> [--note 真值]");
    process.exitCode = 2;
  }
}
