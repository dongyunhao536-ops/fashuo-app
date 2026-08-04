// node --env-file=.env.local scripts/cuoti.mjs <命令> [参数]
// 错题复盘·出题考核的数据管道（电脑端 skill「cuoti-fupan」专用）。
//
// 数据同步纪律（2026-08-04 收口）：复盘写操作先进入本地 outbox，再立即尝试同步；
// 网络/数据库失败时只保留失败项，下一次写操作或 `sync` 自动重试。显式 `--stage` 才只暂存。
// 出题/判题由电脑端的我=Opus 直接做，不调 APP 的付费 API、不受 ¥1.5/轮预算约束。
//
// 只读命令（随时可跑）：
//   list [科目]            —— 拉错题本 open 行（带 #id、×累计错次、🔁复发），并标出已暂存待同步的
//   material <词> [特征词]  —— 在 教材/做题心得/讲义心得/易混库/真题 里检索出题弹药（带行号锚点）
//   recheck                —— 列销账 5-60 天的旧账，突袭抽查名单
// 写操作（先进本地缓冲 .local/cuoti-pending.jsonl）：
//   absorb <id...>         —— 销账（云确认掌握后）；也可 absorb --like <片段> [--subject 刑法]
//   add <科目> <知识点...>  —— 新增一条错题（复盘中发现的新漏洞）
//   pending [--clear]      —— 查看待同步缓冲；--clear 清空
//   sync [--dry]           —— 重试 outbox；--dry 只预览不写。写命令加 --stage 可显式延后
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  appendOutbox,
  readOutbox,
  syncStudyOutbox,
  writeOutbox,
} from "./lib/study-outbox.mjs";

const db = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"]; // 英语错题=干扰项套路(2026-07-10 起)，生词归 Anki 不入本
const PENDING = ".local/cuoti-pending.jsonl";
const [cmd, ...args] = process.argv.slice(2);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日（UTC+8）——别用 UTC，深夜零点后记录会归错天

// ---------- 本地待同步缓冲 ----------
function readPending() {
  return readOutbox(PENDING);
}
function appendPending(op) {
  return appendOutbox(PENDING, op);
}
function clearPending() {
  writeOutbox(PENDING, []);
}

// ---------- 老错题抽查·本地轮换台账（只记每条"上次抽查时间/次数"，纯本地调度元数据，
//   不进系统、不受同步纪律约束；台账丢了也不影响"永不遗忘"——那样全部退回"从没考过"，照样都会被轮到）----------
const LEDGER = ".local/cuoti-recheck.json";
function readLedger() {
  if (!existsSync(LEDGER)) return {};
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; }
}
function writeLedger(obj) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(obj, null, 2));
}

// ---------- list：错题本 ----------
async function list(subject) {
  // 拉全生命周期（open+absorbed），据此算【累计】错次与复发（销账不清零，同教练 aggregateErrorBook）
  const { data, error } = await db
    .from("study_error")
    .select("id, subject, kp_id, knowledge, log_date, status, absorbed_at")
    .in("status", ["open", "absorbed"])
    .limit(2000);
  if (error) return fail(error.message);

  const keyOf = (r) => r.kp_id ?? `${r.subject ?? "未分类"}::${r.knowledge}`;
  const agg = new Map();
  for (const r of data ?? []) {
    const k = keyOf(r);
    const cur = agg.get(k) ?? { nOpen: 0, nAbs: 0, last: "" };
    if (r.status === "absorbed") cur.nAbs++;
    else { cur.nOpen++; const d = String(r.log_date ?? ""); if (d > cur.last) cur.last = d; }
    agg.set(k, cur);
  }

  // 已暂存待同步的 id（本地缓冲，尚未落库）
  const staged = new Set(readPending().filter((o) => o.op === "absorb").flatMap((o) => o.ids ?? []));

  let open = (data ?? []).filter((r) => r.status === "open");
  if (subject) open = open.filter((r) => r.subject === subject);
  const rows = open
    .map((r) => { const a = agg.get(keyOf(r)); return { ...r, total: a.nOpen + a.nAbs, recurN: a.nAbs }; })
    .sort((x, y) => y.total - x.total || (x.log_date < y.log_date ? 1 : -1));

  const bySubj = {};
  for (const r of rows) bySubj[r.subject ?? "未分类"] = (bySubj[r.subject ?? "未分类"] ?? 0) + 1;

  console.log(`错题本 open：${rows.length} 条` + (subject ? `（已筛 ${subject}）` : "") +
    "　按科目：" + (Object.entries(bySubj).map(([k, v]) => `${k}${v}`).join(" / ") || "空"));
  console.log("（#id 用于 absorb；×N=累计错次，🔁×N=复发轮数（销过N次账又栽·N≥2=顽固错题优先打·销账升格跨两会话），⏳=已暂存待同步）\n");
  for (const r of rows) {
    const flags = `${r.total > 1 ? " ×" + r.total : ""}${r.recurN > 0 ? " 🔁复发×" + r.recurN : ""}${staged.has(r.id) ? " ⏳待同步" : ""}`;
    console.log(`#${r.id}  [${r.subject ?? "?"}]${flags}  (${r.log_date})`);
    console.log(`     ${String(r.knowledge).replace(/\s+/g, " ").trim()}`);
  }
  if (!rows.length) console.log("（错题本是空的——没有待复盘的错题）");
  const pend = readPending();
  if (pend.length) console.log(`\n⚠️ outbox 有 ${pend.length} 条上次同步失败/显式暂存的操作——跑 pending 查看、sync 重试。`);
}

// ---------- material：出题弹药检索 ----------
// 第三列＝该 kind 的保底字符配额（前面的 kind 吃不掉后面的，省下的才向后滚）
const KINDS = [
  ["xinde", "做题心得/讲义心得(马工程·提示·易错·辨析·总结)", 4000],
  ["textbook", "《考试分析》教材原文", 5000],
  ["yixiao", "易混概念库", 2000],
  ["zhenti", "真题分析/高频/主观题汇总", 3000],
];
const CTX = 2, CLIP = 150, MAX_BLOCKS_PER_KIND = 6;
const clip = (s) => { const t = s.trim(); return t.length <= CLIP ? t : t.slice(0, CLIP) + "…"; };

function grep(rows, keyword, refine) {
  const blocks = [];
  let totalHits = 0;
  for (const row of rows) {
    const lines = String(row.content).split("\n");
    const base = row.start_line ?? 1;
    const hits = [];
    lines.forEach((ln, i) => { if (ln.includes(keyword) && !/\.{6,}/.test(ln)) hits.push(i); });
    totalHits += hits.length;
    const spans = [];
    for (const i of hits) {
      const from = Math.max(0, i - CTX), to = Math.min(lines.length - 1, i + CTX);
      const cur = spans[spans.length - 1];
      if (cur && from <= cur.to + 1) { cur.to = to; cur.hits.push(i); }
      else spans.push({ from, to, hits: [i] });
    }
    for (const s of spans) {
      const hitSet = new Set(s.hits);
      let refineHit = false;
      const text = [];
      for (let i = s.from; i <= s.to; i++) {
        if (refine && lines[i].includes(refine)) refineHit = true;
        text.push(`${base + i}${hitSet.has(i) ? "►" : " "} ${clip(lines[i])}`);
      }
      blocks.push({ path: row.path, lines: s.hits.map((i) => base + i), text: text.join("\n"), refineHit });
    }
  }
  blocks.sort((a, b) => {
    if (refine) { const c = (b.refineHit ? 1 : 0) - (a.refineHit ? 1 : 0); if (c) return c; }
    return b.lines.length - a.lines.length;
  });
  return { blocks, totalHits };
}

async function material(keyword, refine) {
  if (!keyword) return fail('material 需要关键词，如：material 想象竞合 因果');
  console.log(`检索「${keyword}${refine ? " + " + refine : ""}」的出题弹药（►=命中行，带行号锚点）`);
  if (refine) console.log(`（特征词「${refine}」同时命中的条目已置顶）`);
  // 配额制（2026-07-22 修）：原先四个 kind 共享一个 14000 总预算、超了直接 return，
  // 宽词下 xinde 的合并巨块一段就吃光，教材/易混/真题整段不输出 → 预检"教材锚定"写成"无"＝假阴性。
  // 现在每个 kind 有保底额度，且有命中就至少出一块，绝不整段空手。
  let carry = 0;
  for (const [kind, label, quota] of KINDS) {
    const { data } = await db.from("content_mirror").select("path, content, start_line").eq("kind", kind);
    const { blocks, totalHits } = grep(data ?? [], keyword, refine);
    console.log(`\n───── ${label}　命中 ${totalHits} 行 / ${blocks.length} 片段 ─────`);
    if (!blocks.length) { console.log("（无命中）"); carry += quota; continue; }
    const budget = quota + carry;
    let used = 0, shown = 0;
    for (const b of blocks.slice(0, MAX_BLOCKS_PER_KIND)) {
      let seg = `· ${b.path}\n${b.text}`;
      if (used + seg.length > budget) {
        if (shown) break;
        seg = seg.slice(0, budget) + "\n…（本片段过长已截断）"; // 保底：命中了就必须看见东西
      }
      console.log(seg);
      used += seg.length;
      shown++;
    }
    if (shown < blocks.length) console.log(`…（本段还有 ${blocks.length - shown} 个片段未显示，换更具体的关键词或加特征词再查）`);
    carry = Math.max(0, budget - used);
  }
}

// ---------- absorb：暂存销账到本地缓冲 ----------
async function absorb(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  if (rest[0] === "--like") {
    const like = rest[1];
    if (!like) return fail('absorb --like 需要片段，如：absorb --like 盗窃既遂 --subject 刑法');
    const si = rest.indexOf("--subject");
    const subject = si !== -1 ? rest[si + 1] : null;
    let sel = db.from("study_error").select("id, subject, knowledge").eq("status", "open").ilike("knowledge", `%${like}%`);
    if (subject) sel = sel.eq("subject", subject);
    const { data: hit, error } = await sel;
    if (error) return fail(error.message);
    if (!hit?.length) return console.log(`没有匹配「${like}」的 open 错题，未暂存。`);
    appendPending({ op: "absorb", ids: hit.map((r) => r.id), note: `模糊「${like}」`, items: hit.map((r) => `[${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 50)}`) });
    console.log(`⏳ 已暂存待同步·销账 ${hit.length} 条（模糊「${like}」）：`);
    for (const r of hit) console.log(`   #${r.id} [${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 60)}`);
    if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
    return sync([]);
  }
  const ids = rest.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return fail("absorb 需要错题 id（见 list），如：absorb 22  或  absorb --like 片段");
  const { data: rows, error } = await db.from("study_error").select("id, subject, knowledge, status").in("id", ids);
  if (error) return fail(error.message);
  const openRows = (rows ?? []).filter((r) => r.status === "open");
  const notOpen = ids.filter((id) => !openRows.some((r) => r.id === id));
  if (!openRows.length) return console.log("这些 id 里没有 open 状态的错题（可能已销账/不存在），未暂存。");
  appendPending({ op: "absorb", ids: openRows.map((r) => r.id), items: openRows.map((r) => `[${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 50)}`) });
  console.log(`⏳ 已暂存待同步·销账 ${openRows.length} 条：`);
  for (const r of openRows) console.log(`   #${r.id} [${r.subject ?? "?"}] ${String(r.knowledge).slice(0, 60)}`);
  if (notOpen.length) console.log(`（跳过非 open/不存在：${notOpen.map((x) => "#" + x).join(" ")}）`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync([]);
}

// ---------- add：暂存新错题到本地缓冲 ----------
// --recur-of <旧错题id>：显式标记"这条是老账复发"。2026-07-22 加——量化 v3 的重犯惩罚原本靠
// 「knowledge 全字符串相同」判重犯，而错题描述中位数 245 字、永不重复，惩罚实际形同虚设（实测
// 51 条只揪出 1 组）。重犯必须在【写入时】显式连线，不能靠事后猜文本相似度（那是伪精度、会错并）。
async function add(rest) {
  const stageOnly = rest.includes("--stage");
  rest = rest.filter((arg) => arg !== "--stage");
  let recurOf = null;
  const ri = rest.indexOf("--recur-of");
  if (ri !== -1) { recurOf = Number(rest[ri + 1]); rest.splice(ri, 2); if (!Number.isFinite(recurOf)) return fail("--recur-of 需要旧错题的数字 id，如：add 刑法 xxx --recur-of 36"); }
  const subject = rest[0] && SUBJECTS.includes(rest[0]) ? rest.shift() : null;
  const knowledge = rest.join(" ").trim();
  if (!knowledge) return fail("add 需要知识点，如：add 刑法 牵连犯与吸收犯区分标准 [--recur-of 36]");
  appendPending({ op: "new_error", subject, knowledge, recurOf });
  console.log(`⏳ 已暂存待同步·新错题：[${subject ?? "未分类"}]${recurOf ? ` 🔁复发（源#${recurOf}）` : ""} ${knowledge}`);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后运行 sync。）");
  await sync([]);
}

// ---------- pending：查看/清空缓冲 ----------
function pending(rest) {
  if (rest[0] === "--clear") { clearPending(); return console.log("已清空本地待同步缓冲。"); }
  const ops = readPending();
  if (!ops.length) return console.log("本地待同步缓冲为空。");
  console.log(`本地 outbox：${ops.length} 条（同步失败或显式 --stage；运行 sync 可重试）\n`);
  ops.forEach((o, i) => {
    if (o.op === "absorb") console.log(`${i + 1}. 销账 #${(o.ids ?? []).join(" #")}${o.note ? "（" + o.note + "）" : ""}\n   ${(o.items ?? []).join("\n   ")}`);
    else if (o.op === "new_error") console.log(`${i + 1}. 新错题 [${o.subject ?? "未分类"}] ${o.knowledge}`);
    else if (o.op === "study_log") console.log(`${i + 1}. 学习日志 ${o.date ?? ""} [${o.subject}]${o.chapter ? " " + o.chapter : ""} ${o.activity}${o.accuracy != null ? " " + o.accuracy + "%" : ""}${o.feeling ? "（" + o.feeling + "）" : ""}`);
  });
}

// ---------- sync：逐项幂等落库；只移除成功项 ----------
async function sync(rest) {
  const dry = rest.includes("--dry");
  const ops = readPending();
  if (!ops.length) return console.log("缓冲为空，没有要同步的。");
  const absorbIds = [...new Set(ops.filter((o) => o.op === "absorb").flatMap((o) => o.ids ?? []))];
  const newErrs = ops.filter((o) => o.op === "new_error");
  const logs = ops.filter((o) => o.op === "study_log");
  const mems = ops.filter((o) => o.op === "coach_memory");

  console.log(`${dry ? "【预览·不写库】" : "同步到系统"}：销账 ${absorbIds.length} 条${absorbIds.length ? "（#" + absorbIds.join(" #") + "）" : ""}、新错题 ${newErrs.length} 条、学习日志 ${logs.length} 条、长期记忆 ${mems.length} 条`);
  if (dry) {
    for (const e of newErrs) console.log(`   + 错题 [${e.subject ?? "未分类"}] ${e.knowledge}`);
    for (const l of logs) console.log(`   + 日志 ${l.date ?? ""} [${l.subject}]${l.chapter ? " " + l.chapter : ""} ${l.activity}${l.accuracy != null ? " " + l.accuracy + "%" : ""}${l.feeling ? "（" + l.feeling + "）" : ""}`);
    for (const m of mems) console.log(`   + 记忆 [${m.category ?? "画像"}] ${m.fact}`);
    return console.log("（预览完毕，未改动。去掉 --dry 才真正落库。）");
  }

  let report;
  try {
    report = await syncStudyOutbox({ db, path: PENDING, today });
  } catch (error) {
    return fail(`outbox 同步前检查/重写失败：${error instanceof Error ? error.message : String(error)}（原缓冲保留）`);
  }
  const count = (kind) => report.succeeded
    .filter(({ result }) => result.kind === kind)
    .reduce((sum, { result }) => sum + result.affected, 0);
  console.log(`✅ 已确认同步：销账 ${count("absorb")} 条、新增错题 ${count("new_error")} 条、学习日志 ${count("study_log")} 条、长期记忆 ${count("coach_memory")} 条。`);
  if (report.failed.length) {
    console.error(`⚠️ ${report.failed.length} 项失败，已保留在 outbox，绝未清空：`);
    for (const { op, error } of report.failed) console.error(`   · ${op.operation_id} (${op.op})：${error}`);
    process.exitCode = 1;
  } else {
    console.log("outbox 已清空；每项均由 operation_id 保证重试不重复。");
  }
  console.log(`（错题本是 Supabase 运行态，APP 实时读库即可见，无需重新部署。若日后复盘产出「心得」入内容库才需 archive 提交+部署。）`);
}

// ---------- recheck：老错题全覆盖轮换抽查（云 7-06："每条老题都不会被遗忘、都有可能被抽到"）----------
// 轮换池 = 【全部】已销账老题，【无上限、永不淘汰】。排序 = "最久没碰的优先"
//   （lastTouch = max(销账时间, 上次抽查时间)）→ 考过的沉底、把机会让给还没轮到的 →
//   反复跑下去每一条终会被抽到，绝不漏。刚碰过的先歇 MIN_GAP 天，避免马上重考。
const RECHECK_MIN_GAP = 3 * DAY;
async function recheck(rest) {
  const n = Number(rest.find((x) => /^\d+$/.test(x))) || 6;
  const { data, error } = await db
    .from("study_error").select("id, subject, knowledge, absorbed_at, kp_id")
    .eq("status", "absorbed").not("absorbed_at", "is", null);
  if (error) return fail(error.message);
  const ledger = readLedger();
  const now = Date.now();
  const pool = (data ?? []).map((r) => {
    const led = ledger[r.id];
    const lastTouch = led?.last ? new Date(led.last).getTime() : new Date(r.absorbed_at).getTime();
    return { ...r, lastTouch, sinceDays: Math.floor((now - lastTouch) / DAY), count: led?.count ?? 0, tested: !!led?.last };
  });
  if (!pool.length) return console.log("还没有已销账的老错题——轮换池是空的。");
  const bySince = (a, b) => a.lastTouch - b.lastTouch; // 最久没碰的排前
  const ready = pool.filter((r) => now - r.lastTouch >= RECHECK_MIN_GAP).sort(bySince);
  const draw = (ready.length ? ready : pool.slice().sort(bySince)).slice(0, n);
  const never = pool.filter((r) => !r.tested).length;

  console.log(`老错题轮换池：共 ${pool.length} 条（【全部已销账老题都在池里，无上限、永不淘汰】）`);
  console.log(`本次抽 ${draw.length} 条——最久没考的优先、考过的沉底让位，反复跑保证【每一条终会被轮到、不遗漏】：\n`);
  for (const r of draw) {
    const tag = r.tested ? `上次考 ${r.sinceDays} 天前·累计抽查 ${r.count} 次` : `销账后 ${r.sinceDays} 天·从没抽查过`;
    console.log(`#${r.id} [${r.subject ?? "?"}]（${tag}）`);
    console.log(`   ${String(r.knowledge).replace(/\s+/g, " ").slice(0, 80)}`);
  }
  if (never) console.log(`\n（池里还有 ${never} 条【从没被抽查过】，排最前优先出——一条不漏。抽查后：过了→ pass <id>；没过→ recheck-fail <id> 重新挂账）`);
}

// 记录老题本次抽查【通过】（只写本地轮换台账、不碰系统数据、无需同步）：沉到池底、把机会让给别的
function pass(rest) {
  const ids = rest.map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return fail("pass 需要 id，如：pass 21 23（记录这些老题本次抽查通过）");
  const ledger = readLedger();
  const now = new Date().toISOString();
  for (const id of ids) ledger[id] = { last: now, count: (ledger[id]?.count ?? 0) + 1, result: "pass" };
  writeLedger(ledger);
  console.log(`✅ 已记 ${ids.length} 条老题抽查通过（#${ids.join(" #")}）→ 沉到轮换池底，下次先考还没轮到的。`);
}

// 老题本次抽查【没过】：暂存重新挂账（同步后 open + 🔁 复发）+ 台账记一次（避免它立刻又在老池里冒头）
async function recheckFail(rest) {
  const stageOnly = rest.includes("--stage");
  const ids = rest.filter((arg) => arg !== "--stage").map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return fail("recheck-fail 需要 id，如：recheck-fail 23（老题没过、重新挂账）");
  const { data, error } = await db.from("study_error").select("id, subject, knowledge").in("id", ids);
  if (error) return fail(error.message);
  const ledger = readLedger();
  const now = new Date().toISOString();
  for (const r of data ?? []) {
    appendPending({ op: "new_error", subject: r.subject, knowledge: String(r.knowledge), recurOf: r.id, note: `老题抽查没过·复发（源#${r.id}）` });
    ledger[r.id] = { last: now, count: (ledger[r.id]?.count ?? 0) + 1, result: "fail" };
    console.log(`↩ #${r.id} 没过 → 已暂存重新挂账：${String(r.knowledge).slice(0, 50)}`);
  }
  writeLedger(ledger);
  if (stageOnly) return console.log("（已按 --stage 仅暂存；稍后 sync 后会重新挂账并标 🔁 复发。）");
  await sync([]);
}

function fail(msg) { console.error("✗ " + msg); process.exitCode = 1; }

switch (cmd) {
  case "list": await list(args[0] && SUBJECTS.includes(args[0]) ? args[0] : undefined); break;
  case "material": await material(args[0], args[1]); break;
  case "absorb": await absorb(args); break;
  case "add": await add(args); break;
  case "pending": pending(args); break;
  case "sync": await sync(args); break;
  case "recheck": await recheck(args); break;
  case "pass": pass(args); break;
  case "recheck-fail": await recheckFail(args); break;
  default:
    console.log("用法：node --env-file=.env.local scripts/cuoti.mjs <命令> ...");
    console.log("  只读：list [科目] / material <词> [特征词]");
    console.log("  老题轮换抽查：recheck [n]（全覆盖·永不淘汰）/ pass <id...>（过了）/ recheck-fail <id...>（没过·重新挂账）");
    console.log("  写(outbox 后立即同步)：absorb <id...>|--like <片段> / add <科目> <知识点>（加 --stage 才延后）");
    console.log("  outbox：pending [--clear] / sync [--dry]（失败重试）");
}
