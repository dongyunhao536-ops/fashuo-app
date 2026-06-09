#!/usr/bin/env node
/**
 * AI 综合判频：每科把【高频考点文件全文 + 教材考点列表】喂 Opus，语义判每个考点 高/中/低，回填 zhenti_freq。
 * 根治纯字符串匹配的"通用短语扩散"（共同犯罪→8细分全高、法人→16个全高）。
 *
 * 输出用【行格式】(kp_id 频率)而非 JSON——Opus 中文里偶用 ASCII 引号会破坏 JSON（2026-06-09 教训）。
 * 用法：node --env-file=.env.local scripts/ai-freq.mjs 刑法 [--commit]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FASHUO = process.env.FASHUO_ROOT ?? "D:/fashuo";
const FILES = {
  刑法: "02_刑法高频考点",
  民法: "03_民法高频考点",
  法理: "04_法理学高频考点",
  宪法: "05_宪法高频考点",
  法制史: "06_法制史高频考点",
};
const PREFIX = { 刑法: "XF", 民法: "MF", 法理: "FL", 宪法: "XZ", 法制史: "LS" };
const SUBJECT = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!FILES[SUBJECT]) {
  console.error("用法: ai-freq.mjs 刑法|民法|法理|宪法|法制史 [--commit]");
  process.exit(1);
}

const base = process.env.LLM_BASE_URL;
const key = process.env.LLM_API_KEY;
const md = readFileSync(`${FASHUO}/真题分析/${FILES[SUBJECT]}.md`, "utf8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const { data: kps } = await sb
  .from("kp_state")
  .select("kp_id, ext")
  .eq("subject", SUBJECT)
  .order("kp_id");

const list = kps.map((k) => `${k.kp_id} ${k.ext?.name ?? ""}`).join("\n");

const system = `你是法硕（非法学）命题规律专家。下面给你某一科的【高频考点归纳文件】（基于 2014-2025 历年真题整理，⭐ 越多越高频，带年份标记如 2024-7 表示该年考过），和一批【教材考点】。
请你逐个判断每个教材考点的真题考查频率，分三档：
- 高：高频文件明确列为核心考点 / ⭐⭐⭐ / 每年必考 / 多年真题反复命中
- 中：高频文件提及、或属重要章节但非年年考
- 低：高频文件几乎未涉及 / 边缘细节考点
判断要落到【每一个具体考点】，不要因为它属于某个高频章节就全标高——同一章节里有的细分点高频、有的低频，要区分。

【硬性输出格式】每个考点输出一行：考点ID<空格>频率（只能是 高/中/低 三个字之一）。不要任何解释、不要表头、不要 JSON、不要 markdown。必须覆盖给你的【每一个】考点ID。
示例：
${PREFIX[SUBJECT]}-0001 中
${PREFIX[SUBJECT]}-0002 高`;

const user = `【高频考点文件】\n${md}\n\n【待判教材考点】（共 ${kps.length} 个，每行：ID 名称）\n${list}\n\n现在逐行输出每个考点的频率（ID 频率）：`;

console.log(`▶ ${SUBJECT}：${kps.length} 个考点送 Opus 判频…`);
const reqBody = JSON.stringify({
  model: "anthropic/claude-4.7-opus",
  max_tokens: 8000,
  system: [{ type: "text", text: system }],
  messages: [{ role: "user", content: user }],
});
async function callWithRetry() {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: reqBody,
    });
    if (r.status === 429) {
      const w = Math.min(20000, 3000 * 2 ** i);
      console.log(`  RPM 429，等 ${w / 1000}s 重试…`);
      await new Promise((s) => setTimeout(s, w));
      continue;
    }
    return await r.json();
  }
  throw new Error("429 重试耗尽");
}
const j = await callWithRetry();
if (j.error) {
  console.error("✗ API 错误:", JSON.stringify(j.error));
  process.exit(1);
}
const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

// 解析 "ID 频率" 行
const map = {};
const re = new RegExp(`(${PREFIX[SUBJECT]}-\\d{4})\\s*[：:\\s]\\s*(高|中|低)`, "g");
let m;
while ((m = re.exec(text)) !== null) map[m[1]] = m[2];

const RANK = { 低: 0, 中: 1, 高: 2 };
const dist = { 高: 0, 中: 0, 低: 0 };
const updates = [];
let missing = 0;
for (const kp of kps) {
  const f = map[kp.kp_id];
  if (!f) {
    missing++;
    dist.低++; // 漏判 → 保守给低
    continue;
  }
  dist[f]++;
  if (f !== (kp.ext?.zhenti_freq ?? "低"))
    updates.push({ kp_id: kp.kp_id, freq: f, ext: { ...kp.ext, zhenti_freq: f } });
}

// 成本估算（七牛云 = 官方价 × 0.334；input $5 / output $25 per M）
const u = j.usage || {};
const inTok = u.input_tokens ?? 0;
const outTok = u.output_tokens ?? 0;
const usd = (inTok * 5 + outTok * 25) / 1e6 * 0.334;
console.log(`\n═══ ${SUBJECT} AI 判频 ${COMMIT ? "· 写入" : "· DRY-RUN"} ═══`);
console.log(`Opus 返回判定: ${Object.keys(map).length} / ${kps.length}（漏判 ${missing} → 保守给低）`);
console.log(`分布: 高${dist.高} 中${dist.中} 低${dist.低}`);
console.log(`token: in ${inTok} / out ${outTok} ≈ ¥${(usd * 7.2).toFixed(3)}`);
console.log(`\n高频样本(前 18)：`);
kps.filter((k) => map[k.kp_id] === "高").slice(0, 18).forEach((k) => console.log(`  [高] ${k.ext?.name}`));
console.log(`\n低频样本(前 8)：`);
kps.filter((k) => map[k.kp_id] === "低").slice(0, 8).forEach((k) => console.log(`  [低] ${k.ext?.name}`));

if (!COMMIT) {
  console.log(`\nDRY-RUN 完成。加 --commit 写入。`);
  process.exit(0);
}
let done = 0;
for (const upd of updates) {
  const { error } = await sb.from("kp_state").update({ ext: upd.ext }).eq("kp_id", upd.kp_id);
  if (!error) done++;
}
console.log(`✓ 已更新 ${done} 个 kp（${kps.length - updates.length} 个频率未变）`);
