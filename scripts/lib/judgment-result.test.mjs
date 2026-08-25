// [gpt] 2026-08-13：判题证据卡与 pending 病根纪律回归。

import { describe, expect, it } from "vitest";
import { JudgmentResultValidationError, renderJudgmentCard, validateJudgmentResult } from "./judgment-result.mjs";

function valid(overrides = {}) {
  return {
    targetRef: "T#95/E#107",
    result: "partial",
    originalAnswer: "选 A，因为登记后才发生效力。",
    verdict: "结论选对，但依据把生效与对抗混为一谈。",
    rule: "登记不是该权利成立的一般要件，但可能影响对抗效力。",
    application: "题干只问成立时间，不能把对抗规则代入成立要件。",
    evidence: [{ source: "民法考试分析", anchor: "物权编·第3章·第42页·所有权取得·行120", excerpt: "登记要件与对抗要件应区分。" }],
    confidence: "high",
    diagnosis: { status: "pending", candidates: ["规则不会：未掌握成立与对抗的区分", "题干误读：把对抗对象误当成立时间"] },
    ...overrides,
  };
}

describe("validateJudgmentResult", () => {
  it("生成包含原答、规则、涵摄、证据锚点和待认领候选的证据卡", () => {
    const card = renderJudgmentCard(valid());
    expect(card).toContain("【证据卡】");
    expect(card).toContain("物权编·第3章·第42页");
    expect(card).toContain("【病根·待认领】以下仅为候选");
  });

  it("pending 禁止确定性 claim 或病根就是式表述", () => {
    expect(() => validateJudgmentResult(valid({
      diagnosis: { status: "pending", claim: "你的病根就是题干误读", candidates: ["你的病根是规则不会", "题干误读"] },
    }))).toThrow(JudgmentResultValidationError);
    expect(() => validateJudgmentResult(valid({ application: "这说明你的病根就是题干误读。" }))).toThrow(/pending/);
    expect(() => validateJudgmentResult(valid({ application: "这个错误暴露了新的相邻概念混淆。" }))).toThrow(/pending/);
  });

  it("partial/fail 的 pending 必须提供 2–4 个候选", () => {
    expect(() => validateJudgmentResult(valid({ diagnosis: { status: "pending", candidates: ["规则不会"] } }))).toThrow(/2–4/);
  });

  it("confirmed 必须同时有结论和认领引用", () => {
    expect(() => validateJudgmentResult(valid({ diagnosis: { status: "confirmed", claim: "混淆成立与对抗" } }))).toThrow(/认领/);
    const candidates = valid().diagnosis.candidates;
    const confirmed = validateJudgmentResult(valid({ diagnosis: {
      status: "confirmed",
      claim: candidates[1],
      candidates,
      rejectedCandidates: [candidates[0]],
      recognitionRef: "user:turn-18",
    } }));
    expect(confirmed.diagnosis.status).toBe("confirmed");
    expect(renderJudgmentCard(confirmed)).toContain("【本轮已排除】");
  });

  it("终态必须原样保留全部候选与排除路径，不能在认领后改写", () => {
    const candidates = valid().diagnosis.candidates;
    expect(() => validateJudgmentResult(valid({ diagnosis: {
      status: "confirmed",
      claim: candidates[0],
      candidates,
      rejectedCandidates: ["事后新编候选"],
      recognitionRef: "user:turn-18",
    } }))).toThrow(/逐字来自/);
    expect(validateJudgmentResult(valid({ diagnosis: {
      status: "rejected",
      candidates,
      rejectedCandidates: candidates,
      recognitionRef: "user:turn-18",
    } })).diagnosis.rejectedCandidates).toEqual(candidates);
  });

  it("untraceable 只接受用户明确决定引用，并在临时卡保留但不确诊候选", () => {
    const candidates = valid().diagnosis.candidates;
    const item = validateJudgmentResult(valid({ diagnosis: {
      status: "untraceable",
      candidates,
      recognitionRef: "user:turn-19 原话：早忘了，不认领",
    } }));
    expect(renderJudgmentCard(item)).toContain("仅存本 Run artifact·未形成事实");
    expect(() => validateJudgmentResult(valid({ diagnosis: {
      status: "untraceable",
      candidates,
      recognitionRef: "run_close",
    } }))).toThrow(/user:/);
  });

  it("缺证据锚点或涵摄时直接阻断", () => {
    expect(() => validateJudgmentResult(valid({ application: "", evidence: [{ source: "教材", anchor: "", excerpt: "规则摘要" }] }))).toThrow(/涵摄/);
    expect(() => validateJudgmentResult(valid({ evidence: [{ source: "民法考试分析", anchor: "未给定位", excerpt: "规则摘要" }] }))).toThrow(/锚点/);
  });

  it("教材证据必须同时有页码和行号；真题必须有年份与题号", () => {
    expect(() => validateJudgmentResult(valid({
      evidence: [{ source: "法制史讲义", anchor: "清朝刑事立法·第245页", excerpt: "规则摘要" }],
    }))).toThrow(/页码.*行号/);
    expect(validateJudgmentResult(valid({
      evidence: [{ source: "2019年法硕综合真题", anchor: "第49题及解析", excerpt: "答案为 ACD" }],
    })).evidence[0].anchor).toContain("第49题");
  });

  it("targetRef 必须带稳定 T#，允许同时附 E#事件号", () => {
    expect(validateJudgmentResult(valid()).targetRef).toBe("T#95/E#107");
    expect(() => validateJudgmentResult(valid({ targetRef: "E#107" }))).toThrow(/T#/);
    expect(() => validateJudgmentResult(valid({ targetRef: "T#95/监护顺位" }))).toThrow(/模糊文本/);
  });
});
