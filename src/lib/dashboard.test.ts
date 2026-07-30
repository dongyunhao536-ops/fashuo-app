import { describe, it, expect } from "vitest";
import { scoreSubject, scoreEnglish } from "./dashboard";

/**
 * 量化 v3.1 的性质测试（2026-07-26 建）。
 *
 * 为什么是性质测试而不是几个固定用例：v3 上线以来「缺证据时默认给分」这一类失效已四次现形
 * （闭环重归一化 / papers14d 口径 / raw_input 兜底误判 / 深度分母＋闭环借先验），每次都是靠肉眼
 * 发现某个数不对才捞出来。下面四条正好对应这四次事故的形状——公式怎么改都得先让它们跑绿。
 *   P1 上界：能力 ≤ 100×广度      P2 零证据零分
 *   P3 反瞒报：删光某科错题不得涨分  P4 单调：新增学习证据不得掉分
 */

// 确定性 PRNG（xorshift32），保证 CI 上每次跑的是同一批账本
function rng(seed: number) {
  let x = seed;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0;
    return Math.abs(x) / 2147483647;
  };
}

type Ev = Parameters<typeof scoreSubject>[0];

/** 随机构造一份账本证据（含各种极端：零覆盖、满覆盖、零错题、全未销账、全重犯） */
function randomEv(r: () => number): Ev {
  const total = 5 + Math.floor(r() * 20);
  const covered = Math.floor(r() * (total + 1));
  const chapSteps = Array.from({ length: covered }, () => 1 + Math.floor(r() * 3));
  const outChapters = Math.min(covered, Math.floor(r() * (covered + 1)));
  const open = Math.floor(r() * 40);
  const absorbed = Math.floor(r() * 40);
  const repeat = Math.floor(r() * (open + absorbed + 1));
  return { total, chapSteps, outChapters, open, absorbed, repeat };
}

const SAMPLES = 400;

describe("P1 上界：能力 ≤ 100×广度（只摸过 5% 的章，掌握度不可能超 5%）", () => {
  it("随机账本一律不越界", () => {
    const r = rng(20260726);
    for (let i = 0; i < SAMPLES; i++) {
      const ev = randomEv(r);
      const s = scoreSubject(ev);
      expect(s.ability, JSON.stringify(ev)).toBeLessThanOrEqual(s.progress);
    }
  });

  it("民法实况：21 章只听了 1 章，能力必须是个位数（旧口径给 20 分）", () => {
    const s = scoreSubject({ total: 21, chapSteps: [1], outChapters: 0, open: 0, absorbed: 0, repeat: 0 });
    expect(s.depth).toBe(2);          // 旧口径分母用「已覆盖章」→ 33
    expect(s.ability).toBeLessThan(5);
  });

  it("零错题的科，分只由自己的覆盖决定，不受别科影响（纯函数无先验入参）", () => {
    const a = scoreSubject({ total: 21, chapSteps: [1], outChapters: 0, open: 0, absorbed: 0, repeat: 0 });
    const b = scoreSubject({ total: 21, chapSteps: [1], outChapters: 0, open: 0, absorbed: 0, repeat: 0 });
    expect(a.ability).toBe(b.ability);
  });
});

describe("P2 零证据零分：未开张的科不得凭空得分", () => {
  it("零章零错题 → 四维全 0、能力 0", () => {
    const s = scoreSubject({ total: 21, chapSteps: [], outChapters: 0, open: 0, absorbed: 0, repeat: 0 });
    expect([s.progress, s.depth, s.recitePct, s.ability]).toEqual([0, 0, 0, 0]);
    expect(s.closure).toBeNull();
  });

  it("英语零记录 → 能力 0", () => {
    expect(scoreEnglish({ accs: [], papers14d: 0, essays30d: 0, open: 0, absorbed: 0, repeat: 0 }).ability).toBe(0);
  });
});

describe("P3 反瞒报：删光某科错题不得涨分（7-22 那次没堵死，v3.1 用保守锚堵死）", () => {
  it("随机账本：抹掉全部错题记录后能力一律不升", () => {
    const r = rng(20260727);
    for (let i = 0; i < SAMPLES; i++) {
      const ev = randomEv(r);
      const withErr = scoreSubject(ev).ability;
      const hidden = scoreSubject({ ...ev, open: 0, absorbed: 0, repeat: 0 }).ability;
      expect(hidden, JSON.stringify(ev)).toBeLessThanOrEqual(withErr);
    }
  });

  it("有销账记录时，瞒报是严格亏的", () => {
    const ev: Ev = { total: 13, chapSteps: [3, 3, 3, 2, 2, 1], outChapters: 4, open: 8, absorbed: 4, repeat: 0 };
    expect(scoreSubject({ ...ev, open: 0, absorbed: 0, repeat: 0 }).ability).toBeLessThan(scoreSubject(ev).ability);
  });

  it("登记未销账的错题不掉分、销账才涨分——【仅当该科还没有任何销账记录时】（absorbed=0）", () => {
    const base: Ev = { total: 21, chapSteps: [3, 2, 2, 1], outChapters: 2, open: 0, absorbed: 0, repeat: 0 };
    const logged = scoreSubject({ ...base, open: 3 });
    const closed = scoreSubject({ ...base, absorbed: 3 });
    expect(logged.ability).toBe(scoreSubject(base).ability);
    expect(closed.ability).toBeGreaterThan(logged.ability);
  });

  // —— P3-c（2026-07-31 补·起因：上面那条测试只覆盖 absorbed=0，害得头注写下「登记未销账不掉分」这句
  //    在 absorbed>0 时并不成立的假不变量，云问"综合指数是不是虚低"时才查出来）——
  it("P3-c 方向：多登记一条错题永远不会让能力上升（否则会变成刷假错题赚分）", () => {
    const r = rng(20260731);
    for (let i = 0; i < SAMPLES; i++) {
      const ev = randomEv(r);
      expect(scoreSubject({ ...ev, open: ev.open + 1 }).ability, JSON.stringify(ev)).toBeLessThanOrEqual(scoreSubject(ev).ability);
    }
  });

  it("P3-c 上界：absorbed>0 时诚实登记确实有代价（诚实税），但云当前形状下不得超过 12 能力分", () => {
    // 云 2026-07-30 实况形状（跑 dashboard 拿的真值：刑法 open25/absorbed27/repeat5、法理 open13/absorbed4）
    const 刑法: Ev = { total: 21, chapSteps: [...Array(21)].map((_, i) => (i < 12 ? 3 : i < 17 ? 2 : 1)), outChapters: 6, open: 25, absorbed: 27, repeat: 5 };
    const 法理: Ev = { total: 13, chapSteps: [3, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1], outChapters: 10, open: 13, absorbed: 4, repeat: 0 };
    for (const ev of [刑法, 法理]) {
      const tax = scoreSubject({ ...ev, open: 0 }).ability - scoreSubject(ev).ability;
      expect(tax, `诚实税 ${tax} 分 @ ${JSON.stringify(ev)}`).toBeGreaterThan(0);   // 事实：它存在，别再写成"不掉分"
      expect(tax, `诚实税 ${tax} 分 @ ${JSON.stringify(ev)}`).toBeLessThanOrEqual(12); // 红线：调 SMOOTH_K/QUALITY_FLOOR 放大它就报警
    }
  });
});

describe("P4 单调：新增一条学习证据不得掉分（旧口径下多听一章新课会掉分）", () => {
  it("随机账本：多覆盖一章新课，能力一律不降", () => {
    const r = rng(20260728);
    for (let i = 0; i < SAMPLES; i++) {
      const ev = randomEv(r);
      if (ev.chapSteps.length >= ev.total) continue;
      const after = scoreSubject({ ...ev, chapSteps: [...ev.chapSteps, 1] });
      expect(after.ability, JSON.stringify(ev)).toBeGreaterThanOrEqual(scoreSubject(ev).ability);
    }
  });

  it("随机账本：已覆盖章上多走一个台阶，能力一律不降", () => {
    const r = rng(20260729);
    for (let i = 0; i < SAMPLES; i++) {
      const ev = randomEv(r);
      if (ev.chapSteps.length === 0) continue;
      const steps = [...ev.chapSteps];
      steps[0] = Math.min(3, steps[0] + 1);
      expect(scoreSubject({ ...ev, chapSteps: steps }).ability).toBeGreaterThanOrEqual(scoreSubject(ev).ability);
    }
  });

  it("旧口径的反例：5 章满台阶后再听第 6 章新章，不再掉分", () => {
    const before = scoreSubject({ total: 21, chapSteps: [3, 3, 3, 3, 3], outChapters: 5, open: 0, absorbed: 0, repeat: 0 });
    const after = scoreSubject({ total: 21, chapSteps: [3, 3, 3, 3, 3, 1], outChapters: 5, open: 0, absorbed: 0, repeat: 0 });
    expect(after.ability).toBeGreaterThan(before.ability);
  });
});

describe("英语：比率维必须过样本闸（旧口径第 1 篇 80% 当场 41 分）", () => {
  it("只做 1 篇 80%，能力远低于做满 4 篇 80%", () => {
    const one = scoreEnglish({ accs: [80], papers14d: 1, essays30d: 0, open: 0, absorbed: 0, repeat: 0 });
    const four = scoreEnglish({ accs: [80, 80, 80, 80], papers14d: 4, essays30d: 0, open: 0, absorbed: 0, repeat: 0 });
    expect(one.ability).toBeLessThan(20);
    expect(four.ability).toBeGreaterThan(one.ability * 2);
    expect(one.reading).toBe(80); // 展示的仍是真实均值，只是不按满格计分
  });

  it("英语同样反瞒报：删光错题不得涨分", () => {
    const ev = { accs: [70, 75], papers14d: 2, essays30d: 1, open: 5, absorbed: 3, repeat: 1 };
    expect(scoreEnglish({ ...ev, open: 0, absorbed: 0, repeat: 0 }).ability).toBeLessThanOrEqual(scoreEnglish(ev).ability);
  });
});
