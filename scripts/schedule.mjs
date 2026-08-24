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
  extractScheduleTargetIds,
  setScheduleDispatch,
} from "./lib/schedule-store.mjs";
import { commitLinkedTextFiles } from "./lib/linked-file-transaction.mjs";
import { appendOutboxText, buildReciteAttemptOperation } from "./lib/attempt-producers.mjs";
import { assertDaibeiTargetWritebackReady } from "./lib/skill-run.mjs";

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

function numericIdList(options, key) {
  const raw = options[key];
  if (raw == null) return null;
  if (raw === true) throw new Error(`--${key} 必须提供以逗号或斜杠分隔的数字 ID`);
  const values = String(raw).split(/[,/，、\s]+/u).filter(Boolean);
  if (!values.length || values.some((value) => !/^\d+$/u.test(value))) {
    throw new Error(`--${key} 只接受数字 ID 列表，例如 --${key} 27,29,30`);
  }
  return [...new Set(values.map(Number))].sort((left, right) => left - right);
}

function assertCuotiClosureTargets(markdownText, scheduleId, optionsValue, referenceDate) {
  const parsed = parseReviewSchedule(markdownText, { referenceDate });
  if (parsed.counts.errors) throw new Error(`现有复盘排期有 ${parsed.counts.errors} 个结构错误，拒绝结案`);
  const item = parsed.items.find((entry) => entry.source === "canonical" && entry.id === scheduleId);
  if (!item) throw new Error(`未找到排期 ID：${scheduleId}`);
  if (item.status === "completed") throw new Error(`排期已完成：${scheduleId}`);
  if (item.route !== "cuoti-fupan" || item.dimension !== "application") return null;

  const stableTargets = extractScheduleTargetIds(item);
  const expected = stableTargets.topicIds.sort((left, right) => left - right);
  if (!expected.length && stableTargets.knowledgeIds.length === 1) {
    const suppliedKnowledge = optionsValue.kp && optionsValue.kp !== true ? clean(optionsValue.kp).toUpperCase() : null;
    if (suppliedKnowledge !== stableTargets.knowledgeIds[0]) {
      throw new Error(`知识点错题排期 ${scheduleId} 必须提供 --kp ${stableTargets.knowledgeIds[0]}，同科其他知识点不得冲抵`);
    }
    return { kind: "knowledge", ids: stableTargets.knowledgeIds };
  }
  if (!expected.length) {
    throw new Error(`错题排期 ${scheduleId} 缺少唯一稳定 T# 或 KP-ID 目标，禁止手工结案；先补 ref/任务目标或拆成可核验排期`);
  }
  const supplied = numericIdList(optionsValue, "topics");
  if (!supplied) {
    throw new Error(`错题排期 ${scheduleId} 禁止无目标结案；单主题优先用 cuoti.mjs review T# --schedule ${scheduleId}，整组逐题留证后提供 --topics ${expected.join(",")}`);
  }
  if (supplied.length !== expected.length || supplied.some((id, index) => id !== expected[index])) {
    throw new Error(`错题排期 ${scheduleId} 目标不一致：排期=${expected.map((id) => `T#${id}`).join("、")}，提交=${supplied.map((id) => `T#${id}`).join("、") || "空"}`);
  }
  return { kind: "topic", ids: expected };
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
  // [gpt] 2026-08-12：错题排期不能靠同科其他题或自然语言 result 冲抵，结案前必须核对完整稳定目标集。
  const cuotiClosureTopics = assertCuotiClosureTargets(markdown, id, options, today);
  if (cuotiClosureTopics && !options["evidence-refs"]) {
    throw new Error(`错题排期 ${id} 手工结案还必须提供 --evidence-refs，逐一列出已落库复检证据（例如 review:T#10:2026-08-12,review:T#25:2026-08-12）`);
  }
  if (cuotiClosureTopics && options["evidence-refs"] === true) throw new Error("--evidence-refs 必须提供非空证据引用");
  if (cuotiClosureTopics?.kind === "topic") {
    const evidenceTopics = extractScheduleTargetIds({ task: String(options["evidence-refs"]) }).topicIds.sort((left, right) => left - right);
    if (evidenceTopics.length !== cuotiClosureTopics.ids.length
      || evidenceTopics.some((topicId, index) => topicId !== cuotiClosureTopics.ids[index])) {
      throw new Error(`错题排期 ${id} 的 --evidence-refs 必须逐一覆盖且只覆盖原目标：${cuotiClosureTopics.ids.map((topicId) => `T#${topicId}`).join("、")}`);
    }
  }
  if (cuotiClosureTopics?.kind === "knowledge") {
    const evidenceKnowledge = extractScheduleTargetIds({ task: String(options["evidence-refs"]) }).knowledgeIds;
    if (evidenceKnowledge.length !== 1 || evidenceKnowledge[0] !== cuotiClosureTopics.ids[0]) {
      throw new Error(`知识点错题排期 ${id} 的 --evidence-refs 必须覆盖 ${cuotiClosureTopics.ids[0]}`);
    }
  }
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
    // [gpt] 2026-08-14：排期、带背条目与 Run 冻结对象在原子写入前统一核对。
    if (options.run === true) throw new Error("--run 必须提供 Skill Run ID");
    const runFile = options["run-file"] && options["run-file"] !== true ? String(options["run-file"]) : undefined;
    if (options.run) assertDaibeiTargetWritebackReady({
      runId: String(options.run),
      reciteId,
      scheduleId: id,
      file: runFile,
    });
  }
  // 必须先把排期结案结果算完并复验；排期 ID/关联有问题时，绝不能先动带背账本。
  const scheduleClosure = closeScheduleItem(markdown, id, {
    date: today,
    result,
    // [gpt] 2026-08-10：联动带背结案同时固化真实检验条件，供干预响应闭环重算。
    outcome: structuredOutcome,
    cold: structuredRequested ? structuredCold : null,
    promptIntegrity: structuredRequested ? structuredPrompt : null,
  });
  if (typeof scheduleClosure !== "string") {
    console.log(`↩ 作废题只归责教练；排期 ${id} 保持 open、冷却不前移，重写并重新过命题 Gate 后再执行。`);
  } else {
    const closedSchedule = scheduleClosure;
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
  }
} else {
  console.error("用法：node scripts/schedule.mjs <summary|check|audit-links|add|route|done> [--json] [--today YYYY-MM-DD]");
  console.error("  add --date YYYY-MM-DD --priority P0 --type 错题复检 --task \"...\" [--route cuoti-fupan --dimension application --ref T#1]");
  console.error("      [--plan W20260810-P0-1 --week 2026-08-10 --source weekly|assessment|milestone|coach --weight 1-5 --goal G-MINFALAW]");
  console.error("  route <ID> --route cuoti-fupan --dimension application（仅补齐/纠正执行路由，不改任务事实）");
  console.error("  done <ID> --result \"...\" [--outcome pass|partial|fail|void --cold true|false --prompt clean|cued|invalid]（协议化 episode 必须提供结构化结果）");
  console.error("  done <错题整组ID> --result \"逐题证据摘要\" --topics 27,29,30 --evidence-refs \"review:T#27:日期,...\"（完整目标精确一致且必须给已落库证据引用；单主题优先用 cuoti review --schedule）");
  console.error("  done <知识点错题ID> --result \"证据摘要\" --kp XF-0054 --evidence-refs \"attempt:XF-0054:日期\"（仅兼容无 T# 的单一 KP 精准复检）");
  console.error("  done <ID> --result \"通过/未过及证据\"");
  console.error("  done <ID> --result \"...\" --recite <条目ID> --event withdraw|rehang|observe --outcome pass|partial|fail --cold true|false --prompt clean|cued --evidence \"教材/复检锚点\" [--run SR-...] [--pattern code --diagnosis pending|confirmed --note 说明 --outbox 路径]（原子联动写带背证据、状态、排期与尝试分母；延迟通过用 observe）");
  process.exitCode = 2;
}
