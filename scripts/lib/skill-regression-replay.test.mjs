// [gpt] 2026-08-12：将近期四类真实失灵场景固化为失败回放，防止同型错误回归。

import { describe, expect, it } from "vitest";
import { auditReviewQuestion } from "./question-integrity.mjs";
import {
  assessPromptMateriality,
  buildCrossSubjectReviewPool,
} from "./skill-context.mjs";

describe("近期 Skill 失灵场景回放", () => {
  it("文字瑕疵不改变实体结论时，不再机械判错或强制重做", () => {
    expect(assessPromptMateriality()).toMatchObject({
      level: "immaterial",
      invalidate: false,
      deduct: false,
      repeatRequired: false,
    });
  });

  it("法理最小动作完成后重新跨科排序，不被宏观 P0 锁死", () => {
    const referenceDate = "2026-08-12";
    const topics = [
      { id: 1, subject: "法理", title: "法律解释主体", riskScore: 90, nextProbe: { earliestDate: referenceDate, probeAxis: "subject_identity" } },
      { id: 2, subject: "民法", title: "监护人顺位", riskScore: 55, nextProbe: { earliestDate: referenceDate, probeAxis: "rule_boundary" } },
    ];
    const events = [
      { id: 81, subject: "法理", status: "open", logDate: "2026-08-08", knowledge: "解释主体", topicIds: [1] },
      { id: 82, subject: "民法", status: "open", logDate: "2026-08-08", knowledge: "监护顺位", topicIds: [2] },
    ];
    const pool = buildCrossSubjectReviewPool({
      topics,
      events,
      eventProofs: new Map([
        [81, { primaryTopicId: 1, eligible: false, passCount: 0, coldPassCount: 0, axes: [], blockers: ["还需两条"] }],
        [82, { primaryTopicId: 2, eligible: false, passCount: 1, coldPassCount: 1, axes: ["fact_signal"], blockers: ["第二轴"] }],
      ]),
      schedule: { overdue: [], dueToday: [], upcoming: [] },
      weeklyPriorities: [{ priority: "P0", title: "法理错题闭环", details: [] }],
      referenceDate,
      routing: { currentSubject: "法理", focusSubject: "法理", subjectStreak: 3, focusMinimumMet: true, signal: "too-little" },
    });
    expect(pool.candidates[0]).toMatchObject({ eventId: 82, subject: "民法", canAbsorbAfterPass: true });
  });

  it("追加追问点名错误项时必须阻断，不能再把答案带进题面", () => {
    const stem = [
      "【多选题】下列关于法律解释主体的说法，正确的有：",
      "①立法机关可以解释法律",
      "②任何法院都能作有普遍约束力的解释",
      "③行政机关只能解释宪法",
      "④解释主体与解释效力完全无关",
    ].join("\n");
    const audit = auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "请选择，并指出③④为什么错误。",
      answerKey: "①",
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((item) => item.code)).toEqual(expect.arrayContaining(["named-option-verdict"]));
  });

  it("指定 P0 必须精确命中原对象，T#10 不会误吃 T#108", () => {
    const pool = buildCrossSubjectReviewPool({
      topics: [{ id: 10, subject: "刑法", title: "法条竞合", riskScore: 50, nextProbe: { earliestDate: "2026-08-12" } }],
      events: [{ id: 64, subject: "刑法", status: "open", logDate: "2026-08-01", knowledge: "法条竞合", topicIds: [10] }],
      eventProofs: new Map([[64, { primaryTopicId: 10, eligible: false, passCount: 0, coldPassCount: 0, axes: [], blockers: [] }]]),
      schedule: {
        overdue: [], dueToday: [],
        upcoming: [{ id: "P0-108", date: "2026-08-14", priority: "P0", route: "cuoti-fupan", dimension: "application", ref: "T#108", title: "T#108 销售劣药罪" }],
      },
      referenceDate: "2026-08-12",
    });
    expect(pool.candidates[0]).toMatchObject({ scheduleStatus: "unscheduled", scheduleIds: [] });
  });
});
