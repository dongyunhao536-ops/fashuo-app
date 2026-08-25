// [gpt] 2026-08-12：六个主 Skill 的完整正向闭环、等待续轮和跨 Skill handoff 仿真。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkpointSkillRun,
  endSkillRun,
  hashSkillArtifact,
  recordAutomaticSkillStep,
  recordBusinessWriteback,
  recordEnglishReadingWriteback,
  recordManualSkillStep,
  recordReferenceAnswerBinding,
  startSkillRun,
  summarizeSkillRuns,
  readSkillRunEvents,
} from "./skill-run.mjs";

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "six-skill-e2e-"));
  return { file: join(directory, "runs.jsonl") };
}

function auto(file, runId, step, extras = {}) {
  return recordAutomaticSkillStep({ runId, step, source: "e2e-business", file, ...extras });
}

function manual(file, runId, step, evidenceRef) {
  return recordManualSkillStep({ runId, step, evidenceRef, file });
}

function gate(file, runId, draft) {
  auto(file, runId, "question_integrity_pass", {
    artifactHash: hashSkillArtifact(draft),
    artifactLength: draft.length,
  });
  return hashSkillArtifact(draft);
}

describe("六个主 Skill 端到端仿真", () => {
  it("六 Skill 逐一完成真实阶段契约，且英文双轨互不串签", () => {
    const { file } = harness();

    const ask = startSkillRun({ skill: "ask-pc", subject: "民法", runId: "SR-E2E-ASK", file });
    auto(file, ask.runId, "materials_checked", { evidenceRef: "queries:居住权+租赁权" });
    auto(file, ask.runId, "context_loaded");
    expect(endSkillRun({ runId: ask.runId, phase: "answer", done: ["preflight_checked", "response_verified"], evidenceRef: "六步预检+证据卡", file }).status).toBe("completed");

    const coach = startSkillRun({ skill: "coach-pc", runId: "SR-E2E-COACH", file });
    auto(file, coach.runId, "context_loaded");
    expect(endSkillRun({ runId: coach.runId, phase: "plan", done: ["priority_checked", "response_verified"], evidenceRef: "weekly:P0+到期排期", file }).status).toBe("completed");

    const cuoti = startSkillRun({ skill: "cuoti-fupan", subject: "民法", runId: "SR-E2E-CUOTI", file });
    auto(file, cuoti.runId, "context_loaded");
    manual(file, cuoti.runId, "target_frozen", "T#监护顺位");
    auto(file, cuoti.runId, "materials_checked", { evidenceRef: "queries:监护" });
    const cuotiHash = gate(file, cuoti.runId, "【单选题】监护顺位如何判断？\nA父母\nB兄姐");
    expect(checkpointSkillRun({ runId: cuoti.runId, phase: "question", artifactHash: cuotiHash, file }).status).toBe("waiting_user");
    auto(file, cuoti.runId, "judgment_output_verified", { evidenceRef: "T#1:pass:diagnosis=pending", artifactHash: "c".repeat(64), artifactLength: 280 });
    recordBusinessWriteback({ runId: cuoti.runId, source: "cuoti-review", evidenceRef: "T#1:pass:diagnosis=pending", expectedSkill: "cuoti-fupan", requiredSteps: ["context_loaded", "target_frozen", "materials_checked", "question_integrity_pass", "judgment_output_verified"], file });
    expect(endSkillRun({ runId: cuoti.runId, phase: "result", artifactHash: "c".repeat(64), file }).status).toBe("completed");

    // [gpt] 2026-08-14：带背轻入口在启动时冻结稳定对象。
    const daibei = startSkillRun({ skill: "daibei-pc", subject: "法理", targetRef: "L30", runId: "SR-E2E-DAIBEI", file });
    auto(file, daibei.runId, "context_loaded");
    auto(file, daibei.runId, "materials_checked", { evidenceRef: "queries:司法平等" });
    const daibeiHash = gate(file, daibei.runId, "请复述司法平等原则的三个对象层次。");
    checkpointSkillRun({ runId: daibei.runId, phase: "question", artifactHash: daibeiHash, file });
    auto(file, daibei.runId, "result_recorded", { evidenceRef: "L30:recall/pass:op=op-daibei" });
    auto(file, daibei.runId, "writeback_verified", { evidenceRef: "ingest:op-daibei:applied" });
    expect(endSkillRun({ runId: daibei.runId, phase: "result", done: ["response_verified"], evidenceRef: "逐项核原文", file }).status).toBe("completed");

    const lunshu = startSkillRun({ skill: "lunshu-pc", subject: "法理", kind: "essay", runId: "SR-E2E-LUNSHU", file });
    auto(file, lunshu.runId, "context_loaded");
    manual(file, lunshu.runId, "target_frozen", "论述58型");
    manual(file, lunshu.runId, "source_checked", "真题2019-58");
    // [gpt] 2026-08-24：端到端仿真也必须走同 hash 的加载绑定接口，
    // 不再用手工步骤伪造“已经看过参考答案”。
    recordReferenceAnswerBinding({
      runId: lunshu.runId,
      referenceHash: "f".repeat(64),
      evidenceRef: "reference:2019/essay:Q58:fixture",
      file,
    });
    const lunshuHash = gate(file, lunshu.runId, "请论述法治原则，并结合材料展开。");
    checkpointSkillRun({ runId: lunshu.runId, phase: "question", artifactHash: lunshuHash, file });
    manual(file, lunshu.runId, "rubric_applied", "15分采分表:9分");
    auto(file, lunshu.runId, "ledger_validated", { evidenceRef: "subjective-ledger:2026-08-12:line=10:9/15" });
    recordBusinessWriteback({ runId: lunshu.runId, source: "coach-log", evidenceRef: "study-log:lunshu:applied", expectedSkill: "lunshu-pc", requiredSteps: ["context_loaded", "target_frozen", "source_checked", "reference_answer_checked", "grading_bound", "question_integrity_pass", "rubric_applied", "ledger_validated"], file });
    expect(endSkillRun({ runId: lunshu.runId, phase: "grading", done: ["response_verified"], evidenceRef: "逐句批改+替换句", file }).status).toBe("completed");

    const englishReading = startSkillRun({ skill: "yingyu-pc", subject: "英语", runId: "SR-E2E-EN-R", file });
    auto(file, englishReading.runId, "context_loaded");
    manual(file, englishReading.runId, "target_frozen", "2016-T1");
    manual(file, englishReading.runId, "source_checked", "2016英语一真题");
    manual(file, englishReading.runId, "reading_page_verified", "净卷网页");
    checkpointSkillRun({ runId: englishReading.runId, phase: "question", file });
    auto(file, englishReading.runId, "answer_key_checked", { evidenceRef: `reading:2016:T1:score=4/5:key=${"a".repeat(12)}:paper=${"b".repeat(12)}` });
    auto(file, englishReading.runId, "ledger_validated", { evidenceRef: "english-ledger:EN-20260812-R-2016-T1:line=9" });
    // [gpt] 2026-08-16：教学尾段与文件沉淀必须在阅读 Run 内分别留证，不能由篇级流水替代。
    manual(file, englishReading.runId, "reading_review_verified", "2016-T1-Q25:定位+改写+干扰项");
    manual(file, englishReading.runId, "long_sentence_reviewed", "2016-T1:切碎+认主+念荒谬");
    manual(file, englishReading.runId, "vocabulary_handoff_ready", "2016-T1:4词已列给用户");
    auto(file, englishReading.runId, "reading_artifacts_verified", { evidenceRef: "english-close:EN-20260812-R-2016-T1:corpus=3:review=Q25" });
    auto(file, englishReading.runId, "lifecycle_checked", { evidenceRef: "english-lifecycle:EN-20260812-R-2016-T1:test" });
    recordEnglishReadingWriteback({ runId: englishReading.runId, chapter: "2016 Text 1", sessionKey: "EN-20260812-R-2016-T1", score: 4, maxScore: 5, file });
    expect(endSkillRun({ runId: englishReading.runId, phase: "reading_grading", done: ["response_verified"], evidenceRef: "逐项干扰归因", file }).status).toBe("completed");

    const englishWriting = startSkillRun({ skill: "yingyu-pc", subject: "英语", runId: "SR-E2E-EN-W", file });
    auto(file, englishWriting.runId, "context_loaded");
    manual(file, englishWriting.runId, "target_frozen", "2024-REPLY");
    manual(file, englishWriting.runId, "source_checked", "作文十年题库:2024");
    manual(file, englishWriting.runId, "reference_answer_checked", "考研评分档");
    const writingHash = gate(file, englishWriting.runId, "Write a reply to Paul and answer both questions.");
    checkpointSkillRun({ runId: englishWriting.runId, phase: "writing_question", artifactHash: writingHash, file });
    manual(file, englishWriting.runId, "rubric_applied", "scorecard:7/10");
    auto(file, englishWriting.runId, "ledger_validated", { evidenceRef: "english-ledger:EN-20260812-W-2024-REPLY:line=20" });
    recordBusinessWriteback({ runId: englishWriting.runId, source: "coach-log", evidenceRef: "study-log:english-writing:applied", expectedSkill: "yingyu-pc", requiredSteps: ["context_loaded", "target_frozen", "source_checked", "reference_answer_checked", "question_integrity_pass", "rubric_applied", "ledger_validated"], file });
    expect(endSkillRun({ runId: englishWriting.runId, phase: "writing_grading", done: ["response_verified"], evidenceRef: "评分档+三病根", file }).status).toBe("completed");
    expect(englishWriting.steps.answer_key_checked).toBeUndefined();

    const summary = summarizeSkillRuns(readSkillRunEvents(file), { windowStart: "2026-01-01", windowEnd: "2026-12-31" });
    expect(summary.counts).toMatchObject({ runs: 7, completed: 7, active: 0, stale: 0, invalidHandoffs: 0, unresolvedHandoffs: 0 });
    expect(Object.keys(summary.bySkill).sort()).toEqual(["ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "yingyu-pc"].sort());
  });

  it("显式 handoff 形成闭环，目标 Skill 未启动时会被监控识别", () => {
    const { file } = harness();
    const previous = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "e2e-session";
    try {
      const coach = startSkillRun({ skill: "coach-pc", runId: "SR-E2E-HANDOFF-1", sessionId: "e2e-session", turnId: "turn-1", file });
      auto(file, coach.runId, "context_loaded");
      endSkillRun({ runId: coach.runId, outcome: "handoff", handoffSkill: "cuoti-fupan", handoffReason: "计划落到具体错题检验", file });
      expect(summarizeSkillRuns(readSkillRunEvents(file), { windowStart: "2026-01-01", windowEnd: "2026-12-31" }).counts.unresolvedHandoffs).toBe(1);
      startSkillRun({ skill: "cuoti-fupan", runId: "SR-E2E-HANDOFF-2", sessionId: "e2e-session", turnId: "turn-1", file });
      expect(summarizeSkillRuns(readSkillRunEvents(file), { windowStart: "2026-01-01", windowEnd: "2026-12-31" }).counts.unresolvedHandoffs).toBe(0);
    } finally {
      if (previous == null) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previous;
    }
  });
});
