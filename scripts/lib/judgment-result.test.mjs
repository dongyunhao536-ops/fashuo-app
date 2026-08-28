// [gpt] 2026-08-13：判题证据卡与 pending 病根纪律回归。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JUDGMENT_RESULT_SCHEMA_VERSION,
  JudgmentResultValidationError,
  judgmentResultContext,
  judgmentResultTemplate,
  renderJudgmentCard,
  validateJudgmentResult,
} from "./judgment-result.mjs";

function valid(overrides = {}) {
  return {
    schemaVersion: JUDGMENT_RESULT_SCHEMA_VERSION,
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

  // [gpt] 2026-08-26：答对不等于用户“排除了病根”；固定快路径可省掉 classify 的第二次同步。
  it("pass 只接受空 pending，不生成病根终态或候选", () => {
    const passed = validateJudgmentResult(valid({
      result: "pass",
      diagnosis: { status: "pending", claim: null, candidates: [], rejectedCandidates: [], recognitionRef: null },
    }));
    expect(passed.diagnosis).toEqual({
      status: "pending", claim: null, candidates: [], rejectedCandidates: [], recognitionRef: null,
    });
    expect(renderJudgmentCard(passed)).toContain("【病根·不新增】");
    expect(renderJudgmentCard(passed)).not.toContain("待认领");
    expect(() => validateJudgmentResult(valid({
      result: "pass",
      diagnosis: {
        status: "rejected",
        candidates: ["规则不会", "题干误读"],
        rejectedCandidates: ["规则不会", "题干误读"],
        recognitionRef: "user:turn-20",
      },
    }))).toThrow(/通过.*不产生新的病根终态/);
    expect(() => validateJudgmentResult(valid({
      result: "pass",
      diagnosis: { status: "pending", candidates: ["题干误读"] },
    }))).toThrow(/空 pending/);
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

  it("F6：证据卡字段拦孤立裸编号，并豁免并列列举", () => {
    expect(() => validateJudgmentResult(valid({ application: "已入账 #72。" }))).toThrow(/bare_reference_summary_required/);
    expect(validateJudgmentResult(valid({ application: "对照 L28／L29／L30 后确认边界。" })).application).toContain("L28／L29／L30");
  });
});

// [claude] 2026-08-26：本组是 fail-open 回归。2026-08-22 那份旧扁平 artifact
// （diagnosisStatus:"confirmed" + 字符串 diagnosis + evidenceAnchors）当时 ok:true，
// 病根被归一成 pending 静默丢失，证据卡照常渲染“本轮不作确定性病根推断”。
// 原测试只覆盖业务约束，不覆盖未知键与错误类型，所以一路放行。
describe("schema 严格化：未知键、错误类型与版本", () => {
  it("旧扁平 artifact 整份阻断，并逐键给迁移提示", () => {
    const legacy = {
      topicId: 93,
      eventId: 105,
      result: "pass",
      originalAnswer: "选 B，双方没有主仆名分。",
      userAnswer: "选 B，双方没有主仆名分。",
      correctAnswer: "B",
      verdict: "结论与依据均正确。",
      rule: "无主仆名分者依凡人科断。",
      application: "题干事实符合依凡人科断的条件。",
      evidenceAnchors: [{ source: "讲义", page: "第248页", lines: "10894-10900" }],
      evidence: [{ source: "法制史讲义", anchor: "清朝·第248页·行10894-10900", excerpt: "无主仆名分者依凡人科断。" }],
      confidence: "high",
      diagnosisStatus: "confirmed",
      diagnosis: "既有确认栽点为把条件性规则扩张适用；本次未复现。",
    };
    let caught = null;
    try { validateJudgmentResult(legacy); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(JudgmentResultValidationError);
    const codes = caught.issues.map((item) => `${item.code}:${item.field}`);
    expect(codes).toContain("deprecated_key:diagnosisStatus");
    expect(codes).toContain("deprecated_key:evidenceAnchors");
    expect(codes).toContain("deprecated_key:topicId");
    expect(codes).toContain("deprecated_key:userAnswer");
    expect(codes).toContain("schema_version_missing:schemaVersion");
    expect(codes).toContain("diagnosis_type_invalid:diagnosis");
    expect(caught.message).toContain("请改用 diagnosis.status");
  });

  it("键名对但类型错的 diagnosis 不再被归一成空对象", () => {
    expect(() => validateJudgmentResult(valid({ diagnosis: "题干误读" }))).toThrow(/diagnosis 必须是对象/);
    expect(() => validateJudgmentResult(valid({ diagnosis: ["题干误读"] }))).toThrow(/diagnosis 必须是对象/);
    expect(() => validateJudgmentResult(valid({ diagnosis: null }))).toThrow(/diagnosis 必须是对象/);
  });

  it("diagnosis 缺失也要显式阻断，通过的题同样得写 pending", () => {
    const { diagnosis, ...withoutDiagnosis } = valid();
    expect(diagnosis).toBeDefined();
    expect(() => validateJudgmentResult({ ...withoutDiagnosis, result: "pass" })).toThrow(/缺少 diagnosis/);
  });

  it("schemaVersion 缺失、类型错或版本不支持一律阻断", () => {
    const { schemaVersion, ...withoutVersion } = valid();
    expect(schemaVersion).toBe(JUDGMENT_RESULT_SCHEMA_VERSION);
    expect(() => validateJudgmentResult(withoutVersion)).toThrow(/缺少 schemaVersion/);
    expect(() => validateJudgmentResult(valid({ schemaVersion: "1" }))).toThrow(/不支持的 schemaVersion/);
    expect(() => validateJudgmentResult(valid({ schemaVersion: 2 }))).toThrow(/不支持的 schemaVersion/);
  });

  it("未知键在顶层、diagnosis 内层和 evidence 内层都拦", () => {
    expect(() => validateJudgmentResult(valid({ 备注: "随手加的" }))).toThrow(/未知字段 备注/);
    expect(() => validateJudgmentResult(valid({
      diagnosis: { status: "pending", candidates: ["规则不会", "题干误读"], confidence: "high" },
    }))).toThrow(/未知字段 confidence/);
    expect(() => validateJudgmentResult(valid({
      evidence: [{ source: "民法考试分析", anchor: "第42页·行120", excerpt: "摘要", page: "第42页" }],
    }))).toThrow(/未知字段 page/);
  });

  it("evidence 写成对象而非数组时报类型错，不静默当空", () => {
    expect(() => validateJudgmentResult(valid({
      evidence: { source: "民法考试分析", anchor: "第42页·行120", excerpt: "摘要" },
    }))).toThrow(/evidence 必须是数组/);
  });

  it("校验通过的结果再喂回校验器仍然通过——渲染器依赖这条", () => {
    const normalized = validateJudgmentResult(valid());
    expect(() => validateJudgmentResult(normalized)).not.toThrow();
    expect(normalized.schemaVersion).toBe(JUDGMENT_RESULT_SCHEMA_VERSION);
  });
});

// [claude] 2026-08-26：模板是唯一来源，漂移了就等于把执行者推回翻源码或抄旧文件。
describe("模板与校验器不漂移", () => {
  it("模板键集合与校验器接受的键集合逐层一致", () => {
    const template = judgmentResultTemplate();
    const accepted = validateJudgmentResult(valid());
    expect(Object.keys(template).sort()).toEqual(Object.keys(accepted).sort());
    expect(Object.keys(template.diagnosis).sort()).toEqual(Object.keys(accepted.diagnosis).sort());
    expect(Object.keys(template.evidence[0]).sort()).toEqual(Object.keys(accepted.evidence[0]).sort());
  });

  it("按模板骨架填真值即可直接通过，无需再翻源码", () => {
    const filled = {
      ...judgmentResultTemplate(),
      targetRef: "T#90/E#102",
      result: "pass",
      originalAnswer: "选 C，元朝取消门下省与尚书省。",
      verdict: "结论与依据均正确。",
      rule: "元朝以中书省取代隋唐三省，六部隶属中书省。",
      application: "所选项与教材表述一致。",
      evidence: [{ source: "法制史讲义", anchor: "元朝行政立法·第213页·行9275-9281", excerpt: "中书省下仍设吏、户、礼、兵、刑、工六部。" }],
      confidence: "high",
      diagnosis: { status: "pending", claim: null, candidates: [], rejectedCandidates: [], recognitionRef: null },
    };
    expect(validateJudgmentResult(filled).targetRef).toBe("T#90/E#102");
  });

  // [claude] 2026-08-26：文档漂移和代码漂移一样致命——散文过期时执行者不会知道，
  // 只会照着过期的骨架写，然后卡在 Gate 上重新去翻源码，等于把这次修的洞又挖回来。
  it("数据契约.md 里的骨架与模板逐层一致", () => {
    const doc = readFileSync(new URL("../../.agents/skills/cuoti-fupan/数据契约.md", import.meta.url), "utf8");
    const block = doc.match(/judgment-schema:begin[\s\S]*?```json\n([\s\S]*?)\n```/u);
    expect(block, "数据契约.md 里找不到 judgment-schema 标记块").not.toBeNull();
    const documented = JSON.parse(block[1]);
    const template = judgmentResultTemplate();
    expect(Object.keys(documented).sort()).toEqual(Object.keys(template).sort());
    expect(Object.keys(documented.diagnosis).sort()).toEqual(Object.keys(template.diagnosis).sort());
    expect(Object.keys(documented.evidence[0]).sort()).toEqual(Object.keys(template.evidence[0]).sort());
    expect(documented.schemaVersion).toBe(JUDGMENT_RESULT_SCHEMA_VERSION);
  });

  it("开场上下文自带模板与版本，正常会话零额外调用", () => {
    const context = judgmentResultContext("SR-20260826-005110-5eec30a7");
    expect(context.command).toContain("--run SR-20260826-005110-5eec30a7");
    expect(context.schemaVersion).toBe(JUDGMENT_RESULT_SCHEMA_VERSION);
    expect(context.template.diagnosis.status).toContain("pending");
    expect(context.templateRule).toContain("未知字段");
  });
});
