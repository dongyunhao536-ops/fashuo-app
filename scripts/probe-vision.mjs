// 一次性：探七牛云图像输入（拍照识别可行性，2026-06-21）。测两条路：
//   A) Claude（Anthropic 协议 /v1/messages）认不认 image 块 —— 若认，集成最省（复用 anthropic.ts）
//   B) Qwen-VL（OpenAI 兼容 /v1/chat/completions，image_url）—— 兜底路径
// 跑法：node --env-file=.env.local scripts/probe-vision.mjs
import { readFileSync } from "node:fs";

const b64 = readFileSync("D:/fashuo-app/tmp-ocr-test.png").toString("base64");
const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
const PROMPT = "读出这张图里的所有中文文字，逐行原样输出，不要解释。";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testAnthropic(model) {
  const r = await fetch(BASE + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  const t = await r.text();
  if (r.status !== 200) return `❌ ${r.status} ${t.slice(0, 160)}`;
  try {
    const j = JSON.parse(t);
    const out = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return `✅ 200 识别="${out.replace(/\n/g, " / ")}"`;
  } catch { return `？200 但解析失败 ${t.slice(0, 120)}`; }
}

async function testOpenAI(model) {
  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  const t = await r.text();
  if (r.status !== 200) return `❌ ${r.status} ${t.slice(0, 160)}`;
  try {
    const j = JSON.parse(t);
    const out = (j.choices?.[0]?.message?.content ?? "").trim();
    return `✅ 200 识别="${String(out).replace(/\n/g, " / ")}"`;
  } catch { return `？200 但解析失败 ${t.slice(0, 120)}`; }
}

console.log("A) Anthropic 协议 + claude-haiku-4-5-20251001：");
console.log("   " + (await testAnthropic("claude-haiku-4-5-20251001")));
await sleep(8000);
console.log("A') Anthropic 协议 + anthropic/claude-4.8-opus：");
console.log("   " + (await testAnthropic("anthropic/claude-4.8-opus")));
await sleep(8000);
console.log("B) OpenAI 兼容 + qwen2.5-vl-72b-instruct：");
console.log("   " + (await testOpenAI("qwen2.5-vl-72b-instruct")));
console.log("\n探针完毕。");
