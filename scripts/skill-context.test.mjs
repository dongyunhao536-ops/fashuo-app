// [gpt] 2026-08-13：CLI 科目别名归一回归，避免自然教材名阻断 Skill 启动。

import { describe, expect, it } from "vitest";
import { parseSkillContextOptions, trackSkillContextExecution } from "./skill-context.mjs";

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

  it("targetFallback 新 Run 走 snapshot 且真实补签 context_loaded", () => {
    const calls = [];
    const run = trackSkillContextExecution({
      parsed: { runId: null, signal: "startup", subject: "法理", kind: "recall" },
      recovery: { targetFallback: { targetRef: "R20260812-RECITE-L31" } },
      context: { skill: "daibei-pc" },
      referenceDate: "2026-08-24",
      mode: "daibei",
      startedAt: 100,
      nowMs: () => 140,
      dependencies: {
        startSkillRun: (input) => {
          calls.push(["start", input]);
          return { runId: "SR-NEW" };
        },
        recordAutomaticSkillStep: (input) => {
          calls.push(["step", input]);
          return { runId: input.runId, skill: "daibei-pc", steps: { context_loaded: { status: "pass" } } };
        },
      },
    });
    expect(calls[0][1]).toMatchObject({ entryMode: "snapshot", targetRef: "R20260812-RECITE-L31" });
    expect(calls[1][1]).toMatchObject({ runId: "SR-NEW", step: "context_loaded", durationMs: 40 });
    expect(run.steps.context_loaded.status).toBe("pass");
  });
});

// [claude] 2026-08-25：干跑测试若建成 learning Run 会计进 7 日验收统计；本组锁住
// purpose 的解析、透传与"不得复用既有 Run"三件事。Codex 审查指出原 9 条断言没有
// 一条覆盖新参数，只证明没改坏旧行为。
describe("skill-context --purpose 运行目的", () => {
  it("默认 learning，合法值原样解析", () => {
    expect(parseSkillContextOptions([]).purpose).toBe("learning");
    for (const value of ["learning", "diagnostic", "simulation"]) {
      expect(parseSkillContextOptions(["--purpose", value]).purpose).toBe(value);
    }
  });

  it("拒绝非法 purpose，也拒绝与 --run 续写组合", () => {
    expect(() => parseSkillContextOptions(["--purpose", "bogus"])).toThrow(/只接受 learning\|diagnostic\|simulation/);
    expect(() => parseSkillContextOptions(["--run", "SR-1", "--purpose", "diagnostic"])).toThrow(/只在新建 Run 时生效/);
    expect(parseSkillContextOptions(["--run", "SR-1", "--purpose", "learning"]).purpose).toBe("learning");
  });

  it("purpose 透传到常规建 Run 与 targetFallback 两条分支", () => {
    for (const recovery of [null, { targetFallback: { targetRef: "R20260812-RECITE-L31" } }]) {
      const calls = [];
      trackSkillContextExecution({
        parsed: { runId: null, signal: "startup", subject: "法理", kind: null, purpose: "diagnostic" },
        recovery,
        context: { skill: "cuoti-fupan" },
        referenceDate: "2026-08-25",
        mode: "cuoti",
        startedAt: 0,
        nowMs: () => 10,
        dependencies: {
          startSkillRun: (input) => { calls.push(input); return { runId: "SR-NEW" }; },
          recordAutomaticSkillStep: () => ({ runId: "SR-NEW", steps: {} }),
        },
      });
      expect(calls[0].runPurpose).toBe("diagnostic");
    }
  });

  it("非 learning 不得隐式复用既有 Run——干跑不能接进真实学习 Run", () => {
    const resume = () => { throw new Error("不该走到 resume"); };
    expect(() => trackSkillContextExecution({
      parsed: { runId: null, signal: "startup", subject: "法理", kind: null, purpose: "diagnostic" },
      recovery: { preferred: { runId: "SR-LEARNING" } },
      context: { skill: "daibei-pc" },
      referenceDate: "2026-08-25",
      mode: "daibei",
      startedAt: 0,
      nowMs: () => 10,
      dependencies: { resumeDaibeiSkillRun: resume },
    })).toThrow(/不能复用既有 Run SR-LEARNING/);
  });

  it("learning 仍可正常隐式复用，不误伤真实续跑", () => {
    const seen = [];
    trackSkillContextExecution({
      parsed: { runId: null, signal: "startup", subject: "法理", kind: null, purpose: "learning" },
      recovery: { preferred: { runId: "SR-LEARNING" } },
      context: { skill: "daibei-pc" },
      referenceDate: "2026-08-25",
      mode: "daibei",
      startedAt: 0,
      nowMs: () => 10,
      dependencies: { resumeDaibeiSkillRun: (input) => { seen.push(input); return { runId: input.runId }; } },
    });
    expect(seen[0]).toMatchObject({ runId: "SR-LEARNING", subject: "法理" });
  });
});
