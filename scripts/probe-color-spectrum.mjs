// Step1 验证：扫某科 Anki 原文HTML 的颜色谱，对齐用户图例（rgb/hex → 重要度 tier）。
// 只读、零风险。跑法：node scripts/probe-color-spectrum.mjs 法理
import { readFileSync } from "node:fs";

const subj = process.argv[2] || "法理";
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const cards = (Array.isArray(raw) ? raw : raw.cards).filter((c) => c.subject === subj);
console.log(`科目「${subj}」卡数：${cards.length}\n`);

// 收集 (前景色, 背景色) 组合 → 次数 + 样例文字
const combos = new Map();
const add = (fg, bg, text) => {
  const t = text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  if (!t) return;
  const key = `fg=${fg || "-"} | bg=${bg || "-"}`;
  const e = combos.get(key) ?? { n: 0, samples: [] };
  e.n++;
  if (e.samples.length < 4 && t.length <= 30) e.samples.push(t);
  combos.set(key, e);
};

const styleRe = /style="([^"]*)"[^>]*>([^<]{1,80})/g;
const fontRe = /<font color=\\?"?(#[0-9a-fA-F]{3,6})\\?"?[^>]*>([^<]{1,80})/g;
const pick = (style, prop) => {
  const m = style.match(new RegExp(`${prop}:\\s*(rgb\\([^)]*\\)|#[0-9a-fA-F]{3,6})`));
  return m ? m[1].replace(/\s/g, "") : "";
};

for (const c of cards) {
  const html = c.原文HTML || "";
  let m;
  while ((m = styleRe.exec(html))) add(pick(m[1], "color"), pick(m[1], "background-color"), m[2]);
  while ((m = fontRe.exec(html))) add(m[1], "", m[2]);
}

const sorted = [...combos.entries()].sort((a, b) => b[1].n - a[1].n);
console.log("颜色组合（按出现次数）→ 样例文字：\n");
for (const [key, e] of sorted) {
  console.log(`【${e.n}次】 ${key}`);
  console.log(`        例：${e.samples.join("  /  ") || "(无短样例)"}\n`);
}
