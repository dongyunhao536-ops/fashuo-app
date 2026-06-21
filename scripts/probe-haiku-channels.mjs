// 一次性：探针七牛云当前可用的 Haiku 渠道（3.5 将下架，找替代）。
// 跑法：node --env-file=.env.local scripts/probe-haiku-channels.mjs
// 七牛云 RPM≈1/min → 每个候选最多重试 3 次，撞 429 退避 35s。
import Anthropic from "@anthropic-ai/sdk";

const ai = new Anthropic({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined });

const CANDIDATES = [
  "claude-3-5-haiku-20241022",   // 现役（确认是否还活着）
  "claude-haiku-4-5-20251001",   // Haiku 4.5 官方 dated ID（首选替代）
  "claude-haiku-4-20250514",     // Haiku 4（6 月无渠道，复测）
  "anthropic/claude-4.5-haiku",  // 七牛云自家命名猜测（对齐 opus 命名风格）
  "anthropic/claude-haiku-4.5",  // 另一种命名猜测
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const model of CANDIDATES) {
  let verdict = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ai.messages.create({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      });
      const txt = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      verdict = `✅ 可用  (回 "${txt}")`;
      break;
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const msg = err?.message ?? String(err);
      if (status === 429 && attempt < 2) {
        console.log(`   …${model} 撞 429，退避 35s 重试`);
        await sleep(35000);
        continue;
      }
      verdict = `❌ ${status ?? "?"}  ${msg.slice(0, 140)}`;
      break;
    }
  }
  console.log(`${verdict}   ${model}`);
  await sleep(8000); // 错开 RPM
}
console.log("\n探针完毕。");
