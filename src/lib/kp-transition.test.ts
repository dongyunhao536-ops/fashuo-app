import { describe, it, expect } from "vitest";
import { computeTransition, masterNowTransition, type Level, type Grade } from "./kp-transition";
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

  it("勉强：间隔按通过升一档、难度+1、不升档、status=untested", () => {
    const t = run({ cur_level: "L2", interval_idx: 2, difficulty: 5 }, "L2", "勉强");
    expect(t.cur_level).toBe("L2"); // 不升档
    expect(t.difficulty).toBe(6); // 难度+1
    expect(t.interval_idx).toBe(3); // 间隔按通过推进（D6→rungCap4，2<4 升到 3）
    expect(t.statusValue).toBe("untested"); // 不记 passed
    expect(t.errorCountDelta).toBe(0);
    expect(t.mastered).toBe(false); // 勉强不计入 mastered
  });

  it("勉强·重学档（该档刚 failed）：间隔不放长（防挂了→勉强→飞长间隔）", () => {
    const t = run(
      { cur_level: "L1", interval_idx: 2, difficulty: 5, l1_status: "failed" },
      "L1",
      "勉强",
    );
    expect(t.difficulty).toBe(6);
    expect(t.interval_idx).toBe(2); // 刚挂过 → 勉强只确认、不放长
  });

  it("未过：难度+2、间隔退两档、档级不动、error+1、status=failed", () => {
    const t = run({ cur_level: "L2", interval_idx: 3, difficulty: 5 }, "L2", "未过");
    expect(t.difficulty).toBe(7); // +2（遗忘惩罚比旧版重）
    expect(t.interval_idx).toBe(1); // 15天(idx3) 忘了 → 3天(idx1)，退两档
    expect(t.cur_level).toBe("L2");
    expect(t.statusValue).toBe("failed");
    expect(t.errorCountDelta).toBe(1);
  });

  it("难度 clamp 在 [1,10]：底部未过(+2)不越界、顶部通过不越界", () => {
    expect(run({ difficulty: 10 }, "L1", "未过").difficulty).toBe(10);
    expect(run({ difficulty: 9 }, "L1", "未过").difficulty).toBe(10); // 9+2 clamp 10
    expect(run({ difficulty: 1 }, "L1", "干净通过").difficulty).toBe(1);
  });

  it("间隔退档不低于 0（退两档也封底）", () => {
    expect(run({ interval_idx: 1 }, "L1", "未过").interval_idx).toBe(0);
    expect(run({ interval_idx: 0 }, "L1", "未过").interval_idx).toBe(0);
  });

  it("真题高频卡失手直接回 1 天档(idx0)，不管之前爬到多高", () => {
    const t = run({ interval_idx: 4, difficulty: 3, ext: { zhenti_freq: "高" } }, "L1", "未过");
    expect(t.interval_idx).toBe(0); // 30天档高频失手 → 1天（中低频会是退两档=7天）
  });

  it("中/低频卡失手仍按退两档（背得越熟退得越少）", () => {
    expect(run({ interval_idx: 4, ext: { zhenti_freq: "中" } }, "L1", "未过").interval_idx).toBe(2);
    expect(run({ interval_idx: 4, ext: { zhenti_freq: "低" } }, "L1", "未过").interval_idx).toBe(2);
    expect(run({ interval_idx: 4, ext: {} }, "L1", "未过").interval_idx).toBe(2); // 缺省=低频
  });

  it("难度门控：正常卡(D≤6)happy path 不变，可一路升到 30 天档", () => {
    expect(run({ interval_idx: 0, difficulty: 5 }, "L1", "干净通过").interval_idx).toBe(1);
    expect(run({ interval_idx: 3, difficulty: 5 }, "L1", "干净通过").interval_idx).toBe(4);
  });

  it("难度门控：高难卡通过也封在近端档（复习前 D8 → rungCap=7天档，idx3 被按住）", () => {
    // idx3=15天, 复习前 D8 → rungCap(8)=2(7天)，idx3 不<2 → 保持不升；通过把难度降到 7
    const t = run({ interval_idx: 3, difficulty: 8 }, "L1", "干净通过");
    expect(t.difficulty).toBe(7);
    expect(t.interval_idx).toBe(3); // 被门控按住，没升到 idx4(30天)
  });

  it("难度门控随通过逐步解锁：D8 硬卡连续通过 3→7→15→30 慢慢爬回", () => {
    let kp = mkKp({ interval_idx: 0, difficulty: 8 });
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = computeTransition(kp, "L1", "干净通过", NOW);
      seq.push(t.interval_idx);
      kp = { ...kp, interval_idx: t.interval_idx, difficulty: t.difficulty };
    }
    expect(seq).toEqual([1, 2, 3, 4]); // 3→7→15→30 天，逐档解锁不跳级
  });

  it("重学档：刚挂过的档当场答对只确认、不放长不升档（错错对→仍 1 天/明天再背）", () => {
    // 模拟 FL-0001：连错两次后 l1=failed、idx0、难度高；第三次干净通过
    const t = run({ cur_level: "L1", l1_status: "failed", interval_idx: 0, difficulty: 9 }, "L1", "干净通过");
    expect(t.interval_idx).toBe(0); // 仍 1 天档（不跳到 3 天）
    expect(t.cur_level).toBe("L1"); // 不升档，留 L1 再确认
    expect(t.statusValue).toBe("passed"); // 该档已答对
    expect(t.difficulty).toBe(8); // 难度仍 -1
  });

  it("重学档后再稳过一次（该档已 passed）才放长 + 升档", () => {
    const t = run({ cur_level: "L1", l1_status: "passed", interval_idx: 0, difficulty: 8 }, "L1", "干净通过");
    expect(t.interval_idx).toBe(1); // 3 天，正常放长
    expect(t.cur_level).toBe("L2"); // 升档
  });

  it("勉强累积难度→下次通过被门控压短（不再'原地踏步无后果'）", () => {
    // D6 的卡在 idx3，勉强→D7；下次复习前 D7 → rungCap(7)=3 → idx3 保持不升到 30 天
    const m = run({ interval_idx: 3, difficulty: 6 }, "L1", "勉强");
    expect(m.difficulty).toBe(7);
    expect(m.interval_idx).toBe(3);
    const p = run({ interval_idx: 3, difficulty: 7 }, "L1", "干净通过");
    expect(p.interval_idx).toBe(3); // 复习前 D7 门控按住
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
    const t = run({ interval_idx: 0 }, "L1", "勉强"); // 勉强→升到 idx1，间隔档[1]=3 天
    expect(t.lastReview).toBe("2026-06-20");
    expect(t.nextDue).toBe("2026-06-23");
  });
});

describe("masterNowTransition 手动「我已会」排进常规周期", () => {
  const m = (p: Partial<KpRow>) => masterNowTransition(mkKp(p), NOW);

  it("刚失手的弱项(idx0,L1 failed,cap L1)→当作通过推进一档、标 passed、退近端", () => {
    const t = m({ cap_level: "L1", cur_level: "L1", l1_status: "failed", interval_idx: 0, difficulty: 5 });
    expect(t.cur_level).toBe("L1");
    expect(t.l1_status).toBe("passed");
    expect(t.l2_status).toBeUndefined();
    expect(t.l3_status).toBeUndefined();
    expect(t.difficulty).toBe(4); // -1
    expect(t.interval_idx).toBe(1); // 0→1（D5 rungCap=4，<4 推进）
    expect(t.nextDue).toBe("2026-06-23"); // NOW+3 天
    expect(t.lastReview).toBe("2026-06-20");
  });

  it("cap=L3：三档全标 passed、cur 提到 L3", () => {
    const t = m({ cap_level: "L3", interval_idx: 2, difficulty: 5 });
    expect(t.cur_level).toBe("L3");
    expect(t.l1_status).toBe("passed");
    expect(t.l2_status).toBe("passed");
    expect(t.l3_status).toBe("passed");
    expect(t.interval_idx).toBe(3); // 2→3
    expect(t.nextDue).toBe("2026-07-05"); // NOW+15 天
  });

  it("只放长绝不缩短：高难卡(D9 rungCap=1)已在 idx2 → 保持 idx2", () => {
    const t = m({ cap_level: "L1", interval_idx: 2, difficulty: 9 });
    expect(t.interval_idx).toBe(2); // 2 不<1 → 不动（不缩短）
    expect(t.difficulty).toBe(8);
    expect(t.nextDue).toBe("2026-06-27"); // NOW+7 天
  });

  it("间隔封顶 MAX 不溢出（idx4 已满档）", () => {
    const t = m({ cap_level: "L1", interval_idx: 4, difficulty: 3 });
    expect(t.interval_idx).toBe(4);
    expect(t.nextDue).toBe("2026-07-20"); // NOW+30 天
  });
});
