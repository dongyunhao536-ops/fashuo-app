// node --env-file=.env.local scripts/probe-effort.mjs
// 探针：effort / thinking 旋钮在七牛云 Anthropic 兼容端点的【当前】真实形态（2026-06-21 复测）。
// 重点验三件事：① effort=high 能不能收（旧版 400）② thinking 能不能开 ③ 思考内容还被抹空吗(redacted)。
// 七牛云 RPM≈1/min → 每调用 8s 间隔 + 撞 429 退避 35s 重试 1 次。
const models = ["anthropic/claude-4.8-opus", "anthropic/claude-4.7-opus"];

// 每个变体 = 往请求体打的补丁（除 model/max_tokens/messages 外）
const variants = [
  { label: "baseline", patch: {} },
  { label: "output_config.effort=high", patch: { output_config: { effort: "high" } } },
  { label: "top-level effort=high", patch: { effort: "high" } },
  { label: "thinking.effort=high", patch: { thinking: { type: "enabled", effort: "high" } } },
  { label: "thinking.budget=2048", patch: { thinking: { type: "enabled", budget_tokens: 2048 } } },
  { label: "thinking.adaptive", patch: { thinking: { type: "adaptive" } } },
];

// 需要点推理的题（让 thinking 有机会真触发）
const PROMPT =
  "甲深夜入户盗窃，被主人发现后为抗拒抓捕当场使用暴力致主人轻伤。请一步步分析甲构成何罪，仅输出结论一句话。";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(body) {
  return fetch(process.env.LLM_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

for (const model of models) {
  console.log(`\n===== ${model} =====`);
  for (const v of variants) {
    const budget = v.patch.thinking?.budget_tokens;
    const body = {
      model,
      max_tokens: budget ? budget + 400 : 600,
      messages: [{ role: "user", content: PROMPT }],
      ...v.patch,
    };

    let r, text;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      r = await call(body);
      text = await r.text();
      if (r.status === 429 && attempt === 0) {
        console.log(`   …${v.label} 撞 429，退避 35s`);
        await sleep(35000);
        continue;
      }
      var elapsed = Date.now() - t0;
      break;
    }

    let resp;
    try {
      resp = JSON.parse(text);
    } catch {
      console.log(`  ✗ ${v.label.padEnd(26)} → ${r.status} RAW: ${text.slice(0, 120)}`);
      await sleep(8000);
      continue;
    }
    if (r.status !== 200) {
      console.log(`  ✗ ${v.label.padEnd(26)} → ${r.status}  ${resp.error?.message?.slice(0, 120)}`);
      await sleep(8000);
      continue;
    }
    const thinkBlocks = (resp.content ?? []).filter((b) => b.type === "thinking");
    const thinkLen = thinkBlocks.reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
    const u = resp.usage ?? {};
    const redacted = thinkBlocks.length > 0 && thinkLen === 0 ? " ⚠️思考被抹空(redacted)" : "";
    const visible = thinkLen > 0 ? ` ✓思考可见${thinkLen}字` : "";
    console.log(
      `  ✅ ${v.label.padEnd(26)} ${String(elapsed).padStart(6)}ms` +
        ` content=[${(resp.content ?? []).map((b) => b.type).join(",")}]` +
        ` in:${u.input_tokens} out:${u.output_tokens}${visible}${redacted}`,
    );
    await sleep(8000);
  }
}
console.log("\n探针完毕。");
