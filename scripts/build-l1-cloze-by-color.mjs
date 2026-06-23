// 背诵重做·按颜色离线构建 L1 挖空（先只跑法理验证）。v5：
//   ① 用 ext.l1_keypoints（已按考点锁好节，但是 Haiku 改写句）做"该考点要考哪些点"的指针；
//   ② 把每条改写要点用 Dice 相似度匹配到 原文HTML 里最像的【逐字必背句】（治"要点对齐没对上"）；
//   ③ 用那句的颜色挖空：保留钢蓝上下文、挖掉句内蓝底蓝色要害；句内无蓝底→按词干(是指/：/包括)切。
//   判分：答案≤8字 exact 逐字；更长 semantic 意思对就算。默认 dry-run；--commit 写 ext.l1_cloze。
// 跑法：node --env-file=.env.local scripts/build-l1-cloze-by-color.mjs [科目] [--commit]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUBJ = process.argv.find((a) => !a.startsWith("--") && /[一-龥]/.test(a)) || "法理";
const COMMIT = process.argv.includes("--commit");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const ANKI = new Map((Array.isArray(raw) ? raw : raw.cards).map((c) => [c.note_id, c]));

const BLUE_BG = "rgb(194,226,255)";
const BLUE_FG = new Set(["rgb(54,96,145)", "rgb(36,64,97)", "rgb(64,62,214)"]);
const MARK_BG = new Set(["rgb(217,217,217)", "rgb(210,76,76)", "rgb(0,128,128)", "rgb(255,252,230)"]);
const DROP_FG = new Set(["rgb(255,0,0)", "rgb(0,176,80)", "rgb(78,97,39)", "rgb(152,72,6)", "rgb(227,108,9)"]);
const norm = (s) => String(s).replace(/[\s　,，。、；;：:（）()「」""''.]/g, "");
const pickStyle = (st, p) => { const m = st && st.match(new RegExp(`${p}:\\s*(rgb\\([^)]*\\)|#[0-9a-fA-F]{3,6})`)); return m ? m[1].replace(/\s/g, "") : ""; };
const bigr = (s) => { const b = []; for (let i = 0; i < s.length - 1; i++) b.push(s.slice(i, i + 2)); return b; };
const dice = (a, b) => { const A = bigr(a), B = bigr(b); if (!A.length || !B.length) return 0; const set = new Set(B); let m = 0; for (const g of A) if (set.has(g)) m++; return (2 * m) / (A.length + B.length); };

/** 原文HTML → 必背句 [{text, mask(蓝底per字)}]：整句保留(含上下文，治断词)，按句号/块标签断，必背字≥3 才留。
 *  blue=蓝底蓝色(挖空靶)；编辑标记/题目底字直接剔除不入句；must=蓝系或蓝底(用于判定这句值不值得留)。 */
function mustSentences(html) {
  const stack = [{ fg: "", bg: "" }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br|p|li)([^>]*)>|([^<]+)/g;
  const sents = []; let cur = [];
  const flush = () => { if (cur.filter((c) => c.must && c.ch.trim()).length >= 3) sents.push({ text: cur.map((c) => c.ch).join("").trim(), mask: cur.map((c) => c.blue) }); cur = []; };
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) {
      const top = stack[stack.length - 1];
      const drop = DROP_FG.has(top.fg) || MARK_BG.has(top.bg); // 编辑标记/题目底/红底/青底 不进句
      if (drop) { continue; }
      const isBlue = top.bg === BLUE_BG;
      const must = isBlue || BLUE_FG.has(top.fg);
      const t = text.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "");
      for (const ch of t) { cur.push({ ch, blue: isBlue, must }); if (ch === "。") flush(); }
      continue;
    }
    if (close) { if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop(); }
    else { const top = { ...stack[stack.length - 1] }; if (tag === "span") { const st = (attrs.match(/style="([^"]*)"/) || [])[1] || ""; if (pickStyle(st, "color")) top.fg = pickStyle(st, "color"); if (pickStyle(st, "background-color")) top.bg = pickStyle(st, "background-color"); } else if (tag === "font") { const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1]; if (c) top.fg = c.replace(/\s/g, ""); } if (["span", "font", "b", "u"].includes(tag)) stack.push(top); else flush(); }
  }
  flush();
  return sents;
}

/** 逐字必背句 + 蓝底 mask → cloze（挖蓝底要害；无蓝底按词干切）。aligned=是否用上了颜色 */
function clozeOf(sent) {
  const chars = [...sent.text].map((ch, i) => ({ ch, blue: sent.mask[i] }));
  // 去前缀编号
  const pre = sent.text.match(/^[一二三四五六七八九十\d（(]+[)）、.\s]*/);
  const skip = pre ? pre[0].length : 0;
  const body = chars.slice(skip);
  const text = body.map((c) => c.ch).join("").replace(/[。；]$/, "").trim();
  // 蓝底连续段
  const runs = []; let i = 0;
  while (i < body.length) { if (body[i].blue && body[i].ch.trim()) { let j = i; while (j < body.length && (body[j].blue || !body[j].ch.trim())) j++; const r = body.slice(i, j).map((c) => c.ch).join("").trim().replace(/[，。、；]$/, ""); if (norm(r).length >= 2) runs.push(r); i = j; } else i++; }
  const hasCtx = body.some((c) => !c.blue && c.ch.trim());
  let s, ans, aligned = false;
  if (runs.length && hasCtx) { s = text; const used = []; for (const r of runs) if (s.includes(r) && !used.includes(r)) { s = s.replace(r, "▢"); used.push(r); } if (used.length) { ans = used; aligned = true; } }
  if (!ans) { const m = text.match(/^(.{1,16}?(?:是指|是为|具有|包括|分为|主要有|有以下|可分为|有[：:]|[：:]))(.+)$/); if (!m) return null; const a = m[2].replace(/[。；]$/, "").trim(); if (norm(a).length < 2) return null; s = `${m[1]}▢`; ans = [a]; }
  const longest = Math.max(...ans.map((a) => norm(a).length));
  if (longest < 2 || longest > 40) return null;
  const blanks = (s.match(/▢/g) || []).length;
  if (blanks !== ans.length || !blanks) return null;
  return { s, a: ans, mode: longest <= 8 ? "exact" : "semantic", aligned };
}

async function main() {
  const { data: kps, error } = await sb.from("kp_state").select("kp_id, ext").eq("subject", SUBJ);
  if (error) { console.error("查 kp_state 失败：", error.message); process.exit(1); }
  let built = 0, noKpts = 0, noCloze = 0, exactN = 0, semN = 0, alignedN = 0, totalC = 0, plainN = 0;
  const previews = [];
  // 写库：建到挖空→l1_cloze+l1_plain:false；建不到→l1_plain:true(走普通默写，禁 Haiku 现造挖空)。
  const writeExt = async (kp, patch) => { if (!COMMIT) return; const { error: e } = await sb.from("kp_state").update({ ext: { ...(kp.ext ?? {}), ...patch } }).eq("kp_id", kp.kp_id); if (e) console.error(`写 ${kp.kp_id} 失败：`, e.message); };
  for (const kp of kps) {
    const kpts = (kp.ext?.l1_keypoints ?? []).map((s) => String(s).trim()).filter((s) => s.length >= 4 && s.length <= 80);
    if (!kpts.length) { noKpts++; plainN++; await writeExt(kp, { l1_plain: true, l1_cloze: [] }); continue; }
    const noteIds = kp.ext?.anki_note_ids ?? [];
    const sents = noteIds.map((id) => ANKI.get(id)).filter(Boolean).flatMap((c) => mustSentences(c.原文HTML || ""));
    const cloze = []; const seen = new Set();
    for (const kpt of kpts.slice(0, 8)) {
      let best = null, bestD = 0;
      for (const st of sents) { const d = dice(norm(kpt), norm(st.text)); if (d > bestD) { bestD = d; best = st; } }
      const src = bestD >= 0.42 ? best : { text: kpt, mask: [...kpt].map(() => false) }; // 对不上→退用要点自身做词干切
      const c = clozeOf(src);
      if (c && !seen.has(c.s)) { seen.add(c.s); cloze.push(c); }
      if (cloze.length >= 6) break;
    }
    if (!cloze.length) { noCloze++; plainN++; await writeExt(kp, { l1_plain: true, l1_cloze: [] }); continue; }
    built++; for (const c of cloze) { totalC++; c.mode === "exact" ? exactN++ : semN++; if (c.aligned) alignedN++; }
    if (previews.length < 14) previews.push({ name: (kp.ext?.name ?? kp.kp_id).trim(), cloze });
    await writeExt(kp, { l1_cloze: cloze.map(({ s, a, mode }) => ({ s, a, mode })), l1_plain: false });
  }
  console.log(`\n科目「${SUBJ}」：考点 ${kps.length}，建挖空 ${built}；改普通默写(l1_plain) ${plainN}（无l1要点${noKpts}/句不适合${noCloze}）；空 ${totalC}（颜色对齐挖 ${alignedN}、词干切 ${totalC - alignedN}）；exact ${exactN}/semantic ${semN}${COMMIT ? "（已写库）" : "（dry-run）"}\n`);
  console.log("===== 挖空预览（前 14 考点；★=颜色对齐挖的精确空）=====");
  for (const p of previews) { console.log(`\n◆ ${p.name}`); for (const c of p.cloze) console.log(`   [${c.mode}]${c.aligned ? "★" : " "} ${c.s}\n        ← ${c.a.join(" / ")}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
