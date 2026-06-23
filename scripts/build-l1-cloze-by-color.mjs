// 背诵重做·按颜色离线构建 L1 挖空（先只跑法理验证）。v4：复用已有的 ext.l1_keypoints（按考点抽好、
// 已正确锁节，build-l1-keypoints.mjs 产出）作必背句，只用 原文HTML 的颜色决定"挖哪段要害"。
// 规则：把要点句在 原文HTML 字符流里定位 → 句内【蓝底蓝色】= 挖空靶（保留钢蓝上下文）；
//   句内无蓝底 → 按词干(是指/具有/有：)切，挖词干后内容。判分：答案≤8字 exact 逐字；更长 semantic。
// 默认 dry-run；--commit 写 kp_state.ext.l1_cloze。
// 跑法：node --env-file=.env.local scripts/build-l1-cloze-by-color.mjs [科目] [--commit]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUBJ = process.argv.find((a) => !a.startsWith("--") && /[一-龥]/.test(a)) || "法理";
const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const ANKI = new Map((Array.isArray(raw) ? raw : raw.cards).map((c) => [c.note_id, c]));

const BLUE_BG = "rgb(194,226,255)";
const DROP_FG = new Set(["rgb(255,0,0)", "rgb(0,176,80)", "rgb(78,97,39)", "rgb(152,72,6)", "rgb(227,108,9)"]); // 编辑标记/口诀棕橙
const norm = (s) => String(s).replace(/[\s　,，。、；;：:（）()「」""''.]/g, "");
const pickStyle = (st, p) => { const m = st && st.match(new RegExp(`${p}:\\s*(rgb\\([^)]*\\)|#[0-9a-fA-F]{3,6})`)); return m ? m[1].replace(/\s/g, "") : ""; };

/** 原文HTML → 字符流 [{ch, blue}]（blue=蓝底蓝色要害；含编辑标记的不算 blue 也不可挖） */
function charStream(html) {
  const out = [], stack = [{ fg: "", bg: "" }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br|p|li)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) { const top = stack[stack.length - 1]; const t = text.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, ""); for (const ch of t) out.push({ ch, blue: top.bg === BLUE_BG && !DROP_FG.has(top.fg), drop: DROP_FG.has(top.fg) }); continue; }
    if (close) { if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop(); }
    else { const top = { ...stack[stack.length - 1] }; if (tag === "span") { const st = (attrs.match(/style="([^"]*)"/) || [])[1] || ""; if (pickStyle(st, "color")) top.fg = pickStyle(st, "color"); if (pickStyle(st, "background-color")) top.bg = pickStyle(st, "background-color"); } else if (tag === "font") { const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1]; if (c) top.fg = c.replace(/\s/g, ""); } if (["span", "font", "b", "u"].includes(tag)) stack.push(top); }
  }
  return out;
}

/** 在字符流里按归一化定位要点句，返回该 span 的 [{ch,blue}]（去标点对齐）；找不到 null */
function locate(stream, kpText) {
  const want = norm(kpText);
  if (want.length < 4) return null;
  const idx = stream.map((c) => c.ch); // 原字符
  // 归一化流 + 反查原下标
  const map = []; let ns = "";
  for (let i = 0; i < stream.length; i++) { const n = norm(idx[i]); if (n) { ns += n; map.push(i); } }
  const pos = ns.indexOf(want);
  if (pos === -1) return null;
  const from = map[pos], to = map[pos + want.length - 1];
  return stream.slice(from, to + 1);
}

/** 要点句(原文) + 其颜色 span → cloze item；挖蓝底要害；无蓝底按词干切 */
function clozeOf(kpText, span) {
  const text = kpText.replace(/^[一二三四五六七八九十\d（(]+[)）、.\s]*/, "").replace(/[。；]$/, "").trim();
  let ans, s;
  if (span) {
    // 蓝底连续段
    const runs = []; let i = 0;
    while (i < span.length) { if (span[i].blue && span[i].ch.trim()) { let j = i; while (j < span.length && (span[j].blue || !span[j].ch.trim())) j++; const r = span.slice(i, j).map((c) => c.ch).join("").trim().replace(/[，。、；]$/, ""); if (norm(r).length >= 2) runs.push(r); i = j; } else i++; }
    const hasCtx = span.some((c) => !c.blue && c.ch.trim());
    if (runs.length && hasCtx) {
      s = text; const used = [];
      for (const r of runs) { if (s.includes(r) && !used.includes(r)) { s = s.replace(r, "▢"); used.push(r); } }
      ans = used;
    }
  }
  if (!ans) {
    const m = text.match(/^(.{1,16}?(?:是指|是为|具有|包括|分为|主要有|有以下|可分为|有[：:]|[：:]))(.+)$/);
    if (!m) return null; const a = m[2].replace(/[。；]$/, "").trim(); if (norm(a).length < 2) return null; s = `${m[1]}▢`; ans = [a];
  }
  const longest = Math.max(...ans.map((a) => norm(a).length));
  if (longest < 2 || longest > 40) return null;
  const blanks = (s.match(/▢/g) || []).length;
  if (blanks !== ans.length || !blanks) return null;
  return { s, a: ans, mode: longest <= 8 ? "exact" : "semantic" };
}

async function main() {
  const { data: kps, error } = await sb.from("kp_state").select("kp_id, ext").eq("subject", SUBJ);
  if (error) { console.error("查 kp_state 失败：", error.message); process.exit(1); }
  let built = 0, noKpts = 0, noCloze = 0, exactN = 0, semN = 0, alignFail = 0, total = 0;
  const previews = [];
  for (const kp of kps) {
    const kpts = (kp.ext?.l1_keypoints ?? []).map((s) => String(s).trim()).filter((s) => s.length >= 4 && s.length <= 80);
    if (!kpts.length) { noKpts++; continue; }
    const noteIds = kp.ext?.anki_note_ids ?? [];
    const stream = noteIds.map((id) => ANKI.get(id)).filter(Boolean).flatMap((c) => charStream(c.原文HTML || ""));
    const cloze = [];
    for (const k of kpts.slice(0, 6)) { total++; const span = stream.length ? locate(stream, k) : null; if (!span) alignFail++; const c = clozeOf(k, span); if (c) cloze.push(c); }
    if (!cloze.length) { noCloze++; continue; }
    built++; for (const c of cloze) c.mode === "exact" ? exactN++ : semN++;
    if (previews.length < 14) previews.push({ name: (kp.ext?.name ?? kp.kp_id).trim(), cloze });
    if (COMMIT) { const newExt = { ...(kp.ext ?? {}), l1_cloze: cloze }; const { error: e } = await sb.from("kp_state").update({ ext: newExt }).eq("kp_id", kp.kp_id); if (e) console.error(`写 ${kp.kp_id} 失败：`, e.message); }
  }
  console.log(`\n科目「${SUBJ}」：考点 ${kps.length}，建挖空 ${built}；跳过=无l1要点${noKpts}/句不适合挖空${noCloze}；要点对齐失败 ${alignFail}/${total}；空：exact ${exactN}/semantic ${semN}${COMMIT ? "（已写库）" : "（dry-run）"}\n`);
  console.log("===== 挖空预览（前 14 考点）=====");
  for (const p of previews) { console.log(`\n◆ ${p.name}`); for (const c of p.cloze) console.log(`   [${c.mode}] ${c.s}\n        ← ${c.a.join(" / ")}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
