import { describe, it, expect } from "vitest";
import { bjDateStr, bjDayStart, bjDayEnd, bjWeekMonday } from "./dates";

describe("dates 北京日历日", () => {
  it("UTC 当天白天 → 同一北京日", () => {
    expect(bjDateStr(new Date("2026-06-11T04:00:00Z"))).toBe("2026-06-11");
  });

  it("北京 0–8 点（UTC 前一天 16:00–24:00）归到正确的北京日，不再错记前一天", () => {
    // 北京 2026-06-11 06:30 = UTC 2026-06-10 22:30
    expect(bjDateStr(new Date("2026-06-10T22:30:00Z"))).toBe("2026-06-11");
    // 边界：北京 00:00 = UTC 前一天 16:00
    expect(bjDateStr(new Date("2026-06-10T16:00:00Z"))).toBe("2026-06-11");
    // 边界前一刻：UTC 15:59:59 仍是北京前一天 23:59:59
    expect(bjDateStr(new Date("2026-06-10T15:59:59Z"))).toBe("2026-06-10");
  });

  it("bjDayStart/bjDayEnd 带 +08:00 偏移，供 timestamptz 窗口", () => {
    expect(bjDayStart("2026-06-11")).toBe("2026-06-11T00:00:00+08:00");
    expect(bjDayEnd("2026-06-11")).toBe("2026-06-11T23:59:59.999+08:00");
  });

  it("bjWeekMonday 返回北京时间所在自然周的周一", () => {
    // 2026-07-01 是周三 → 本周一 2026-06-29
    expect(bjWeekMonday(new Date("2026-07-01T04:00:00Z"))).toBe("2026-06-29");
    // 周一当天（北京周一 07:00 = UTC 周日 23:00）→ 自己
    expect(bjWeekMonday(new Date("2026-06-28T23:00:00Z"))).toBe("2026-06-29");
    // 周日（北京 2026-07-05）→ 仍是本周一 06-29；cron 周一取昨天锚点即落上一整周
    expect(bjWeekMonday(new Date("2026-07-05T04:00:00Z"))).toBe("2026-06-29");
    // 北京周一 0-8 点（UTC 还是周日）不许滑回上一周
    expect(bjWeekMonday(new Date("2026-06-28T16:00:00Z"))).toBe("2026-06-29");
  });
});
