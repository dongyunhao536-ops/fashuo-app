// 验证背诵 L1 双模式判分落地：① 读法理某考点已写库的 l1_cloze(含 mode) ② 用 Haiku 跑语义判分提示词，
// 确认"自己的话/同义→过、答错/空泛→挂"。跑法：node --env-file=.env.local scripts/probe-cloze-grade.mjs
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ai = new Anthropic({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined });
const MODEL = process.env.MODEL_DRAFT || "claude-haiku-4-5-20251001";

// ① 抽一个有 semantic 空的法理考点，看挖空写库没有
const { data } = await sb.from("kp_state").select("kp_id, ext").eq("subject", "法理").limit(400);
const withCloze = (data ?? []).filter((k) => Array.isArray(k.ext?.l1_cloze) && k.ext.l1_cloze.some((c) => c.mode === "semantic"));
console.log(`法理有 semantic 挖空的考点：${withCloze.length} 个`);
const sample = withCloze.find((k) => k.ext.name?.includes("效力")) || withCloze[0];
console.log(`\n样例考点：${sample.ext.name}`);
for (const c of sample.ext.l1_cloze) console.log(`  [${c.mode}] ${c.s}  ← ${c.a.join(" / ")}`);

// ② 用判分提示词测语义判：同义该过、答错/空泛该挂
const ans = "法律对法律主体的应然约束力或拘束力";
const pairs = [
  { answer: ans, fill: "法对法律主体产生的、应该遵守的约束力或拘束力", expect: true, desc: "同义改写" },
  { answer: ans, fill: "法律对人的实际强制执行力", expect: false, desc: "偷换(应然→实际)" },
  { answer: ans, fill: "就是法律的作用", expect: false, desc: "空泛套话" },
];
const list = pairs.map((p, i) => `${i + 1}. 标准答案：「${p.answer}」 ｜ 考生填：「${p.fill}」`).join("\n");
const system = `你给中文法考填空题判对错。【按意思判，不要求逐字】：考生填入与标准答案【意思一致 / 同义 / 涵盖其关键点】=对(true)；意思错、答非所问、空泛套话、漏掉关键限定 =错(false)。不放水也不抠字面。仅输出一个 JSON 布尔数组，长度与条数相同（如 [true,false,true]），不要任何解释。`;
const r = await ai.messages.create({ model: MODEL, max_tokens: 200, system, messages: [{ role: "user", content: `逐条判断：\n${list}` }] });
const txt = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
const arr = JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1));
console.log("\n语义判分实测（Haiku）：");
let pass = 0;
pairs.forEach((p, i) => { const got = arr[i] === true; const ok = got === p.expect; if (ok) pass++; console.log(`  ${ok ? "✓" : "✗"} ${p.desc}：判${got ? "过" : "挂"}（应${p.expect ? "过" : "挂"}）`); });
console.log(`\n${pass === pairs.length ? "✅ 语义判分按预期：同义算过、偷换/空泛判挂" : "⚠️ 有偏差，需调提示词"}`);
