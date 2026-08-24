// [gpt] 2026-08-13：CLI 科目别名归一回归，避免自然教材名阻断 Skill 启动。

import { describe, expect, it } from "vitest";
import { parseSkillContextOptions } from "./skill-context.mjs";

describe("skill-context CLI 科目参数", () => {
  it.each([
    ["民法学", "民法"],
    ["刑法学", "刑法"],
    ["法理学", "法理"],
    ["宪法学", "宪法"],
    ["中国法制史", "法制史"],
    ["英语一", "英语"],
  ])("将 %s 归一为 %s", (input, expected) => {
    expect(parseSkillContextOptions([input]).subject).toBe(expected);
    expect(parseSkillContextOptions(["--subject", input]).subject).toBe(expected);
  });

  it("当前科目别名也归一，未知值继续拒绝", () => {
    expect(parseSkillContextOptions(["--current-subject", "民法学"]).currentSubject).toBe("民法");
    expect(() => parseSkillContextOptions(["--subject", "商法"])).toThrow(/未知科目/);
  });

  it("新错题 intake 显式进入轻量模式", () => {
    expect(parseSkillContextOptions(["民法", "--intake"])).toMatchObject({ subject: "民法", intake: true });
  });
});
