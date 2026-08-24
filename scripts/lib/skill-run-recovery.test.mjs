// [claude] 2026-08-23：阻断必须带补救指令的回归。
// 病灶实证：2026-08-13～08-23 共 21 次阻断，daibei-pc/plan 缺 context_loaded
// 一项在 8 天里重复 5 次；错误信息只说缺什么、不说归谁签，模型只能再花往返或瞎猜。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRecovery, recoveryHint, recoveryHints } from "./skill-run-recovery.mjs";
import { buildSkillExecutionContext, endSkillRun, startSkillRun } from "./skill-run.mjs";

function harness() {
  return { file: join(mkdtempSync(join(tmpdir(), "skill-recovery-")), "skill-runs.jsonl") };
}

describe("阻断补救指令", () => {
  it("context_loaded 指向 skill-context 并要求挂到原 Run，不叫模型新建 Run", () => {
    const hint = recoveryHint("daibei-pc", "context_loaded", { runId: "SR-A", subject: "法理" });
    expect(hint).toContain("skill-context.mjs daibei 法理");
    expect(hint).toContain("--run SR-A");
    expect(hint).toContain("不要为此新建 Run");
  });

  it("yingyu-pc 不走 skill-context（它不是合法档位），改指 english-growth start", () => {
    const hint = recoveryHint("yingyu-pc", "context_loaded", { runId: "SR-B" });
    expect(hint).toContain("english-growth.mjs start");
    expect(hint).not.toContain("skill-context.mjs");
  });

  it("材料检索指令带 --env-file，并把多争点导向 material-batch", () => {
    const hint = recoveryHint("cuoti-fupan", "materials_checked", { runId: "SR-C" });
    // macOS 上不带 --env-file 会因 mirror-scope 的 D:\fashuo 根回退而直接失败。
    expect(hint).toContain("--env-file=.env.local");
    expect(hint).toContain("material-batch");
    expect(hint).toContain("别拆成多次 material");
  });

  it("题面 Gate 指令说明 PASS 草稿与 hash 的绑定关系", () => {
    const hint = recoveryHint("cuoti-fupan", "question_integrity_pass", { runId: "SR-D" });
    expect(hint).toContain("question-integrity.mjs check");
    expect(hint).toContain("QUESTION_INTEGRITY_PASS");
    expect(hint).toContain("--hash");
  });

  it("写回回执按 skill 与阶段分流，且明确拒绝手工补签", () => {
    const intake = recoveryHint("cuoti-fupan", "result_recorded", { runId: "SR-E", phase: "intake" });
    expect(intake).toContain("record-batch");
    const review = recoveryHint("cuoti-fupan", "result_recorded", { runId: "SR-E", phase: "result" });
    expect(review).toContain("cuoti.mjs review");
    expect(review).toContain("不接受手工补签");

    const daibei = recoveryHint("daibei-pc", "writeback_verified", { runId: "SR-F" });
    expect(daibei).toContain("daibei-ledger.mjs evidence");
    expect(daibei).toContain("cuoti.mjs sync --operation");
  });

  it("手工步骤给出 --done/--ref 写法及该写什么引用", () => {
    const hint = recoveryHint("cuoti-fupan", "target_frozen", { runId: "SR-G" });
    expect(hint).toContain("--done target_frozen");
    expect(hint).toContain("T#/事件号");
  });

  it("intake_question 缺口说明题数必须与批次错题数一致", () => {
    const hint = recoveryHint("cuoti-fupan", "intake_question×2", { runId: "SR-H" });
    expect(hint).toContain("--phase intake_question");
    expect(hint).toContain("题数必须与批次内错题数一致");
  });

  it("未知步骤不编造指令，formatRecovery 退化为空串", () => {
    expect(recoveryHint("cuoti-fupan", "no_such_step")).toBeNull();
    expect(formatRecovery("cuoti-fupan", ["no_such_step"])).toBe("");
    expect(formatRecovery("cuoti-fupan", [])).toBe("");
  });

  it("多条缺失逐条给指令且保序", () => {
    const lines = recoveryHints("cuoti-fupan", ["target_frozen", "materials_checked"], { runId: "SR-I" });
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("target_frozen →")).toBe(true);
    expect(lines[1].startsWith("materials_checked →")).toBe(true);
  });
});

describe("接线到真实阻断", () => {
  // 复现 2026-08-22 实况：DAIBEI_CONTEXT_REQUIRED 只挡住裸启动，
  // 用 --target 起的轻量 Run 仍能走到 --phase plan，于是缺 context_loaded。
  it("end 阻断的报错正文直接带补救命令", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "daibei-pc", subject: "法理", targetRef: "第五章第一节", file, runId: "SR-PLAN" });
    let message = "";
    try {
      endSkillRun({ runId: run.runId, phase: "plan", done: ["priority_checked", "response_verified"], evidenceRef: "P0-1", file });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("缺步骤：context_loaded");
    expect(message).toContain("补救：");
    expect(message).toContain("skill-context.mjs daibei");
    expect(message).toContain(run.runId);
  });

  it("启动快照就交出每一步归谁签，不必等被阻断才知道", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", subject: "刑法", kind: "review", file, runId: "SR-EXEC" });
    const execution = buildSkillExecutionContext(run);
    expect(Object.keys(execution.stepCommands)).toEqual(
      expect.arrayContaining(["target_frozen", "materials_checked", "question_integrity_pass", "result_recorded"]),
    );
    expect(execution.stepCommands.materials_checked).toContain("cuoti.mjs material");
    expect(execution.stepCommands.question_integrity_pass).toContain("question-integrity.mjs");
    // phases 里出现的每一步都要能答出"归谁签"，否则模型仍要靠猜。
    const covered = new Set(Object.keys(execution.stepCommands));
    for (const steps of Object.values(execution.phases)) {
      for (const step of steps) expect(covered.has(step)).toBe(true);
    }
  });
});
