import { describe, expect, it } from "vitest";
import {
  buildReviewEvidence,
  cleanTopicTitle,
  nextMasteryStatus,
  normalizeSubject,
  parseAddArgs,
  parseTopicOptions,
  recommendNextReviewProbe,
  summarizeReviewProof,
  topicInsertPayload,
  topicKey,
  validateFailurePattern,
  validateReviewDate,
  validateRootCause,
} from "./error-taxonomy.mjs";

describe("error taxonomy", () => {
  it("归一科目全称和主题排版，但保留可读标题", () => {
    expect(normalizeSubject(" 法理学 ")).toBe("法理");
    expect(cleanTopicTitle("  监护人   顺位  ")).toBe("监护人 顺位");
    expect(topicKey("法理学", "法律 继承")).toBe(topicKey("法理", "法律继承"));
  });

  it("同一科目同一主题生成稳定键，不把不同主题误合并", () => {
    expect(topicKey("刑法", "共同犯罪成立前提")).toBe(topicKey("刑法", "共同犯罪成立前提"));
    expect(topicKey("刑法", "共同犯罪成立前提")).not.toBe(topicKey("刑法", "主犯认定"));
  });

  it("解析兼容旧 add，同时接受结构化分类参数", () => {
    const parsed = parseAddArgs([
      "民法", "监护顺位题误选", "--topic", "监护人顺位的法定条件",
      "--chapter", "第三章 自然人", "--cause", "boundary_miss",
      "--pattern", "exception_omission",
      "--diagnosis", "confirmed", "--anchor", "考试分析L120-126",
      "--recur-of", "81",
    ]);
    expect(parsed).toMatchObject({
      subject: "民法",
      knowledge: "监护顺位题误选",
      recurOf: 81,
      topic: {
        title: "监护人顺位的法定条件",
        chapter: "第三章 自然人",
        rootCauseCode: "boundary_miss",
        failurePatternCode: "exception_omission",
        diagnosisStatus: "confirmed",
        classificationStatus: "confirmed",
      },
    });
  });

  it("没有主题时不允许悬空填写病根或章节", () => {
    expect(() => parseTopicOptions(["--cause-note", "漏了原则例外"])).toThrow("必须先给 --topic");
    expect(() => validateRootCause("粗心")).toThrow("未知病根代码");
    expect(() => validateFailurePattern("粗心")).toThrow("未知栽点代码");
  });

  it("add 可单独保留事件章节，主题未知时交给校验器标 pending", () => {
    expect(parseAddArgs(["刑法", "犯罪中止时间点误判", "--chapter", "故意犯罪停止形态"])).toMatchObject({
      subject: "刑法",
      chapter: "故意犯罪停止形态",
      topic: null,
    });
  });

  it("主题分类与病根认领分开：主题可确认而病根仍待认领", () => {
    const { topic } = parseTopicOptions(["--topic", "审题层级错位"]);
    expect(topic).toMatchObject({
      classificationStatus: "confirmed",
      rootCauseCode: "unclassified",
      diagnosisStatus: "pending",
    });
  });

  it("主题 payload 不把事件长文本当主题键", () => {
    const payload = topicInsertPayload("宪法学", {
      title: "国家机构领导与指导关系",
      chapter: "第五章 国家机构",
      classificationStatus: "confirmed",
    }, "2026-08-05T00:00:00.000Z");
    expect(payload).toMatchObject({
      subject: "宪法",
      title: "国家机构领导与指导关系",
      chapter: "第五章 国家机构",
      classification_status: "confirmed",
      updated_at: "2026-08-05T00:00:00.000Z",
    });
    expect(payload.topic_key).toMatch(/^宪法:[a-f0-9]{20}$/);
  });

  it("旧版 pass 只兼容 monitoring，结构化迁移证据满足跨时与换角度门槛才 stable", () => {
    expect(nextMasteryStatus([])).toBe("open");
    expect(nextMasteryStatus([{ id: 1, review_date: "2026-08-03", result: "pass" }])).toBe("monitoring");
    expect(nextMasteryStatus([
      { id: 2, review_date: "2026-08-05", result: "pass" },
      { id: 1, review_date: "2026-08-03", result: "pass" },
    ])).toBe("monitoring");

    const reviews = [
      {
        id: 1, review_date: "2026-08-03", result: "pass", dimension: "application",
        cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3,
        probe_axis: "subject_condition",
        angle: "改变主体条件", evidence_anchor: "变式卷#1",
      },
      {
        id: 2, review_date: "2026-08-10", result: "pass", dimension: "application",
        cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4,
        probe_axis: "time_condition",
        angle: "改变时间条件", evidence_anchor: "变式卷#2",
      },
    ];
    expect(nextMasteryStatus(reviews)).toBe("stable");
    expect(summarizeReviewProof(reviews)).toMatchObject({
      status: "stable",
      qualifyingPassCount: 2,
      passDates: ["2026-08-03", "2026-08-10"],
      spanDays: 7,
      hasNovelTransfer: true,
    });
    expect(nextMasteryStatus([
      ...reviews,
      {
        id: 3, review_date: "2026-08-11", result: "fail", dimension: "application",
        cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4,
        probe_axis: "fact_signal",
        angle: "再换案情", evidence_anchor: "变式卷#3",
      },
    ])).toBe("open");
  });

  it("同场、提示、原题复现和规则复述均不能伪造迁移稳定", () => {
    const base = {
      result: "pass",
      prompt_integrity: "clean",
      probe_axis: "rule_boundary",
      angle: "边界变化",
      evidence_anchor: "测试锚点",
    };
    const proof = summarizeReviewProof([
      { ...base, id: 1, review_date: "2026-08-01", dimension: "application", cold: false, variant_kind: "novel_case", transfer_level: 4 },
      { ...base, id: 2, review_date: "2026-08-08", dimension: "application", cold: false, prompt_integrity: "cued", variant_kind: "novel_case", transfer_level: 4 },
      { ...base, id: 3, review_date: "2026-08-15", dimension: "application", cold: true, variant_kind: "original", transfer_level: 1 },
      { ...base, id: 4, review_date: "2026-08-22", dimension: "recall", cold: true, variant_kind: "teach_back", transfer_level: 5 },
    ]);
    expect(proof.status).toBe("open");
    expect(proof.qualifyingPassCount).toBe(0);
    expect(summarizeReviewProof([{
      id: 5,
      review_date: "2026-08-23",
      result: "pass",
      variant_kind: "novel_case",
    }])).toMatchObject({ status: "open", legacyPassCount: 0 });
  });

  it("新复检写入按变式派生等级，并严格隔离作废题", () => {
    expect(buildReviewEvidence({
      result: "pass",
      variantKind: "counterfactual",
      cold: true,
      promptIntegrity: "clean",
      probeAxis: "rule_boundary",
      angle: "改变例外条件",
      evidenceAnchor: "教材L120-126",
    })).toMatchObject({ dimension: "application", transferLevel: 3 });
    expect(buildReviewEvidence({
      result: "void",
      variantKind: "invalid",
      cold: false,
      promptIntegrity: "invalid",
    })).toMatchObject({ dimension: "application", transferLevel: 0 });
    expect(() => buildReviewEvidence({
      result: "pass",
      variantKind: "invalid",
      cold: false,
      promptIntegrity: "invalid",
    })).toThrow("作废复检必须同时使用");
    expect(() => buildReviewEvidence({
      result: "pass",
      variantKind: "novel_case",
      cold: true,
      promptIntegrity: "clean",
      probeAxis: "rule_boundary",
      angle: "缺锚点",
    })).toThrow("必须提供 --anchor");
    expect(() => buildReviewEvidence({
      result: "pass",
      variantKind: "counterfactual",
      cold: true,
      promptIntegrity: "clean",
      angle: "缺验证轴",
      evidenceAnchor: "测试锚点",
    })).toThrow("未知验证轴");
    expect(() => buildReviewEvidence({
      result: "pass",
      variantKind: "counterfactual",
      promptIntegrity: "clean",
      probeAxis: "rule_boundary",
      angle: "缺 cold",
      evidenceAnchor: "测试锚点",
    })).toThrow("cold 必须是布尔值");
    expect(validateReviewDate("2026-08-10")).toBe("2026-08-10");
    expect(() => validateReviewDate("2026-02-30")).toThrow("有效的 YYYY-MM-DD 北京日");
  });

  it("自由文本 angle 改写不能伪造第二个验证轴", () => {
    const proof = summarizeReviewProof([
      {
        id: 1, review_date: "2026-08-01", result: "pass", dimension: "application",
        cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3,
        probe_axis: "rule_boundary", angle: "改变例外条件", evidence_anchor: "变式#1",
      },
      {
        id: 2, review_date: "2026-08-08", result: "pass", dimension: "application",
        cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4,
        probe_axis: "rule_boundary", angle: "换成但书条件", evidence_anchor: "变式#2",
      },
    ]);
    expect(proof).toMatchObject({ status: "monitoring", probeAxes: ["rule_boundary"] });
    expect(proof.angles).toHaveLength(2);
    expect(proof.blockers).toContain("需要至少两个不同的结构化验证轴");
  });

  it("下一探针按已确认栽点、证据缺口与冷却期确定，不输出概率", () => {
    const baseline = recommendNextReviewProbe([], {
      referenceDate: "2026-08-10",
      failurePatternCode: "subject_confusion",
    });
    expect(baseline).toMatchObject({
      variantKind: "counterfactual",
      transferLevel: 3,
      probeAxis: "subject_condition",
      earliestDate: "2026-08-10",
      reasonCode: "establish_transfer_baseline",
      sourceFailurePattern: "subject_confusion",
    });
    expect(baseline).not.toHaveProperty("probability");

    const onePass = [{
      id: 1, review_date: "2026-08-08", result: "pass", dimension: "application",
      cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3,
      probe_axis: "subject_condition", angle: "改变主体", evidence_anchor: "变式#1",
    }];
    expect(recommendNextReviewProbe(onePass, {
      referenceDate: "2026-08-10",
      failurePatternCode: "subject_confusion",
    })).toMatchObject({
      variantKind: "novel_case",
      transferLevel: 4,
      probeAxis: "concept_boundary",
      earliestDate: "2026-08-15",
      reasonCode: "raise_to_novel_transfer",
    });

    const afterFailure = [...onePass, {
      id: 2, review_date: "2026-08-10", result: "fail", dimension: "application",
      cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4,
      probe_axis: "concept_boundary", angle: "陌生案例", evidence_anchor: "变式#2",
    }];
    expect(recommendNextReviewProbe(afterFailure, {
      referenceDate: "2026-08-10",
      failurePatternCode: "subject_confusion",
    })).toMatchObject({
      variantKind: "counterfactual",
      transferLevel: 3,
      probeAxis: "subject_condition",
      earliestDate: "2026-08-12",
      reasonCode: "repair_after_failure",
    });
  });
});
