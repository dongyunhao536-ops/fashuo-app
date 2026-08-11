// node scripts/daibei-ledger.mjs summary [--json] [--today YYYY-MM-DD] [--file .local/带背挂账.md]
// node scripts/daibei-ledger.mjs audit [--json] [--today YYYY-MM-DD]
// node scripts/daibei-ledger.mjs check [--today YYYY-MM-DD]  # 有 error 时退出 1
// node scripts/daibei-ledger.mjs evidence <ID> --result fail --pattern degree_strength --diagnosis pending --anchor "教材/题目锚点"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyEvidenceEvent, applyTransition, formatReciteLedgerSummary, parseReciteLedger, readReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";
import { appendOutboxText, buildReciteAttemptOperation } from "./lib/attempt-producers.mjs";
import { commitLinkedTextFiles } from "./lib/linked-file-transaction.mjs";

const LIVE_LEDGER = ".local/带背挂账.md";
const DEFAULT_OUTBOX = ".local/cuoti-pending.jsonl";

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

function booleanOption(options, key, fallback = false) {
  const value = options[key];
  if (value == null) return fallback;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} 只接受 true 或 false`);
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const file = options.file && options.file !== true ? options.file : LIVE_LEDGER;
const today = options.today && options.today !== true ? String(options.today) : undefined;
const parsed = readReciteLedger(file, today ? { referenceDate: today } : {});
const summary = summarizeReciteLedger(parsed);

if (command === "evidence") {
  if (summary.counts.errors) throw new Error(`写证据前账本已有 ${summary.counts.errors} 个结构错误，请先 audit 修复`);
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? clean(process.argv[3]) : requireOption(options, "id");
  const dimension = options.dimension && options.dimension !== true ? clean(options.dimension) : "recall";
  const result = requireOption(options, "result");
  const promptIntegrity = options.prompt && options.prompt !== true ? clean(options.prompt) : "clean";
  const failurePatternCode = options.pattern && options.pattern !== true ? clean(options.pattern) : null;
  const diagnosisStatus = options.diagnosis && options.diagnosis !== true ? clean(options.diagnosis) : null;
  const evidenceAnchor = requireOption(options, "anchor");
  const note = options.note && options.note !== true ? clean(options.note) : null;
  const backfill = booleanOption(options, "backfill");
  const markdown = readFileSync(file, "utf8");
  const applied = applyEvidenceEvent(markdown, parsed, {
    id,
    date: today ?? parsed.referenceDate,
    dimension,
    result,
    cold: booleanOption(options, "cold"),
    promptIntegrity,
    failurePatternCode,
    diagnosisStatus,
    evidenceAnchor,
    note,
    backfill,
  });
  const checked = parseReciteLedger(applied.markdown, { referenceDate: today ?? parsed.referenceDate });
  const errors = checked.issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(`复检证据未写入：${errors.map((issue) => issue.message).join("；")}`);
  if (options.outbox === true) throw new Error("--outbox 必须提供文件路径");
  const explicitOutbox = options.outbox && options.outbox !== true ? String(options.outbox) : null;
  const shouldStageAttempt = !backfill && (file === LIVE_LEDGER || explicitOutbox != null);
  if (shouldStageAttempt) {
    const entry = parsed.records.find((record) => record.id === id);
    const operation = buildReciteAttemptOperation(applied.event, entry);
    const outbox = explicitOutbox ?? DEFAULT_OUTBOX;
    const previousOutbox = existsSync(outbox) ? readFileSync(outbox, "utf8") : "";
    const staged = appendOutboxText(previousOutbox, operation);
    // [gpt] 人读账本与机器尝试共用一次联动提交，避免只写一边造成隐性漏数。
    commitLinkedTextFiles([
      { path: file, previous: markdown, next: applied.markdown },
      { path: outbox, previous: previousOutbox, next: staged.text },
    ]);
    console.log(`⏳ 已同步暂存统一尝试：${operation.operation_id}（运行 node --env-file=.env.local scripts/cuoti.mjs sync 入库）`);
  } else {
    writeFileSync(file, applied.markdown, "utf8");
    if (backfill && file === LIVE_LEDGER) console.log("ℹ️ backfill 仅补账本结构，不制造历史 learning_attempt。");
  }
  console.log(`✓ 已记录带背证据：${id} ${applied.event.date} ${dimension}/${result}${failurePatternCode ? ` · ${failurePatternCode}(${applied.event.diagnosisStatus})` : ""}`);
} else if (command === "transition") {
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
  console.error("用法：node scripts/daibei-ledger.mjs <summary|audit|check|flow|transition|evidence> [--json] [--today YYYY-MM-DD] [--file 路径]");
  console.error("  flow --from YYYY-MM-DD --to YYYY-MM-DD");
  console.error("  transition <ID> --event new|withdraw|rehang|transfer|route-anki --evidence \"教材/复检锚点\" [--note \"接收轨/说明\"]");
  console.error("  evidence <ID> --result pass|partial|fail|void --anchor \"教材/题目锚点\" [--dimension understanding|recall] [--cold true|false] [--prompt clean|cued|invalid] [--pattern code --diagnosis pending|confirmed|rejected] [--note \"诊断\"] [--backfill] [--outbox 路径]");
  process.exitCode = 2;
}

if (command === "check" && summary.counts.errors > 0) process.exitCode = 1;
