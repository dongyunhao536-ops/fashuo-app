// [gpt] 2026-08-10：干预响应闭环的纯函数回归覆盖。
import { describe, expect, it } from "vitest";
import { buildInterventionResponse, findInterventionResponse, findProtocolResponse } from "./intervention-response.mjs";

function item(id, kpId, outcome, overrides = {}) {
  return {
    id,
    dueDate: "2026-08-01",
    completedOn: "2026-08-08",
    status: "completed",
    subject: "刑法",
    kpId,
    failurePatternCode: "scope_expansion",
    failurePatternScope: "subject",
    route: "cuoti-fupan",
    dimension: "application",
    interventionCode: "scope_expansion@cuoti-fupan:application",
    baselineRisk: 80,
    expectedOutcome: "clean-pass",
    outcome,
    cold: true,
    promptIntegrity: "clean",
    ...overrides,
  };
}

function episodeRows(episodeId, kpId, protocolCode, outcomes, startedOn = "2026-08-01") {
  const dates = { immediate: startedOn, d3: "2026-08-04", d14: "2026-08-15", d30: "2026-08-31" };
  return Object.entries(outcomes).map(([window, outcome]) => ({
    id: `${episodeId}-${window}`,
    dueDate: dates[window],
    completedOn: dates[window],
    status: "completed",
    subject: "刑法",
    kpId,
    failurePatternCode: "scope_expansion",
    failurePatternScope: "subject",
    route: "cuoti-fupan",
    dimension: "application",
    interventionCode: "scope_expansion@cuoti-fupan:application",
    interventionEpisodeId: episodeId,
    protocolCode,
    protocolVersion: 1,
    observationWindow: window,
    episodeStartedOn: startedOn,
    baselineRisk: 80,
    expectedOutcome: "clean-pass",
    outcome,
    cold: window !== "immediate",
    promptIntegrity: "clean",
  }));
}

describe("intervention response", () => {
  it("跨两个知识点的三次有效结果形成受支持的观察性策略", () => {
    const response = buildInterventionResponse({
      reviewSchedule: { items: [
        item("R1", "XF-0001", "pass", { baselineRisk: 82 }),
        item("R2", "XF-0002", "pass", { baselineRisk: 78 }),
        item("R3", "XF-0002", "partial", { baselineRisk: 76 }),
      ] },
      examForecast: { hotspots: [
        { kpId: "XF-0001", lossRiskIndex: 60 },
        { kpId: "XF-0002", lossRiskIndex: 58 },
      ] },
      failurePortrait: { bySubject: [{
        subject: "刑法",
        patterns: [{ pattern: "scope_expansion", status: "confirmed", habitual: true }],
      }] },
    });
    const strategy = findInterventionResponse(response, {
      patternCode: "scope_expansion", route: "cuoti-fupan", dimension: "application",
    });
    expect(strategy).toMatchObject({
      status: "supported",
      observedCleanPassRate: 67,
      counts: { countable: 3, cleanPass: 2, coldTransferPass: 2, distinctKps: 2, coldTransferKps: 2 },
      portrait: { status: "confirmed", habitual: true },
    });
    expect(strategy.observedRiskShift.averageDelta).toBeLessThan(0);
    expect(strategy.observedRiskShift.interpretation).toContain("不能归因");
  });

  it("提示后通过不算 clean pass，作废题不进有效分母", () => {
    const response = buildInterventionResponse({ reviewSchedule: { items: [
      item("R1", "XF-0001", "pass", { cold: false, promptIntegrity: "cued" }),
      item("R2", "XF-0002", "void", { cold: false, promptIntegrity: "invalid" }),
      item("R3", "XF-0002", "fail"),
    ] } });
    expect(response.items[0]).toMatchObject({
      status: "collecting",
      observedCleanPassRate: 0,
      counts: { structured: 3, countable: 2, cleanPass: 0, void: 1 },
    });
  });

  it("跨点连续低响应只触发改策略，不冒充病根已证伪", () => {
    const response = buildInterventionResponse({ reviewSchedule: { items: [
      item("R1", "XF-0001", "fail"),
      item("R2", "XF-0002", "fail"),
      item("R3", "XF-0002", "partial"),
    ] } });
    expect(response.items[0]).toMatchObject({ status: "needs-redesign", observedCleanPassRate: 0 });
    expect(response.items[0].recommendation).toContain("复核病根");
    expect(response.policy).toContain("不是因果效果");
  });

  it("同一病根能区分具体协议，并用 D30 保持压过 D3 复发", () => {
    // [gpt] 2026-08-10：方法 A 的短期复发与方法 B 的长期保持必须落在两个可比较 arm。
    const weak = [
      ...episodeRows("EP-A1", "XF-0001", "counterfactual_case", { immediate: "pass", d3: "fail" }),
      ...episodeRows("EP-A2", "XF-0002", "counterfactual_case", { immediate: "pass", d3: "fail" }),
      ...episodeRows("EP-A3", "XF-0002", "counterfactual_case", { immediate: "pass", d3: "partial" }),
    ];
    const durable = [
      ...episodeRows("EP-B1", "XF-0001", "contrast_case", { immediate: "pass", d3: "pass", d14: "pass", d30: "pass" }),
      ...episodeRows("EP-B2", "XF-0002", "contrast_case", { immediate: "pass", d3: "pass", d14: "pass", d30: "pass" }),
      ...episodeRows("EP-B3", "XF-0002", "contrast_case", { immediate: "pass", d3: "pass", d14: "pass", d30: "pass" }),
    ];
    const response = buildInterventionResponse({
      reviewSchedule: { items: [...weak, ...durable] },
      referenceDate: "2026-09-10",
    });
    const methodA = findProtocolResponse(response, {
      protocolCode: "counterfactual_case",
      patternCode: "scope_expansion",
      subject: "刑法",
      route: "cuoti-fupan",
      dimension: "application",
    });
    const methodB = findProtocolResponse(response, {
      protocolCode: "contrast_case",
      patternCode: "scope_expansion",
      subject: "刑法",
      route: "cuoti-fupan",
      dimension: "application",
    });
    expect(methodA).toMatchObject({ status: "needs-redesign", horizons: { d3: { passRate: 0, evaluable: 3 } } });
    expect(methodB).toMatchObject({ status: "supported", deepestEvaluatedWindow: "d30", horizons: { d30: { passRate: 100, evaluable: 3, distinctPassKps: 2 } } });
    expect(methodB.conservativeScore).toBeGreaterThan(methodA.conservativeScore);
    expect(response.counts).toMatchObject({ episodes: 6, protocolizedEpisodes: 6, protocols: 2, structuredObservations: 18 });
  });
});
