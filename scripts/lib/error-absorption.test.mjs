import { describe, expect, it } from "vitest";
import { summarizeEventAbsorptionProof } from "./error-absorption.mjs";

// [gpt] 2026-08-10：防止“一次答对就销账”回归。
const event = { id: 102, log_date: "2026-08-09" };

function pass(id, axis, overrides = {}) {
  return {
    id,
    topic_id: 90,
    study_error_id: 102,
    review_date: "2026-08-10",
    result: "pass",
    dimension: "application",
    cold: id === 1,
    prompt_integrity: "clean",
    variant_kind: "counterfactual",
    transfer_level: 3,
    probe_axis: axis,
    angle: `角度${id}`,
    evidence_anchor: `教材锚点${id}`,
    note: `保留原答与依据${id}`,
    ...overrides,
  };
}

describe("study error absorption proof", () => {
  it("一次合格 L3 通过仍拒绝销账", () => {
    const proof = summarizeEventAbsorptionProof({ event, primaryTopicId: 90, reviews: [pass(1, "fact_signal")], referenceDate: "2026-08-10" });
    expect(proof.eligible).toBe(false);
    expect(proof.blockers.join("；")).toContain("1/2 条");
  });

  it("改写 angle 但仍是同一验证轴不能凑门槛", () => {
    const proof = summarizeEventAbsorptionProof({ event, primaryTopicId: 90, reviews: [pass(1, "fact_signal"), pass(2, "fact_signal")], referenceDate: "2026-08-10" });
    expect(proof.eligible).toBe(false);
    expect(proof.axes).toEqual(["fact_signal"]);
  });

  it("两轴通过仍必须至少含一次跨会话冷检", () => {
    const reviews = [pass(1, "fact_signal", { cold: false }), pass(2, "rule_boundary", { cold: false })];
    const proof = summarizeEventAbsorptionProof({ event, primaryTopicId: 90, reviews, referenceDate: "2026-08-10" });
    expect(proof.eligible).toBe(false);
    expect(proof.blockers).toContain("至少需要一次跨会话冷检通过");
  });

  it("一条冷检加一条无提示补充角度、两轴且有依据时允许销账", () => {
    const proof = summarizeEventAbsorptionProof({ event, primaryTopicId: 90, reviews: [pass(1, "fact_signal"), pass(2, "rule_boundary")], referenceDate: "2026-08-10" });
    expect(proof).toMatchObject({ eligible: true, passCount: 2, coldPassCount: 1, axes: ["fact_signal", "rule_boundary"] });
  });

  it("最近失败会清空此前通过，当日新错也禁止销账", () => {
    const fail = pass(3, "concept_boundary", { result: "fail", review_date: "2026-08-10" });
    const afterFailure = summarizeEventAbsorptionProof({ event, primaryTopicId: 90, reviews: [pass(1, "fact_signal"), pass(2, "rule_boundary"), fail], referenceDate: "2026-08-10" });
    expect(afterFailure.eligible).toBe(false);
    expect(afterFailure.passCount).toBe(0);

    const sameDay = summarizeEventAbsorptionProof({ event: { ...event, log_date: "2026-08-10" }, primaryTopicId: 90, reviews: [pass(1, "fact_signal"), pass(2, "rule_boundary")], referenceDate: "2026-08-10" });
    expect(sameDay.eligible).toBe(false);
    expect(sameDay.blockers).toContain("当日新错不得当天销账");
  });
});
