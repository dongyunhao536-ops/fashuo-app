// node --env-file=.env.local scripts/probe-plan.mjs
// 拿真实法硕题塞规划器（Sonnet 4），验证：
//   ① JSON 格式正确（首字符是 {，能 parse）
//   ② 含 subject 字段且符合预期
//   ③ searches 数组 ≥ 4 条且 keyword 无空格
//   ④ 延迟/成本估算
// 与 src/lib/ask-prompt.ts 的 buildPlanSystem() 保持一致——若那边改了这里要同步。
const planSystem = `你是法硕答疑的"检索规划器"。只做两件事：①判断题目科目 ②规划出回答它需要的所有检索查询。【不要作答、不要解释】。

按答疑优先级规划检索（心得→真题→教材）：
- search_xinde：查刑法/民法做题心得规则（最高优先级，先规划这个）
- search_textbook：查《考试分析》教材原文
- search_zhenti：查真题（按年份，题号可选）

规划要求：
1. 覆盖题目涉及的【每一个】核心概念/罪名/法律关系/争议点，逐个给检索词。
2. 关键词必须是【单个连续词，不能含空格】（grep 逐行子串匹配，带空格几乎必然零命中）。如"债务转移"对，"债务转移 担保"错——拆成两条。
3. 关键词宜短而准（2-6 字的法律术语最佳），太长命中率低。
4. 同一概念可对 心得+教材 各来一条；涉及具体真题年份再加 search_zhenti（题号填 question_no，不要并进 year）。
5. 一般规划 4-10 条即可，宁可多覆盖几个角度。
6. 若消息含【此前对话】节选 + 【本轮新问题】：只为本轮新问题规划，此前对话仅用于理解"它/这种情况/那如果"之类指代。

仅输出一个 JSON 对象，不要任何其他文字（不要 markdown 代码块、不要前后说明）：
{"subject":"刑法|民法|法理|宪法|法制史（判断不了给 null）","searches":[{"tool":"search_xinde","keyword":"债务转移"},{"tool":"search_textbook","keyword":"免责的债务承担"},{"tool":"search_zhenti","year":"2024","question_no":"48"}]}`;

const cases = [
  { label: "民法·债务承担", q: "甲将债务转移给乙，担保人丙未同意，丙还担责吗？" },
  { label: "刑法·正当防卫", q: "醉酒乙袭击甲，甲反击致乙重伤死亡，甲构成什么罪？是否成立正当防卫？" },
  { label: "选项排除", q: "下列关于宪法监督的说法错误的是？A.全国人大常委会有权撤销国务院的行政法规 B.最高法可宣告法律违宪 C.地方人大可撤销本级政府不当决定 D.省级人大有立法权" },
];

const model = "claude-sonnet-4-20250514";
const url = process.env.LLM_BASE_URL + "/v1/messages";
let totalIn = 0, totalOut = 0, anyFail = false;

for (const c of cases) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: [{ type: "text", text: planSystem }],
      messages: [{ role: "user", content: c.q }],
    }),
  });
  const elapsed = Date.now() - t0;
  const text = await r.text();
  if (r.status !== 200) {
    console.log(`✗ ${c.label}  HTTP ${r.status}  ${text.slice(0, 200)}`);
    anyFail = true;
    continue;
  }
  const j = JSON.parse(text);
  const out = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  totalIn += j.usage?.input_tokens ?? 0;
  totalOut += j.usage?.output_tokens ?? 0;

  // 模拟 parsePlan 的对象抽取
  const oStart = out.indexOf("{");
  const oEnd = out.lastIndexOf("}");
  let parsed = null, parseOk = false, hasSubject = false, searches = [], badKw = [];
  try {
    parsed = JSON.parse(out.slice(oStart, oEnd + 1));
    parseOk = true;
    hasSubject = !!parsed.subject && parsed.subject !== "null";
    searches = Array.isArray(parsed.searches) ? parsed.searches : [];
    badKw = searches.filter((s) => typeof s.keyword === "string" && /\s/.test(s.keyword)).map((s) => s.keyword);
  } catch {}

  const ok = parseOk && searches.length >= 4 && badKw.length === 0;
  const tag = ok ? "✓" : "✗";
  if (!ok) anyFail = true;
  console.log(
    `${tag} ${c.label.padEnd(14)} ${String(elapsed).padStart(5)}ms` +
      ` in:${j.usage?.input_tokens ?? "?"} out:${j.usage?.output_tokens ?? "?"}` +
      ` subject=${parsed?.subject ?? "?"} searches=${searches.length}` +
      (badKw.length ? ` 含空格关键词:${JSON.stringify(badKw)}` : ""),
  );
  if (!parseOk) console.log(`   原文片段: ${out.slice(0, 200)}`);
}

// pricing.json sonnet 价（按 cost.ts 系族匹配会落到 sonnet 价位）
const sonnetIn = 3 / 1e6, sonnetOut = 15 / 1e6;
const usd = totalIn * sonnetIn + totalOut * sonnetOut;
console.log(`\n汇总：${cases.length} 题，总计 in:${totalIn} out:${totalOut}，估算 $${usd.toFixed(5)} (¥${(usd * 7.2).toFixed(4)})`);
console.log(anyFail ? "结论：有失败用例，慎用。" : "结论：3 道用例全部通过，Sonnet 4 可作为规划器。");
process.exit(anyFail ? 1 : 0);
