// node --env-file=.env.local scripts/daily.mjs data [--date YYYY-MM-DD]
// node --env-file=.env.local scripts/daily.mjs save --file <日报.md> [--date YYYY-MM-DD]
// PC 端日报（ribao-pc skill 专用 · 每天北京 17:20 定时跑）：
//   data  = 拉当日事实源（昨日全天结算面 + 今日截至此刻 + 断档链 + 欠账池 + 周报分档 + 昨日派单）
//   save  = 落 .local/日报/YYYY-MM-DD.md，并把摘要块 upsert 进 .local/日报台账.md（周报/评估读它拿日粒度）
// 生态链：周报(周标准) → 日报(当日执行层·不另立标准) → 日报台账 → 周报/月度评估/里程碑体检 逐级回读。
// 铁律：零编造；库里没有 = 【没记录】，不等于没做，措辞必须分开（见 skill）。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const db = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const cfg = JSON.parse(readFileSync("config/coach.json", "utf8"));
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"];
const DEEP = new Set(["复盘", "带背"]); // 深度动作（对齐周报「深度动作占比」口径；成段输出无 activity 枚举，靠 feeling 人工判）
const LEDGER = ".local/日报台账.md";
const DIR = ".local/日报";

// —— 北京日历（本机 UTC-7，绝不能用本地日期）——
const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const shift = (ymd, n) => new Date(new Date(ymd + "T00:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);
const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
const dow = (ymd) => "日一二三四五六"[new Date(ymd + "T00:00:00Z").getUTCDay()];
const dayStart = (ymd) => new Date(ymd + "T00:00:00+08:00").toISOString();
const daysTo = (d) => Math.ceil((new Date(d).getTime() - Date.now()) / DAY);
// knowledge/feeling 在本库里是长文（整段讲解），日报只要标题级信息——一律截断，
// 否则 data 输出能冲到 30KB 把定时任务的上下文吃光（2026-07-28 首跑实测）。要全文去 cuoti.mjs list / study_log。
const cut = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
function parseFlags(args) { const o = {}; for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith("--")) ? args[++i] : true; return o; }

// —— 日报台账读写（一日一块，重跑同日覆盖不追加）——
function readLedger() {
  if (!existsSync(LEDGER)) return { header: "", blocks: [] };
  const raw = readFileSync(LEDGER, "utf8");
  const at = []; const re = /^## (\d{4}-\d{2}-\d{2})/gm; let m;
  while ((m = re.exec(raw))) at.push({ date: m[1], start: m.index });
  const header = at.length ? raw.slice(0, at[0].start) : raw;
  const blocks = at.map((it, i) => ({ date: it.date, text: raw.slice(it.start, i + 1 < at.length ? at[i + 1].start : raw.length).trimEnd() }));
  return { header, blocks };
}

const LEDGER_HEADER = `# 日报台账（日粒度执行账 · 周报/月度评估/里程碑体检读它）

> **定位（2026-07-28 云拍板建）**：每天北京 17:20 由定时任务 ribao-pc 追加一块。它记的是账本里**记不到的那一半**——「今天本该做什么」以及「昨天派的单落没落」。Supabase 只存"做了什么"，永远答不了"该做没做"，这本补的就是这个洞。
> 1. **日报不另立标准**：派单只能派生自当周周报的 P0/P1（[[weekly-as-week-standard]]）、\`.local/复盘排期.md\` 到期项、\`.local/带背挂账.md\` 最老条目。日报是执行层，不是第二个规划源。
> 2. **一日一块、重跑覆盖**：\`daily.mjs save\` 按日期 upsert，同日重跑改写不追加。
> 3. **结算写昨天、派单写今晚**：17:20 跑时今天还没过完——【昨日结算】才是完整的一天，【今日流水】只是半天切面，别拿它判勤惰。
> 4. **零编造 + 「没记录 ≠ 没做」**：库里为空只能写"无流水记录"，不许写成"没学"；连续多日空记录本身当发现报出来。
> 5. **上游怎么读它**：周报读近 7 块拿派单执行率与断档链；月度评估读全量拿日粒度投入趋势；里程碑体检拿处方到日的落地证据。别只读周报就下结论。
`;

function writeLedger(date, block) {
  const { header, blocks } = readLedger();
  const kept = blocks.filter((b) => b.date !== date);
  kept.push({ date, text: block });
  kept.sort((a, b) => (a.date < b.date ? -1 : 1));
  mkdirSync(".local", { recursive: true });
  writeFileSync(LEDGER, (header.trim() ? header.trimEnd() : LEDGER_HEADER.trimEnd()) + "\n\n" + kept.map((b) => b.text).join("\n\n") + "\n");
}

// —— 里程碑（与 coach.mjs ledger 同一口径）——
function milestone() {
  const ms = cfg.里程碑; if (!ms?.关键点_天?.length) return null;
  const left = Math.max(0, daysTo(cfg.考试日期));
  const done = new Set((ms.已完成 ?? []).map((x) => Number(x.关键点 ?? x)));
  const pts = [...ms.关键点_天].sort((a, b) => b - a);
  const due = pts.filter((p) => left <= p && !done.has(p));
  const next = pts.find((p) => left > p);
  if (due.length) return `🚨 里程碑到点·欠一次【在轨体检】：${due.map((p) => p + "天").join("、")}（现剩 ${left} 天）—— 今日必须在日报里点名，追到做完为止`;
  return next != null ? `下一个 ${next} 天关口还有 ${left - next} 天（${shift(cfg.考试日期, -next)}）` : null;
}

// —— 周报分档（派单唯一来源）——
function weeklyBuckets() {
  const f = ".local/weekly-draft.md";
  if (!existsSync(f)) return null;
  const md = readFileSync(f, "utf8");
  const sec = md.split(/^##\s*🎯?\s*下周指导/m)[1] ?? md;
  const lines = sec.split("\n").filter((l) => /\bP[012]\b/.test(l)).map((l) => l.trim()).slice(0, 12);
  return lines.length ? lines : null;
}

// —— 两本欠账台账的规模（细节让 skill 去 Read 原文，这里只给体量）——
function guazhangScale() {
  const f = ".local/带背挂账.md";
  if (!existsSync(f)) return "（无台账文件）";
  const m = readFileSync(f, "utf8").match(/^##\s*挂账中[^\n]*/m);
  return m ? m[0].replace(/^##\s*/, "").slice(0, 120) : "（未找到「挂账中」小节）";
}

async function collect(date) {
  const yday = shift(date, -1);
  const from14 = shift(date, -13);
  const [todayLog, ydayLog, heat, ydayErrNew, ydayErrAbs, todayErrNew, todayErrAbs, openErr, lastBySubj, allAct] = await Promise.all([
    db.from("study_log").select("subject, chapter, activity, accuracy, feeling, raw_input").eq("log_date", date),
    db.from("study_log").select("subject, chapter, activity, accuracy, feeling, raw_input").eq("log_date", yday),
    db.from("study_log").select("log_date, subject, activity").gte("log_date", from14).lte("log_date", date),
    db.from("study_error").select("subject, knowledge").eq("log_date", yday),
    db.from("study_error").select("subject, knowledge").eq("status", "absorbed").gte("absorbed_at", dayStart(yday)).lt("absorbed_at", dayStart(date)),
    db.from("study_error").select("subject, knowledge").eq("log_date", date),
    db.from("study_error").select("subject, knowledge").eq("status", "absorbed").gte("absorbed_at", dayStart(date)).lt("absorbed_at", dayStart(shift(date, 1))),
    db.from("study_error").select("subject, kp_id, knowledge, log_date, status").in("status", ["open", "absorbed"]).limit(2000),
    Promise.all(SUBJECTS.map((s) => db.from("study_log").select("log_date, activity").eq("subject", s).order("log_date", { ascending: false }).limit(1).then((r) => [s, r.data?.[0] ?? null]))),
    db.from("study_log").select("log_date, activity").order("log_date", { ascending: false }).limit(600),
  ]);

  // 轨道断档：按 activity 看各条轨最后一次（"带背轨断了 6 天"这种信号，只看"每天有没有流水"看不出来
  // ——周报 P1 常点名某条轨，日报得答得上它断没断。2026-07-28 首跑就逮到带背断 6 天）
  const trackLast = {};
  for (const row of allAct.data ?? []) if (row.activity && !(row.activity in trackLast)) trackLast[row.activity] = String(row.log_date);

  // 错题本 open 聚合（同 coach.mjs：累计错次×新近，🔁=曾吸收又错）
  const agg = new Map();
  for (const r of openErr.data ?? []) {
    if (!r.knowledge) continue;
    const key = r.kp_id ?? `${r.subject ?? "未分类"}::${r.knowledge}`;
    const cur = agg.get(key) ?? { label: `${r.subject ?? "未分类"}·${cut(r.knowledge, 40)}`, nOpen: 0, nAbs: 0, last: "" };
    if (r.status === "absorbed") cur.nAbs++; else { cur.nOpen++; const d = String(r.log_date ?? ""); if (d > cur.last) cur.last = d; }
    agg.set(key, cur);
  }
  const open = [...agg.values()].filter((e) => e.nOpen > 0);

  // 近 14 天热力 + 连续零流水链
  const byDate = new Map();
  for (const r of heat.data ?? []) byDate.set(String(r.log_date), (byDate.get(String(r.log_date)) ?? 0) + 1);
  const days = []; for (let i = 13; i >= 0; i--) { const d = shift(date, -i); days.push({ d, n: byDate.get(d) ?? 0 }); }
  let gap = 0; for (let i = days.length - 2; i >= 0; i--) { if (days[i].n === 0) gap++; else break; } // 从昨天往回数（今天没过完不算）

  return { date, yday, todayLog: todayLog.data ?? [], ydayLog: ydayLog.data ?? [], days, gap, trackLast,
    ydayErrNew: ydayErrNew.data ?? [], ydayErrAbs: ydayErrAbs.data ?? [], todayErrNew: todayErrNew.data ?? [], todayErrAbs: todayErrAbs.data ?? [],
    open, lastBySubj: Object.fromEntries(lastBySubj) };
}

function fmtLog(rows) {
  if (!rows.length) return ["  （无流水记录 —— 注意：这是「没记录」，不等于「没做」）"];
  return rows.map((r) => `  · ${[r.subject, cut(r.chapter, 30), r.activity, r.accuracy != null ? r.accuracy + "%" : ""].filter(Boolean).join(" ")}${r.feeling ? `（${cut(r.feeling, 160)}）` : ""}`);
}
const deepRatio = (rows) => `${rows.filter((r) => DEEP.has(r.activity)).length}/${rows.length}`;

function render(r) {
  const L = [];
  const { blocks } = readLedger();
  const prev = blocks.filter((b) => b.date < r.date).pop();
  L.push(`═══════════ 法硕日报 · 事实源（北京 ${r.date} 周${dow(r.date)} ${bjNow()}）═══════════`);
  L.push(`距初试(${cfg.考试日期}) ${Math.max(0, daysTo(cfg.考试日期))} 天　距基础结业死线(${cfg.基础结业死线}) ${daysTo(cfg.基础结业死线)} 天　距首次模拟(${cfg.首次模拟}) ${daysTo(cfg.首次模拟)} 天`);
  const ms = milestone(); if (ms) L.push(`里程碑：${ms}`);

  L.push(`\n──── ① 昨日派单（今天必须逐条结算，别跳过）────`);
  if (!prev) L.push("  （台账为空：这是第一份日报，无可结算的派单——今天只派单）");
  else {
    const m = prev.text.match(/^-\s*\*\*派单\*\*[：:]\s*(.+)$/m);
    const lag = Math.round((new Date(r.date) - new Date(prev.date)) / DAY);
    L.push(`  来自 ${prev.date} 日报${lag > 1 ? `　⚠️ 日报断链 ${lag - 1} 天（中间没跑，那几天无派单可结算）` : ""}`);
    L.push(`  ${m ? m[1] : "（上一块没有「派单」行——格式破了，如实说明）"}`);
  }

  L.push(`\n──── ② 昨日全天真实流水（${r.yday} 周${dow(r.yday)}·完整的一天，结算就看它）────`);
  L.push(...fmtLog(r.ydayLog));
  L.push(`  深度动作占比（复盘+带背 ÷ 全部）：${deepRatio(r.ydayLog)}`);
  const errList = (a) => a.map((e) => `${e.subject ?? "未分类"}·${cut(e.knowledge, 40)}`).join("、");
  L.push(`  错题：新增 ${r.ydayErrNew.length}${r.ydayErrNew.length ? "（" + errList(r.ydayErrNew) + "）" : ""} ／ 销账 ${r.ydayErrAbs.length}${r.ydayErrAbs.length ? "（" + errList(r.ydayErrAbs) + "）" : ""}`);

  L.push(`\n──── ③ 今日截至此刻（${r.date} 00:00~${bjNow()}·半天切面，不能拿它判勤惰）────`);
  L.push(...fmtLog(r.todayLog));
  L.push(`  错题：新增 ${r.todayErrNew.length} ／ 销账 ${r.todayErrAbs.length}`);

  L.push(`\n──── ④ 近 14 天动作热力（断档链）────`);
  L.push("  " + r.days.map((d) => `${d.d.slice(5)}${d.n ? "▊" + d.n : "·0"}`).join("  "));
  L.push(`  连续零流水：${r.gap} 天（从昨天往回数）`);
  const ago = (d) => Math.round((new Date(r.date) - new Date(d)) / DAY);
  L.push(`  分科最后一次：${SUBJECTS.map((s) => { const v = r.lastBySubj[s]; return `${s} ${v ? `${v.log_date}(${ago(v.log_date)}天前·${v.activity})` : "❌从未"}`; }).join(" ／ ")}`);
  L.push(`  分轨最后一次：${Object.entries(r.trackLast).sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([a, d]) => `${a} ${d}(${ago(d)}天前)`).join(" ／ ")}`);

  L.push(`\n──── ⑤ 欠账池（三本账的体量；细节自己去 Read 原文）────`);
  L.push(`  错题本：open ${r.open.length} 类，其中 🔁曾吸收又错 ${r.open.filter((e) => e.nAbs > 0).length} 类、🔺已达 ${cfg.红线?.同弱项错次转专题 ?? 3} 次转专题 ${r.open.filter((e) => e.nOpen + e.nAbs >= (cfg.红线?.同弱项错次转专题 ?? 3)).length} 类`);
  L.push(`  最久没碰的 open：${r.open.slice().sort((a, b) => (a.last < b.last ? -1 : 1)).slice(0, 5).map((e) => `${e.label}(${e.last || "?"})`).join("、") || "（无）"}`);
  L.push(`  带背挂账：${guazhangScale()}`);
  L.push(`  复盘排期：Read .local/复盘排期.md 取「到期未执行」的验收项（本脚本不解析，避免养成第二本账）`);

  L.push(`\n──── ⑥ 本周周报分档（派单唯一来源 · 日报不另立标准）────`);
  const wk = weeklyBuckets();
  if (wk) L.push(...wk.map((l) => "  " + l));
  else L.push("  （.local/weekly-draft.md 无 P0/P1 行或文件缺失——如实说明，别自己编一套优先级）");

  L.push(`\n（据此写日报到 .local/日报草稿.md，必须含 4 行摘要：**派单** / **昨日结算** / **今日流水** / **断档**；再 daily.mjs save --file .local/日报草稿.md）`);
  return L.join("\n");
}

const cmd = process.argv[2];
const f = parseFlags(process.argv.slice(3));
const date = (f.date && f.date !== true) ? f.date : bjToday();

if (cmd === "data") {
  console.log(render(await collect(date)));
} else if (cmd === "save") {
  if (!f.file || f.file === true) { console.error("save 需要 --file <日报markdown路径>"); process.exit(1); }
  const md = readFileSync(f.file, "utf8").trim();
  if (!md) { console.error("日报文件为空"); process.exit(1); }
  const pick = (label) => { const m = md.match(new RegExp(`^-\\s*\\*\\*${label}\\*\\*[：:]\\s*(.+)$`, "m")); return m ? m[1].trim() : null; };
  const 派单 = pick("派单");
  if (!派单) { console.error("✗ 日报里缺【- **派单**：...】行——台账靠它做明天的结算，必须写（其余 3 行：昨日结算/今日流水/断档）"); process.exit(1); }
  const left = Math.max(0, daysTo(cfg.考试日期));
  const block = [`## ${date}（周${dow(date)}）· 距初试 ${left} 天`,
    `- **派单**：${派单}`,
    `- **昨日结算**：${pick("昨日结算") ?? "（未填）"}`,
    `- **今日流水**：${pick("今日流水") ?? "（未填）"}`,
    `- **断档**：${pick("断档") ?? "（未填）"}`,
    `- 全文：\`.local/日报/${date}.md\``].join("\n");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${date}.md`, md + "\n");
  writeLedger(date, block);
  console.log(`✅ 日报已落地：${DIR}/${date}.md　台账已 upsert：${LEDGER}（${date} 块）`);

  // 同步给 APP 展示（2026-07-28 云要求「APP 加日报栏」）：与周报同架构——PC 生产、APP 只读。
  // 事实源仍是上面那两个本地文件；这张表是镜像，写失败不影响日报本身已落地。
  const headline = (md.match(/^>\s*一句话[：:]\s*(.+)$/m)?.[1] ?? "").replace(/\*\*/g, "").trim() || null;
  const { error } = await db.from("daily_report").upsert({
    report_date: date, content: md, headline,
    dispatch: 派单, settle: pick("昨日结算"), flow: pick("今日流水"), gap: pick("断档"),
    model: "pc-codex", cost_usd: 0, generated_at: new Date().toISOString(),
  }, { onConflict: "report_date" });
  if (error) console.error(`⚠️ daily_report 同步失败（本地已落地、APP 会看到旧的一份）：${error.message}`);
  else console.log(`✅ 已同步共享 daily_report（${date}·PC 生产 ¥0），APP 日报栏即刻展示。`);
  console.log(`（周报/评估/里程碑体检下次会读这本台账拿日粒度执行率与断档链）`);
} else {
  console.log("用法：node --env-file=.env.local scripts/daily.mjs <data|save> [--date YYYY-MM-DD] [--file 日报.md]");
  console.log("  data                       拉当日事实源（昨日结算面+今日切面+断档链+欠账池+周报分档+昨日派单）");
  console.log("  save --file .local/日报草稿.md   落 .local/日报/ 并 upsert .local/日报台账.md");
}
