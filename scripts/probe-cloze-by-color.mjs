// Step2 原型验证：按颜色从 原文HTML 提取「蓝底蓝色必背关键词」，看能否干净挖到考点（不挖形容词）。
// 只读、不写库。跑法：node scripts/probe-cloze-by-color.mjs 法的基本特征
import { readFileSync } from "node:fs";

const kw = process.argv[2] || "法的基本特征";
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const cards = (Array.isArray(raw) ? raw : raw.cards).filter((c) => c.subject === "法理");

// 必背蓝底
const BLUE_BG = "rgb(194,226,255)";
// 编辑标记/口诀/题目 等需剔除的前景色
const DROP_FG = new Set(["rgb(255,0,0)", "rgb(0,176,80)", "rgb(78,97,39)", "rgb(217,217,217)"]);
const norm = (s) => s.replace(/\s/g, "");
const pick = (style, prop) => {
  const m = style && style.match(new RegExp(`${prop}:\\s*(rgb\\([^)]*\\)|#[0-9a-fA-F]{3,6})`));
  return m ? norm(m[1]) : "";
};

// 把一段 HTML 线性化成 [{text, fg, bg, bold}]（栈式跟踪 span/font/b 的样式）
function tokenize(html) {
  const toks = [];
  const stack = [{ fg: "", bg: "", bold: false }];
  const re = /<(\/?)(span|font|b|u|div|h2|h3|br)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, attrs, text] = m;
    if (text != null) {
      const top = stack[stack.length - 1];
      const t = text.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "");
      if (t.trim()) toks.push({ text: t, ...top });
      continue;
    }
    if (close) {
      if (["span", "font", "b", "u"].includes(tag) && stack.length > 1) stack.pop();
    } else {
      const top = { ...stack[stack.length - 1] };
      if (tag === "span") {
        const style = (attrs.match(/style="([^"]*)"/) || [])[1] || "";
        if (pick(style, "color")) top.fg = pick(style, "color");
        if (pick(style, "background-color")) top.bg = pick(style, "background-color");
      } else if (tag === "font") {
        const c = (attrs.match(/color=\\?"?(#[0-9a-fA-F]{3,6})/) || [])[1];
        if (c) top.fg = c;
      } else if (tag === "b") top.bold = true;
      if (["span", "font", "b", "u"].includes(tag)) stack.push(top);
    }
  }
  return toks;
}

// 取含该考点的卡（题目/原文命中）
const card = cards.find((c) => (c.原文HTML || "").includes(kw) || (c.title || "").includes(kw));
if (!card) {
  console.log(`没找到含「${kw}」的法理卡`);
  process.exit(0);
}
console.log(`卡：${card.title}（note ${card.note_id}）\n`);

const toks = tokenize(card.原文HTML || "");
// 必背关键词 = 落在蓝底上、且不是编辑标记/口诀红字 的文字；相邻合并
const must = [];
let buf = "";
for (const t of toks) {
  const isMust = t.bg === BLUE_BG && !DROP_FG.has(t.fg);
  if (isMust) buf += t.text;
  else {
    if (norm(buf).length >= 2) must.push(buf.trim());
    buf = "";
  }
}
if (norm(buf).length >= 2) must.push(buf.trim());

console.log("【颜色提取·必背关键词/句（蓝底蓝色）】");
must.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
console.log(`\n共 ${must.length} 条必背片段\n`);

// 蓝底 token 级结构：看关键词(红字口诀首字/亮蓝)和骨架(深蓝)怎么分色 → 定挖空粒度
console.log("【蓝底 token 结构（text | fg）—— 红(192,0,0)=口诀首字, 亮蓝(64,62,214)=精确必背, 深蓝(36,64,97)=骨架】");
let line = "";
for (const t of toks) {
  if (t.bg !== BLUE_BG) { if (line) { console.log("  " + line); line = ""; } continue; }
  const tag = t.fg === "rgb(192,0,0)" ? "🔴" : t.fg === "rgb(64,62,214)" ? "🔵" : t.fg === "rgb(36,64,97)" ? "·" : `(${t.fg})`;
  line += `[${t.text}${tag}]`;
}
if (line) console.log("  " + line);
