import { describe, it, expect } from "vitest";
import { formatWeeklyReportText, type WeeklyReview } from "./weekly-review";

const empty: WeeklyReview = {
  weekStart: "2026-06-06",
  weekEnd: "2026-06-12",
  activity: { detections: 0, asks: 0, coachLogs: 0 },
  passByLevel: [],
  passBySubject: [],
  study: { totalMinutes: 0, bySubject: [], planAdoption: { 采纳: 0, 改一改: 0, 不按: 0, rate: null } },
  askPoints: [],
  repeatedFails: [],
  inbox: { createdByType: {}, pendingBacklog: 0 },
  cost: { totalUsd: 0, byRoute: [] },
  gradingAudit: [],
};

describe("formatWeeklyReportText 排版", () => {
  it("空数据不抛、各段给兜底文案", () => {
    const t = formatWeeklyReportText(empty);
    expect(t).toContain("# 周复盘 2026-06-06 ~ 2026-06-12");
    expect(t).toContain("（本周无检测）");
    expect(t).toContain("（无表态）");
    expect(t).toContain("（本周无答疑卡点记录）");
    expect(t).toContain("（本周无失败）");
    expect(t).toContain("（本周无低信心/★评分，评分稳定）");
  });

  it("有数据时算出通过率/采纳率/审计星标", () => {
    const r: WeeklyReview = {
      ...empty,
      activity: { detections: 12, asks: 3, coachLogs: 5 },
      passByLevel: [{ level: "L1", passed: 8, total: 10, pct: 80 }],
      study: {
        totalMinutes: 600,
        bySubject: [{ subject: "刑法", minutes: 600 }],
        planAdoption: { 采纳: 3, 改一改: 1, 不按: 0, rate: 75 },
      },
      repeatedFails: [{ kp_id: "XF-0009", subject: "刑法", name: "因果关系", failCount: 2 }],
      cost: { totalUsd: 1.5, byRoute: [{ route: "ask", usd: 1.5 }] },
      gradingAudit: [{ kp_id: "XF-0009", level: "L2", grade: "未过", confidence: 60, starred: true, question: "简述因果关系" }],
    };
    const t = formatWeeklyReportText(r);
    expect(t).toContain("L1 80%(8/10)");
    expect(t).toContain("总时长 10.0h");
    expect(t).toContain("规划采纳率：75%");
    expect(t).toContain("刑法·因果关系 失败 2 次（XF-0009）");
    expect(t).toContain("★ XF-0009 L2 判「未过」信心60");
  });
});
