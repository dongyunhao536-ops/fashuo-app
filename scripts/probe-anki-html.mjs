// 一次性：抽样看 Anki 原文HTML 的真实标注（蓝#55aaff/橙#ffaa7f/加粗 各包了什么文字），
// 判断"蓝=必背关键词?橙=?"以定 L1 挖空靶。跑法：node scripts/probe-anki-html.mjs [关键词]
import { readFileSync } from "node:fs";

const kw = process.argv[2] || "法的概念";
const raw = JSON.parse(readFileSync("src/data/anki_extracted.json", "utf8"));
const cards = Array.isArray(raw) ? raw : raw.cards;
console.log(`总卡数 ${cards.length}；搜「${kw}」`);

const hit = cards.find((c) => JSON.stringify(c).includes(kw) && /color=|<b>/.test(c.原文HTML || ""));
if (!hit) {
  console.log("没找到含该词且带标注的卡");
  process.exit(0);
}
const html = hit.原文HTML || "";
console.log(`\n=== 卡 title: ${hit.title} (note ${hit.note_id}, 星${hit.星级}) ===\n`);
console.log("【原文HTML 前 1400 字】\n" + html.slice(0, 1400));

// 抽出各标注包裹的纯文字
const grab = (re) => [...html.matchAll(re)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
console.log("\n--- 蓝 #55aaff 包裹 ---\n", grab(/<font color=\\?"?#55aaff\\?"?>(.*?)<\/font>/g).slice(0, 20));
console.log("\n--- 橙 #ffaa7f 包裹 ---\n", grab(/<font color=\\?"?#ffaa7f\\?"?>(.*?)<\/font>/g).slice(0, 20));
console.log("\n--- 加粗 <b> 包裹 ---\n", grab(/<b>(.*?)<\/b>/g).slice(0, 20));
