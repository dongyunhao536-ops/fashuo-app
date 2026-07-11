// node --env-file=.env.local scripts/coach.mjs ledger
// PC 端教练（coach-pc skill 专用）读【完整共享账本】——火力全开，不做 APP 那套成本截断。
// PC 是 APP 的升级版、独立系统、共享同一份 Supabase 账本（见记忆 pc-primary-two-systems）。
// 只读。出题弹药检索复用 cuoti.mjs material；错题/销账复用 cuoti.mjs add/absorb；
// 进度/长期记忆的写回下一步接（走同一 stage→sync 缓冲）。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const cfg = JSON.parse(readFileSync("config/coach.json", "utf8"));
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"]; // 英语=公共课(2026-07-10 起)，账本同库、量化v3不计入
const ACTIVITIES = ["听课", "做题", "背诵", "带背", "复盘", "其他"]; // 带背=PC辅导带背(理解层，非云自背)；今日页逐字渲染 activity 即可与"背诵"区分
const DAY = 86400000;

// 写回共享账本走同一个 stage→sync 缓冲（cuoti.mjs sync 统一落库）
const PENDING = ".local/cuoti-pending.jsonl";
function stage(op) { mkdirSync(dirname(PENDING), { recursive: true }); appendFileSync(PENDING, JSON.stringify({ ...op, ts: new Date().toISOString() }) + "\n"); }
function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith("--")) ? args[++i] : true;
  return o;
}

// 暂存一条学习日志（进度汇报）→ 云说"同步"由 cuoti.mjs sync 落库到共享账本
function log(args) {
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
  console.log(`（未落库，云说"同步"再 sync；用 cuoti.mjs pending 查、sync 落库）`);
}
const today = new Date();
const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日（UTC+8）——别用 UTC，深夜零点后记录会归错天
const daysTo = (d) => Math.ceil((new Date(d).getTime() - today.getTime()) / DAY);

// 暂存一条关于云的长期记忆（画像/倾向/里程碑/约定）→ cuoti.mjs sync 落库到 coach_memory
// PC↔APP 共享：APP 教练的 prompt 读 coach_memory，PC 侧画像更新由此同步过去（2026-07-09 接线，堵"双系统画像不同步"的洞）
function remember(args) {
  const f = parseFlags(args);
  if (!f.fact || f.fact === true) return console.error('remember 需要 --fact "关于云的一条事实"（可选 --category 画像|倾向|里程碑|约定，默认 画像）');
  const op = { op: "coach_memory", fact: f.fact, category: (f.category && f.category !== true) ? f.category : "画像" };
  stage(op);
  console.log(`⏳ 已暂存待同步·长期记忆：[${op.category}] ${op.fact}`);
  console.log(`（cuoti.mjs sync 落库后 APP 教练即读到）`);
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

  const line = (s) => console.log(s);
  line("═══════════ PC 教练 · 完整账本（火力全开·无截断）═══════════");
  line(`今天 ${ymd}　距初试(${cfg.考试日期}) ${Math.max(0, daysTo(cfg.考试日期))} 天　距基础结业死线(${cfg.基础结业死线}) ${daysTo(cfg.基础结业死线) >= 0 ? daysTo(cfg.基础结业死线) + " 天" : "已过期 " + -daysTo(cfg.基础结业死线) + " 天"}`);
  line(`当前应在：${currentRound()}`);

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
else if (cmd === "log") log(process.argv.slice(3));
else if (cmd === "remember") remember(process.argv.slice(3));
else {
  console.log("用法：node --env-file=.env.local scripts/coach.mjs <ledger|log|remember>");
  console.log("  ledger                                     读完整共享账本");
  console.log('  log --subject 刑法 --activity 复盘 --chapter "..." [--accuracy N --feeling "..." --date YYYY-MM-DD]  暂存学习日志（云说"同步"落库）');
  console.log('  remember --fact "..." [--category 画像|倾向|里程碑|约定]  暂存长期记忆 → coach_memory（APP 教练可读）');
  console.log("（检索用 cuoti.mjs material；错题/销账用 cuoti.mjs add/absorb；统一 cuoti.mjs sync 落库）");
}
