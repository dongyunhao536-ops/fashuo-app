// node --env-file=.env.local scripts/coach.mjs ledger
// PC 端教练（coach-pc skill 专用）读【完整共享账本】——火力全开，不做 APP 那套成本截断。
// PC 是 APP 的升级版、独立系统、共享同一份 Supabase 账本（见记忆 pc-primary-two-systems）。
// 出题弹药检索复用 cuoti.mjs material；错题/销账复用 cuoti.mjs add/absorb；
// 进度/长期记忆先入同一 outbox，再立即幂等同步；失败项留待下一次自动重试。
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { appendOutbox, syncStudyOutbox } from "./lib/study-outbox.mjs";

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const cfg = JSON.parse(readFileSync("config/coach.json", "utf8"));
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"]; // 英语=公共课(2026-07-10 起)，账本同库、量化v3不计入
const ACTIVITIES = ["听课", "看书", "做题", "背诵", "带背", "复盘", "其他"]; // 看书=自学输入；带背=PC辅导带背(理解层，非云自背)
const DAY = 86400000;

// 写回共享账本走同一个可靠 outbox（cuoti.mjs sync 也可手动重试）
const PENDING = ".local/cuoti-pending.jsonl";
function stage(op) { return appendOutbox(PENDING, op); }
function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith("--")) ? args[++i] : true;
  return o;
}

async function flushOutbox() {
  let report;
  try {
    report = await syncStudyOutbox({ db, path: PENDING, today: ymd });
  } catch (error) {
    console.error(`✗ outbox 同步失败：${error instanceof Error ? error.message : String(error)}（原缓冲保留）`);
    process.exitCode = 1;
    return;
  }
  if (report.failed.length) {
    console.error(`⚠️ 已同步 ${report.succeeded.length} 项；${report.failed.length} 项失败并保留在 outbox：`);
    for (const { op, error } of report.failed) console.error(`   · ${op.operation_id} (${op.op})：${error}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ 已同步共享账本（${report.succeeded.length} 项），outbox 已清空。`);
  }
}

// 记录一条学习日志（进度汇报）：先入 outbox，再立即同步；--stage 才延后
async function log(args) {
  const f = parseFlags(args);
  if (!SUBJECTS.includes(f.subject)) return console.error("log 需要 --subject 刑法|民法|法理|宪法|法制史|英语（还可 --chapter --activity --accuracy --feeling --date --raw）");
  const op = {
    op: "study_log", subject: f.subject, chapter: f.chapter || null,
    activity: ACTIVITIES.includes(f.activity) ? f.activity : (f.activity ? "其他" : "其他"),
    accuracy: f.accuracy != null && f.accuracy !== true ? Number(f.accuracy) : null,
    feeling: f.feeling && f.feeling !== true ? f.feeling : null,
    raw: f.raw && f.raw !== true ? f.raw : null, date: (f.date && f.date !== true) ? f.date : ymd,
  };
  stage(op);
  console.log(`⏳ 已暂存待同步·学习日志：${op.date} ${op.subject}${op.chapter ? " " + op.chapter : ""} ${op.activity}${op.accuracy != null ? " " + op.accuracy + "%" : ""}${op.feeling ? "（" + op.feeling + "）" : ""}`);
  if (f.stage) return console.log("（已按 --stage 仅暂存；稍后用 cuoti.mjs sync 重试。）");
  await flushOutbox();
}
const today = new Date();
const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日（UTC+8）——别用 UTC，深夜零点后记录会归错天
const daysTo = (d) => Math.ceil((new Date(d).getTime() - today.getTime()) / DAY);

// —— 里程碑在轨体检（2026-07-22 云拍板）——
// 剩余天数跌破 150/120/100/60/30 时必须主动提醒 + 做一次「当下学情 × 剩余时间」的在轨体检。
// 到点未做 → 每次 ledger 都醒目告警，追到 config「里程碑.已完成」记上为止（别只提醒一次就飘过去）。
function milestoneLine(line) {
  const ms = cfg.里程碑;
  if (!ms?.关键点_天?.length) return;
  const left = Math.max(0, daysTo(cfg.考试日期));
  const done = new Set((ms.已完成 ?? []).map((x) => Number(x.关键点 ?? x)));
  const pts = [...ms.关键点_天].sort((a, b) => b - a);
  const due = pts.filter((p) => left <= p && !done.has(p));      // 已到点但没做体检的
  const next = pts.find((p) => left > p);                        // 下一个还没到的
  if (due.length) {
    line(`🚨 里程碑到点·欠一次【在轨体检】：${due.map((p) => p + "天").join("、")}（现剩 ${left} 天）`);
    line(`   → 本次会话必须做：当下学情 × 剩余时间 → 还在不在轨/偏多少/怎么补（SOP 见 coach-pc「里程碑在轨体检」），做完把关键点记进 config/coach.json「里程碑.已完成」`);
  } else if (next != null) {
    line(`里程碑：下一个 ${next} 天关口还有 ${left - next} 天（${new Date(new Date(cfg.考试日期).getTime() - next * DAY).toISOString().slice(0, 10)}）`);
  }
}

// 记录一条关于云的长期记忆（画像/倾向/里程碑/约定）→ outbox 后立即同步
// PC↔APP 共享：APP 教练的 prompt 读 coach_memory，PC 侧画像更新由此同步过去（2026-07-09 接线，堵"双系统画像不同步"的洞）
async function remember(args) {
  const f = parseFlags(args);
  if (!f.fact || f.fact === true) return console.error('remember 需要 --fact "关于云的一条事实"（可选 --category 画像|倾向|里程碑|约定，默认 画像）');
  const op = { op: "coach_memory", fact: f.fact, category: (f.category && f.category !== true) ? f.category : "画像" };
  stage(op);
  console.log(`⏳ 已暂存待同步·长期记忆：[${op.category}] ${op.fact}`);
  if (f.stage) return console.log("（已按 --stage 仅暂存；稍后用 cuoti.mjs sync 重试。）");
  await flushOutbox();
}

// 当前应在第几轮（按 轮次表 窗口 "2026-07~08" / "2026-12" 粗匹配当月）
function currentRound() {
  const ym = ymd.slice(0, 7);
  for (const [name, r] of Object.entries(cfg.轮次表)) {
    if (typeof r !== "object" || !r.窗口) continue;
    const m = String(r.窗口).match(/(\d{4})-(\d{2})(?:~(\d{2}))?/);
    if (!m) continue;
    const [, y, m1, m2] = m;
    const start = `${y}-${m1}`, end = `${y}-${m2 ?? m1}`;
    if (ym >= start && ym <= end) return `${name}（${r.窗口}·${r.范围}·${r.强度}）`;
  }
  return "（介于轮次之间，按最近窗口判断）";
}

async function ledger() {
  const [prog, recent, errs, ask, mem, msg] = await Promise.all([
    db.from("study_log").select("log_date, subject, chapter").not("chapter", "is", null).order("log_date", { ascending: false }).limit(400),
    db.from("study_log").select("log_date, subject, chapter, activity, accuracy, feeling, raw_input").order("id", { ascending: false }).limit(8),
    db.from("study_error").select("subject, kp_id, knowledge, log_date, status, absorbed_at").in("status", ["open", "absorbed"]).limit(2000),
    db.from("ask_summary").select("subject, confusion, created_at").eq("status", "open").not("confusion", "is", null).order("created_at", { ascending: false }).limit(30),
    db.from("coach_memory").select("fact, category, updated_at").order("updated_at", { ascending: false }).limit(200),
    db.from("coach_message").select("role, content").order("id", { ascending: false }).limit(20),
  ]);

  // 🔒 静默空账闸（2026-08-02 立·起因：当日月度评估首跑六张表全空、无任何报错，
  //    若照单下笔会得出"云什么都没学"的完全错误结论；二跑即正常＝网络抖动。
  //    Supabase 查询失败时 .data 为 null，原先被 `?? []` 吞掉 → 打印出一份全零账本。
  //    规矩：任一查询报错就中止，绝不输出半份账本。）
  const probes = { 进度: prog, 流水: recent, 错题: errs, 答疑: ask, 记忆: mem, 对话: msg };
  const broken = Object.entries(probes).filter(([, r]) => r.error);
  if (broken.length) {
    console.error("❌ 账本读取失败，已中止（不输出半份账本，防止据空账下结论）：");
    for (const [name, r] of broken) console.error(`   · ${name}：${r.error.message}`);
    console.error("→ 多为网络抖动，重跑一次即可；连续失败请查 .env.local 的 SUPABASE 配置。");
    process.exit(1);
  }

  const line = (s) => console.log(s);
  line("═══════════ PC 教练 · 完整账本（火力全开·无截断）═══════════");
  line(`今天 ${ymd}　距初试(${cfg.考试日期}) ${Math.max(0, daysTo(cfg.考试日期))} 天　距基础结业死线(${cfg.基础结业死线}) ${daysTo(cfg.基础结业死线) >= 0 ? daysTo(cfg.基础结业死线) + " 天" : "已过期 " + -daysTo(cfg.基础结业死线) + " 天"}${cfg.首次模拟 ? `　距首次模拟(${cfg.首次模拟}) ${daysTo(cfg.首次模拟)} 天·${cfg.红线?.["9月底模拟分下限"] ?? 320}分红线` : ""}`);
  line(`当前应在：${currentRound()}`);
  milestoneLine(line);

  // 已学进度（按科聚合全部章节，不设 6 章上限）
  const bySubj = {};
  for (const r of prog.data ?? []) {
    if (!SUBJECTS.includes(r.subject) || !r.chapter) continue;
    (bySubj[r.subject] ??= []); if (!bySubj[r.subject].includes(r.chapter)) bySubj[r.subject].push(r.chapter);
  }
  line("\n──── 已学进度（学习流水聚合章节，每科全量）────");
  for (const s of SUBJECTS) line(`${s}：${bySubj[s]?.length ? bySubj[s].join("、") : "（尚未铺开）"}`);

  line("\n──── 最近学习流水（近 8 条）────");
  for (const r of recent.data ?? [])
    line(`· ${[r.log_date, r.subject, r.chapter, r.activity, r.accuracy != null ? r.accuracy + "%" : "", r.feeling].filter(Boolean).join(" ")}${r.raw_input ? `（原话：${String(r.raw_input).slice(0, 40)}）` : ""}`);
  if (!(recent.data ?? []).length) line("（暂无）");

  // 错题本 = 弱项（全生命周期聚合：累计错次×新近，🔁复发）
  const agg = new Map();
  for (const r of errs.data ?? []) {
    const key = r.kp_id ?? `${r.subject ?? "未分类"}::${r.knowledge}`;
    const cur = agg.get(key) ?? { label: `${r.subject ?? "未分类"}·${r.knowledge}`, nOpen: 0, nAbs: 0, last: "" };
    if (r.status === "absorbed") cur.nAbs++;
    else { cur.nOpen++; const d = String(r.log_date ?? ""); if (d > cur.last) cur.last = d; }
    agg.set(key, cur);
  }
  const openErrs = [...agg.values()].filter((e) => e.nOpen > 0).sort((a, b) => b.nOpen + b.nAbs - (a.nOpen + a.nAbs) || (a.last < b.last ? 1 : -1));
  const absorbedCount = [...agg.values()].filter((e) => e.nOpen === 0 && e.nAbs > 0).length;
  line(`\n──── 错题本（=弱项·唯一事实源；open ${openErrs.length} 类 / 已销账 ${absorbedCount} 类；🔁=复发=病根优先）────`);
  for (const e of openErrs) {
    const n = e.nOpen + e.nAbs;
    line(`· ${e.label}${n > 1 ? " ×" + n : ""}${e.nAbs > 0 ? " 🔁曾吸收又错" : ""}${n >= (cfg.红线?.同弱项错次转专题 ?? 3) ? " 🔺转专题" : ""}（最近 ${e.last || "?"}）`);
  }
  if (!openErrs.length) line("（错题本 open 为空——用 cuoti.mjs recheck 抽老题）");

  line("\n──── 答疑最近卡点（ask_summary open·互通只读）────");
  for (const r of ask.data ?? []) line(`· ${r.subject ?? "未分类"}·${String(r.confusion).slice(0, 70)}（${r.created_at ? String(r.created_at).slice(0, 10) : "?"}）`);
  if (!(ask.data ?? []).length) line("（无）");

  line("\n──── 关于云·长期记忆（coach_memory 全量）────");
  for (const m of mem.data ?? []) line(`- ${m.category ? `[${m.category}] ` : ""}${m.fact}`);
  if (!(mem.data ?? []).length) line("（暂无）");

  line("\n──── 近 20 条教练对话（跨会话连续性；PC 会话内我本就记得，主要给新会话续上下文）────");
  for (const m of (msg.data ?? []).slice().reverse()) line(`${m.role === "user" ? "云" : "教练"}：${String(m.content).slice(0, 200)}`);
  if (!(msg.data ?? []).length) line("（暂无历史）");

  line("\n──── 节奏参考（config/coach.json）────");
  line("轮次：" + Object.entries(cfg.轮次表).filter(([, r]) => typeof r === "object" && r.窗口).map(([n, r]) => `${n}(${r.窗口})`).join(" / "));
  line("双轨：" + Object.entries(cfg.双轨节奏).filter(([k, v]) => !k.startsWith("_") && typeof v === "string").map(([k, v]) => `${k} ${v}`).join("；"));
  line(`红线：周投入下限 ${cfg.红线?.周投入下限_小时}h·连续低投入 ${cfg.红线?.连续低投入周阈值_周} 周预警·9月底模拟分下限 ${cfg.红线?.["9月底模拟分下限"]}`);
}

const cmd = process.argv[2];
if (cmd === "ledger") await ledger();
else if (cmd === "log") await log(process.argv.slice(3));
else if (cmd === "remember") await remember(process.argv.slice(3));
else {
  console.log("用法：node --env-file=.env.local scripts/coach.mjs <ledger|log|remember>");
  console.log("  ledger                                     读完整共享账本");
  console.log('  log --subject 刑法 --activity 复盘 --chapter "..." [--accuracy N --feeling "..." --date YYYY-MM-DD]  记录学习日志');
  console.log('  remember --fact "..." [--category 画像|倾向|里程碑|约定]  记录长期记忆 → coach_memory');
  console.log("（写操作默认立即同步；显式 --stage 才延后，cuoti.mjs sync 可重试 outbox）");
}
