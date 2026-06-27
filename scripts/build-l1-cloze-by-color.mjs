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

/** 原文HTML → 按【蓝底大标题】切节：[{header, sents:[{text,mask}]}]。每节收集其下的钢蓝必背正文句
 *  （作者标蓝的定义句），治"一卡多考点共用母卡"——每个小考点只挖自己那节，不串兄弟考点的内容。
 *  蓝底占比高且形如"一、/（1）"的句子=节标题(分节用，本身不挖)；其余必背句=该节正文(挖空源)。 */
const GRAY_BG = "rgb(217,217,217)", RED_BG = "rgb(210,76,76)";
function cardSections(html, kpNorms = []) {
  const stack = [{ fg: "", bg: "" }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br|p|li)([^>]*)>|([^<]+)/g;
  const sections = [{ header: "", sents: [] }]; let cur = [];
  // 标题(灰底0XX./红底二、/蓝底一、) 清成纯名供匹配。
  const cleanTitle = (t) => t.trim().replace(/^\d{2,3}\s*[.．、]\s*/, "").replace(/[✨【(（].*$/g, "").replace(/^(简述|简答|论述)/, "").replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "").replace(/^.*?——/, "").trim();
  const startSec = (h) => { if (h.length >= 2) sections.push({ header: h, sents: [] }); };
  // 关键：标题行只有【≈某考点名】才开新考点节；否则是子点标签(演绎推理/形式推理…)→ 跳过，
  //   其后的内容句归当前考点节。这样作者配色不统一也不怕（蓝底有时是考点、有时是子点）。
  const isKp = (h) => h.length >= 2 && kpNorms.some((nm) => dice(norm(h), nm) >= 0.55);
  const flush = () => {
    if (!cur.length) { return; }
    const text = cur.map((c) => c.ch).join("").trim();
    const real = cur.filter((c) => c.ch.trim()); const n = real.length || 1;
    const grayR = real.filter((c) => c.bg === GRAY_BG).length / n;
    const redR = real.filter((c) => c.bg === RED_BG).length / n;
    const mc = cur.filter((c) => c.must && c.ch.trim());
    const blueR = mc.length ? mc.filter((c) => c.blue).length / mc.length : 0;
    const numbered = /^[（(]?\s*[一二三四五六七八九十\d]+\s*[)）、.]/.test(text);
    const isHdr = (grayR > 0.6 && /^\d{2,3}\s*[.．、]/.test(text)) || (redR > 0.6 && numbered) || (mc.length >= 3 && blueR > 0.55 && numbered);
    if (isHdr) { const h = cleanTitle(text); if (isKp(h)) startSec(h); } // 匹配考点名才开节；子点标签跳过
    else if (mc.length >= 3) { const sc = cur.filter((c) => !c.drop); sections[sections.length - 1].sents.push({ text: sc.map((c) => c.ch).join("").trim(), mask: sc.map((c) => c.blue) }); }
    cur = [];
  };
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) {
      const top = stack[stack.length - 1];
      const drop = DROP_FG.has(top.fg) || MARK_BG.has(top.bg);
      const isBlue = top.bg === BLUE_BG;
      const must = (isBlue || BLUE_FG.has(top.fg)) && !drop;
      const t = text.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "");
      for (const ch of t) { cur.push({ ch, bg: top.bg, blue: isBlue, must, drop }); if (ch === "。") flush(); }
      continue;
    }
    if (close) { if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop(); }
    else { const top = { ...stack[stack.length - 1] }; if (tag === "span") { const st = (attrs.match(/style="([^"]*)"/) || [])[1] || ""; if (pickStyle(st, "color")) top.fg = pickStyle(st, "color"); if (pickStyle(st, "background-color")) top.bg = pickStyle(st, "background-color"); } else if (tag === "font") { const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1]; if (c) top.fg = c.replace(/\s/g, ""); } if (["span", "font", "b", "u"].includes(tag)) stack.push(top); else flush(); }
  }
  flush();
  return sections.filter((s) => s.sents.length > 0);
}

/** 卡内【蓝底蓝色】连续必背片段（作者真·必背靶，按卡/题目天然锁好 → 覆盖 Haiku 串考点的脏 l1_keypoints） */
function blueRuns(html) {
  const stack = [{ fg: "", bg: "" }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br|p|li)([^>]*)>|([^<]+)/g;
  const out = []; let buf = "";
  const flush = () => { const t = buf.replace(/&nbsp;/g, " ").trim().replace(/^[（(]?[一二三四五六七八九十\d]+[)）.、]\s*/, "").replace(/[。；，、]+$/, "").trim(); if (norm(t).length >= 3) out.push(t); buf = ""; };
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) { const top = stack[stack.length - 1]; if (top.bg === BLUE_BG && !DROP_FG.has(top.fg)) buf += text; else flush(); continue; }
    if (close) { if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop(); }
    else { const top = { ...stack[stack.length - 1] }; if (tag === "span") { const st = (attrs.match(/style="([^"]*)"/) || [])[1] || ""; if (pickStyle(st, "color")) top.fg = pickStyle(st, "color"); if (pickStyle(st, "background-color")) top.bg = pickStyle(st, "background-color"); } else if (tag === "font") { const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1]; if (c) top.fg = c.replace(/\s/g, ""); } if (["span", "font", "b", "u"].includes(tag)) stack.push(top); else flush(); }
  }
  flush();
  return out;
}
const colorMustList = (cards) => { const out = [], seen = new Set(); for (const c of cards) for (const r of blueRuns(c.原文HTML || "")) if (!seen.has(r) && r.length <= 60) { seen.add(r); out.push(r); } return out.slice(0, 12); };

/** 逐字必背句 + 蓝底 mask → cloze（挖蓝底要害；无蓝底按词干切）。aligned=是否用上了颜色 */
function clozeOf(sent) {
  const chars = [...sent.text].map((ch, i) => ({ ch, blue: sent.mask[i] }));
  // 去前缀编号 / 残留项目符号(如 Anki 拆出的孤立 "v "/"o ")
  const pre = sent.text.match(/^(?:[a-zA-Z]\s+|[一二三四五六七八九十\d（(•·▪◦]+[)）、.\s]*)/);
  const skip = pre ? pre[0].length : 0;
  const body = chars.slice(skip);
  const text = body.map((c) => c.ch).join("").replace(/[。；]$/, "").trim();
  // 蓝底连续段
  const runs = []; let i = 0;
  while (i < body.length) { if (body[i].blue && body[i].ch.trim()) { let j = i; while (j < body.length && (body[j].blue || !body[j].ch.trim())) j++; const r = body.slice(i, j).map((c) => c.ch).join("").trim().replace(/[，。、；]$/, ""); if (norm(r).length >= 2) runs.push(r); i = j; } else i++; }
  const hasCtx = body.some((c) => !c.blue && c.ch.trim());
  let s, ans, aligned = false;
  if (runs.length && hasCtx) { s = text; const used = []; for (const r of runs) if (s.includes(r) && !used.includes(r)) { s = s.replace(r, "▢"); used.push(r); } if (used.length) { ans = used; aligned = true; } }
  // 词干切：在钢蓝必背定义句里按标记词切出"该挖的短答案"。标记窗口放宽到 28 字——很多必背句
  //   的"具有/表现为"落在第 17 字以后（如"法是以权利和义务为内容的社会规范,具有▢"具有在第17字），
  //   旧 16 字窗口会整句漏挖、退默写。答案仍受 2~14 字长度闸约束，不会切出长尾。
  if (!ans) { const m = text.match(/^(.{1,28}?(?:是指|是为|表现为|体现为|主要表现为|具有|包括|分为|主要有|有以下|可分为|有[：:]|[：:]))(.+)$/); if (!m) return null; const a = m[2].replace(/[。；，、：,]+$/, "").trim(); if (norm(a).length < 2) return null; s = `${m[1]}▢`; ans = [a]; }
  const longest = Math.max(...ans.map((a) => norm(a).length));
  // 挖空只做【短关键词/短语】(≤14字)；更长的复合/定义答案塞单空=变默写、半对判0%(治"社会科学性"那种)，
  // 一律 return null → 该考点退普通默写(按意思判、可给部分分)。
  if (longest < 2 || longest > 14) return null;
  const blanks = (s.match(/▢/g) || []).length;
  if (blanks !== ans.length || !blanks) return null;
  // 退化空闸：题面去掉 ▢ 后实质字 <3（如"▢,"）= 没上下文/几乎挖光整句 = 送答案或无意义，丢弃→退默写。
  if (norm(s.replace(/▢/g, "")).length < 3) return null;
  // 子句闸：答案含内部逗号(，,) = 词干切切到整段子句而非关键词(如"先在性,它的产生早于法律")，丢弃→退默写。
  if (ans.some((a) => /[，,]/.test(a))) return null;
  // 超长题面闸：整句太长(如习近平要义那种整段)塞一个空=读不动，丢弃→退默写或用本考点更短的句。
  if (norm(s).length > 48) return null;
  return { s, a: ans, mode: longest <= 8 ? "exact" : "semantic", aligned };
}

async function main() {
  const { data: kps, error } = await sb.from("kp_state").select("kp_id, ext").eq("subject", SUBJ);
  if (error) { console.error("查 kp_state 失败：", error.message); process.exit(1); }
  let built = 0, noKpts = 0, noCloze = 0, exactN = 0, semN = 0, alignedN = 0, totalC = 0, plainN = 0, droppedRaw = 0;
  let noSect = 0, hdrMiss = 0, sectNoDig = 0; // 诊断：退默写到底卡在哪一步
  const previews = [];
  // 写库：建到挖空→l1_cloze+l1_plain:false；建不到→l1_plain:true(走普通默写，禁 Haiku 现造挖空)。
  const writeExt = async (kp, patch) => { if (!COMMIT) return; const { error: e } = await sb.from("kp_state").update({ ext: { ...(kp.ext ?? {}), ...patch } }).eq("kp_id", kp.kp_id); if (e) console.error(`写 ${kp.kp_id} 失败：`, e.message); };
  let mustN = 0;
  // note_id → 引用它的考点数：独占卡(=1)可全挖不串味；共享母卡(>1)只挖标题对上的那节。
  const noteOwners = new Map();
  for (const kp of kps) for (const id of (kp.ext?.anki_note_ids ?? [])) noteOwners.set(id, (noteOwners.get(id) || 0) + 1);
  // 考点名全集（归一化）：cardSections 用它判"标题行是不是考点级"（区分考点 vs 子点标签）。
  const kpNorms = kps.map((k) => norm(String(k.ext?.name ?? ""))).filter((s) => s.length >= 3);
  for (const kp of kps) {
    const cards = (kp.ext?.anki_note_ids ?? []).map((id) => ANKI.get(id)).filter(Boolean);
    const mustList = colorMustList(cards); // 蓝底蓝色真·必背靶
    const extra = mustList.length >= 2 ? { l1_must: mustList } : {}; // ≥2 才覆盖 Haiku 脏靶，否则保留原靶
    if (mustList.length >= 2) mustN++;
    // 挖空来源（用户 2026-06-27 重做）：不再靠 Haiku l1_keypoints + 逐字 Dice（太脆，大批节对不上
    //   被漏挖、只剩 13 个）。改为【按蓝底大标题切节 → 考点对到自己那节 → 挖那节的钢蓝必背正文句】。
    //   每节都有蓝色字体(钢蓝定义句)，所以基本每个考点都能挖到，且只挖本节、不串兄弟考点、不碰黑字。
    const kpName = String(kp.ext?.name ?? "").trim();
    const sections = cards.flatMap((c) => cardSections(c.原文HTML || "", kpNorms));
    if (!sections.length) { noCloze++; noSect++; plainN++; await writeExt(kp, { l1_plain: true, l1_cloze: [], ...extra }); continue; }
    const shared = (kp.ext?.anki_note_ids ?? []).some((id) => (noteOwners.get(id) || 0) > 1);
    const headed = sections.filter((s) => s.header);
    let pickSents;
    if (shared) {
      // 共享母卡（多考点引用同张 note）：一律【唯一性认领一节、绝不挖全卡】——否则兄弟考点全拿同一份
      //   （法律关系主体/内容/客体共用一张"构成要素"卡，全挖就三个一样）。该节须本考点在所有考点里
      //   匹配得最好才认领；对不上/不是最佳 → 退默写。根治共享母卡串味。
      const kn = norm(kpName);
      let best = null, bd = 0;
      for (const s of headed) { const d = dice(norm(s.header), kn); if (d > bd) { bd = d; best = s; } }
      let bestKpD = 0; if (best) for (const nm of kpNorms) { const d = dice(norm(best.header), nm); if (d > bestKpD) bestKpD = d; }
      // 唯一最佳才认领：多个考点对该节打平(主体/内容/客体 对"构成要素"等距) → 全退默写，不发等同错空。
      const tie = best ? kpNorms.filter((nm) => dice(norm(best.header), nm) >= bestKpD - 1e-9).length : 0;
      pickSents = (best && bd >= 0.45 && bd >= bestKpD - 1e-9 && tie === 1) ? best.sents : null;
    } else {
      pickSents = sections.flatMap((s) => s.sents); // 独占卡：本考点拥有整卡 → 全挖，不可能串味
    }
    const cloze = []; const seen = new Set();
    for (const st of (pickSents ?? [])) {
      const c = clozeOf(st);
      const key = norm(c?.s ?? ""); // 归一化去重：治全角/半角逗号造成的"同句两空"
      if (c && key && !seen.has(key)) { seen.add(key); cloze.push(c); }
      if (cloze.length >= 4) break;
    }
    if (!cloze.length) { noCloze++; if (!pickSents) hdrMiss++; else sectNoDig += (pickSents.length > 0 ? 1 : 0); plainN++; await writeExt(kp, { l1_plain: true, l1_cloze: [], ...extra }); continue; }
    built++; for (const c of cloze) { totalC++; c.mode === "exact" ? exactN++ : semN++; if (c.aligned) alignedN++; }
    if (previews.length < 14) previews.push({ name: (kp.ext?.name ?? kp.kp_id).trim(), cloze });
    await writeExt(kp, { l1_cloze: cloze.map(({ s, a, mode }) => ({ s, a, mode })), l1_plain: false, ...extra });
  }
  console.log(`\n科目「${SUBJ}」：考点 ${kps.length}，建挖空 ${built}；改普通默写(l1_plain) ${plainN}；写颜色真靶 l1_must ${mustN}；空 ${totalC}（蓝底对齐挖 ${alignedN}、钢蓝必背句词干切 ${totalC - alignedN}）；exact ${exactN}/semantic ${semN}${COMMIT ? "（已写库）" : "（dry-run）"}`);
  console.log(`退默写拆解：无蓝色必背节 ${noSect} / 多考点母卡标题对不上 ${hdrMiss} / 有必背句但挖不出 ${sectNoDig}\n`);
  console.log("===== 挖空预览（前 14 考点；★=颜色对齐挖的精确空）=====");
  for (const p of previews) { console.log(`\n◆ ${p.name}`); for (const c of p.cloze) console.log(`   [${c.mode}]${c.aligned ? "★" : " "} ${c.s}\n        ← ${c.a.join(" / ")}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
