// node --env-file=.env.local scripts/probe-effort.mjs
// 探针：thinking 旋钮在七牛云 Anthropic 兼容端点的真实形态。
// 试两套：① effort（七牛云文档说法）② budget_tokens（Anthropic 官方原生）
const models = ["claude-sonnet-4-20250514", "anthropic/claude-4.8-opus"];
const variants = [
  { label: "no-thinking", thinking: undefined },
  { label: "budget=1024", thinking: { type: "enabled", budget_tokens: 1024 } },
  { label: "budget=4096", thinking: { type: "enabled", budget_tokens: 4096 } },
  { label: "type=adaptive", thinking: { type: "adaptive" } },
];

for (const model of models) {
  for (const v of variants) {
    const body = {
      model,
      max_tokens: v.thinking?.budget_tokens ? v.thinking.budget_tokens + 200 : 300,
      messages: [
        { role: "user", content: "用两步规划法，吐出 JSON {\"steps\":[\"\",\"\"]}（仅 JSON，无多余文字）" },
      ],
    };
    if (v.thinking) body.thinking = v.thinking;

    const t0 = Date.now();
    const r = await fetch(process.env.LLM_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    const text = await r.text();
    let resp;
    try {
      resp = JSON.parse(text);
    } catch {
      console.log(`${model.padEnd(28)} ${v.label.padEnd(14)} → ${r.status} (${elapsed}ms) RAW: ${text.slice(0, 140)}`);
      continue;
    }
    if (r.status !== 200) {
      console.log(`${model.padEnd(28)} ${v.label.padEnd(14)} → ${r.status} ERR: ${resp.error?.message?.slice(0, 140)}`);
      continue;
    }
    const blocks = (resp.content ?? []).map((b) => b.type);
    const u = resp.usage ?? {};
    console.log(
      `${model.padEnd(28)} ${v.label.padEnd(14)} ${String(elapsed).padStart(6)}ms` +
        ` content=[${blocks.join(",")}]` +
        ` in:${u.input_tokens} out:${u.output_tokens}` +
        (blocks.includes("thinking") ? " ✓有thinking块" : ""),
    );
  }
}
