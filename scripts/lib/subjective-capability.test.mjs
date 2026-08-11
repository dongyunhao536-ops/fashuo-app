// [gpt] 2026-08-10：内部能力画像纯函数测试，覆盖显式解析、趋势和同题去重。
import { describe, expect, it } from "vitest";
import { buildSubjectiveAnalytics, parseSubjectivePracticeSignals } from "./subjective-capability.mjs";

describe("subjective capability", () => {
  it("只接受契约内的维度、量表和门槛值", () => {
    const parsed = parseSubjectivePracticeSignals(`
- **画像标签**：主科=刑法｜辅科=无｜专题=共犯,罪数
- **诊断依据**：官方答案
- **能力观测·首稿**：定性=4/4｜规则=NA｜涵摄=2/4｜收口=3/4
- **门槛观测·首稿**：设问层=pass｜时限回扫=partial
- **病灶观测·首稿**：A1@C1=fail
`, { kind: "案例", line: 12 });

    expect(parsed).toMatchObject({
      track: "case",
      primarySubject: "刑法",
      diagnosticSource: "official",
      dimensions: { draft: { classification: 4, subsumption: 2, closure: 3 } },
      notApplicable: { draft: ["rule"] },
      gates: { draft: { taskLevel: "pass", timingReview: "partial" } },
      defectObservations: [{ defectId: "A1", rootCode: "C1", outcome: "fail", stage: "draft" }],
    });
    expect(parsed.issues).toEqual([]);
  });

  it("拒绝越界分值和不存在的维度，不把坏字段带进画像", () => {
    const parsed = parseSubjectivePracticeSignals(`
- **画像标签**：主科=法理｜辅科=无｜专题=法治
- **诊断依据**：官方答案
- **能力观测·首稿**：概念=5/4｜涵摄=2/4
`, { kind: "论述", line: 8 });

    expect(parsed.dimensions.draft).toEqual({});
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "invalid_subjective_dimension_score",
      "unknown_subjective_dimension",
    ]);
  });

  it("六次观测才计算趋势，同一练笔的同根病灶只算一个 episode", () => {
    const values = [1, 1, 1, 3, 3, 3];
    const practices = values.map((value, index) => ({
      date: `2026-08-0${index + 1}`,
      kind: "论述",
      title: `论述 57型｜样本${index + 1}`,
      line: index + 1,
      signals: {
        track: "essay",
        primarySubject: "法理",
        secondarySubjects: [],
        topics: [`专题${index + 1}`],
        diagnosticSource: "official",
        dimensions: { draft: { concept: value }, rewrite: {} },
        gates: { draft: {}, rewrite: {} },
        defectObservations: [
          { defectId: "B1", rootCode: null, outcome: "fail", stage: "draft" },
          { defectId: "B2", rootCode: null, outcome: "partial", stage: "draft" },
        ],
      },
    }));
    const analytics = buildSubjectiveAnalytics(practices, {
      defects: [
        { id: "B1", title: "缺结合句", rootCode: "C1" },
        { id: "B2", title: "涵摄复述", rootCode: "C1" },
      ],
    });

    expect(analytics.capabilityProfile.tracks.essay.draft.dimensions.concept).toMatchObject({
      samples: 6,
      observedPercent: 50,
      qualifiedPercent: 50,
      confidence: "stable",
      trendDelta: 50,
    });
    expect(analytics.propagation.roots[0]).toMatchObject({ rootCode: "C1", issueEpisodes: 6, observedEpisodes: 6 });
  });
});
