// node --env-file=.env.local scripts/smoke-llm.mjs
// 七牛云 Claude 连通 + 缓存烟测。会真实花费（~¥0.5）。需手动运行。
// 验证：①连接/模型/已去掉 output_config ②prompt caching 透传 ③记账写入 api_usage
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const MODEL = process.env.MODEL_ASK ?? "anthropic/claude-4.7-opus";
const client = new Anthropic({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || undefined,
});
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const pricing = JSON.parse(readFileSync("config/pricing.json", "utf8"));
const RMB = pricing._汇率 ?? 7.2;
const P = pricing.opus;
const usd = (u) =>
  (u.in * P.input + u.cw * P.cache_write + u.cr * P.cache_read + u.out * P.output) / 1e6;

function pick(msg) {
  const u = msg.usage ?? {};
  return {
    in: u.input_tokens ?? 0,
    cw: u.cache_creation_input_tokens ?? 0,
    cr: u.cache_read_input_tokens ?? 0,
    out: u.output_tokens ?? 0,
  };
}
async function record(u) {
  const cost = usd(u);
  await sb.from("api_usage").insert({
    route: "smoketest",
    model: MODEL,
    input_tokens: u.in,
    cache_write_tokens: u.cw,
    cache_read_tokens: u.cr,
    output_tokens: u.out,
    est_cost_usd: cost,
  });
  return cost;
}
const text = (m) =>
  (m.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

let total = 0;

// ── 测试 A：最小连通调用（验证去掉 output_config 后能 200）──
console.log("【A】最小连通调用 ...");
try {
  const a = await client.messages.create({
    model: MODEL,
    max_tokens: 50,
    messages: [{ role: "user", content: "用一句话回答：法硕考试分析这本书是干嘛的？" }],
  });
  const ua = pick(a);
  total += await record(ua);
  console.log(`  ✓ 200  回答：${text(a).slice(0, 60)}`);
  console.log(`  usage: 非缓存输入 ${ua.in} / 输出 ${ua.out}`);
} catch (e) {
  console.log(`  ✗ 失败：${e.status ?? ""} ${e.message}`);
  console.log("  （若是 output_config 相关 400，说明代码没去干净；若 429=限速，稍后重试）");
  process.exit(1);
}

// ── 测试 B：缓存透传（同一 ≥4096 token 前缀连发两次）──
console.log("\n【B】缓存透传测试（同前缀连发两次）...");
const md = readFileSync("D:/fashuo/真题分析/_刑法做题心得.md", "utf8").slice(0, 6000);
const prefix = `以下是刑法做题心得（仅作缓存测试上下文）：\n${md}`;

async function createWithRetry(params, max = 6) {
  for (let a = 0; a <= max; a++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      if (e.status === 429 && a < max) {
        const wait = 15000 + a * 10000; // 15s,25s,35s... RPM 窗口约 1 分钟
        console.log(`    （429 限速，等 ${wait / 1000}s 重试 ${a + 1}/${max}）`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

async function cachedCall(tag) {
  const m = await createWithRetry({
    model: MODEL,
    max_tokens: 30,
    system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "只回复两个字：收到" }],
  });
  const u = pick(m);
  total += await record(u);
  console.log(`  ${tag}: 缓存创建 ${u.cw} / 缓存命中 ${u.cr} / 非缓存输入 ${u.in} / 输出 ${u.out}`);
  return u;
}

try {
  const b1 = await cachedCall("第1次");
  await new Promise((r) => setTimeout(r, 12000)); // 错开 RPM（七牛云限速狠）
  const b2 = await cachedCall("第2次");

  if (b2.cr > 0) {
    console.log(`  ✓ 缓存命中确认：第2次 cache_read=${b2.cr} > 0，七牛云透传 caching 有效`);
  } else if (b1.cw > 0) {
    console.log("  ⚠️ 第1次写了缓存但第2次没命中——可能 TTL/前缀不稳；caching 半可用，需再观察");
  } else {
    console.log("  ⚠️ 两次都无缓存字段——七牛云此 key 可能未透传 caching（成本模型要上调）");
  }
} catch (e) {
  console.log(`  ✗ 缓存测试失败：${e.status ?? ""} ${e.message}`);
}

console.log(`\n本次烟测估算花费：$${total.toFixed(4)} ≈ ¥${(total * RMB).toFixed(2)}`);
console.log("跑 npm run cost 看累计（route=smoketest）。真实账单以七牛云控制台为准。");
