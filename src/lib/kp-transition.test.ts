import { describe, it, expect } from "vitest";
import { computeTransition, type Level, type Grade } from "./kp-transition";
import type { KpRow } from "./scheduler";

function mkKp(p: Partial<KpRow>): KpRow {
  return {
    kp_id: "XF-0001",
    subject: "刑法",
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
const NOW = new Date("2026-06-20T12:00:00Z");
const run = (p: Partial<KpRow>, level: Level, grade: Grade) => computeTransition(mkKp(p), level, grade, NOW);

describe("computeTransition 升降档", () => {
  it("干净通过：难度-1、间隔升档、升到下一档、status=passed", () => {
    const t = run({ cur_level: "L1", interval_idx: 0, difficulty: 5 }, "L1", "干净通过");
    expect(t.difficulty).toBe(4);
    expect(t.interval_idx).toBe(1);
    expect(t.cur_level).toBe("L2");
    expect(t.statusField).toBe("l1_status");
    expect(t.statusValue).toBe("passed");
    expect(t.errorCountDelta).toBe(0);
  });

  it("干净通过到封顶档不再升档（cur=cap=L3）", () => {
    const t = run({ cur_level: "L3", cap_level: "L3", interval_idx: 2 }, "L3", "干净通过");
    expect(t.cur_level).toBe("L3");
  });

  it("间隔升档封顶 MAX（idx 4 不溢出）", () => {
    const t = run({ interval_idx: 4 }, "L1", "干净通过");
    expect(t.interval_idx).toBe(4);
  });

  it("勉强：同档、难度+1、间隔不动、status=untested", () => {
    const t = run({ cur_level: "L2", interval_idx: 2, difficulty: 5 }, "L2", "勉强");
    expect(t.cur_level).toBe("L2");
    expect(t.difficulty).toBe(6);
    expect(t.interval_idx).toBe(2);
    expect(t.statusValue).toBe("untested");
    expect(t.errorCountDelta).toBe(0);
  });

  it("未过：难度+1、间隔退一档、档级不动、error+1、status=failed", () => {
    const t = run({ cur_level: "L2", interval_idx: 3, difficulty: 5 }, "L2", "未过");
    expect(t.difficulty).toBe(6);
    expect(t.interval_idx).toBe(2);
    expect(t.cur_level).toBe("L2");
    expect(t.statusValue).toBe("failed");
    expect(t.errorCountDelta).toBe(1);
  });

  it("难度 clamp 在 [1,10]：底部未过不越界、顶部通过不越界", () => {
    expect(run({ difficulty: 10 }, "L1", "未过").difficulty).toBe(10);
    expect(run({ difficulty: 1 }, "L1", "干净通过").difficulty).toBe(1);
  });

  it("间隔退档不低于 0", () => {
    expect(run({ interval_idx: 0 }, "L1", "未过").interval_idx).toBe(0);
  });
});

describe("mastered 判定（按 cap 全过，本次实时并入）", () => {
  it("cap=L1：L1 干净通过即 mastered", () => {
    expect(run({ cap_level: "L1", cur_level: "L1" }, "L1", "干净通过").mastered).toBe(true);
  });
  it("cap=L3：仅 L3 过、L1/L2 未过 → 未 mastered", () => {
    expect(run({ cap_level: "L3", l1_status: "untested", l2_status: "untested" }, "L3", "干净通过").mastered).toBe(false);
  });
  it("cap=L3：L1/L2 历史已过 + 本次 L3 过 → mastered", () => {
    const t = run({ cap_level: "L3", l1_status: "passed", l2_status: "passed", cur_level: "L3" }, "L3", "干净通过");
    expect(t.mastered).toBe(true);
  });
});

describe("已强化触发：曾弱 + 首次 mastered", () => {
  it("曾错过(error>0)的考点首次达成 mastered → shouldEmitStrengthened", () => {
    const t = run(
      { cap_level: "L1", cur_level: "L1", error_count: 3, mastered: false },
      "L1",
      "干净通过",
    );
    expect(t.wasWeak).toBe(true);
    expect(t.shouldEmitStrengthened).toBe(true);
  });
  it("从没弱过的考点达成 mastered → 不投已强化", () => {
    const t = run({ cap_level: "L1", cur_level: "L1", error_count: 0, mastered: false }, "L1", "干净通过");
    expect(t.shouldEmitStrengthened).toBe(false);
  });
  it("已经 mastered 的不重复投", () => {
    const t = run({ cap_level: "L1", cur_level: "L1", error_count: 3, mastered: true }, "L1", "干净通过");
    expect(t.shouldEmitStrengthened).toBe(false);
  });
  it("曾有档 failed 也算 wasWeak", () => {
    const t = run(
      { cap_level: "L2", cur_level: "L2", l1_status: "passed", l2_status: "failed", error_count: 0, mastered: false },
      "L2",
      "干净通过",
    );
    expect(t.wasWeak).toBe(true);
    expect(t.shouldEmitStrengthened).toBe(true);
  });
});

describe("北京日历日", () => {
  it("lastReview=今日北京日，nextDue=按间隔档天数后", () => {
    const t = run({ interval_idx: 0 }, "L1", "勉强"); // 间隔档[0]=1 天
    expect(t.lastReview).toBe("2026-06-20");
    expect(t.nextDue).toBe("2026-06-21");
  });
});
