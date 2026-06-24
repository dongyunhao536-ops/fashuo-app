// 排查具体考点：DB 里的 l1_cloze/l1_keypoints/l1_plain + 卡内蓝底蓝色必背抽取。
// 跑法：node --env-file=.env.local scripts/probe-inspect-kp.mjs 法学的产生
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const KW = process.argv[2] || "法学的产生";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const ANKI = new Map((Array.isArray(raw) ? raw : raw.cards).map((c) => [c.note_id, c]));

const BLUE_BG = "rgb(194,226,255)";
const BLUE_FG = new Set(["rgb(54,96,145)", "rgb(36,64,97)", "rgb(64,62,214)"]);
const MARK_BG = new Set(["rgb(217,217,217)", "rgb(210,76,76)", "rgb(0,128,128)", "rgb(255,252,230)"]);
const DROP_FG = new Set(["rgb(255,0,0)", "rgb(0,176,80)", "rgb(78,97,39)", "rgb(152,72,6)", "rgb(227,108,9)"]);
const pickStyle = (st, p) => { const m = st && st.match(new RegExp(`${p}:\\s*(rgb\\([^)]*\\)|#[0-9a-fA-F]{3,6})`)); return m ? m[1].replace(/\s/g, "") : ""; };

function spans(html) {
  const out = [], stack = [{ fg: "", bg: "" }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br|p|li)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) { const top = stack[stack.length - 1]; const t = text.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, ""); if (t.trim()) out.push({ text: t, fg: top.fg, bg: top.bg }); continue; }
    if (close) { if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop(); }
    else { const top = { ...stack[stack.length - 1] }; if (tag === "span") { const st = (attrs.match(/style="([^"]*)"/) || [])[1] || ""; if (pickStyle(st, "color")) top.fg = pickStyle(st, "color"); if (pickStyle(st, "background-color")) top.bg = pickStyle(st, "background-color"); } else if (tag === "font") { const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1]; if (c) top.fg = c.replace(/\s/g, ""); } if (["span", "font", "b", "u"].includes(tag)) stack.push(top); else out.push({ text: "\n", fg: "", bg: "" }); }
  }
  return out;
}

const { data: kps } = await sb.from("kp_state").select("kp_id, ext").eq("subject", "法理");
const hits = (kps ?? []).filter((k) => (k.ext?.name ?? "").includes(KW));
for (const kp of hits) {
  console.log(`\n████ ${kp.ext.name}  (${kp.kp_id}) ████`);
  console.log("l1_plain:", kp.ext.l1_plain, " note_ids:", JSON.stringify(kp.ext.anki_note_ids));
  console.log("l1_keypoints:", JSON.stringify(kp.ext.l1_keypoints, null, 1));
  console.log("l1_cloze:", JSON.stringify(kp.ext.l1_cloze, null, 1));
  for (const id of kp.ext.anki_note_ids ?? []) {
    const card = ANKI.get(id); if (!card) continue;
    console.log(`\n  —— 卡 ${card.title} 的蓝底蓝色必背(挖空靶) ——`);
    const sp = spans(card.原文HTML || "");
    let buf = "";
    const flush = () => { if (buf.trim().length >= 2) console.log("   蓝底▢ ", buf.trim()); buf = ""; };
    for (const s of sp) { if (s.bg === BLUE_BG && !DROP_FG.has(s.fg)) buf += s.text; else flush(); }
    flush();
  }
}
