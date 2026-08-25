// PC 答疑卡点轴：普通提问不记；只有确认“跨会话仍未收口的真实理解卡点”才 add。
// node --env-file=.env.local scripts/ask.mjs list [--subject 刑法] [--all] [--json]
// node --env-file=.env.local scripts/ask.mjs add --subject 刑法 --confusion "..." [--type 案例 --step 3 --kp XF-0001 --evidence partial|fail --question "..." --anchor "..."] [--stage]
// node --env-file=.env.local scripts/ask.mjs verify <id> <pass|partial|fail|void> [--kp XF-0001 --anchor "..." --note "..."] [--cold --cued|--invalid-prompt --schedule ID]
// node --env-file=.env.local scripts/ask.mjs resolve <id> --action dismissed|superseded [--note "..."] [--stage]
// node --env-file=.env.local scripts/ask.mjs <pending|sync>
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertScheduleLink, closeScheduleItem } from "./lib/schedule-store.mjs";
import { appendOutbox, readOutbox, syncStudyOutbox } from "./lib/study-outbox.mjs";
import { askPointLabel, summarizeAskPoints } from "./lib/ask-point-summary.mjs";
import { assertSkillRunPrerequisites, readSkillRun, recordAutomaticSkillStep, recordBusinessWriteback } from "./lib/skill-run.mjs";
import { parseMaterialEvidenceRef } from "./cuoti.mjs";
import {
  AskPreflightError,
  assertPreflightSignable,
  buildPreflightChecklist,
  describeVerdict,
  formatPreflightEvidenceRef,
} from "./lib/ask-preflight.mjs";
import { AskEvidenceCardError, renderAskEvidenceCard, validateAskEvidenceCard } from "./lib/ask-evidence-card.mjs";

let database = null;
function db() {
  if (database) return database;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  // [gpt] 2026-08-10：延迟建客户端，让纯本地 --stage 与参数预检不依赖远端密钥。
  database = createClient(url, key, { auth: { persistSession: false } });
  return database;
}
const OUTBOX = ".local/cuoti-pending.jsonl";
const SUBJECTS = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const ACTIONS = new Set(["clarified", "dismissed", "superseded"]);
const VERIFY_RESULTS = new Set(["pass", "partial", "fail", "void"]);
const INITIAL_EVIDENCE = new Set(["partial", "fail"]);
const KP_ID = /^[A-Z]{2,4}-\d{4}$/;
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function flags(args) {
  const out = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    out[arg.slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

async function sync() {
  const pending = readOutbox(OUTBOX);
  if (!pending.length) {
    console.log("outbox 为空，没有要同步的。");
    return { total: 0, succeeded: [], failed: [] };
  }
  let report;
  try {
    report = await syncStudyOutbox({ db: db(), path: OUTBOX, today });
  } catch (error) {
    fail(`outbox 同步前检查/重写失败：${error instanceof Error ? error.message : String(error)}（原缓冲保留）`);
    return null;
  }
  const count = (kind) => report.succeeded.filter(({ result }) => result.kind === kind).reduce((sum, { result }) => sum + result.affected, 0);
  console.log(`✅ 已确认同步：新增答疑卡点 ${count("ask_point")} 条、验证 ${count("ask_verification")} 条、管理收口 ${count("resolve_ask_point")} 条；错题 ${count("new_error")} 条、错题归类 ${count("classify_error")} 条、冷复检 ${count("error_review")} 条、学习日志 ${count("study_log")} 条、长期记忆 ${count("coach_memory")} 条、错题销账 ${count("absorb")} 条。`);
  if (report.failed.length) {
    for (const { op, error } of report.failed) console.error(`   · ${op.operation_id} (${op.op})：${error}`);
    console.error(`⚠️ ${report.failed.length} 项失败，已保留在 outbox。`);
    process.exitCode = 1;
  } else {
    console.log("outbox 已清空；operation_id 保证重试不重复。");
  }
  return report;
}

async function list(options) {
  let query = db().from("ask_point_v2").select("id, subject, kp_id, question_type, step_stuck, confusion, status, effective_status, active, ttl_until, source, created_at, updated_at, resolved_at, resolution_note").order("created_at", { ascending: false }).limit(5000);
  if (options.subject && options.subject !== true) query = query.eq("subject", options.subject);
  if (!options.all) query = query.eq("active", true);
  const response = await query;
  if (response.error) return fail(`答疑卡点读取失败：${response.error.message}`);
  const summary = summarizeAskPoints(response.data ?? [], { referenceDate: today });
  if (options.json) return console.log(JSON.stringify(summary, null, 2));
  console.log(options.all
    ? `答疑卡点全量：有效 open ${summary.counts.open} / expired ${summary.counts.expired} / clarified ${summary.counts.clarified} / dismissed ${summary.counts.dismissed} / superseded ${summary.counts.superseded}`
    : `答疑卡点：当前有效 open ${summary.activePoints.length}`);
  const points = options.all ? summary.points : summary.activePoints;
  if (!points.length) return console.log(options.all ? "（无记录）" : "（当前没有有效未收口卡点）");
  for (const point of points) console.log(`· ${askPointLabel(point)}｜${point.questionType ?? "未标题型"}｜${String(point.createdAt ?? "").slice(0, 10)}｜${point.effectiveStatus}${point.ttlUntil ? `｜TTL ${point.ttlUntil}` : ""}`);
}

async function add(options) {
  if (!SUBJECTS.has(options.subject)) return fail("add 需要 --subject 刑法|民法|法理|宪法|法制史");
  if (!options.confusion || options.confusion === true) return fail('add 需要 --confusion "仍未打通的具体混淆点"');
  const step = options.step && options.step !== true ? Number(options.step) : null;
  if (step != null && (!Number.isInteger(step) || step < 1)) return fail("--step 必须是正整数");
  const ttlDays = options.ttl && options.ttl !== true ? Number(options.ttl) : 90;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) return fail("--ttl 必须是 1~365 的整数天");
  const kpId = options.kp && options.kp !== true ? String(options.kp).trim().toUpperCase() : null;
  if (kpId && !KP_ID.test(kpId)) return fail("--kp 必须是合法 KP-ID（如 XF-0054）");
  const initialUnderstanding = options.evidence && options.evidence !== true ? String(options.evidence) : "partial";
  if (kpId && !INITIAL_EVIDENCE.has(initialUnderstanding)) return fail("add 的 --evidence 只能是 partial 或 fail；通过必须走 verify");
  if (!kpId && options.evidence) return fail("--evidence 需要同时提供 --kp");
  const op = appendOutbox(OUTBOX, {
    op: "ask_point",
    subject: options.subject,
    confusion: String(options.confusion).trim(),
    questionType: options.type && options.type !== true ? options.type : null,
    stepStuck: step,
    kpId,
    initialUnderstanding: kpId ? initialUnderstanding : null,
    rawQuestion: options.question && options.question !== true ? options.question : null,
    evidenceAnchor: options.anchor && options.anchor !== true ? options.anchor : null,
    date: options.date && options.date !== true ? options.date : today,
    ttlDays,
  });
  console.log(`⏳ 已暂存答疑卡点：[${op.subject}] ${op.confusion}`);
  if (options.stage) return console.log("（已按 --stage 仅暂存；稍后运行 ask.mjs sync 或 cuoti.mjs sync。）");
  await sync();
}

async function resolve(options) {
  const id = Number(options._[0]);
  if (!Number.isInteger(id) || id <= 0) return fail("resolve 需要合法卡点 id");
  if (!ACTIONS.has(options.action)) return fail("resolve 需要 --action dismissed|superseded（clarified 请走 verify）");
  if (options.action === "clarified") return fail("clarified 不能直接管理收口；请用 verify 写入 understanding 证据后自动销疑");
  appendOutbox(OUTBOX, {
    op: "resolve_ask_point",
    pointId: id,
    action: options.action,
    note: options.note && options.note !== true ? options.note : null,
  });
  console.log(`⏳ 已暂存答疑卡点 A#${id} → ${options.action}`);
  if (options.stage) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync();
}

async function askPointKp(pointId) {
  const response = await db().from("ask_point_v2").select("id, kp_id, status, effective_status").eq("id", pointId).maybeSingle();
  if (response.error) throw new Error(`读取答疑卡点失败：${response.error.message}`);
  if (!response.data) throw new Error(`答疑卡点 A#${pointId} 不存在`);
  if (!response.data.kp_id) throw new Error(`答疑卡点 A#${pointId} 尚未关联知识点；请显式提供 --kp KP-ID`);
  return String(response.data.kp_id).trim().toUpperCase();
}

async function verify(options) {
  const id = Number(options._[0]);
  const result = String(options._[1] ?? "");
  if (!Number.isInteger(id) || id <= 0) return fail("verify 需要合法卡点 id");
  if (!VERIFY_RESULTS.has(result)) return fail("verify 结果只能是 pass|partial|fail|void");
  if (options.run && options.run !== true) {
    try {
      assertSkillRunPrerequisites({ runId: String(options.run), expectedSkill: "ask-pc", steps: ["materials_checked", "question_integrity_pass"] });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  const promptFlags = [options.cued ? "cued" : null, options["invalid-prompt"] ? "invalid" : null].filter(Boolean);
  if (promptFlags.length > 1) return fail("--cued 与 --invalid-prompt 不能同时使用");
  const promptIntegrity = promptFlags[0] ?? "clean";
  if (promptIntegrity === "invalid" && result !== "void") return fail("--invalid-prompt 必须配合 void");
  if (result === "void" && promptIntegrity !== "invalid") return fail("void 必须配合 --invalid-prompt");
  const evidenceAnchor = options.anchor && options.anchor !== true ? String(options.anchor).trim() : "";
  const noteInput = options.note && options.note !== true ? String(options.note).trim() : "";
  // [gpt] 2026-08-12：答疑检验的污染题同样只归责教练，审计语义不能靠调用者手填。
  const note = result === "void"
    ? ["responsibility=teacher", "valid_attempt=false", "user_error=false", "cooldown_advanced=false", noteInput].filter(Boolean).join("；")
    : noteInput;
  if (!evidenceAnchor) return fail('verify 需要 --anchor "检验题/教材锚点"');
  if (!note) return fail('verify 需要 --note "作答表现与判定理由"');
  let kpId = options.kp && options.kp !== true ? String(options.kp).trim().toUpperCase() : null;
  if (!kpId) {
    try {
      kpId = await askPointKp(id);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (!KP_ID.test(kpId)) return fail("--kp 必须是合法 KP-ID（如 XF-0054）");
  const date = options.date && options.date !== true ? String(options.date) : today;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) return fail("--date 必须是 YYYY-MM-DD");
  const scheduleId = options.schedule && options.schedule !== true ? String(options.schedule) : null;
  const scheduleFile = options["schedule-file"] && options["schedule-file"] !== true ? String(options["schedule-file"]) : ".local/复盘排期.md";
  if (options.stage && scheduleId) return fail("--stage 不能与 --schedule 同用；排期联动需要本次同步后立即结案");
  if (scheduleId) {
    if (!existsSync(scheduleFile)) return fail(`排期文件不存在：${scheduleFile}`);
    try {
      assertScheduleLink(readFileSync(scheduleFile, "utf8"), scheduleId, {
        kind: "knowledge", targetId: kpId, referenceDate: date, route: "ask-pc", dimension: "understanding",
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  // [gpt] 2026-08-10：验证结果由复合 outbox 保证“先证据、后销疑”；cued pass 只留证据不收口。
  const op = appendOutbox(OUTBOX, {
    op: "ask_verification",
    pointId: id,
    kpId,
    date,
    result,
    cold: Boolean(options.cold),
    promptIntegrity,
    evidenceAnchor,
    note,
  });
  console.log(`⏳ 已暂存答疑验证：A#${id} → ${kpId} understanding/${result}${promptIntegrity === "clean" ? "" : `｜${promptIntegrity}`}`);
  if (result === "void") console.log("↩ 本次只留教练题面事故审计：不计有效题量、不记用户错误、不推进冷却，原排期保持 open。");
  if (options.stage) return console.log("（已按 --stage 仅暂存；稍后运行 ask.mjs sync。）");
  const report = await sync();
  const succeeded = report?.succeeded.find(({ op: item }) => item.operation_id === op.operation_id);
  if (!succeeded) return;
  if (scheduleId) {
    const markdown = readFileSync(scheduleFile, "utf8");
    assertScheduleLink(markdown, scheduleId, {
      kind: "knowledge", targetId: kpId, referenceDate: date, route: "ask-pc", dimension: "understanding",
    });
    const closure = closeScheduleItem(markdown, scheduleId, {
      date,
      result: `understanding/${result}${promptIntegrity === "clean" ? "" : `｜${promptIntegrity}`}`,
      // [gpt] 2026-08-10：结构化保存干预响应条件，提示后通过不再混入 clean pass。
      outcome: result,
      cold: Boolean(options.cold),
      promptIntegrity,
    });
    if (typeof closure === "string") {
      writeFileSync(scheduleFile, closure, "utf8");
      console.log(`✅ 已结案答疑检验排期：${scheduleId}`);
    } else {
      console.log(`↩ 作废题只归责教练；排期 ${scheduleId} 保持 open，重写并重新过命题 Gate 后再执行。`);
    }
  }
  console.log(succeeded.result.clarified
    ? `✅ A#${id} 已有 clean pass 理解证据，状态已收口为 clarified。`
    : `↩ A#${id} 已记理解证据但继续保持 open；下一轮仍需无提示通过。`);
  if (options.run && options.run !== true) {
    recordBusinessWriteback({
      runId: String(options.run),
      source: "ask-verify",
      evidenceRef: `A#${id}:${result}`,
      expectedSkill: "ask-pc",
      requiredSteps: ["materials_checked", "question_integrity_pass"],
    });
  }
}

// [claude] 2026-08-25：六步预检从"执行者填表"改为"从检索回执推导"。
// 第 2/4/5 项一律读 materials_checked 里各类材料的真实命中数，执行者只能提供
// 第 1 项归类与第 6 项法律更新；判权算完才签 preflight_checked，零实锤直接拒签。
function preflight(options) {
  const runId = options.run;
  if (!runId || runId === true) {
    console.error("preflight 必须提供 --run SR-...；预检的全部证据都来自该 Run 的检索回执");
    process.exit(2);
  }
  let run;
  try {
    run = readSkillRun(runId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (run.skill !== "ask-pc") {
    console.error(`Skill Run 路由不一致：预期 ask-pc，实际 ${run.skill}`);
    process.exit(2);
  }
  const materials = run.steps?.materials_checked;
  if (materials?.status !== "pass") {
    console.error(
      "ASK_PREFLIGHT_BLOCK｜本 Run 还没有 materials_checked 回执，无从推导预检。\n"
      + "补救：先运行 node --env-file=.env.local scripts/cuoti.mjs material-batch --query <争点特征词> ... --run "
      + runId,
    );
    process.exit(2);
  }
  const hits = parseMaterialEvidenceRef(materials.evidenceRef);
  let built;
  try {
    built = buildPreflightChecklist({
      category: options.category,
      hits,
      queries: hits.queries,
      updated: options.updated === true ? null : options.updated,
    });
    assertPreflightSignable(built, { discussionOnly: options["discussion-only"] === true });
  } catch (error) {
    if (error instanceof AskPreflightError) {
      console.error(`${error.code}｜${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  recordAutomaticSkillStep({
    runId,
    step: "preflight_checked",
    status: "pass",
    source: "ask-preflight",
    evidenceRef: formatPreflightEvidenceRef(built),
    expectedSkill: "ask-pc",
  });
  console.log(`ASK_PREFLIGHT_PASS｜${built.verdict}`);
  console.log(built.checklist);
  if (built.verdict !== "normal") console.error(`⚠️ ${describeVerdict(built.verdict)}`);
}

// 证据卡：出处四件套缺一即 BLOCK，杜绝"只报行号"。
function card(options) {
  if (!options.file || options.file === true) {
    console.error("card 必须提供 --file <证据卡.json>");
    process.exit(2);
  }
  let validated;
  try {
    validated = validateAskEvidenceCard(JSON.parse(readFileSync(options.file, "utf8")));
  } catch (error) {
    if (error instanceof AskEvidenceCardError) {
      console.error(`ASK_EVIDENCE_CARD_BLOCK｜${error.issues.length} 项`);
      for (const item of error.issues) console.error(`- ${item.code} [${item.field}] ${item.message}`);
      process.exit(2);
    }
    throw error;
  }
  console.log("ASK_EVIDENCE_CARD_PASS");
  console.log(renderAskEvidenceCard(validated));
}

function pending() {
  const operations = readOutbox(OUTBOX).filter((op) => ["ask_point", "ask_verification", "resolve_ask_point"].includes(op.op));
  if (!operations.length) return console.log("没有待同步的答疑卡点操作。");
  for (const [index, op] of operations.entries()) {
    if (op.op === "ask_point") console.log(`${index + 1}. 新卡点 [${op.subject}] ${op.confusion}`);
    else if (op.op === "ask_verification") console.log(`${index + 1}. 验证 A#${op.pointId} → ${op.kpId} understanding/${op.result}`);
    else console.log(`${index + 1}. 管理收口 A#${op.pointId} → ${op.action}`);
  }
}

const command = process.argv[2] ?? "list";
const options = flags(process.argv.slice(3));
if (command === "list") await list(options);
else if (command === "add") await add(options);
else if (command === "verify") await verify(options);
else if (command === "resolve") await resolve(options);
else if (command === "preflight") preflight(options);
else if (command === "card") card(options);
else if (command === "pending") pending();
else if (command === "sync") await sync();
else {
  console.log("用法：node --env-file=.env.local scripts/ask.mjs <list|add|verify|resolve|preflight|card|pending|sync> ...");
  console.log("  preflight --run SR-... --category <科目/章节/题型> [--updated <法律更新说明>] [--discussion-only]");
  console.log("  card --file <证据卡.json>");
}
