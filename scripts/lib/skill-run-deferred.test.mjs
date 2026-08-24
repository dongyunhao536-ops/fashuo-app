// [claude] 2026-08-24：断网降级通路的回归。
//
// 实况：2026-08-24 云网络本身不稳，三次中断。cuoti 复检的证据已经进了本地 outbox，
// 只是远端没同步上；写回步骤只在成功时才签，失败不留任何遥测，于是四个 Run 被迫
// 记成 aborted。监控显示"判了题不写回"，而 error_review T#94 其实在 19 分钟后
// 自己落库了。状态机只有"成功"和"中止"两档，缺了中间这一档。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  endSkillRun,
  readSkillRun,
  readSkillRunEvents,
  recordAutomaticSkillStep,
  recordManualSkillStep,
  recordWritebackDeferred,
  startSkillRun,
  summarizeSkillRuns,
} from "./skill-run.mjs";

function harness() {
  return { file: join(mkdtempSync(join(tmpdir(), "skill-deferred-")), "skill-runs.jsonl") };
}

function judgedRun(file, runId = "SR-DEFER") {
  const run = startSkillRun({ skill: "cuoti-fupan", subject: "法制史", kind: "review", file, runId });
  recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#94/E#106", file });
  recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "cuoti-material", file });
  recordAutomaticSkillStep({
    runId: run.runId, step: "question_integrity_pass", source: "question-integrity",
    artifactHash: "a".repeat(64), artifactLength: 20, file,
  });
  return run;
}

describe("写回延迟（断网降级通路）", () => {
  it("同步失败时留痕，Run 进入 deferred 而不是被迫当作已完成", () => {
    const { file } = harness();
    const run = judgedRun(file);

    const after = recordWritebackDeferred({
      runId: run.runId,
      source: "cuoti-review",
      reason: "远端同步失败；复检证据已暂存本地 outbox",
      operationId: "op-1234",
      evidenceRef: "T#94:partial",
      expectedSkill: "cuoti-fupan",
      file,
    });

    expect(after.status).toBe("deferred");
    expect(after.deferredWriteback.operationId).toBe("op-1234");
    expect(after.deferredWriteback.reason).toContain("同步失败");
    // 关键：延迟不等于写回成功，门槛一步都不许放宽。
    expect(after.steps.writeback_verified).toBeUndefined();
    expect(after.steps.result_recorded).toBeUndefined();
  });

  it("延迟状态下仍不能按 result 收口——证据还没落库", () => {
    const { file } = harness();
    const run = judgedRun(file);
    recordWritebackDeferred({ runId: run.runId, source: "cuoti-review", operationId: "op-1", file });

    expect(() => endSkillRun({
      runId: run.runId, phase: "result", done: ["response_verified"],
      evidenceRef: "T#94", artifactHash: "b".repeat(64), file,
    })).toThrow(/result_recorded|writeback_verified/);
  });

  it("补同步后回执接回原 Run，可以正常收口", () => {
    const { file } = harness();
    const run = judgedRun(file);
    recordWritebackDeferred({ runId: run.runId, source: "cuoti-review", operationId: "op-1", evidenceRef: "T#94:partial", file });

    recordAutomaticSkillStep({ runId: run.runId, step: "diagnosis_recorded", source: "cuoti-classify", evidenceRef: "E#106:diagnosis=confirmed", file });
    recordAutomaticSkillStep({
      runId: run.runId, step: "judgment_output_verified", source: "judgment-result",
      evidenceRef: "T#94/E#106:partial:diagnosis=confirmed", artifactHash: "c".repeat(64), artifactLength: 42, file,
    });
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "cuoti-review-deferred", evidenceRef: "T#94:partial:diagnosis=confirmed", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "writeback_verified", source: "cuoti-sync-deferred", evidenceRef: "deferred:op-1:applied", file });

    const resumed = readSkillRun(run.runId, file);
    // 写回真成功后，延迟标记必须撤销，否则监控会一直把它算作待补同步。
    expect(resumed.deferredWriteback).toBeNull();
    expect(resumed.status).not.toBe("deferred");

    const ended = endSkillRun({
      runId: run.runId, phase: "result", done: ["response_verified"],
      evidenceRef: "T#94", artifactHash: "c".repeat(64), file,
    });
    expect(ended.end.outcome).toBe("completed");
  });

  it("因同步失败而中止的 Run 带标记，监控能与真放弃分开", () => {
    const { file } = harness();
    const deferred = judgedRun(file, "SR-NET");
    recordWritebackDeferred({ runId: deferred.runId, source: "cuoti-review", operationId: "op-9", reason: "远端同步失败", file });
    endSkillRun({ runId: deferred.runId, outcome: "aborted", file });

    const abandoned = judgedRun(file, "SR-GIVEUP");
    endSkillRun({ runId: abandoned.runId, outcome: "aborted", file });

    const report = summarizeSkillRuns(readSkillRunEvents(file), { nowIso: "2026-08-24T12:00:00Z" });
    expect(report.counts.aborted).toBe(2);
    expect(report.counts.deferredWriteback).toBe(1);
    expect(report.counts.abandonedAborted).toBe(1);

    const example = report.deferredWritebackExamples.find((row) => row.runId === "SR-NET");
    expect(example.outcome).toBe("aborted");
    // 报表要直接给出可执行的续跑命令，不能只报"有个 Run 卡住了"。
    expect(example.resume).toContain("cuoti.mjs sync --run SR-NET --operation op-9");
  });

  it("已结束的 Run 不能再记延迟写回", () => {
    const { file } = harness();
    const run = judgedRun(file);
    endSkillRun({ runId: run.runId, outcome: "aborted", file });
    expect(() => recordWritebackDeferred({ runId: run.runId, source: "cuoti-review", file }))
      .toThrow(/已结束/);
  });

  it("路由不符时拒绝留痕，不给跨 skill 冒名的机会", () => {
    const { file } = harness();
    const run = judgedRun(file);
    expect(() => recordWritebackDeferred({
      runId: run.runId, source: "cuoti-review", expectedSkill: "daibei-pc", file,
    })).toThrow(/路由不一致/);
  });
});
