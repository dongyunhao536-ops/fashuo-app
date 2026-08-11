// [gpt] 2026-08-10：概率预测台账 CLI；与普通判断台账分开，按 Brier 分数回测。
// 用法：
//   node scripts/forecast.mjs add --target-date YYYY-MM-DD --subject 刑法 --event "刑法卷面分≥62" --probability 62 --lower 45 --upper 76 --confidence low --model ols-normal-v1 --evidence-ref "mock:..."
//   node scripts/forecast.mjs resolve F0001 1 --actual 64 --date YYYY-MM-DD
//   node scripts/forecast.mjs void F0001 --note "口径变更" --date YYYY-MM-DD
//   node scripts/forecast.mjs summary|due|list|check [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beijingDate } from "./lib/recite-ledger.mjs";
import {
  appendProbabilityForecast,
  assertValidProbabilityForecastLedger,
  cleanForecastCell,
  formatProbabilityForecastSummary,
  parseProbabilityForecastLedger,
  resolveProbabilityForecast,
  summarizeProbabilityForecastLedger,
  voidProbabilityForecast,
} from "./lib/forecast-ledger.mjs";

const DEFAULT_FILE = ".local/概率预测台账.md";

function flags(args) {
  const output = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    output[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return output;
}

function required(options, key) {
  if (options[key] == null || options[key] === true || options[key] === "") throw new Error(`缺少 --${key}`);
  return cleanForecastCell(options[key]);
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const today = options.date && options.date !== true ? String(options.date) : beijingDate();
const file = options.file && options.file !== true ? String(options.file) : DEFAULT_FILE;
const markdown = existsSync(file) ? readFileSync(file, "utf8") : null;
const load = () => {
  if (markdown == null) throw new Error(`概率预测台账不存在：${file}（首次用 add 初始化）`);
  return markdown;
};

if (command === "add") {
  const result = appendProbabilityForecast(markdown ?? "", {
    date: today,
    targetDate: required(options, "target-date"),
    subject: required(options, "subject"),
    event: required(options, "event"),
    probability: required(options, "probability"),
    lower: required(options, "lower"),
    upper: required(options, "upper"),
    confidence: required(options, "confidence"),
    model: required(options, "model"),
    evidenceRef: required(options, "evidence-ref"),
    note: options.note && options.note !== true ? options.note : "",
  }, { referenceDate: today });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, result.markdown, "utf8");
  console.log(result.added ? `✅ 已落账 ${result.id}：${result.item.event} ${result.item.probability}%（${result.item.lower}-${result.item.upper}%）` : `（同一证据版本已存在 ${result.id}，未重复写入）`);
} else if (command === "resolve") {
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? cleanForecastCell(process.argv[3]) : required(options, "id");
  const outcome = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : required(options, "outcome");
  const result = resolveProbabilityForecast(load(), id, outcome, { date: today, actual: options.actual && options.actual !== true ? options.actual : null, note: options.note && options.note !== true ? options.note : "" });
  writeFileSync(file, result.markdown, "utf8");
  console.log(result.changed ? `✅ 已对账 ${id} → ${outcome}` : `（${id} 已结案，未改动）`);
} else if (command === "void") {
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? cleanForecastCell(process.argv[3]) : required(options, "id");
  const result = voidProbabilityForecast(load(), id, { date: today, note: options.note && options.note !== true ? options.note : "" });
  writeFileSync(file, result.markdown, "utf8");
  console.log(result.changed ? `✅ 已作废 ${id}` : `（${id} 已结案，未改动）`);
} else {
  const parsed = parseProbabilityForecastLedger(load());
  if (command !== "check") assertValidProbabilityForecastLedger(parsed, "读取");
  if (command === "summary") {
    const summary = summarizeProbabilityForecastLedger(parsed, { referenceDate: today });
    console.log(options.json ? JSON.stringify(summary, null, 2) : formatProbabilityForecastSummary(summary));
  } else if (command === "due") {
    const due = parsed.items.filter((item) => item.status === "pending" && item.targetDate <= today);
    console.log(options.json ? JSON.stringify(due, null, 2) : due.map((item) => `- ${item.id} ${item.subject} ${item.event}｜${item.probability}%｜目标日 ${item.targetDate}`).join("\n") || "没有到期未对账概率预测。");
  } else if (command === "list") {
    const state = options.state && options.state !== true ? String(options.state) : null;
    const items = state ? parsed.items.filter((item) => item.status === state) : parsed.items;
    console.log(options.json ? JSON.stringify(items, null, 2) : items.map((item) => `- ${item.id} [${item.status}] ${item.subject} ${item.event}｜${item.probability}% [${item.lower},${item.upper}]｜${item.date}→${item.targetDate}`).join("\n") || "暂无记录。");
  } else if (command === "check") {
    console.log(`概率预测台账校验：${parsed.items.length} 条，错误 ${parsed.counts.errors}`);
    for (const issue of parsed.issues) console.log(`✗ ${issue.code} [行${issue.line}]：${issue.message}`);
    if (parsed.counts.errors) process.exitCode = 1;
  } else {
    console.error("用法：node scripts/forecast.mjs <add|resolve|void|summary|due|list|check> [参数]");
    process.exitCode = 2;
  }
}
