// node scripts/daibei-ledger.mjs summary [--json] [--today YYYY-MM-DD] [--file .local/带背挂账.md]
// node scripts/daibei-ledger.mjs audit [--json] [--today YYYY-MM-DD]
// node scripts/daibei-ledger.mjs check [--today YYYY-MM-DD]  # 有 error 时退出 1
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatReciteLedgerSummary, parseReciteLedger, readReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";

function flags(args) {
  const out = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    out[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return out;
}

function issueLine(issue) {
  const at = [issue.id, issue.line ? `行${issue.line}` : null].filter(Boolean).join("@");
  return `${issue.severity === "error" ? "✗" : "!"} ${issue.code}${at ? ` [${at}]` : ""}：${issue.message}`;
}

function clean(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").replace(/-->/g, "→").replace(/\s+/g, " ").trim();
}

function requireOption(options, key) {
  if (!options[key] || options[key] === true) throw new Error(`缺少 --${key}`);
  return clean(options[key]);
}

function applyTransition(markdown, parsed, { id, event, date, evidence, note }) {
  const entry = parsed.records.find((record) => record.id === id);
  if (!entry) throw new Error(`未找到带背条目：${id}`);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = entry.line - 1;
  let end = headingIndex + 1;
  while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end += 1;
  const fieldIndex = lines.findIndex((line, index) => index > headingIndex && index < end && /^-\s*挂(?:\s|\*)/.test(line));
  if (fieldIndex < 0 && event !== "new") throw new Error(`${id} 缺状态字段行，不能安全迁移`);
  const mmdd = date.slice(5);
  const fromStatus = event === "new" ? null : entry.status;
  const fromRoute = event === "new" ? null : entry.route;
  let toStatus = entry.status;
  let toRoute = entry.route;
  let statusText = null;
  let headingMarker = "";

  if (event === "new") {
    if (entry.status !== "active") throw new Error(`new 事件只适用于新建的 active 条目，当前为 ${entry.status}`);
  } else if (event === "withdraw") {
    if (entry.status !== "active") throw new Error(`withdraw 要求当前 active，${id} 当前为 ${entry.status}`);
    toStatus = "withdrawn";
    statusText = `撤 ${mmdd}${note ? `（${note}）` : ""}`;
    headingMarker = ` → 撤 ${mmdd}`;
  } else if (event === "rehang") {
    if (entry.status !== "withdrawn") throw new Error(`rehang 要求当前 withdrawn，${id} 当前为 ${entry.status}`);
    toStatus = "active";
    toRoute = "daibei";
    statusText = `重挂 ${mmdd}${note ? `（${note}）` : ""}`;
    headingMarker = ` → ${mmdd} 重挂`;
  } else if (event === "transfer") {
    if (entry.status === "transferred") throw new Error(`${id} 已是 transferred`);
    if (!note) throw new Error("transfer 必须用 --note 写明接收轨");
    toStatus = "transferred";
    toRoute = "transferred";
    statusText = `带背侧结案·移交${note}`;
    headingMarker = " → 带背侧结案";
  } else if (event === "route-anki") {
    if (entry.status !== "active" || entry.route !== "daibei") throw new Error(`route-anki 要求 active:daibei，${id} 当前为 ${entry.status}:${entry.route}`);
    toRoute = "anki";
    statusText = `挂（转 Anki 轨${note ? `：${note}` : ""}）`;
    headingMarker = " → 转 Anki 轨";
  } else {
    throw new Error(`未知 event：${event}`);
  }

  if (headingMarker) lines[headingIndex] = `${lines[headingIndex]}${headingMarker}`;
  if (statusText) {
    let field = lines[fieldIndex];
    if (/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/.test(field)) field = field.replace(/最后碰\s+[*]*(?:20\d{2}-)?\d{2}-\d{2}[*]*/, `最后碰 **${mmdd}**`);
    else field = `${field.trimEnd()} ｜ 最后碰 **${mmdd}**`;
    if (/状态[：:]\s*[^｜|]+/.test(field)) field = field.replace(/状态[：:]\s*[^｜|]+/, `状态：${statusText}`);
    else field = `${field.trimEnd()} ｜ 状态：${statusText}`;
    lines[fieldIndex] = field;
  }

  const transition = {
    operationId: randomUUID(),
    date,
    event,
    entryId: id,
    fromStatus,
    toStatus,
    fromRoute,
    toRoute,
    evidence,
    note: note || null,
  };
  const hasSection = lines.some((line) => /^##\s+迁移流水（机器读取/.test(line));
  const suffix = `${hasSection ? "" : "\n## 迁移流水（机器读取·append-only）\n\n> 这里只记流量审计；条目当前状态仍是唯一状态事实。已有事件不得改写或删除。\n"}\n<!-- recite-transition-v1 ${JSON.stringify(transition)} -->`;
  return { markdown: `${lines.join("\n").trimEnd()}${suffix}\n`, transition };
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const file = options.file && options.file !== true ? options.file : ".local/带背挂账.md";
const today = options.today && options.today !== true ? String(options.today) : undefined;
const parsed = readReciteLedger(file, today ? { referenceDate: today } : {});
const summary = summarizeReciteLedger(parsed);

if (command === "transition") {
  if (summary.counts.errors) throw new Error(`迁移前账本已有 ${summary.counts.errors} 个结构错误，先 audit 修复`);
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? clean(process.argv[3]) : requireOption(options, "id");
  const event = requireOption(options, "event");
  const evidence = requireOption(options, "evidence");
  const note = options.note && options.note !== true ? clean(options.note) : "";
  const markdown = readFileSync(file, "utf8");
  const applied = applyTransition(markdown, parsed, { id, event, date: today ?? parsed.referenceDate, evidence, note });
  const checked = parseReciteLedger(applied.markdown, { referenceDate: today ?? parsed.referenceDate });
  const checkedSummary = summarizeReciteLedger(checked);
  if (checkedSummary.counts.errors) throw new Error(`迁移结果未写入：${checked.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("；")}`);
  writeFileSync(file, applied.markdown, "utf8");
  console.log(`✅ 已迁移并留流水：${id} ${applied.transition.fromStatus ?? "none"}:${applied.transition.fromRoute ?? "none"} → ${applied.transition.toStatus}:${applied.transition.toRoute}（${applied.transition.date}）`);
} else if (command === "flow") {
  const flow = summarizeReciteTransitions(parsed, {
    start: options.from && options.from !== true ? String(options.from) : null,
    end: options.to && options.to !== true ? String(options.to) : null,
  });
  if (options.json) console.log(JSON.stringify(flow, null, 2));
  else {
    console.log(`带背迁移流水 ${flow.start ?? "最早"} ~ ${flow.end ?? "最新"}：共 ${flow.total} 条`);
    console.log(`新挂 ${flow.byEvent.new} / 撤池 ${flow.byEvent.withdraw} / 重挂 ${flow.byEvent.rehang} / 移交 ${flow.byEvent.transfer} / 转 Anki ${flow.byEvent["route-anki"]}`);
    for (const item of flow.transitions) console.log(`- ${item.date} ${item.entryId} ${item.event}：${item.fromStatus ?? "none"}:${item.fromRoute ?? "none"} → ${item.toStatus}:${item.toRoute}｜${item.evidence}`);
  }
} else if (options.json) {
  console.log(JSON.stringify(command === "audit" || command === "check" ? parsed : summary, null, 2));
} else if (command === "summary") {
  console.log(formatReciteLedgerSummary(summary));
} else if (command === "audit" || command === "check") {
  console.log(`带背账本审计：${parsed.records.length} 个唯一条目，错误 ${summary.counts.errors} / 警告 ${summary.counts.warnings}`);
  for (const issue of parsed.issues) console.log(issueLine(issue));
} else {
  console.error("用法：node scripts/daibei-ledger.mjs <summary|audit|check|flow|transition> [--json] [--today YYYY-MM-DD] [--file 路径]");
  console.error("  flow --from YYYY-MM-DD --to YYYY-MM-DD");
  console.error("  transition <ID> --event new|withdraw|rehang|transfer|route-anki --evidence \"教材/复检锚点\" [--note \"接收轨/说明\"]");
  process.exitCode = 2;
}

if (command === "check" && summary.counts.errors > 0) process.exitCode = 1;
