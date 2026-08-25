// [gpt] 2026-08-12：Skill Run 状态机回归；自动步骤不可口头补签，缺步骤不能展示或完成。

import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SkillRunGateError,
  assertCuotiJudgmentReady,
  assertDaibeiTargetWritebackReady,
  checkpointSkillRun,
  endSkillRun,
  findDaibeiRecovery,
  readSkillRunEvents,
  recordAutomaticSkillStep,
  recordBusinessWriteback,
  recordDaibeiKnowledgeAttemptWriteback,
  recordDaibeiProgressWriteback,
  recordEnglishReadingWriteback,
  validateBusinessWriteback,
  validateDaibeiIngestReceipt,
  validateDaibeiProgressWriteback,
  recordManualSkillStep,
  resumeDaibeiSkillRun,
  startSkillRun,
  summarizeSkillRuns,
} from "./skill-run.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "skill-run-"));
  return { file: join(dir, "skill-runs.jsonl") };
}

describe("Skill Run 硬闸", () => {
  it("缺材料或题面 Gate 时拒绝展示题目，补真实回执后才放行", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, now: "2026-08-12T01:00:00Z", runId: "SR-QUESTION" });
    // [gpt] 2026-08-13：目标 T# 已知时，展示题目的硬闸只依赖目标、材料与无泄题草稿。
    expect(() => checkpointSkillRun({
      runId: run.runId,
      phase: "question",
      done: ["target_frozen"],
      evidenceRef: "T#10",
      file,
      now: "2026-08-12T01:00:02Z",
    })).toThrow(SkillRunGateError);

    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file, now: "2026-08-12T01:00:03Z" });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "b".repeat(64), artifactLength: 12, file, now: "2026-08-12T01:00:04Z" });
    expect(() => checkpointSkillRun({ runId: run.runId, phase: "question", artifactHash: "c".repeat(64), file, now: "2026-08-12T01:00:05Z" })).toThrow(/question_integrity_pass/);
    expect(checkpointSkillRun({ runId: run.runId, phase: "question", artifactHash: "b".repeat(64), file, now: "2026-08-12T01:00:06Z" }).status).toBe("waiting_user");
  });

  it("自动步骤禁止手工签字，结果缺真实记录或写回核对时不能假收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-RESULT" });
    expect(() => recordManualSkillStep({ runId: run.runId, step: "replanned", file })).toThrow(/只能由对应脚本自动落证/);
    // [gpt] 2026-08-13：直接复检无需个人全盘，业务结果和写回仍不可手工补签。
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#42/E#42", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test-material", evidenceRef: "queries:3", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "question-integrity", artifactHash: "d".repeat(64), artifactLength: 12, file });
    expect(() => endSkillRun({
      runId: run.runId,
      phase: "result",
      done: ["response_verified"],
      evidenceRef: "review:E42",
      file,
    })).toThrow(/result_recorded/);
    expect(() => recordManualSkillStep({ runId: run.runId, step: "result_recorded", evidenceRef: "review:E42", file })).toThrow(/只能由对应脚本自动落证/);
    expect(() => recordManualSkillStep({ runId: run.runId, step: "writeback_verified", evidenceRef: "outbox:op-42", file })).toThrow(/只能由对应脚本自动落证/);
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "test-business-command", evidenceRef: "T#42:partial:diagnosis=confirmed", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "writeback_verified", source: "test-business-command", evidenceRef: "T#42:partial:diagnosis=confirmed", file });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", done: ["response_verified"], evidenceRef: "manual-bypass", file })).toThrow(/judgment_output_verified/);
    expect(() => recordManualSkillStep({ runId: run.runId, step: "judgment_output_verified", evidenceRef: "manual-bypass", file })).toThrow(/只能由对应脚本自动落证/);
    recordAutomaticSkillStep({
      runId: run.runId,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: "T#42/E#42:partial:diagnosis=confirmed",
      artifactHash: "e".repeat(64),
      artifactLength: 320,
      file,
    });
    recordAutomaticSkillStep({ runId: run.runId, step: "diagnosis_recorded", source: "test-business-command", evidenceRef: "E#42:diagnosis=confirmed", file });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", artifactHash: "f".repeat(64), file })).toThrow(/hash/);
    expect(endSkillRun({ runId: run.runId, phase: "result", artifactHash: "e".repeat(64), file }).status).toBe("completed");
  });

  it("错题证据卡与数据库写回的 T# 或结果不一致时拒绝收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-JUDGMENT-MISMATCH" });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#42", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 10, file });
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "writeback_verified", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "judgment_output_verified", source: "test", evidenceRef: "T#43:partial:diagnosis=pending", artifactHash: "b".repeat(64), artifactLength: 20, file });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", artifactHash: "b".repeat(64), file })).toThrow(/不一致/);
  });

  it("partial/fail 的 pending 病根必须先展示证据卡暂停，认领写回后才能收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-DIAGNOSIS-LIFECYCLE" });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#42/E#81", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 10, file });
    recordAutomaticSkillStep({
      runId: run.runId,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: "T#42/E#81:partial:diagnosis=pending",
      artifactHash: "b".repeat(64),
      artifactLength: 200,
      candidateHash: "9".repeat(64),
      file,
    });
    expect(() => assertCuotiJudgmentReady({ runId: run.runId, topicId: 42, result: "partial", diagnosisStatus: "confirmed", file })).toThrow(/不一致/);
    expect(assertCuotiJudgmentReady({ runId: run.runId, topicId: 42, result: "partial", diagnosisStatus: "pending", file }).runId).toBe(run.runId);
    recordBusinessWriteback({
      runId: run.runId,
      source: "cuoti-review",
      evidenceRef: "T#42:partial:diagnosis=pending",
      expectedSkill: "cuoti-fupan",
      requiredSteps: ["target_frozen", "materials_checked", "question_integrity_pass", "judgment_output_verified"],
      file,
    });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", artifactHash: "b".repeat(64), file })).toThrow(/病根仍待认领/);
    expect(() => checkpointSkillRun({ runId: run.runId, phase: "diagnosis_question", artifactHash: "c".repeat(64), file })).toThrow(/judgment_output_verified/);
    expect(checkpointSkillRun({ runId: run.runId, phase: "diagnosis_question", artifactHash: "b".repeat(64), file }).status).toBe("waiting_user");

    recordAutomaticSkillStep({
      runId: run.runId,
      step: "diagnosis_recorded",
      source: "cuoti-classify",
      evidenceRef: "E#81:diagnosis=confirmed",
      file,
    });
    recordAutomaticSkillStep({
      runId: run.runId,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: "T#42/E#81:partial:diagnosis=confirmed",
      artifactHash: "c".repeat(64),
      artifactLength: 220,
      candidateHash: "9".repeat(64),
      file,
    });
    expect(endSkillRun({ runId: run.runId, phase: "result", artifactHash: "c".repeat(64), file }).status).toBe("completed");
  });

  it("pending 到终态的候选集合 hash 不可改写", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-CANDIDATE-HASH" });
    recordAutomaticSkillStep({
      runId: run.runId,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: "T#42:fail:diagnosis=pending",
      artifactHash: "a".repeat(64),
      artifactLength: 200,
      candidateHash: "b".repeat(64),
      file,
    });
    expect(() => recordAutomaticSkillStep({
      runId: run.runId,
      step: "judgment_output_verified",
      source: "judgment-result",
      evidenceRef: "T#42:fail:diagnosis=confirmed",
      artifactHash: "c".repeat(64),
      artifactLength: 220,
      candidateHash: "d".repeat(64),
      file,
    })).toThrow(/DIAGNOSIS_CANDIDATES_IMMUTABLE/);
  });

  it("confirmed 判题卡必须与 diagnosis_recorded 状态一致", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-DIAGNOSIS-MISMATCH" });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#42/E#81", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 10, file });
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "writeback_verified", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "diagnosis_recorded", source: "test", evidenceRef: "E#81:diagnosis=rejected", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "judgment_output_verified", source: "test", evidenceRef: "T#42/E#81:fail:diagnosis=confirmed", artifactHash: "d".repeat(64), artifactLength: 200, file });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", artifactHash: "d".repeat(64), file })).toThrow(/病根状态.*不一致/);
  });

  it("不能用另一个事件的病根认领回执解锁当前判题", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-DIAGNOSIS-TARGET-MISMATCH" });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "T#42/E#81", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 10, file });
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "writeback_verified", source: "test", evidenceRef: "T#42:fail:diagnosis=pending", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "diagnosis_recorded", source: "test", evidenceRef: "E#82:diagnosis=confirmed", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "judgment_output_verified", source: "test", evidenceRef: "T#42/E#81:fail:diagnosis=confirmed", artifactHash: "e".repeat(64), artifactLength: 200, file });
    expect(() => endSkillRun({ runId: run.runId, phase: "result", artifactHash: "e".repeat(64), file })).toThrow(/认领对象.*不一致/);
  });

  it("同一会话禁止另建 Run 掩盖漏步，handoff 必须写明目标和原因", () => {
    const { file } = harness();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "session-1";
    try {
      const run = startSkillRun({ skill: "coach-pc", file, runId: "SR-HANDOFF", sessionId: "session-1", turnId: "turn-1" });
      expect(() => startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-DUP", sessionId: "session-1", turnId: "turn-1" })).toThrow(/已有未收口/);
      expect(() => endSkillRun({ runId: run.runId, outcome: "handoff", file })).toThrow(/--to/);
      expect(() => endSkillRun({ runId: run.runId, outcome: "handoff", handoffSkill: "cuoti-fupan", file })).toThrow(/--reason/);
      const ended = endSkillRun({ runId: run.runId, outcome: "handoff", handoffSkill: "cuoti-fupan", handoffReason: "用户要求逐题销账", file });
      expect(ended.end).toMatchObject({ outcome: "handoff", handoffSkill: "cuoti-fupan", handoffReason: "用户要求逐题销账" });
      expect(startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-AFTER-HANDOFF", sessionId: "session-1", turnId: "turn-1" }).skill).toBe("cuoti-fupan");
    } finally {
      if (previousThread == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });

  it("调用方不显式传 session 时仍使用宿主 session 阻止重复 Run", () => {
    const { file } = harness();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "session-inferred";
    try {
      startSkillRun({ skill: "coach-pc", file, runId: "SR-INFERRED-1" });
      expect(() => startSkillRun({ skill: "ask-pc", file, runId: "SR-INFERRED-2" })).toThrow(/已有未收口/);
    } finally {
      if (previousThread == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });

  it("无宿主 session 但同 turn 明确绑定时也阻止重复 Run", () => {
    const { file } = harness();
    startSkillRun({ skill: "coach-pc", file, runId: "SR-TURN-ONLY-1", turnId: "turn-only" });
    expect(() => startSkillRun({ skill: "ask-pc", file, runId: "SR-TURN-ONLY-2", turnId: "turn-only" })).toThrow(/已有未收口/);
  });

  it("通用业务写回桥只落 result/writeback，不能冒充答案键核验", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "coach-pc", file, runId: "SR-BUSINESS" });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file });
    const recorded = recordBusinessWriteback({
      runId: run.runId,
      source: "coach-log",
      evidenceRef: "study-log:op-1:applied",
      expectedSkill: "coach-pc",
      requiredSteps: ["context_loaded"],
      file,
    });
    expect(recorded.steps).toMatchObject({
      result_recorded: { status: "pass", source: "coach-log" },
      writeback_verified: { status: "pass", source: "coach-log" },
    });
    expect(recorded.steps.answer_key_checked).toBeUndefined();
  });

  it("自背进度走轻量 progress 回执，不加载全盘画像也不冒充抽查结果", () => {
    const { file } = harness();
    const run = startSkillRun({
      skill: "daibei-pc",
      subject: "法制史",
      kind: "progress",
      targetRef: "第三章 秦汉三国两晋南北朝",
      file,
      runId: "SR-DAIBEI-PROGRESS",
    });
    expect(() => validateDaibeiProgressWriteback({
      runId: run.runId,
      subject: "法制史",
      chapter: "第四章 隋唐宋",
      activity: "背诵",
      recitationMode: "自背",
      file,
    })).toThrow(/TARGET_MISMATCH/);
    expect(validateBusinessWriteback({
      runId: run.runId,
      subject: "法制史",
      chapter: "第三章 秦汉三国两晋南北朝",
      activity: "背诵",
      recitationMode: "自背",
      file,
    })).toMatchObject({ expectedSkill: "daibei-pc", businessMode: "daibei_progress" });
    const recorded = recordDaibeiProgressWriteback({
      runId: run.runId,
      subject: "法制史",
      chapter: "第三章 秦汉三国两晋南北朝",
      activity: "背诵",
      recitationMode: "自背",
      operationId: "op-progress-1",
      file,
    });
    expect(recorded.steps).toMatchObject({
      progress_recorded: { status: "pass", source: "coach-log" },
      writeback_verified: { status: "pass", source: "coach-log" },
    });
    expect(recorded.steps.context_loaded).toBeUndefined();
    expect(recorded.steps.result_recorded).toBeUndefined();
    expect(endSkillRun({
      runId: run.runId,
      phase: "progress",
      done: ["response_verified"],
      evidenceRef: "study-log:op-progress-1:applied",
      file,
    }).status).toBe("completed");
  });

  it("带背 recall 禁止降级成 plan 收口", () => {
    const { file } = harness();
    const run = startSkillRun({
      skill: "daibei-pc",
      subject: "法制史",
      kind: "recall",
      targetRef: "第三章 秦汉三国两晋南北朝",
      file,
      runId: "SR-DAIBEI-RECALL-NOT-PLAN",
    });
    expect(() => endSkillRun({ runId: run.runId, phase: "plan", file })).toThrow(/不能按 plan 收口/);
  });

  it("带背新章节 KP 抽查用 learning_attempt 回执收口且目标必须一致", () => {
    // [gpt] 2026-08-21：正确回答不新建栽点；统一尝试事实与冻结 KP-ID 对齐后签 Run。
    const { file } = harness();
    const run = startSkillRun({
      skill: "daibei-pc",
      subject: "法制史",
      kind: "recall",
      targetRef: "LS-0023",
      file,
      runId: "SR-DAIBEI-KP-ATTEMPT",
    });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "d".repeat(64), artifactLength: 32, file });
    expect(() => recordDaibeiKnowledgeAttemptWriteback({
      runId: run.runId,
      kpId: "LS-0022",
      operationId: "attempt-wrong-target",
      file,
    })).toThrow(/TARGET_MISMATCH/);
    const recorded = recordDaibeiKnowledgeAttemptWriteback({
      runId: run.runId,
      kpId: "LS-0023",
      operationId: "attempt-pass-1",
      file,
    });
    expect(recorded.steps).toMatchObject({
      result_recorded: { status: "pass", source: "knowledge-attempt" },
      writeback_verified: { status: "pass", source: "knowledge-attempt" },
    });
    expect(endSkillRun({
      runId: run.runId,
      phase: "result",
      done: ["response_verified"],
      evidenceRef: "learning-attempt:LS-0023:attempt-pass-1:applied",
      file,
    }).status).toBe("completed");
  });

  it("新错题 intake 不要求复检题 Gate，等待错因后可正常收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-INTAKE" });
    // [gpt] 2026-08-13：用户已提交本批错题，不为跨科选题读取全量上下文。
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "batch-1/E1,E2", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", evidenceRef: "queries:2", file });
    recordBusinessWriteback({ runId: run.runId, source: "cuoti-record-batch", evidenceRef: "batch-1:log=1:errors=2", expectedSkill: "cuoti-fupan", file });
    const waiting = checkpointSkillRun({ runId: run.runId, phase: "intake_question", file });
    expect(waiting.status).toBe("waiting_user");
    checkpointSkillRun({ runId: run.runId, phase: "intake_question", file });
    const ended = endSkillRun({ runId: run.runId, phase: "intake", done: ["response_verified"], evidenceRef: "batch-1/E1,E2", file });
    expect(ended.end).toMatchObject({ outcome: "completed", phase: "intake" });
    expect(ended.steps.question_integrity_pass).toBeUndefined();
  });

  it("新错题 intake 缺逐题讲解 checkpoint 时拒绝只写库收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-INTAKE-GATE" });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "batch-1/E1,E2,E3", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", evidenceRef: "queries:3", file });
    recordBusinessWriteback({ runId: run.runId, source: "cuoti-record-batch", evidenceRef: "batch-1:log=1:errors=3", expectedSkill: "cuoti-fupan", file });
    checkpointSkillRun({ runId: run.runId, phase: "intake_question", file });
    expect(() => endSkillRun({ runId: run.runId, phase: "intake", done: ["response_verified"], evidenceRef: "batch-1/E1,E2,E3", file })).toThrow(/缺 2 道/);
    checkpointSkillRun({ runId: run.runId, phase: "intake_question", file });
    checkpointSkillRun({ runId: run.runId, phase: "intake_question", file });
    expect(endSkillRun({ runId: run.runId, phase: "intake", done: ["response_verified"], evidenceRef: "batch-1/E1,E2,E3", file }).status).toBe("completed");
  });

  it("英语阅读写回必须先有答案键和台账回执，且篇目会话与分数完全一致", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "yingyu-pc", file, runId: "SR-ENGLISH-STRICT" });
    // [gpt] 2026-08-13：用户已指定篇目时直接核题源、答案键与台账，不跑派题快照。
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2016-T1", file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "2016-paper", file });
    recordManualSkillStep({ runId: run.runId, step: "reading_page_verified", evidenceRef: "2016-T1-page", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "answer_key_checked", source: "test", evidenceRef: `reading:2016:T1:score=4/5:key=${"a".repeat(12)}:paper=${"b".repeat(12)}`, file });
    expect(() => recordEnglishReadingWriteback({ runId: run.runId, chapter: "2016 Text 1", sessionKey: "EN-20260812-R-2016-T1", score: 4, maxScore: 5, file })).toThrow(/ledger_validated/);
    recordAutomaticSkillStep({ runId: run.runId, step: "ledger_validated", source: "test", evidenceRef: "english-ledger:EN-20260812-R-2016-T1:line=9", file });
    expect(() => recordEnglishReadingWriteback({ runId: run.runId, chapter: "2016 Text 2", sessionKey: "EN-20260812-R-2016-T1", score: 4, maxScore: 5, file })).toThrow(/篇目/);
    expect(() => recordEnglishReadingWriteback({ runId: run.runId, chapter: "2016 Text 1", sessionKey: "EN-20260812-R-2016-T1", score: 5, maxScore: 5, file })).toThrow(/分数/);
    expect(recordEnglishReadingWriteback({ runId: run.runId, chapter: "2016 Text 1", sessionKey: "EN-20260812-R-2016-T1", score: 4, maxScore: 5, file }).steps.writeback_verified.status).toBe("pass");
  });

  it("英语已经核对阅读答案后禁止降级成 plan 收口", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "yingyu-pc", file, runId: "SR-EN-PHASE" });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "answer_key_checked", source: "english-reading-key", evidenceRef: "reading:2017:T1:score=5/5", file });
    expect(() => endSkillRun({
      runId: run.runId,
      phase: "plan",
      done: ["priority_checked", "response_verified"],
      evidenceRef: "2017 Text 1",
      file,
    })).toThrow(/必须按 reading_grading 完整收口/);
    const summary = summarizeSkillRuns(readSkillRunEvents(file));
    expect(summary.counts).toMatchObject({ completed: 0, gateFailures: 1 });
  });

  it("业务写入前预检拒绝拿错 Skill Run 或缺台账回执", () => {
    const first = harness();
    const ask = startSkillRun({ skill: "ask-pc", file: first.file, runId: "SR-WRONG-SKILL" });
    expect(() => validateBusinessWriteback({ runId: ask.runId, sourceKind: "subjective_answer", subject: "刑法", file: first.file })).toThrow(/预期 lunshu-pc/);
    const second = harness();
    const lunshu = startSkillRun({ skill: "lunshu-pc", file: second.file, runId: "SR-LUNSHU-PREFLIGHT" });
    // [gpt] 2026-08-13：目标已明确的主观题不要求全盘 context；硬闸应报告真实缺失的业务步骤。
    expect(() => validateBusinessWriteback({ runId: lunshu.runId, sourceKind: "subjective_answer", subject: "民法", file: second.file })).toThrow(/target_frozen/);
  });

  it("仿真中止不要求完成阶段步骤", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "lunshu-pc", file, runId: "SR-SIM-ABORT" });
    expect(endSkillRun({ runId: run.runId, outcome: "aborted", evidenceRef: "checkpoint 后结束仿真", file }).end).toMatchObject({ outcome: "aborted", phase: null });
  });

  it("主观题业务写回必须完成题源、无泄题、采分表与台账闭环", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "yingyu-pc", file, runId: "SR-ESSAY-PREFLIGHT" });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file });
    recordManualSkillStep({ runId: run.runId, step: "reference_answer_checked", evidenceRef: "rubric:exam", file });
    recordManualSkillStep({ runId: run.runId, step: "rubric_applied", evidenceRef: "scorecard:7/10", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "ledger_validated", source: "test", evidenceRef: "english-ledger:EN-20260812-W-2024-REPLY:line=1", file });
    expect(() => validateBusinessWriteback({ runId: run.runId, sourceKind: "subjective_answer", subject: "英语", file })).toThrow(/target_frozen/);
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2024-reply", file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "作文十年题库:2024", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "question-integrity", artifactHash: "d".repeat(64), artifactLength: 20, file });
    const validated = validateBusinessWriteback({ runId: run.runId, sourceKind: "subjective_answer", subject: "英语", file });
    expect(validated.expectedSkill).toBe("yingyu-pc");
    expect(validated.requiredSteps).not.toContain("grading_bound");
  });

  it("英语作文题阶段同样进入 waiting_user，并校验 Gate 草稿 hash", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "yingyu-pc", file, runId: "SR-WRITING-QUESTION" });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2024-reply", file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "作文十年题库:2024", file });
    recordManualSkillStep({ runId: run.runId, step: "reference_answer_checked", evidenceRef: "考研评分档", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "question-integrity", artifactHash: "e".repeat(64), artifactLength: 20, file });
    expect(() => checkpointSkillRun({ runId: run.runId, phase: "writing_question", artifactHash: "f".repeat(64), file })).toThrow(/question_integrity_pass/);
    expect(checkpointSkillRun({ runId: run.runId, phase: "writing_question", artifactHash: "e".repeat(64), file }).status).toBe("waiting_user");
  });

  it("带背远端回执必须与本地 operation_id 一致且确为 learning_attempt/applied", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "daibei-pc", subject: "刑法", targetRef: "X1", file, runId: "SR-DAIBEI-RECEIPT" });
    // [gpt] 2026-08-13：指定带背条目直接检验，仍严格核 operation 回执。
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", evidenceRef: "queries:1", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 10, file });
    recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "daibei-evidence", evidenceRef: "X1:recall/pass:op=op-42", file });
    expect(() => validateDaibeiIngestReceipt({ runId: run.runId, operationId: "op-41", receipt: { operation_id: "op-41", op_type: "learning_attempt", status: "applied" }, file })).toThrow(/不一致/);
    expect(() => validateDaibeiIngestReceipt({ runId: run.runId, operationId: "op-42", receipt: { operation_id: "op-42", op_type: "study_log", status: "applied" }, file })).toThrow(/尚未完成/);
    expect(validateDaibeiIngestReceipt({ runId: run.runId, operationId: "op-42", receipt: { operation_id: "op-42", op_type: "learning_attempt", status: "applied" }, file }).runId).toBe(run.runId);
  });

  it("遥测只存引用和 hash，不落题干与答案正文", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "ask-pc", file, runId: "SR-SAFE" });
    recordAutomaticSkillStep({
      runId: run.runId,
      step: "materials_checked",
      source: "test",
      evidenceRef: "queries:2",
      artifactHash: "a".repeat(64),
      file,
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("queries:2");
    expect(raw).not.toContain("answerKey");
    expect(raw).not.toContain("stem");
  });

  // [gpt] 2026-08-14：覆盖带背入口、对象不可变、恢复与历史污染降级。
  it("带背只给科目时拒绝轻量启动，明确目标时归一科目并自动冻结", () => {
    const { file } = harness();
    expect(() => startSkillRun({ skill: "daibei-pc", subject: "法理学", file, runId: "SR-DAIBEI-SUBJECT-ONLY" })).toThrow(/DAIBEI_CONTEXT_REQUIRED/);
    const run = startSkillRun({ skill: "daibei-pc", subject: "法理学", targetRef: "R20260812-RECITE-L31", file, runId: "SR-DAIBEI-DIRECT" });
    expect(run).toMatchObject({ subject: "法理", entryMode: "direct" });
    expect(run.steps.target_frozen.evidenceRef).toBe("R20260812-RECITE-L31");
  });

  it("带背目标冻结后不可换题，写回对象不一致时在业务文件写入前阻断", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "daibei-pc", subject: "法理", targetRef: "R20260812-RECITE-L31", file, runId: "SR-DAIBEI-TARGET" });
    recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "test", evidenceRef: "queries:L31", file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "test", artifactHash: "a".repeat(64), artifactLength: 20, file });
    expect(() => recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "R20260812-RECITE-L30", file })).toThrow(/SKILL_TARGET_IMMUTABLE/);
    expect(() => assertDaibeiTargetWritebackReady({ runId: run.runId, reciteId: "L30", file })).toThrow(/DAIBEI_TARGET_MISMATCH/);
    expect(assertDaibeiTargetWritebackReady({ runId: run.runId, reciteId: "L31", scheduleId: "R20260812-RECITE-L31", file }).reciteId).toBe("L31");
    expect(() => recordAutomaticSkillStep({ runId: run.runId, step: "result_recorded", source: "test", evidenceRef: "L30:recall/pass:op=op-wrong", file })).toThrow(/DAIBEI_TARGET_MISMATCH/);
  });

  it("恢复时优先稳定 waiting 目标，忽略更新但不含条目 ID 的模糊 Run", () => {
    const { file } = harness();
    const events = [
      { schemaVersion: 1, eventId: "SE-1", runId: "SR-L31", event: "started", observedAt: "2026-08-14T01:00:00.000Z", beijingDate: "2026-08-14", sessionId: "old-a", turnId: "turn-a", skill: "daibei-pc", subject: "法理学", referenceDate: "2026-08-14", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-2", runId: "SR-L31", event: "step", observedAt: "2026-08-14T01:00:01.000Z", beijingDate: "2026-08-14", sessionId: "old-a", turnId: "turn-a", skill: "daibei-pc", step: "target_frozen", status: "pass", evidenceRef: "R20260812-RECITE-L31" },
      { schemaVersion: 1, eventId: "SE-3", runId: "SR-L31", event: "checkpoint_passed", observedAt: "2026-08-14T01:00:02.000Z", beijingDate: "2026-08-14", sessionId: "old-a", turnId: "turn-a", skill: "daibei-pc", phase: "question" },
      { schemaVersion: 1, eventId: "SE-4", runId: "SR-FUZZY", event: "started", observedAt: "2026-08-14T02:00:00.000Z", beijingDate: "2026-08-14", sessionId: "old-b", turnId: "turn-b", skill: "daibei-pc", subject: "法理", referenceDate: "2026-08-14", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-5", runId: "SR-FUZZY", event: "step", observedAt: "2026-08-14T02:00:01.000Z", beijingDate: "2026-08-14", sessionId: "old-b", turnId: "turn-b", skill: "daibei-pc", step: "target_frozen", status: "pass", evidenceRef: "带背标准答案:法理第六章第三节-v1" },
      { schemaVersion: 1, eventId: "SE-6", runId: "SR-FUZZY", event: "checkpoint_passed", observedAt: "2026-08-14T02:00:02.000Z", beijingDate: "2026-08-14", sessionId: "old-b", turnId: "turn-b", skill: "daibei-pc", phase: "question" },
    ];
    appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const recovery = findDaibeiRecovery({ subject: "法理学", file });
    expect(recovery.preferred).toMatchObject({ runId: "SR-L31", reciteId: "L31" });
    expect(recovery.ignored.map((item) => item.runId)).toContain("SR-FUZZY");
    const resumed = resumeDaibeiSkillRun({ runId: "SR-L31", subject: "法理", sessionId: "new-session", turnId: "new-turn", file });
    expect(resumed).toMatchObject({ runId: "SR-L31", sessionId: "new-session", turnId: "new-turn", status: "waiting_user" });
  });

  it("历史 waiting Run 已含跨题结果时只回收目标，不把污染 Run 标成可恢复", () => {
    const { file } = harness();
    const events = [
      { schemaVersion: 1, eventId: "SE-Q1", runId: "SR-LEGACY-MIXED", event: "started", observedAt: "2026-08-14T01:00:00.000Z", beijingDate: "2026-08-14", sessionId: "old", turnId: "old-turn", skill: "daibei-pc", subject: "法理", referenceDate: "2026-08-14" },
      { schemaVersion: 1, eventId: "SE-Q2", runId: "SR-LEGACY-MIXED", event: "step", observedAt: "2026-08-14T01:00:01.000Z", beijingDate: "2026-08-14", sessionId: "old", turnId: "old-turn", skill: "daibei-pc", step: "target_frozen", status: "pass", evidenceRef: "R20260812-RECITE-L31" },
      { schemaVersion: 1, eventId: "SE-Q3", runId: "SR-LEGACY-MIXED", event: "step", observedAt: "2026-08-14T01:00:02.000Z", beijingDate: "2026-08-14", sessionId: "old", turnId: "old-turn", skill: "daibei-pc", step: "result_recorded", status: "pass", evidenceRef: "L30:recall/pass:op=legacy-op" },
      { schemaVersion: 1, eventId: "SE-Q4", runId: "SR-LEGACY-MIXED", event: "checkpoint_passed", observedAt: "2026-08-14T01:00:03.000Z", beijingDate: "2026-08-14", sessionId: "old", turnId: "old-turn", skill: "daibei-pc", phase: "question" },
    ];
    appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const recovery = findDaibeiRecovery({ subject: "法理", file });
    expect(recovery.preferred).toBeNull();
    expect(recovery.targetFallback).toMatchObject({ runId: "SR-LEGACY-MIXED", reciteId: "L31", resultState: "mismatch", resumable: false });
    expect(() => resumeDaibeiSkillRun({ runId: "SR-LEGACY-MIXED", subject: "法理", sessionId: "new", turnId: "new", file })).toThrow(/DAIBEI_RECOVERY_BLOCK/);
    const summary = summarizeSkillRuns(readSkillRunEvents(file), { nowIso: "2026-08-14T02:00:00.000Z", windowStart: "2026-08-14", windowEnd: "2026-08-14" });
    expect(summary.counts).toMatchObject({ active: 1, actionableActive: 0, waitingUser: 1, quarantined: 1 });
    expect(summary.issues).toContainEqual(expect.objectContaining({ code: "daibei_target_result_mismatch", runId: "SR-LEGACY-MIXED" }));
  });

  it("ask 也禁止手工补签材料，必须由材料脚本自动回执", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "ask-pc", file, runId: "SR-ASK-BRIDGE" });
    expect(() => recordManualSkillStep({ runId: run.runId, step: "materials_checked", file })).toThrow(/只能由对应脚本自动落证/);
    expect(() => recordManualSkillStep({ runId: run.runId, step: "materials_checked", evidenceRef: "material-batch:3", file })).toThrow(/只能由对应脚本自动落证/);
    expect(recordAutomaticSkillStep({ runId: run.runId, step: "materials_checked", source: "cuoti-material", evidenceRef: "queries:3", file }).steps.materials_checked.status).toBe("pass");
  });

  it("手工核验步骤缺证据引用时拒绝签字", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "coach-pc", file, runId: "SR-MANUAL-REF" });
    expect(() => recordManualSkillStep({ runId: run.runId, step: "priority_checked", file })).toThrow(/必须用 --ref/);
    expect(recordManualSkillStep({ runId: run.runId, step: "priority_checked", evidenceRef: "weekly:P0-2", file }).steps.priority_checked.evidenceRef).toBe("weekly:P0-2");
  });

  it("宿主已绑定时拒绝跨 session 冒名收口", () => {
    const { file } = harness();
    const run = startSkillRun({
      skill: "coach-pc",
      file,
      runId: "SR-TURN-BOUND",
      sessionId: "session-1",
      turnId: "turn-old",
    });
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "session-other";
    try {
      expect(() => recordManualSkillStep({ runId: run.runId, step: "priority_checked", evidenceRef: "weekly:P0", file })).toThrow(/会话不一致/);
    } finally {
      if (previousThread == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });

  it("仅当当前 prompt 明确绑定原 Run 时允许 active Run 跨 turn 恢复", () => {
    const { file } = harness();
    const turnFile = join(mkdtempSync(join(tmpdir(), "skill-turn-")), "skill-turns.jsonl");
    const previousThread = process.env.CODEX_THREAD_ID;
    const previousTurnFile = process.env.FASHUO_SKILL_TURN_FILE;
    process.env.CODEX_THREAD_ID = "session-resume";
    process.env.FASHUO_SKILL_TURN_FILE = turnFile;
    try {
      const run = startSkillRun({ skill: "ask-pc", file, runId: "SR-RESUME", sessionId: "session-resume", turnId: "turn-old" });
      const unbound = {
        schemaVersion: 1, eventId: "ST-unbound", event: "prompt_routed", observedAt: "2026-08-13T01:00:00Z", beijingDate: "2026-08-13",
        sessionId: "session-resume", turnId: "turn-new", expectedSkill: "ask-pc", expectedRunId: null,
      };
      appendFileSync(turnFile, `${JSON.stringify(unbound)}\n`, "utf8");
      expect(() => recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file })).toThrow(/当前 prompt 未路由/);
      const bound = { ...unbound, eventId: "ST-bound", observedAt: "2026-08-13T01:00:01Z", expectedRunId: run.runId };
      appendFileSync(turnFile, `${JSON.stringify(bound)}\n`, "utf8");
      const resumed = recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file });
      expect(resumed.steps.context_loaded.status).toBe("pass");
      expect(resumed.turnId).toBe("turn-new");
    } finally {
      if (previousThread == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      if (previousTurnFile == null) delete process.env.FASHUO_SKILL_TURN_FILE;
      else process.env.FASHUO_SKILL_TURN_FILE = previousTurnFile;
    }
  });
});

describe("Skill Run 监控摘要", () => {
  it("学习摘要排除 diagnostic/simulation，同时保留按 purpose 单独查看", () => {
    const { file } = harness();
    for (const [runId, runPurpose, minute] of [
      ["SR-PURPOSE-LEARNING", "learning", "00"],
      ["SR-PURPOSE-DIAGNOSTIC", "diagnostic", "01"],
      ["SR-PURPOSE-SIMULATION", "simulation", "02"],
    ]) {
      const started = startSkillRun({
        skill: "coach-pc",
        file,
        runId,
        runPurpose,
        now: `2026-08-25T01:${minute}:00Z`,
      });
      endSkillRun({
        runId: started.runId,
        outcome: "aborted",
        abortReason: "test_fixture",
        abortSource: "system",
        file,
        now: `2026-08-25T01:${minute}:01Z`,
      });
    }

    const parsed = readSkillRunEvents(file);
    const learning = summarizeSkillRuns(parsed, {
      nowIso: "2026-08-25T02:00:00Z",
      windowStart: "2026-08-25",
      windowEnd: "2026-08-25",
    });
    expect(learning.counts).toMatchObject({ runs: 1, aborted: 1, abandonedAborted: 1 });
    expect(learning.compliance).toMatchObject({ eligible: 1, rawStarted: 1, rawRate: 0 });
    expect(learning.purposeScope).toEqual({
      selected: "learning",
      legacyFallback: "learning",
      byPurpose: { learning: 1, diagnostic: 1, simulation: 1 },
      excluded: 2,
    });

    const diagnostic = summarizeSkillRuns(parsed, {
      nowIso: "2026-08-25T02:00:00Z",
      windowStart: "2026-08-25",
      windowEnd: "2026-08-25",
      runPurpose: "diagnostic",
    });
    expect(diagnostic.counts).toMatchObject({ runs: 1, aborted: 1 });
    expect(diagnostic.purposeScope).toMatchObject({ selected: "diagnostic", excluded: 2 });
    expect(() => summarizeSkillRuns(parsed, { runPurpose: "other" })).toThrow(/runPurpose/);
  });

  it("把带背阶段错配和进度后未抽查从干净收口中剔除", () => {
    const { file } = harness();
    const events = [
      { schemaVersion: 1, eventId: "SE-P1", runId: "SR-PROGRESS", event: "started", observedAt: "2026-08-21T01:00:00.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", subject: "法制史", kind: "progress", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-P2", runId: "SR-PROGRESS", event: "step", observedAt: "2026-08-21T01:00:01.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", step: "target_frozen", status: "pass", source: "skill-run-start", evidenceRef: "第三章 秦汉三国两晋南北朝" },
      { schemaVersion: 1, eventId: "SE-P3", runId: "SR-PROGRESS", event: "ended", observedAt: "2026-08-21T01:00:05.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", phase: "progress", outcome: "completed" },
      { schemaVersion: 1, eventId: "SE-M1", runId: "SR-MISMATCH", event: "started", observedAt: "2026-08-21T02:00:00.000Z", beijingDate: "2026-08-21", sessionId: "session-2", turnId: "turn-2", skill: "daibei-pc", subject: "法制史", kind: "recall", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-M2", runId: "SR-MISMATCH", event: "ended", observedAt: "2026-08-21T02:00:05.000Z", beijingDate: "2026-08-21", sessionId: "session-2", turnId: "turn-2", skill: "daibei-pc", phase: "plan", outcome: "completed" },
    ];
    appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const summary = summarizeSkillRuns(readSkillRunEvents(file), {
      nowIso: "2026-08-21T03:00:00.000Z",
      windowStart: "2026-08-21",
      windowEnd: "2026-08-21",
      postProgressProbeGraceMinutes: 10,
    });
    expect(summary.counts).toMatchObject({ daibeiPhaseKindMismatches: 1, daibeiPostProgressProbeMissing: 1 });
    expect(summary.compliance).toMatchObject({ completed: 2, closedCleanly: 0, rate: 0, rawRate: 0 });
  });

  it("进度 Run 后同科首题进入 waiting_user 时不报抽查断链", () => {
    const { file } = harness();
    const events = [
      { schemaVersion: 1, eventId: "SE-P1", runId: "SR-PROGRESS", event: "started", observedAt: "2026-08-21T01:00:00.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", subject: "法制史", kind: "progress", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-P2", runId: "SR-PROGRESS", event: "step", observedAt: "2026-08-21T01:00:01.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", step: "target_frozen", status: "pass", source: "skill-run-start", evidenceRef: "第三章 秦汉三国两晋南北朝" },
      { schemaVersion: 1, eventId: "SE-P3", runId: "SR-PROGRESS", event: "ended", observedAt: "2026-08-21T01:00:05.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", phase: "progress", outcome: "completed" },
      { schemaVersion: 1, eventId: "SE-Q1", runId: "SR-QUESTION", event: "started", observedAt: "2026-08-21T01:00:06.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", subject: "法制史", kind: "recall", entryMode: "direct" },
      { schemaVersion: 1, eventId: "SE-Q2", runId: "SR-QUESTION", event: "checkpoint_passed", observedAt: "2026-08-21T01:00:10.000Z", beijingDate: "2026-08-21", sessionId: "session-1", turnId: "turn-1", skill: "daibei-pc", phase: "question" },
    ];
    appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const summary = summarizeSkillRuns(readSkillRunEvents(file), {
      nowIso: "2026-08-21T03:00:00.000Z",
      windowStart: "2026-08-21",
      windowEnd: "2026-08-21",
      postProgressProbeGraceMinutes: 10,
    });
    expect(summary.counts.daibeiPostProgressProbeMissing).toBe(0);
  });

  it("过期 waiting_user 标成孤儿等待并进入完整率分母，但不改写 Run 状态", () => {
    const { file } = harness();
    const events = [
      { schemaVersion: 1, eventId: "SE-W1", runId: "SR-WAIT", event: "started", observedAt: "2026-08-10T00:00:00.000Z", beijingDate: "2026-08-10", skill: "daibei-pc" },
      { schemaVersion: 1, eventId: "SE-W2", runId: "SR-WAIT", event: "checkpoint_passed", observedAt: "2026-08-10T00:00:01.000Z", beijingDate: "2026-08-10", skill: "daibei-pc", phase: "question" },
      { schemaVersion: 1, eventId: "SE-C1", runId: "SR-DONE", event: "started", observedAt: "2026-08-10T01:00:00.000Z", beijingDate: "2026-08-10", skill: "daibei-pc" },
      { schemaVersion: 1, eventId: "SE-C2", runId: "SR-DONE", event: "ended", observedAt: "2026-08-10T01:00:01.000Z", beijingDate: "2026-08-10", skill: "daibei-pc", phase: "result", outcome: "completed" },
    ];
    appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const summary = summarizeSkillRuns(readSkillRunEvents(file), {
      nowIso: "2026-08-12T00:00:00.000Z",
      windowStart: "2026-08-10",
      windowEnd: "2026-08-12",
      staleMinutes: 60,
    });
    expect(summary.counts).toMatchObject({ active: 1, actionableActive: 0, waitingUser: 1, freshWaitingUser: 0, orphanedWaiting: 1 });
    expect(summary.compliance).toMatchObject({ eligible: 2, closedCleanly: 1, rate: 50, rawStarted: 2, rawRate: 50 });
    expect(summary.orphanedWaitingRuns[0]).toMatchObject({ runId: "SR-WAIT", status: "waiting_user" });
  });

  it("识别过期未收口、Gate 失败和启动耗时", () => {
    const { file } = harness();
    const run = startSkillRun({ skill: "daibei-pc", subject: "法理", entryMode: "snapshot", file, runId: "SR-STALE", now: "2026-08-10T00:00:00Z" });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", durationMs: 6200, file, now: "2026-08-10T00:00:01Z" });
    try {
      checkpointSkillRun({ runId: run.runId, phase: "question", file, now: "2026-08-10T00:00:02Z" });
    } catch (error) {
      expect(error).toBeInstanceOf(SkillRunGateError);
    }
    const summary = summarizeSkillRuns(readSkillRunEvents(file), {
      nowIso: "2026-08-12T00:00:00Z",
      windowStart: "2026-08-10",
      windowEnd: "2026-08-12",
      staleMinutes: 60,
    });
    expect(summary.counts).toMatchObject({ runs: 1, stale: 1, gateFailures: 1 });
    expect(summary.startupLatencyMs).toMatchObject({ samples: 1, p50: 6200, p95: 6200 });
    expect(summary.stepLatencyMs.context_loaded).toMatchObject({ samples: 1, p50: 6200, p95: 6200, max: 6200 });
  });

  it("监控识别 handoff 后未启动目标 Skill 的断链", () => {
    const { file } = harness();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "session-handoff";
    try {
      const coach = startSkillRun({ skill: "coach-pc", file, runId: "SR-H1", sessionId: "session-handoff", turnId: "turn-1", now: "2026-08-12T01:00:00Z" });
      endSkillRun({ runId: coach.runId, outcome: "handoff", handoffSkill: "cuoti-fupan", handoffReason: "逐题复盘", file, now: "2026-08-12T01:00:01Z" });
      let summary = summarizeSkillRuns(readSkillRunEvents(file), { nowIso: "2026-08-12T02:00:00Z", windowStart: "2026-08-12", windowEnd: "2026-08-12" });
      expect(summary.counts.unresolvedHandoffs).toBe(1);
      startSkillRun({ skill: "cuoti-fupan", file, runId: "SR-H2", sessionId: "session-handoff", turnId: "turn-1", now: "2026-08-12T01:00:02Z" });
      summary = summarizeSkillRuns(readSkillRunEvents(file), { nowIso: "2026-08-12T02:00:00Z", windowStart: "2026-08-12", windowEnd: "2026-08-12" });
      expect(summary.counts.unresolvedHandoffs).toBe(0);
    } finally {
      if (previousThread == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });
});
