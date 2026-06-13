import { describe, it, expect } from "vitest";
import {
  currentStage,
  valueOf,
  urgencyOf,
  paceQuota,
  buildDailyPlan,
  effectiveInterval,
  type KpRow,
} from "./scheduler";

const DAY = 86400000;
const daysAgoISO = (n: number, base = new Date("2026-06-20T12:00:00Z")) =>
  new Date(base.getTime() - n * DAY).toISOString().slice(0, 10);

function mkKp(p: Partial<KpRow> & { kp_id: string; subject: string }): KpRow {
  return {
    parent_kp: "第1章/第1节",
    cap_level: "L3",
    cur_level: "L1",
    l1_status: "untested",
    l2_status: "untested",
    l3_status: "untested",
    difficulty: 5,
    interval_idx: 0,
    last_review: null,
    next_due: null,
    mastered: false,
    review_count: 0,
    error_count: 0,
    ext: {},
    ...p,
  };
}

describe("currentStage 阶段切换", () => {
  it("9-1 前 = 知识体系铺开", () => {
    expect(currentStage(new Date("2026-08-31T12:00:00Z"))).toBe("知识体系铺开");
  });
  it("9-1 ~ 12-7 = 高频+弱项优先", () => {
    expect(currentStage(new Date("2026-09-01T00:00:00Z"))).toBe("高频+弱项优先");
    expect(currentStage(new Date("2026-11-30T12:00:00Z"))).toBe("高频+弱项优先");
  });
  it("12-7 起 = 纯弱项+主观题模板", () => {
    expect(currentStage(new Date("2026-12-07T00:00:00Z"))).toBe("纯弱项+主观题模板");
  });
});

describe("valueOf 价值公式 = w1·频率 + w2·弱项 + w3·科目权重", () => {
  const stage = "知识体系铺开";
  it("刑法·高频·零错 = 3·3 + 2·0 + 1·1.0 = 10", () => {
    expect(valueOf(mkKp({ kp_id: "XF-1", subject: "刑法", ext: { zhenti_freq: "高" } }), stage)).toBe(10);
  });
  it("法理·高频 科目权重 1.2 → 10.2", () => {
    expect(valueOf(mkKp({ kp_id: "FL-1", subject: "法理", ext: { zhenti_freq: "高" } }), stage)).toBeCloseTo(10.2);
  });
  it("错次封顶 5（防爆）：error_count 10 → 当 5 算", () => {
    const v = valueOf(mkKp({ kp_id: "XF-2", subject: "刑法", error_count: 10, ext: { zhenti_freq: "低" } }), stage);
    expect(v).toBe(3 * 1 + 2 * 5 + 1 * 1.0); // 14
  });
  it("未知频率回退到低(1)", () => {
    expect(valueOf(mkKp({ kp_id: "XF-3", subject: "刑法", ext: {} }), stage)).toBe(3 * 1 + 0 + 1.0);
  });
});

describe("urgencyOf 遗忘紧迫度", () => {
  it("未复习过 → 0（走新考点池，不算到期）", () => {
    expect(urgencyOf(mkKp({ kp_id: "X", subject: "刑法", review_count: 0, last_review: daysAgoISO(99) }))).toBe(0);
  });
  it("复习过但未到期（间隔 7 天，过了 7 天）→ 0", () => {
    const kp = mkKp({ kp_id: "X", subject: "刑法", review_count: 1, interval_idx: 2, last_review: daysAgoISO(7) });
    expect(urgencyOf(kp, new Date("2026-06-20T12:00:00Z"))).toBe(0);
  });
  it("过期一倍间隔 → 1", () => {
    const kp = mkKp({ kp_id: "X", subject: "刑法", review_count: 1, interval_idx: 2, last_review: daysAgoISO(14) });
    expect(urgencyOf(kp, new Date("2026-06-20T12:00:00Z"))).toBeCloseTo(1);
  });
});

describe("paceQuota 配速器", () => {
  it("剩余未学 ÷ 距死线天数，至少 1", () => {
    expect(paceQuota(0, new Date("2026-06-20T12:00:00Z"))).toBe(1);
    expect(paceQuota(100, new Date("2026-09-29T12:00:00Z"))).toBe(100); // 距 9-30 仅 1 天
  });
});

describe("考前收敛 effectiveInterval", () => {
  const june = new Date("2026-06-20T12:00:00Z"); // 距初试 ~184 天
  const sprint = new Date("2026-12-11T12:00:00Z"); // 距初试 ~9 天
  const afterExam = new Date("2026-12-25T12:00:00Z");

  it("常规期（距考 > 启用天数）间隔原样", () => {
    expect(effectiveInterval(30, june)).toBe(30);
    expect(effectiveInterval(7, june)).toBe(7);
  });
  it("冲刺期把长间隔压到 距考天数×0.5", () => {
    // 距考 9 天 → 上限 floor(9×0.5)=4 → 30 压到 4
    expect(effectiveInterval(30, sprint)).toBe(4);
  });
  it("冲刺期不拉长本就短的间隔（取 min）", () => {
    expect(effectiveInterval(3, sprint)).toBe(3);
  });
  it("考后不再收敛", () => {
    expect(effectiveInterval(30, afterExam)).toBe(30);
  });
});

describe("考前收敛对 urgencyOf 的影响", () => {
  const reviewedDaysAgo = (n: number, today: Date) =>
    new Date(today.getTime() - n * DAY).toISOString().slice(0, 10);

  it("同一考点：铺开期 8 天未到 30 天间隔→不到期；冲刺期间隔压短→到期", () => {
    const june = new Date("2026-06-20T12:00:00Z");
    const sprint = new Date("2026-12-11T12:00:00Z");
    const kpJune = mkKp({ kp_id: "X", subject: "刑法", review_count: 1, interval_idx: 4, last_review: reviewedDaysAgo(8, june) });
    const kpSprint = mkKp({ kp_id: "X", subject: "刑法", review_count: 1, interval_idx: 4, last_review: reviewedDaysAgo(8, sprint) });
    expect(urgencyOf(kpJune, june)).toBe(0); // 8/30-1 < 0
    expect(urgencyOf(kpSprint, sprint)).toBeGreaterThan(0); // 间隔压到 4，8/4-1>0
  });
});

describe("buildDailyPlan 清单装配", () => {
  const today = new Date("2026-06-20T12:00:00Z");
  const kps: KpRow[] = [
    mkKp({ kp_id: "XF-0002", subject: "刑法", ext: { zhenti_freq: "高" } }), // 新考点
    mkKp({ kp_id: "MF-0001", subject: "民法", ext: { zhenti_freq: "高" } }), // 新考点
    mkKp({ kp_id: "XF-0050", subject: "刑法", review_count: 2, interval_idx: 0, last_review: daysAgoISO(30) }), // 到期
    mkKp({ kp_id: "XF-0099", subject: "刑法", ext: { zhenti_freq: "中" } }), // 被点名复验
  ];

  it("复验最高优先、到期次之、新考点按科目序(刑→民)", () => {
    const plan = buildDailyPlan({ kps, reviewKpIds: ["XF-0099"], capacity: 30, today });
    expect(plan.items.map((i) => i.kp_id)).toEqual(["XF-0099", "XF-0050", "XF-0002", "MF-0001"]);
    expect(plan.counts).toMatchObject({ 复验: 1, 到期: 1, 新考点: 2 });
    expect(plan.items[0].bucket).toBe("复验");
  });

  it("容量裁剪：复验 > 到期 > 新考点", () => {
    const plan = buildDailyPlan({ kps, reviewKpIds: ["XF-0099"], capacity: 3, today });
    // 余量 = 3 - 复验1 - 到期1 = 1 个新考点，刑法优先 → MF 被挤掉
    expect(plan.items.map((i) => i.kp_id)).toEqual(["XF-0099", "XF-0050", "XF-0002"]);
    expect(plan.counts.新考点).toBe(1);
  });

  it("新考点 priority 不含到期项的紧迫度乘子（urgency=0）", () => {
    const plan = buildDailyPlan({ kps, reviewKpIds: [], capacity: 30, today });
    const xf2 = plan.items.find((i) => i.kp_id === "XF-0002")!;
    expect(xf2.urgency).toBe(0);
    expect(xf2.priority).toBe(xf2.value); // value*(1+0)
  });
});
