import { describe, it, expect } from "vitest";
import { splitCoachMeta, aggregateErrorBook, COACH_META_OPEN, COACH_META_CLOSE, type ErrorBookRow } from "./coach";

describe("splitCoachMeta 正文+META 分离", () => {
  it("抽出 META、剥离展示正文", () => {
    const full = `今天辛苦了！犯罪构成听懂了就好。\n\n${COACH_META_OPEN}\n{"subject":"刑法","activity":"听课","accuracy":80,"wrongs":["正当防卫"],"absorbed":[],"memory_updates":[{"fact":"五战","category":"画像"}]}\n${COACH_META_CLOSE}`;
    const { clean, meta } = splitCoachMeta(full);
    expect(clean).toBe("今天辛苦了！犯罪构成听懂了就好。");
    expect(meta?.subject).toBe("刑法");
    expect(meta?.accuracy).toBe(80);
    expect(meta?.wrongs).toEqual(["正当防卫"]);
    expect(meta?.memory_updates?.[0].fact).toBe("五战");
  });

  it("无 META 块 → meta=null，正文原样", () => {
    const { clean, meta } = splitCoachMeta("纯聊天，没有元数据。");
    expect(clean).toBe("纯聊天，没有元数据。");
    expect(meta).toBeNull();
  });

  it("META JSON 损坏 → meta=null 但保住正文（不阻塞对话）", () => {
    const { clean, meta } = splitCoachMeta(`正文在此。\n${COACH_META_OPEN}\n{坏的json\n${COACH_META_CLOSE}`);
    expect(clean).toBe("正文在此。");
    expect(meta).toBeNull();
  });

  it("容错 ```json 包裹", () => {
    const full = `回复。\n${COACH_META_OPEN}\n\`\`\`json\n{"subject":"民法"}\n\`\`\`\n${COACH_META_CLOSE}`;
    expect(splitCoachMeta(full).meta?.subject).toBe("民法");
  });

  it("META 块提前吐在中间 → 块后正文不被吞（与答疑 splitMeta 2026-07-04 同修）", () => {
    const full = `先回一句。\n${COACH_META_OPEN}\n{"subject":"刑法"}\n${COACH_META_CLOSE}\n后半段辅导正文。`;
    const { clean, meta } = splitCoachMeta(full);
    expect(meta?.subject).toBe("刑法");
    expect(clean).toContain("先回一句");
    expect(clean).toContain("后半段辅导正文");
    expect(clean).not.toContain("COACH_META");
  });
});

describe("aggregateErrorBook（复发感知：销账不清零 + 周日复检名单）", () => {
  const DAY = 86400000;
  const now = new Date("2026-07-04T12:00:00+08:00").getTime();
  const row = (p: Partial<ErrorBookRow>): ErrorBookRow => ({
    subject: "刑法", kp_id: null, knowledge: "正当防卫限度",
    log_date: "2026-07-03", status: "open", absorbed_at: null, ...p,
  });

  it("吸收过又错 → 🔁标记，累计错次含 absorbed（销账不清零）、达阈值挂 🔺", () => {
    const rows = [
      row({ status: "absorbed", absorbed_at: "2026-06-20T10:00:00+08:00", log_date: "2026-06-18" }),
      row({ status: "absorbed", absorbed_at: "2026-06-27T10:00:00+08:00", log_date: "2026-06-26" }),
      row({ status: "open", log_date: "2026-07-03" }),
    ];
    const { lines, recheck } = aggregateErrorBook(rows, 3, now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("×3");
    expect(lines[0]).toContain("🔁曾吸收又错");
    expect(lines[0]).toContain("🔺转专题");
    expect(recheck).toHaveLength(0); // 还有 open 行 → 不进复检名单（它已经在挂账清单里了）
  });

  it("纯 open 无复发 → 不挂 🔁，计数照旧", () => {
    const { lines } = aggregateErrorBook([row({}), row({ log_date: "2026-07-01" })], 3, now);
    expect(lines[0]).toContain("×2");
    expect(lines[0]).not.toContain("🔁");
  });

  it("全吸收且销账满 5 天 → 进复检名单（最老优先）；<5 天或 >60 天不进", () => {
    const rows = [
      row({ knowledge: "假想防卫", status: "absorbed", absorbed_at: new Date(now - 10 * DAY).toISOString() }),
      row({ knowledge: "间接故意", status: "absorbed", absorbed_at: new Date(now - 30 * DAY).toISOString() }),
      row({ knowledge: "太新", status: "absorbed", absorbed_at: new Date(now - 2 * DAY).toISOString() }),
      row({ knowledge: "太老", status: "absorbed", absorbed_at: new Date(now - 90 * DAY).toISOString() }),
    ];
    const { lines, recheck } = aggregateErrorBook(rows, 3, now);
    expect(lines).toHaveLength(0);
    expect(recheck).toHaveLength(2);
    expect(recheck[0]).toContain("间接故意"); // 30 天前吸收的排最前（最老优先）
    expect(recheck[1]).toContain("假想防卫");
  });

  it("同 kp_id 跨短语聚合为一条", () => {
    const rows = [
      row({ kp_id: "XF-0042", knowledge: "正当防卫限度" }),
      row({ kp_id: "XF-0042", knowledge: "防卫过当", log_date: "2026-07-02" }),
    ];
    expect(aggregateErrorBook(rows, 3, now).lines).toHaveLength(1);
  });
});
