// 复盘排期的结构化入口；唯一事实源仍是 .local/复盘排期.md。
// 结案可联动带背挂账：done <ID> --recite <条目ID> --event withdraw|rehang --evidence "..."，
// 一条命令完成“带背证据 + 状态迁移 + 排期结案”（[gpt] 2026-08-10：全量预校验 + 进程内失败回滚）。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beijingDate } from "./lib/recite-ledger.mjs";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";
import { applyEvidenceEvent, applyTransition, parseReciteLedger, summarizeReciteLedger } from "./lib/recite-ledger.mjs";
import {
  appendScheduleItem,
  assertScheduleLink,
  auditScheduleLinks,
  cleanScheduleValue,
  closeScheduleItem,
  setScheduleDispatch,
} from "./lib/schedule-store.mjs";
import { commitLinkedTextFiles } from "./lib/linked-file-transaction.mjs";
import { appendOutboxText, buildReciteAttemptOperation } from "./lib/attempt-producers.mjs";

const LIVE_RECITE_LEDGER = ".local/带背挂账.md";
const DEFAULT_OUTBOX = ".local/cuoti-pending.jsonl";

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    result[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function clean(value) {
  return cleanScheduleValue(value);
}

function requireValue(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`缺少 --${key}`);
  return clean(value);
}

function booleanValue(options, key, fallback = false) {
  const value = options[key];
  if (value == null) return fallback;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} 只接受 true 或 false`);
}

const command = process.argv[2] ?? "summary";
const options = flags(process.argv.slice(3));
const file = options.file && options.file !== true ? String(options.file) : ".local/复盘排期.md";
const today = options.today && options.today !== true ? String(options.today) : beijingDate();
const markdown = existsSync(file) ? readFileSync(file, "utf8") : "# 复盘排期\n";

if (command === "summary" || command === "check" || command === "audit-links") {
  const parsed = parseReviewSchedule(markdown, { referenceDate: today });
  let linkAudit = null;
  if (command !== "summary") {
    const reciteFile = options["recite-file"] && options["recite-file"] !== true ? String(options["recite-file"]) : LIVE_RECITE_LEDGER;
    const reciteParsed = existsSync(reciteFile) ? parseReciteLedger(readFileSync(reciteFile, "utf8"), { referenceDate: today }) : null;
    linkAudit = auditScheduleLinks(markdown, { referenceDate: today, reciteParsed });
  }
  const output = command === "summary" ? parsed : linkAudit;
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`复盘排期（北京 ${today}）：逾期 ${parsed.counts.overdue} / 今日 ${parsed.counts.dueToday} / 未来 ${parsed.counts.upcoming} / 已完成 ${parsed.counts.completed}`);
    for (const item of [...parsed.overdue, ...parsed.dueToday, ...parsed.upcoming].slice(0, 12)) {
      const state = item.dueDate < today ? "逾期" : item.dueDate === today ? "今日" : "待办";
      const dispatch = item.route ? ` → ${item.route}/${item.dimension}` : "";
      console.log(`- ${state} ${item.dueDate} [${item.priority}] ${item.id}${dispatch} ${item.task}`);
    }
    console.log(`结构校验：错误 ${parsed.counts.errors} / 警告 ${parsed.counts.warnings}；结构化 ${parsed.counts.canonical} / 旧格式 ${parsed.counts.legacy}`);
    if (linkAudit) {
      console.log(`关联校验：错误 ${linkAudit.counts.errors} / 警告 ${linkAudit.counts.warnings}`);
      for (const issue of linkAudit.issues) console.log(`${issue.severity === "error" ? "✗" : "⚠️"} ${issue.code} [行${issue.line}]：${issue.message}`);
    }
  }
  if (command !== "summary" && linkAudit.counts.errors) process.exitCode = 1;
} else if (command === "add") {
  const date = requireValue(options, "date");
  const priority = requireValue(options, "priority").toUpperCase();
  const type = requireValue(options, "type");
  const task = requireValue(options, "task");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new Error("--date 必须是 YYYY-MM-DD");
  if (!/^P[0-2]$/.test(priority)) throw new Error("--priority 只能是 P0/P1/P2");
  const id = options.id && options.id !== true ? clean(options.id) : `R${date.replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const result = appendScheduleItem(markdown, {
    id,
    date,
    priority,
    type,
    task,
    ref: options.ref && options.ref !== true ? clean(options.ref) : "",
    route: options.route && options.route !== true ? clean(options.route) : "",
    dimension: options.dimension && options.dimension !== true ? clean(options.dimension) : "",
    // [gpt] 2026-08-10：周报/评估/里程碑把每个验收单元写进唯一排期账，供控制器按优先级对账。
    planId: options.plan && options.plan !== true ? clean(options.plan) : "",
    planWeek: options.week && options.week !== true ? clean(options.week) : "",
    planSource: options.source && options.source !== true ? clean(options.source) : "",
    acceptanceWeight: options.weight && options.weight !== true ? Number(options.weight) : null,
    goalId: options.goal && options.goal !== true ? clean(options.goal) : "",
  }, { referenceDate: today });
  if (!result.added) throw new Error(`排期未追加：${result.reason}`);
  writeFileSync(file, result.markdown, "utf8");
  console.log(`✅ 已加入复盘排期：${id} ${date} [${priority}] ${task}`);
} else if (command === "route") {
  // [gpt] 2026-08-10：历史排期接线必须经过枚举校验与解析器回读，不能直接手改字符串。
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? clean(process.argv[3]) : requireValue(options, "id");
  const route = requireValue(options, "route");
  const dimension = requireValue(options, "dimension");
  const routed = setScheduleDispatch(markdown, id, { route, dimension, referenceDate: today });
  writeFileSync(file, routed, "utf8");
  console.log(`✅ 已设置复盘排期路由：${id} → ${route}/${dimension}`);
} else if (command === "done") {
  const id = process.argv[3] && !process.argv[3].startsWith("--") ? clean(process.argv[3]) : requireValue(options, "id");
  const result = requireValue(options, "result");
  const reciteId = options.recite && options.recite !== true ? clean(options.recite) : null;
  const reciteEvent = options.event && options.event !== true ? clean(options.event) : null;
  const reciteEvidence = options.evidence && options.evidence !== true ? clean(options.evidence) : null;
  const structuredOutcome = options.outcome && options.outcome !== true ? clean(options.outcome) : null;
  let structuredCold = null;
  let structuredPrompt = null;
  const structuredRequested = Boolean(structuredOutcome || options.cold != null || options.prompt != null);
  if (structuredRequested) {
    if (!structuredOutcome) throw new Error("结构化结案需要提供 --outcome pass|partial|fail|void");
    if (options.cold == null || options.cold === true) throw new Error("结构化结案必须显式提供 --cold true|false");
    if (options.prompt == null || options.prompt === true) throw new Error("结构化结案必须显式提供 --prompt clean|cued|invalid");
    structuredCold = booleanValue(options, "cold");
    structuredPrompt = requireValue(options, "prompt");
    if (!["clean", "cued", "invalid"].includes(structuredPrompt)) throw new Error("--prompt 只能是 clean、cued 或 invalid");
  }
  const reciteLinkRequested = Boolean(reciteId || reciteEvent);
  // [gpt] 2026-08-10：带背联动必须先形成完整证据，再迁移状态与结清排期，禁止“无证据撤池”。
  if (reciteLinkRequested) {
    if (!(reciteId && reciteEvent && structuredOutcome && reciteEvidence)) {
      throw new Error("带背联动结案需要同时提供 --recite <ID> --event withdraw|rehang|observe --outcome pass|partial|fail --evidence \"教材/复检锚点\"");
    }
    if (options.dimension && options.dimension !== true && clean(options.dimension) !== "recall") {
      throw new Error("带背联动结案的证据维度只能是 recall");
    }
    if (!["pass", "partial", "fail"].includes(structuredOutcome)) throw new Error("带背联动 --outcome 只能是 pass、partial 或 fail");
    if (!["clean", "cued"].includes(structuredPrompt)) throw new Error("带背联动 --prompt 只能是 clean 或 cued");
    assertScheduleLink(markdown, id, {
      kind: "recite", targetId: reciteId, referenceDate: today, route: "daibei-pc", dimension: "recall",
    });
  }
  // 必须先把排期结案结果算完并复验；排期 ID/关联有问题时，绝不能先动带背账本。
  const closedSchedule = closeScheduleItem(markdown, id, {
    date: today,
    result,
    // [gpt] 2026-08-10：联动带背结案同时固化真实检验条件，供干预响应闭环重算。
    outcome: structuredOutcome,
    cold: structuredRequested ? structuredCold : null,
    promptIntegrity: structuredRequested ? structuredPrompt : null,
  });
  if (reciteLinkRequested) {
    // [gpt] 2026-08-10：D3/D14/D30 通过只追加 observe 证据，不反复撤池；失败时仍可 rehang。
    if (!["withdraw", "rehang", "observe"].includes(reciteEvent)) throw new Error("--event 只能是 withdraw、rehang 或 observe");
    const reciteFile = options["recite-file"] && options["recite-file"] !== true ? String(options["recite-file"]) : ".local/带背挂账.md";
    if (!existsSync(reciteFile)) throw new Error(`带背账本不存在：${reciteFile}`);
    const reciteMarkdown = readFileSync(reciteFile, "utf8");
    const parsed = parseReciteLedger(reciteMarkdown, { referenceDate: today });
    if (summarizeReciteLedger(parsed).counts.errors) throw new Error(`带背账本已有结构错误，拒绝联动；先 daibei-ledger.mjs audit 修复`);
    if (reciteEvent === "withdraw" && structuredOutcome !== "pass") throw new Error("withdraw 只能对应 --outcome pass");
    if (reciteEvent === "rehang" && !["partial", "fail"].includes(structuredOutcome)) throw new Error("rehang 只能对应 --outcome partial|fail");
    if (reciteEvent === "withdraw" && (!structuredCold || structuredPrompt !== "clean")) throw new Error("复检撤池必须是 --cold true 且 --prompt clean 的干净通过");
    const evidenceApplied = applyEvidenceEvent(reciteMarkdown, parsed, {
      id: reciteId,
      date: today,
      dimension: "recall",
      result: structuredOutcome,
      cold: structuredCold,
      promptIntegrity: structuredPrompt,
      failurePatternCode: options.pattern && options.pattern !== true ? clean(options.pattern) : null,
      diagnosisStatus: options.diagnosis && options.diagnosis !== true ? clean(options.diagnosis) : null,
      evidenceAnchor: reciteEvidence,
      note: options.note && options.note !== true ? clean(options.note) : null,
    });
    const parsedAfterEvidence = parseReciteLedger(evidenceApplied.markdown, { referenceDate: today });
    if (summarizeReciteLedger(parsedAfterEvidence).counts.errors) throw new Error("带背证据结果未通过结构校验，未落盘");
    const applied = reciteEvent === "observe"
      ? evidenceApplied
      : applyTransition(evidenceApplied.markdown, parsedAfterEvidence, {
        id: reciteId,
        event: reciteEvent,
        date: today,
        evidence: reciteEvidence,
        note: options.note && options.note !== true ? clean(options.note) : "",
      });
    const reverify = parseReciteLedger(applied.markdown, { referenceDate: today });
    if (summarizeReciteLedger(reverify).counts.errors) throw new Error(`带背回写结果未通过结构校验，未落盘`);
    const linkedWrites = [
      { path: reciteFile, previous: reciteMarkdown, next: applied.markdown },
      { path: file, previous: markdown, next: closedSchedule },
    ];
    let stagedAttemptId = null;
    if (options.outbox === true) throw new Error("--outbox 必须提供文件路径");
    const explicitOutbox = options.outbox && options.outbox !== true ? String(options.outbox) : null;
    if (reciteFile === LIVE_RECITE_LEDGER || explicitOutbox != null) {
      const attemptOperation = buildReciteAttemptOperation(
        evidenceApplied.event,
        parsed.records.find((record) => record.id === reciteId),
      );
      const outbox = explicitOutbox ?? DEFAULT_OUTBOX;
      const previousOutbox = existsSync(outbox) ? readFileSync(outbox, "utf8") : "";
      const staged = appendOutboxText(previousOutbox, attemptOperation);
      // [gpt] 排期、带背事实与尝试分母三文件联动；任一写入失败均回滚本进程内全部原文。
      linkedWrites.push({ path: outbox, previous: previousOutbox, next: staged.text });
      stagedAttemptId = attemptOperation.operation_id;
    }
    commitLinkedTextFiles(linkedWrites);
    if (stagedAttemptId) console.log(`⏳ 已同步暂存统一尝试：${stagedAttemptId}`);
    console.log(`✅ 已回写带背证据${reciteEvent === "observe" ? "" : "与挂账"}：${reciteId} ${structuredOutcome} + ${reciteEvent}（${today}）`);
  } else {
    writeFileSync(file, closedSchedule, "utf8");
  }
  console.log(`✅ 已完成复盘排期：${id}（${today}）${result}`);
} else {
  console.error("用法：node scripts/schedule.mjs <summary|check|audit-links|add|route|done> [--json] [--today YYYY-MM-DD]");
  console.error("  add --date YYYY-MM-DD --priority P0 --type 错题复检 --task \"...\" [--route cuoti-fupan --dimension application --ref T#1]");
  console.error("      [--plan W20260810-P0-1 --week 2026-08-10 --source weekly|assessment|milestone|coach --weight 1-5 --goal G-MINFALAW]");
  console.error("  route <ID> --route cuoti-fupan --dimension application（仅补齐/纠正执行路由，不改任务事实）");
  console.error("  done <ID> --result \"...\" [--outcome pass|partial|fail|void --cold true|false --prompt clean|cued|invalid]（协议化 episode 必须提供结构化结果）");
  console.error("  done <ID> --result \"通过/未过及证据\"");
  console.error("  done <ID> --result \"...\" --recite <条目ID> --event withdraw|rehang|observe --outcome pass|partial|fail --cold true|false --prompt clean|cued --evidence \"教材/复检锚点\" [--pattern code --diagnosis pending|confirmed --note 说明 --outbox 路径]（原子联动写带背证据、状态、排期与尝试分母；延迟通过用 observe）");
  process.exitCode = 2;
}
