import { describe, expect, it } from "vitest";
import { askPointLabel, summarizeAskPoints } from "./ask-point-summary.mjs";

function row(overrides = {}) {
  return {
    id: 1,
    subject: "刑法",
    confusion: "不能犯未遂与迷信犯的边界",
    status: "open",
    ttl_until: "2026-11-01",
    created_at: "2026-08-03T12:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("ask point summary", () => {
  it("把过期 open 从有效卡点中排除", () => {
    const summary = summarizeAskPoints([
      row(),
      row({ id: 2, confusion: "旧卡点", ttl_until: "2026-07-01" }),
    ], { referenceDate: "2026-08-05" });

    expect(summary.counts).toMatchObject({ open: 1, expired: 1 });
    expect(summary.activePoints.map((point) => point.id)).toEqual([1]);
  });

  it("本周新增卡点与本周打通分开计算，绝不冒充答疑次数", () => {
    const summary = summarizeAskPoints([
      row({ id: 1, status: "clarified", resolved_at: "2026-08-04T09:00:00Z" }),
      row({ id: 2, created_at: "2026-07-20T09:00:00Z", status: "dismissed", resolved_at: "2026-08-05T09:00:00Z" }),
      row({ id: 3, created_at: "2026-08-05T09:00:00Z" }),
    ], { referenceDate: "2026-08-05", periodStart: "2026-08-03", periodEnd: "2026-08-09" });

    expect(summary.period).toMatchObject({ created: 2, clarified: 1, dismissed: 1, superseded: 0 });
    expect(summary.activePoints.map((point) => point.id)).toEqual([3]);
  });

  it("格式化稳定 ID 标签", () => {
    const summary = summarizeAskPoints([row()], { referenceDate: "2026-08-05" });
    expect(askPointLabel(summary.activePoints[0])).toBe("A#1 [刑法] 不能犯未遂与迷信犯的边界");
  });
});
