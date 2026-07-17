// node --env-file=.env.local scripts/probe-model.mjs <model_id> [<model_id> ...]
// 探针：用 Anthropic 协议 messages 接口，向 LLM_BASE_URL 发一次最小调用，确认模型 ID 是否可用。
// 用例：node --env-file=.env.local scripts/probe-model.mjs anthropic/claude-4.0-sonnet moonshotai/kimi-k2-thinking
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("用法：node scripts/probe-model.mjs <model_id> [<model_id> ...]");
  process.exit(1);
}
for (const id of ids) {
  const r = await fetch(process.env.LLM_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: id,
      max_tokens: 60,
      messages: [{ role: "user", content: "请仅返回这个 JSON：{\"ok\":1}" }],
    }),
  });
  const t = await r.text();
  console.log(id, "→", r.status, t.slice(0, 240).replace(/\n/g, " "));
}
