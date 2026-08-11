// [gpt] 2026-08-10：受控干预协议与确定性保守选策回归。
import { describe, expect, it } from "vitest";
import {
  listCompatibleProtocols,
  selectInterventionProtocol,
  validateProtocolAssignment,
} from "./intervention-protocols.mjs";

describe("intervention protocols", () => {
  it("同一路由维度可区分具体教学方法", () => {
    const options = listCompatibleProtocols({
      patternCode: "scope_expansion",
      route: "cuoti-fupan",
      dimension: "application",
    });
    expect(options.map((item) => item.code)).toEqual(expect.arrayContaining([
      "contrast_case",
      "counterfactual_case",
      "novel_case_transfer",
    ]));
    expect(validateProtocolAssignment({
      code: "contrast_case",
      version: 1,
      patternCode: "scope_expansion",
      route: "cuoti-fupan",
      dimension: "application",
    })).toMatchObject({ ok: true });
    expect(validateProtocolAssignment({
      code: "contrast_case",
      version: 1,
      patternCode: "scope_expansion",
      route: "daibei-pc",
      dimension: "recall",
    })).toMatchObject({ ok: false, reason: "route-dimension-mismatch" });
  });

  it("先探索未试协议，已有长期支持后优先利用且避开低响应方案", () => {
    const context = {
      patternCode: "scope_expansion",
      subject: "刑法",
      route: "cuoti-fupan",
      dimension: "application",
      decisionKey: "2026-08-10:XF-0054",
    };
    const first = selectInterventionProtocol(context);
    expect(first).toMatchObject({ mode: "explore" });

    const response = {
      protocols: [
        { protocolCode: "contrast_case", protocolVersion: 1, patternCode: "scope_expansion", subject: "刑法", route: "cuoti-fupan", dimension: "application", status: "supported", conservativeScore: 78, counts: { episodes: 5 } },
        { protocolCode: "counterfactual_case", protocolVersion: 1, patternCode: "scope_expansion", subject: "刑法", route: "cuoti-fupan", dimension: "application", status: "needs-redesign", conservativeScore: 8, counts: { episodes: 4 } },
        { protocolCode: "novel_case_transfer", protocolVersion: 1, patternCode: "scope_expansion", subject: "刑法", route: "cuoti-fupan", dimension: "application", status: "mixed", conservativeScore: 45, counts: { episodes: 3 } },
      ],
    };
    const selected = selectInterventionProtocol({ ...context, decisionKey: "not-audit", interventionResponse: response });
    expect(selected.code).not.toBe("counterfactual_case");
    expect(["contrast_case", "novel_case_transfer"]).toContain(selected.code);
    expect(["exploit", "audit"]).toContain(selected.mode);
  });
});
