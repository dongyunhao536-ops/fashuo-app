import { describe, it, expect } from "vitest";
import { parseBlocks } from "./coach";

describe("parseBlocks WRONGS 抽取（错题列表）", () => {
  it("逐行解析 WRONGS，剥行首符号/序号、滤占位词", () => {
    const raw = `===PARSED===
subject: 刑法
activity: 做题
===POINTER===
点拨
===PROGRESS===
归位
===PLAN===
规划
===REVIEW===
复盘
===WEAK===
留空
===WRONGS===
- 正当防卫
1. 因果关系认定
留空
紧急避险`;
    const j = parseBlocks(raw);
    expect(j).not.toBeNull();
    expect(j!.wrongs).toEqual(["正当防卫", "因果关系认定", "紧急避险"]);
    expect(j!.parsed?.subject).toBe("刑法");
  });

  it("无 WRONGS 块 → wrongs 为空数组（不报错）", () => {
    const j = parseBlocks(`===PARSED===\nsubject: 民法\n===POINTER===\nx`);
    expect(j!.wrongs).toEqual([]);
  });
});
