import { describe, it, expect } from "vitest";
import { formatWeeklyDataText, type WeeklyReview } from "./weekly-review";

const empty: WeeklyReview = {
  weekStart: "2026-06-06",
  weekEnd: "2026-06-12",
  activity: { detections: 0, asks: 0, coachLogs: 0 },
  studied: [],
  kpTested: 0,
  passByLevel: [],
  passBySubject: [],
  solved: { absorbedErrors: [], reviewResolved: 0, passedKp: 0 },
  weak: { top: [], openErrors: [], repeatedFails: [] },
  askPoints: [],
  inbox: { createdByType: {}, pendingBacklog: 0 },
  cost: { totalUsd: 0, byRoute: [] },
  gradingAudit: [],
};

describe("formatWeeklyDataText（喂复盘层的真实数据序列化）", () => {
  it("空数据不抛、各段给如实兜底（缺失本身也是复盘信号）", () => {
    const t = formatWeeklyDataText(empty);
    expect(t).toContain("【本周真实使用数据 2026-06-06 ~ 2026-06-12】");
    expect(t).toContain("（本周无学习流水记录）");
    expect(t).toContain("本周吸收错题 0 个");
    expect(t).toContain("（暂无错次记录）");
  });

  it("有数据时如实列出学了/解决了/弱项（数字与对象一致）", () => {
    const r: WeeklyReview = {
      ...empty,
      activity: { detections: 12, asks: 3, coachLogs: 5 },
      studied: [{ subject: "刑法", chapters: ["第3章", "第4章"], activities: ["听课", "做题"] }],
      kpTested: 9,
      passByLevel: [{ level: "L1", passed: 8, total: 10, pct: 80 }],
      solved: {
        absorbedErrors: [{ subject: "刑法", knowledge: "正当防卫限度" }],
        reviewResolved: 2,
        passedKp: 7,
      },
      weak: {
        top: [{ kp_id: "XF-0009", subject: "刑法", name: "因果关系", errorCount: 4 }],
        openErrors: [{ subject: "民法", knowledge: "善意取得" }],
        repeatedFails: [{ kp_id: "XF-0009", subject: "刑法", name: "因果关系", failCount: 2 }],
      },
    };
    const t = formatWeeklyDataText(r);
    expect(t).toContain("刑法：第3章、第4章");
    expect(t).toContain("本周检测覆盖 9 个去重考点");
    expect(t).toContain("L1 80%(8/10)");
    expect(t).toContain("本周吸收错题 1 个：刑法·正当防卫限度");
    expect(t).toContain("本周检测通过 7 个考点；复验兑现 2 个");
    expect(t).toContain("刑法·因果关系(错4)");
    expect(t).toContain("民法·善意取得");
  });
});
