import { describe, expect, it } from "vitest";
import { buildWeeklyPresentation, splitDispatchItems, splitH2Sections, splitPriorityActions } from "./report-presentation";

describe("report presentation", () => {
  it("把日报派单拆成可独立扫描的优先级行动", () => {
    expect(splitDispatchItems("[P0] 宪法首段 ｜ [P1] 冷验 T#62 ｜ [P1] 明早复检 L9")).toEqual([
      { priority: "P0", text: "宪法首段" },
      { priority: "P1", text: "冷验 T#62" },
      { priority: "P1", text: "明早复检 L9" },
    ]);
  });

  it("兼容旧周报的粗体第几件写法", () => {
    const parsed = splitPriorityActions(`（P0=红线）

**第 1 件【P0】宪法开张——先交第一条流水**

- 时段：周六上午
- 验收：出现 study_log

**第 2 件【P1】法制史收官**

- 验收：完成一章`);
    expect(parsed.intro).toBe("（P0=红线）");
    expect(parsed.actions).toEqual([
      expect.objectContaining({ priority: "P0", title: "宪法开张——先交第一条流水", body: expect.stringContaining("study_log") }),
      expect.objectContaining({ priority: "P1", title: "法制史收官", body: expect.stringContaining("完成一章") }),
    ]);
  });

  it("识别新版周报分层并把行动层前置", () => {
    const content = `## 本周结论
> 黄灯：P0 兑现不足，但深度动作上升。

## 本周变化
- 做对：周日冷启动。

## 下周作战卡
### [P0] 宪法开张
- 截止：周六
- 验收：第一条流水

### [P2] 英语保温
- 验收：一篇

## 证据附录
- P0 1/2。`;
    const parsed = buildWeeklyPresentation(content);
    expect(parsed.verdict).toContain("黄灯");
    expect(parsed.actions.map((item) => item.priority)).toEqual(["P0", "P2"]);
    expect(parsed.reviewSections.map((item) => item.title)).toEqual(["本周结论", "本周变化"]);
    expect(parsed.reviewSections[0].body).toContain("P0 兑现不足，但深度动作上升");
    expect(parsed.evidenceSections.map((item) => item.title)).toEqual(["证据附录"]);
  });

  it("H2 解析保留标题前导语并不误切 H3", () => {
    const parsed = splitH2Sections("前导\n## A\n### 子节\n正文\n## B\n末尾");
    expect(parsed.preamble).toBe("前导");
    expect(parsed.sections).toEqual([
      { title: "A", body: "### 子节\n正文" },
      { title: "B", body: "末尾" },
    ]);
  });
});
