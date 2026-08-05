import { describe, expect, it } from "vitest";
import { parseReviewSchedule } from "./assessment-ledgers.mjs";
import { appendScheduleItem } from "./schedule-store.mjs";

const TODAY = "2026-08-05";

describe("schedule store", () => {
  it("追加后用同一个解析器复验结构", () => {
    const result = appendScheduleItem("# 复盘排期\n", {
      id: "AUTO-1",
      date: TODAY,
      priority: "P0",
      type: "错题冷复检",
      task: "T#1：换角度复检",
      ref: "coach-engine:topic:T1:2026-08-05",
    }, { referenceDate: TODAY });
    expect(result.added).toBe(true);
    expect(parseReviewSchedule(result.markdown, { referenceDate: TODAY })).toMatchObject({ counts: { errors: 0, canonical: 1 } });
  });

  it("同一对象已有未完成排期时幂等跳过", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-04 | P1 | id=OLD | type=错题冷复检 | task=T#1 | ref=coach-engine:topic:T1:2026-08-04\n";
    const result = appendScheduleItem(markdown, {
      id: "AUTO-2",
      date: TODAY,
      priority: "P1",
      type: "错题冷复检",
      task: "T#1：再复检",
      ref: "coach-engine:topic:T1:2026-08-05",
    }, { referenceDate: TODAY, dedupeRefPrefix: "coach-engine:topic:T1:" });
    expect(result).toMatchObject({ added: false, reason: "open-ref" });
    expect(result.markdown).toBe(markdown);
  });
});
