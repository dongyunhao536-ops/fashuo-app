import { describe, expect, it } from "vitest";
import { planCoverageRange, resolveOutlineChapter } from "./coverage-range.mjs";

const outline = `◆ 民法（测试）
第一章 绪论
第二章 民事法律关系
第三章 自然人
第四章 法人
第五章 非法人组织

◆ 宪法（测试）
第一章 宪法基本理论
第二章 宪法的制定和实施
第三章 国家基本制度`;

describe("coverage range gate", () => {
  it("用显式章号或最长语义标题唯一归章", () => {
    expect(resolveOutlineChapter(outline, "民法", "第三章自然人·监护").chapter.number).toBe(3);
    expect(resolveOutlineChapter(outline, "民法", "非法人组织").chapter.number).toBe(5);
  });

  it("同轨向前跳章时在写账前列出未确认区间", () => {
    const result = planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "听课",
      target: "第五章 非法人组织",
      priorRows: [{ id: 9, chapter: "第二章 民事法律关系" }],
    });
    expect(result).toMatchObject({ status: "blocked", code: "COVERAGE_RANGE_UNCONFIRMED" });
    expect(result.pendingUnits.map((unit) => unit.number)).toEqual([3, 4]);
  });

  it("显式区间一次规划所有新增覆盖单元且不重复上一落点", () => {
    const result = planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "看书",
      target: "第五章 非法人组织",
      priorRows: [{ id: 9, chapter: "第二章 民事法律关系" }],
      coverageFrom: "第二章",
    });
    expect(result).toMatchObject({ status: "pass", code: "COVERAGE_RANGE_EXPLICIT" });
    expect(result.unitsToWrite.map((unit) => unit.number)).toEqual([3, 4, 5]);
  });

  it("确实选学时必须带理由才能关闭区间", () => {
    const base = {
      examOutline: outline,
      subject: "宪法",
      activity: "背诵",
      target: "第三章 国家基本制度",
      priorRows: [{ id: 1, chapter: "第一章 宪法基本理论" }],
      coverageGapConfirmed: true,
    };
    expect(planCoverageRange(base)).toMatchObject({ status: "invalid", code: "COVERAGE_GAP_REASON_REQUIRED" });
    expect(planCoverageRange({ ...base, coverageGapReason: "按高频顺序选学，第二章稍后补" }))
      .toMatchObject({ status: "pass", code: "COVERAGE_GAP_CONFIRMED" });
  });

  it("允许同时确认前段跳过并批量写入后段真实覆盖", () => {
    const result = planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "听课",
      target: "第五章 非法人组织",
      priorRows: [{ id: 1, chapter: "第一章 绪论" }],
      coverageFrom: "第三章 自然人",
      coverageGapConfirmed: true,
      coverageGapReason: "第二章已选学跳过，另日补",
    });
    expect(result).toMatchObject({ status: "pass", code: "COVERAGE_RANGE_WITH_GAP_CONFIRMED" });
    expect(result.pendingUnits.map((unit) => unit.number)).toEqual([2]);
    expect(result.unitsToWrite.map((unit) => unit.number)).toEqual([3, 4, 5]);
  });

  it("倒序、相邻与无可确认顺序不误伤", () => {
    expect(planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "听课",
      target: "第三章 自然人",
      priorRows: [{ id: 9, chapter: "第五章 非法人组织" }],
    }).status).toBe("pass");
    expect(planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "复盘",
      target: "第五章 非法人组织",
      priorRows: [{ id: 9, chapter: "第一章 绪论" }],
    }).status).toBe("not_applicable");
    expect(planCoverageRange({
      examOutline: outline,
      subject: "民法",
      activity: "看书",
      target: "自选专题",
      priorRows: [{ id: 9, chapter: "第一章 绪论" }],
    })).toMatchObject({ status: "hint", code: "COVERAGE_SEQUENCE_UNRESOLVED" });
  });
});
