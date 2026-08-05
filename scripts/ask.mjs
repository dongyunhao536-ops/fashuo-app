// PC 答疑卡点轴：普通提问不记；只有确认“跨会话仍未收口的真实理解卡点”才 add。
// node --env-file=.env.local scripts/ask.mjs list [--subject 刑法] [--all] [--json]
// node --env-file=.env.local scripts/ask.mjs add --subject 刑法 --confusion "..." [--type 案例 --step 3 --kp ... --question "..." --anchor "..."] [--stage]
// node --env-file=.env.local scripts/ask.mjs resolve <id> --action clarified|dismissed|superseded [--note "..."] [--stage]
// node --env-file=.env.local scripts/ask.mjs <pending|sync>
import { createClient } from "@supabase/supabase-js";
import { appendOutbox, readOutbox, syncStudyOutbox } from "./lib/study-outbox.mjs";
import { askPointLabel, summarizeAskPoints } from "./lib/ask-point-summary.mjs";

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OUTBOX = ".local/cuoti-pending.jsonl";
const SUBJECTS = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const ACTIONS = new Set(["clarified", "dismissed", "superseded"]);
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
  if (!pending.length) return console.log("outbox 为空，没有要同步的。");
  let report;
  try {
    report = await syncStudyOutbox({ db, path: OUTBOX, today });
  } catch (error) {
    return fail(`outbox 同步前检查/重写失败：${error instanceof Error ? error.message : String(error)}（原缓冲保留）`);
  }
  const count = (kind) => report.succeeded.filter(({ result }) => result.kind === kind).reduce((sum, { result }) => sum + result.affected, 0);
  console.log(`✅ 已确认同步：新增答疑卡点 ${count("ask_point")} 条、收口 ${count("resolve_ask_point")} 条；错题 ${count("new_error")} 条、错题归类 ${count("classify_error")} 条、冷复检 ${count("error_review")} 条、学习日志 ${count("study_log")} 条、长期记忆 ${count("coach_memory")} 条、错题销账 ${count("absorb")} 条。`);
  if (report.failed.length) {
    for (const { op, error } of report.failed) console.error(`   · ${op.operation_id} (${op.op})：${error}`);
    console.error(`⚠️ ${report.failed.length} 项失败，已保留在 outbox。`);
    process.exitCode = 1;
  } else {
    console.log("outbox 已清空；operation_id 保证重试不重复。");
  }
}

async function list(options) {
  let query = db.from("ask_point_v2").select("id, subject, kp_id, question_type, step_stuck, confusion, status, effective_status, active, ttl_until, source, created_at, updated_at, resolved_at, resolution_note").order("created_at", { ascending: false }).limit(5000);
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
  const op = appendOutbox(OUTBOX, {
    op: "ask_point",
    subject: options.subject,
    confusion: String(options.confusion).trim(),
    questionType: options.type && options.type !== true ? options.type : null,
    stepStuck: step,
    kpId: options.kp && options.kp !== true ? options.kp : null,
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
  if (!ACTIONS.has(options.action)) return fail("resolve 需要 --action clarified|dismissed|superseded");
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

function pending() {
  const operations = readOutbox(OUTBOX).filter((op) => op.op === "ask_point" || op.op === "resolve_ask_point");
  if (!operations.length) return console.log("没有待同步的答疑卡点操作。");
  for (const [index, op] of operations.entries()) {
    if (op.op === "ask_point") console.log(`${index + 1}. 新卡点 [${op.subject}] ${op.confusion}`);
    else console.log(`${index + 1}. 收口 A#${op.pointId} → ${op.action}`);
  }
}

const command = process.argv[2] ?? "list";
const options = flags(process.argv.slice(3));
if (command === "list") await list(options);
else if (command === "add") await add(options);
else if (command === "resolve") await resolve(options);
else if (command === "pending") pending();
else if (command === "sync") await sync();
else console.log("用法：node --env-file=.env.local scripts/ask.mjs <list|add|resolve|pending|sync> ...");
