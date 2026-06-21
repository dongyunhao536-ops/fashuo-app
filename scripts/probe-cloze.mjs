// 一次性：用真实要点验证 L1 关键词填空的 Haiku 挖空提示词（产物是否合法 cloze）。
// 跑法：node --env-file=.env.local scripts/probe-cloze.mjs
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const ai = new Anthropic({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined });
const MODEL = process.env.MODEL_DRAFT ?? "claude-haiku-4-5-20251001";

const SYSTEM = `你把中文法考"背诵要点"改成"填空题"。规则：①逐条处理，保留整句结构，只把每条里【最该记的 1~2 个关键术语/数字】挖空，用全角符号 ▢ 占位（一个空一个 ▢）；②不要挖虚词、连词、"的/是/为/在/和"之类，也不要把整句都挖空；③输出严格 JSON 数组，每条形如 {"s":"挖空后的句子","a":["被挖掉的词1","被挖掉的词2"]}，a 的顺序与句中 ▢ 从左到右一一对应、个数相等；④只输出 JSON，不要任何解释。`;

const { data } = await sb.from("kp_state").select("kp_id, ext").limit(400);
const withKp = data.filter((r) => Array.isArray(r.ext?.l1_keypoints) && r.ext.l1_keypoints.length >= 3);
const samples = withKp.slice(0, 3);

for (const r of samples) {
  const kps = r.ext.l1_keypoints.slice(0, 8);
  const list = kps.map((k, i) => `${i + 1}. ${k}`).join("\n");
  console.log(`\n======【${r.ext?.name ?? r.kp_id}】======`);
  const resp = await ai.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: [{ type: "text", text: SYSTEM }],
    messages: [{ role: "user", content: `把下面每条要点改成填空：\n${list}` }],
  });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  let arr;
  try {
    arr = JSON.parse(text.slice(s, e + 1));
  } catch {
    console.log("✗ JSON 解析失败，原文：", text.slice(0, 200));
    continue;
  }
  for (const it of arr) {
    const blanks = (String(it.s).match(/▢/g) ?? []).length;
    const ok = blanks === (it.a?.length ?? -1) ? "✓" : `✗(▢${blanks}≠a${it.a?.length})`;
    console.log(`  ${ok} ${it.s}   ← ${JSON.stringify(it.a)}`);
  }
}
