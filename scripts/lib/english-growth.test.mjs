// [gpt] 2026-08-10：英语成长系统的样本闸、生命周期调度与作文个人装配测试。

import { describe, expect, it } from "vitest";
import {
  annotateCorpusUsage,
  buildCompositionKit,
  buildEnglishCapabilityProfile,
  buildEnglishTrainingPlan,
  parseEnglishCorpus,
  parseEnglishLedger,
  selectNextReadingAssignment,
} from "./english-growth.mjs";

function readingEntry(index, score, extra = "") {
  const day = String(index + 1).padStart(2, "0");
  return `## 2026-08-${day}｜阅读｜2016 Text ${index + 1}
- **会话键**：EN-202608${day}-R-${index + 1}
- **诊断依据**：答案键+原文
- **得分**：4/5
- **用时**：18
- **能力观测**：定位=${score}/4｜改写=NA｜范围程度=NA｜观点归属=NA｜推理边界=NA｜长句归属=NA｜置信校准=NA
- **门槛观测**：限时=pass
- **语料调用**：无
${extra}`;
}

describe("英语能力画像", () => {
  it("样本不足时拒绝给正式比例，3次后暂定、5次后稳定", () => {
    const two = buildEnglishCapabilityProfile(parseEnglishLedger([readingEntry(0, 1), readingEntry(1, 2)].join("\n")));
    expect(two.tracks.reading.attempt.dimensions.locating).toMatchObject({
      samples: 2,
      observedPercent: 38,
      qualifiedPercent: null,
      confidence: "insufficient",
    });

    const three = buildEnglishCapabilityProfile(parseEnglishLedger([readingEntry(0, 1), readingEntry(1, 2), readingEntry(2, 3)].join("\n")));
    expect(three.tracks.reading.attempt.dimensions.locating).toMatchObject({ samples: 3, qualifiedPercent: 50, confidence: "provisional" });

    const five = buildEnglishCapabilityProfile(parseEnglishLedger([1, 2, 3, 3, 4].map((score, index) => readingEntry(index, score)).join("\n")));
    expect(five.tracks.reading.attempt.dimensions.locating.confidence).toBe("stable");
  });

  it("6次以后才计算趋势，且没有明示观测的维度保持未观测", () => {
    const profile = buildEnglishCapabilityProfile(parseEnglishLedger([1, 1, 2, 3, 4, 4].map((score, index) => readingEntry(index, score)).join("\n")));
    expect(profile.tracks.reading.attempt.dimensions.locating.trendDelta).toBeGreaterThan(0);
    expect(profile.tracks.reading.attempt.dimensions.paraphrase).toMatchObject({ samples: 0, observedPercent: null, confidence: "none" });
  });

  it("有结构化观测却缺诊断依据时报警，不把叙事当证据", () => {
    const markdown = `## 2026-08-10｜作文｜2024 小作文
- **会话键**：EN-20260810-W-1
- **载体**：回信
- **得分**：7/10
- **能力观测·首稿**：任务完整=2/4｜载体处理=3/4｜结构组织=3/4｜论证展开=NA｜语言准确=2/4｜语料调用=1/4
- **门槛观测·首稿**：限时=pass｜要素清单=fail
- **语料调用**：无`;
    const parsed = parseEnglishLedger(markdown);
    expect(parsed.practices).toHaveLength(1);
    expect(parsed.issues.map((item) => item.code)).toContain("missing_english_diagnostic_source");
  });
});

describe("作文个人装配器", () => {
  const corpusMarkdown = `# 语料
## D2. 社会民生
living standards / public well-being / cultural heritage
## D3. 阅读迁移
- 🌱 \`______ must take responsibility for its impact on young people.\`
## E1. 通用格式
- 称呼：\`Dear Paul,\`
- 落款：\`Yours sincerely,\` + \`Li Ming\`
## E2. 回信型
- 🌱 \`As for your first question, ______.\`
- ✅ \`I would be glad to answer both of your questions.\``;

  it("解析固定格式、种子与个人句，并给出稳定ID", () => {
    const first = parseEnglishCorpus(corpusMarkdown);
    const second = parseEnglishCorpus(corpusMarkdown);
    expect(first.phrases.some((item) => item.status === "fixed")).toBe(true);
    expect(first.phrases.some((item) => item.status === "owned")).toBe(true);
    expect(first.phrases.map((item) => item.id)).toEqual(second.phrases.map((item) => item.id));
    expect(first.themeTerms.d2).toContain("public well-being");
  });

  it("已用种子只升级为 used，不冒充 owned；装配包不生成完整首稿", () => {
    const corpus = parseEnglishCorpus(corpusMarkdown);
    const seed = corpus.phrases.find((item) => item.status === "seed");
    const annotated = annotateCorpusUsage(corpus, [{ date: "2026-08-10", phraseUsages: [{ phraseId: seed.id, result: "pass" }] }]);
    expect(annotated.phrases.find((item) => item.id === seed.id)).toMatchObject({ effectiveStatus: "used", usage: { uses: 1, pass: 1 } });
    const profile = buildEnglishCapabilityProfile(parseEnglishLedger(""));
    const kit = buildCompositionKit({
      carrier: "reply",
      theme: "d2",
      requirements: ["回答展示什么", "回答能够提供什么帮助"],
      corpus: annotated,
      profile,
    });
    expect(kit.checklist).toHaveLength(2);
    expect(kit.phrases.some((item) => item.effectiveStatus === "owned")).toBe(true);
    expect(kit.phrases.some((item) => item.sectionId === "E2")).toBe(true);
    expect(kit.policy).toContain("禁止生成完整范文");
    const cartoonKit = buildCompositionKit({ carrier: "cartoon", theme: "d2", corpus: annotated, profile });
    expect(cartoonKit.readingTransfer?.sectionId).toBe("D3");
  });

  it("小作文未提供题干要素时明确阻断可靠 checklist", () => {
    const kit = buildCompositionKit({
      carrier: "reply",
      corpus: annotateCorpusUsage(parseEnglishCorpus(corpusMarkdown), []),
      profile: buildEnglishCapabilityProfile(parseEnglishLedger("")),
    });
    expect(kit.blockers.join(" ")).toContain("未提供题干");
  });
});

describe("英语训练调度", () => {
  it("生命周期训练轴之外还给出下一个未完成的具体篇目，并封存 2025+", () => {
    const rows = [1, 2, 3, 4].map((text) => ({ subject: "英语", chapter: `2016 Text ${text}` }));
    expect(selectNextReadingAssignment(rows)).toMatchObject({ year: 2017, text: 1, label: "2017 Text 1" });
    const all = [];
    for (let year = 2016; year <= 2024; year += 1) for (let text = 1; text <= 4; text += 1) all.push({ subject: "英语", chapter: `${year} Text ${text}` });
    expect(selectNextReadingAssignment(all)).toBeNull();
  });
  it("到期生命周期复检压过画像训练和普通保温", () => {
    const profile = buildEnglishCapabilityProfile(parseEnglishLedger([readingEntry(0, 1), readingEntry(1, 1), readingEntry(2, 1)].join("\n")));
    const plan = buildEnglishTrainingPlan({
      profile,
      lifecycle: [{
        topicId: 12,
        title: "推理题×过度推理",
        computedMasteryStatus: "monitoring",
        nextProbe: { earliestDate: "2026-08-10", variantKind: "novel_case", transferLevel: 4, probeAxis: "degree_term" },
      }],
      corpus: annotateCorpusUsage(parseEnglishCorpus(""), []),
      referenceDate: "2026-08-10",
      essayDue: false,
    });
    expect(plan.selected).toMatchObject({ kind: "lifecycle_review", topicId: 12, track: "reading" });
  });

  it("作文锚点已到且没有个人句时优先启动真实写作", () => {
    const plan = buildEnglishTrainingPlan({
      profile: buildEnglishCapabilityProfile(parseEnglishLedger("")),
      lifecycle: [],
      corpus: annotateCorpusUsage(parseEnglishCorpus(""), []),
      referenceDate: "2026-08-10",
      essayDue: true,
    });
    expect(plan.selected.kind).toBe("essay_bootstrap");
  });
});
