// node scripts/daibei-ledger.mjs summary [--json] [--today YYYY-MM-DD] [--file .local/带背挂账.md]
// node scripts/daibei-ledger.mjs audit [--json] [--today YYYY-MM-DD]
// node scripts/daibei-ledger.mjs check [--today YYYY-MM-DD]  # 有 error 时退出 1
// node scripts/daibei-ledger.mjs evidence <ID> --result fail --pattern degree_strength --diagnosis pending --anchor "教材/题目锚点"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyEvidenceEvent, applyTransition, formatReciteLedgerSummary, parseReciteLedger, readReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";
import { appendOutboxText, buildReciteAttemptOperation } from "./lib/attempt-producers.mjs";
import { commitLinkedTextFiles } from "./lib/linked-file-transaction.mjs";
import { assertDaibeiTargetWritebackReady, recordAutomaticSkillStep } from "./lib/skill-run.mjs";

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
  if (result === "void" && failurePatternCode) throw new Error("作废题只归责教练，不能记录用户栽点 pattern");
  const diagnosisStatus = options.diagnosis && options.diagnosis !== true ? clean(options.diagnosis) : null;
  const evidenceAnchor = requireOption(options, "anchor");
  const note = options.note && options.note !== true ? clean(options.note) : null;
  const backfill = booleanOption(options, "backfill");
  if (options.run === true) throw new Error("--run 必须提供 Skill Run ID");
  if (backfill && options.run) throw new Error("--backfill 只补历史结构，不能给 Skill Run 记本场结果");
  const runFile = options["run-file"] && options["run-file"] !== true ? String(options["run-file"]) : undefined;
  // [gpt] 2026-08-14：在触碰账本和 outbox 之前核对 Run 冻结对象；错对象时零文件写入。
  if (options.run) assertDaibeiTargetWritebackReady({
    runId: String(options.run),
    reciteId: id,
    scheduleId: options.schedule && options.schedule !== true ? clean(options.schedule) : null,
    file: runFile,
  });
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
  let stagedOperationId = null;
  if (shouldStageAttempt) {
    const entry = parsed.records.find((record) => record.id === id);
    const operation = buildReciteAttemptOperation(applied.event, entry);
    stagedOperationId = operation.operation_id;
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
  if (options.run && options.run !== true) {
    if (!stagedOperationId) throw new Error("带 Run 的证据必须同时产生待同步 operation_id");
    // [gpt] 2026-08-12：本地账本成功只证明结果已记录；远端 writeback 必须由 cuoti sync 查询 ingest_operation 后另签。
    recordAutomaticSkillStep({
      runId: String(options.run),
      step: "result_recorded",
      source: "daibei-evidence",
      evidenceRef: `${id}:${dimension}/${result}:op=${stagedOperationId}`,
      expectedSkill: "daibei-pc",
      file: runFile,
    });
    console.log(`下一步：node --env-file=.env.local scripts/cuoti.mjs sync --run ${options.run} --operation ${stagedOperationId}`);
  }
  if (result === "void") console.log("↩ 本次只留教练题面事故审计：不刷新最后碰、不计有效题量、不记用户错误、不推进冷却。");
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
  console.error("  evidence <ID> --result pass|partial|fail|void --anchor \"教材/题目锚点\" [--dimension understanding|recall] [--cold true|false] [--prompt clean|cued|invalid] [--pattern code --diagnosis pending|confirmed|rejected] [--note \"诊断\"] [--run SR-... --schedule 排期ID] [--backfill] [--outbox 路径]");
  process.exitCode = 2;
}

if (command === "check" && summary.counts.errors > 0) process.exitCode = 1;
