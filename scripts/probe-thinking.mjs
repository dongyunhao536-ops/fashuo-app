// node --env-file=.env.local scripts/probe-thinking.mjs
// 用真实复杂案例题打 Opus 4.8，对比 baseline vs thinking:adaptive：
//   ① adaptive 会不会真的触发 thinking（用模拟答疑那种复杂法律推理）？
//   ② 触发后多花多少 thinking_tokens / 延迟？
//   ③ 输出本身在结构/长度上有差异吗？
const model = "anthropic/claude-4.8-opus";
const system = `你是法硕（非法学）答疑老师，按下面的 v2.3 严格证据链作答：
═══ 六步预检（先列）═══
□ 1. 题型 □ 2. 心得 □ 3. 易混 □ 4. 教材锚 □ 5. 真题锚 □ 6. 法律更新
═══ 作答结构 ═══
案例题四段：①结论 ②法理(行号+法条) ③涵摄 ④后果。
末尾「证据卡」必须列：教材锚/真题/心得/法硕立场/法律更新/信心度。`;

const grepStub = `【系统预检索】
■ search_textbook「故意伤害致死」
教材/刑法学.txt:1420► 故意伤害致人死亡，处十年以上有期徒刑、无期徒刑或者死刑（《刑法》第234条第2款）
教材/刑法学.txt:1421  转化型故意伤害致死与故意杀人罪的区分关键在于直接故意之于"伤害"还是"死亡"
■ search_textbook「因果关系」
教材/刑法学.txt:1108► 介入因素若属"异常且独立"则中断原行为与结果的因果关系
■ search_textbook「正当防卫」
教材/刑法学.txt:1305► 不法侵害正在进行 + 防卫意图 + 必要限度（《刑法》第20条）
■ search_xinde「偶然防卫」
真题分析/_刑法做题心得.md:88► 行为人不知道客观存在不法侵害而实施伤害行为=偶然防卫，通说不构成正当防卫，主观无防卫意图`;

const question = `案例：甲与乙长期不和。某日甲埋伏在小巷殴打乙，致乙重伤倒地。甲离开后约 5 分钟，路人丙
（与甲乙均不识）经过，见乙身上有钱包，遂偷走钱包并将奄奄一息的乙翻动至背朝下后离开。
乙因伤口血流被衣物压迫，10 分钟后窒息死亡。法医意见：若乙保持仰卧，重伤伤口虽危险但可
在送医后存活；丙的翻动是死亡的直接诱因。问：①甲对乙的死亡是否承担刑事责任？②丙的行
为构成何罪？请援引教材行号和心得规则作答。

${grepStub}`;

async function run(label, thinking) {
  const t0 = Date.now();
  const body = {
    model,
    max_tokens: 4000,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: question }],
  };
  if (thinking) body.thinking = thinking;
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
  if (r.status !== 200) {
    console.log(`✗ ${label}  HTTP ${r.status}  ${text.slice(0, 200)}`);
    return null;
  }
  const j = JSON.parse(text);
  const blocks = j.content ?? [];
  const thinkingBlock = blocks.find((b) => b.type === "thinking");
  const textBlock = blocks.find((b) => b.type === "text")?.text ?? "";
  const u = j.usage ?? {};
  console.log(
    `━━ ${label} ━━ ${(elapsed / 1000).toFixed(1)}s` +
      ` in:${u.input_tokens} out:${u.output_tokens}` +
      (thinkingBlock
        ? ` ✓thinking(${thinkingBlock.thinking?.length ?? 0}字符)`
        : " ✗未思考"),
  );
  console.log("[答案前 380]", textBlock.slice(0, 380).replace(/\n/g, " "));
  if (thinkingBlock) {
    const t = thinkingBlock.thinking ?? "";
    console.log("[思考前 240]", t.slice(0, 240).replace(/\n/g, " "));
    console.log(`[思考总长] ${t.length} 字符`);
  }
  return { elapsed, usage: u, thinkingBlock, textBlock };
}

console.log("用复杂案例题（多层涵摄：因果关系中断 + 偶然防卫 + 转化抢劫/盗窃）打 Opus 4.8：\n");
const a = await run("baseline（无 thinking）", undefined);
console.log();
const b = await run("adaptive（让模型自主决定）", { type: "adaptive" });

if (a && b) {
  // pricing.opus 估算（cost.ts 系族匹配）
  const opIn = 15 / 1e6, opOut = 75 / 1e6;
  const ca = (a.usage.input_tokens * opIn + a.usage.output_tokens * opOut) * 7.2;
  const cb = (b.usage.input_tokens * opIn + b.usage.output_tokens * opOut) * 7.2;
  console.log(`\n━━ 汇总 ━━`);
  console.log(`baseline: ${(a.elapsed / 1000).toFixed(1)}s  ¥${ca.toFixed(3)}`);
  console.log(`adaptive: ${(b.elapsed / 1000).toFixed(1)}s  ¥${cb.toFixed(3)}` + (b.thinkingBlock ? " (含思考块)" : " (adaptive 决定不思考)"));
  console.log(`差异: +${((b.elapsed - a.elapsed) / 1000).toFixed(1)}s, +¥${(cb - ca).toFixed(3)}`);
}
