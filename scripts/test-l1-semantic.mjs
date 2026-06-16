// L1 语义兜底（Haiku）多场景活体测试：重点验证它【会不会放水】——
// 答对要过、换说法要过、答错小节/答错概念/完全跑题都必须判未过。
// 严格复刻 detection.ts 的 buildL1Reference + gradeL1Semantic 提示词。
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const anki = require("../src/data/anki_extracted.json");
const cards = Array.isArray(anki) ? anki : anki.cards;
const byId = new Map(cards.map((c) => [c.note_id, c]));

const PUNCT = /[\s、，。；：;:,.()（）""""''《》<>【】\[\]·]+/g;
const normalize = (s) => (s || "").replace(PUNCT, "").replace(/[。，！？]/g, "");
function keywordCore(k) {
  let s = (k || "").trim(), p = "";
  while (p !== s) { p = s; s = s.replace(/^[（(]?\s*[0-9０-９]+\s*[）)]?\s*[.、:：)]?\s*/, "").replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "").replace(/^[Øø•·▪◦*\-—]+\s*/, "").replace(/^(概念|含义|特征|定义|理解|要点)\s*[:：]\s*/, ""); }
  return normalize(s);
}
function uniqShort(items) {
  const seen = new Set(), out = [];
  for (const raw of items) { const s = (raw || "").trim(); if (!s || s.length > 80) continue; const core = keywordCore(s); if (core.length < 2 || seen.has(core)) continue; seen.add(core); out.push(s); }
  return out.slice(0, 20);
}
function answerKeyOf(kp) {
  // 镜像 detection.ts：考点专属 l1_keypoints 优先
  const cur = kp.ext.l1_keypoints;
  if (Array.isArray(cur) && cur.length >= 2) return cur;
  const ids = kp.ext.anki_note_ids || [];
  const cs = ids.map((i) => byId.get(i)).filter(Boolean);
  if (!cs.length) return [];
  const pick = [...cs].sort((a, b) => (b.星级 || 0) - (a.星级 || 0))[0];
  const segs = (pick.分段 || []).filter((s) => s.P1必背高精.length || s.P2必背.length || s.口诀.length);
  const seg = segs.length === 1 ? segs[0] : null;
  const p1 = (seg?.P1必背高精) ?? pick.P1必背高精 ?? [];
  const mn = ((seg?.口诀) ?? pick.口诀 ?? []).map((s) => s.replace(/【.+?】/g, ""));
  const core = p1.length ? p1 : ((seg?.P2必背) ?? pick.P2必背 ?? []);
  return uniqShort([...core, ...mn]);
}
function buildL1Reference(kp) {
  const cur = kp.ext.l1_keypoints; // 镜像 detection.ts：专属要点优先做参考
  if (Array.isArray(cur) && cur.length >= 2) return cur.map((s) => "· " + s).join("\n");
  const ids = kp.ext.anki_note_ids || [];
  const lines = [];
  for (const id of ids) {
    const c = byId.get(id); if (!c) continue;
    const mn = (c.口诀 || []).map((s) => s.replace(/【.+?】/g, ""));
    for (const s of [...(c.P1必背高精 || []), ...(c.P2必背 || []), ...(c.客观点 || []), ...mn]) { const t = (s || "").trim(); if (t) lines.push("· " + t); }
  }
  return lines.slice(0, 40).join("\n") || "（本节无结构化要点，按考点名常识判断）";
}
function prompt(kp, answerKey) {
  const kpName = kp.ext.name, subject = kp.subject, reference = buildL1Reference(kp);
  return `你在批改一道法硕「L1 记忆默写」题。考生正在背诵考点【${kpName}】（${subject}）。

【判分原则】
- 按【意思】判，不要求逐字：考生换种说法、答得更细、要点更全，都算覆盖到位。
- 考生只需回忆出与【${kpName}】直接相关的核心要点即可；本节可能还含其他小考点，别因为他没背别的小考点就判错。
- 答错题=未过：若考生答的明显是本节【另一个小考点】的内容（而非【${kpName}】本身），即便那段答得对，也判【未过】——这是答错题、不是答得不全。
- 不放水：与【${kpName}】相关的核心要点缺失 / 关键定性写错 = 未过；核心覆盖但有遗漏 = 勉强；核心都到位 = 干净通过。

【本节参考要点（考生应从中回忆出与考点相关的核心点）】
${reference}

【命题脚本自动抽取的关键词靶（可能只覆盖了本节某一小点，仅供参考；不要因为考生没默到这一条就判错）】
${answerKey.map((k) => "- " + k).join("\n")}

严格输出 JSON（不要任何额外文字、不要 markdown 代码块）：
{"grade":"干净通过|勉强|未过","hits":["考生答对的要点"],"missing":["该补的要点"],"confidence":0-100,"explanation":"一句话评分理由"}`;
}

// (kpId, 作答, 期望: pass=应过(干净通过/勉强) / fail=应未过)
const SCEN = [
  ["MF-0001", "民法就是调整平等主体之间的人身关系和财产关系的法律规范的总和", "pass", "换说法答对概念"],
  ["MF-0001", "刑法是规定犯罪和刑罚的法律规范", "fail", "答成刑法（彻底跑题，放水检验）"],
  ["FL-0001", "法学是以法这种社会现象及其规律为研究对象的人文社会科学", "pass", "自己话答对法学概念"],
  ["FL-0001", "法学产生要满足两个条件：法律材料积累和专门研究的学者阶层出现", "fail", "答的是【产生发展】不是【概念】——靶歧义鉴别"],
  ["FL-0002", "法学的产生必须满足两个条件：1有关于法律现象材料的积累 2有专门研究法律现象的学者阶层", "pass", "答对【产生发展】"],
  ["FL-0002", "法学又称法律科学，是研究法律现象的学科", "fail", "答的是【概念】不是【产生发展】——反向鉴别"],
  ["MF-0012", "公平原则是指民事主体应本着公平理念从事民事活动，权利义务对等", "pass", "答对公平原则（卡的靶却是'民法基本原则'通用定义——靠语义兜底救回）"],
  ["MF-0012", "诚信原则要求民事主体诚实守信，不得欺诈", "fail", "答成【诚信原则】（同节兄弟原则，鉴别）"],
  ["FL-0001", "嗯我觉得这个就是研究法律的吧，具体记不清了", "fail", "含糊敷衍无实质内容"],
];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const client = new Anthropic({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL });
const model = process.env.MODEL_DRAFT;
console.log("模型:", model, "\n");
let pass = 0, fail = 0;
async function callRetry(params, tries = 5) {
  for (let i = 0; i <= tries; i++) {
    try { return await client.messages.create(params); }
    catch (e) { if (e.status !== 429 || i === tries) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
}
for (const [kpId, answer, expect, note] of SCEN) {
  const { data: kp } = await sb.from("kp_state").select("kp_id,subject,ext").eq("kp_id", kpId).single();
  const ak = answerKeyOf(kp);
  const resp = await callRetry({ model, max_tokens: 600, system: [{ type: "text", text: prompt(kp, ak) }], messages: [{ role: "user", content: `【考生作答】\n${answer}` }] });
  await new Promise((r) => setTimeout(r, 3500)); // 拉开间隔躲 RPM
  const txt = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let g = "?", expl = "";
  try { const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); g = j.grade; expl = j.explanation; } catch { expl = txt.slice(0, 60); }
  const passed = g === "干净通过" || g === "勉强";
  const ok = (expect === "pass") === passed;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✅" : "❌ 误判"} [${kpId} 期望${expect === "pass" ? "过" : "未过"}] 判=${g}  ←${note}`);
  console.log(`    理由: ${expl}`);
}
console.log(`\n=== ${pass}/${SCEN.length} 符合预期，${fail} 个误判 ===`);
