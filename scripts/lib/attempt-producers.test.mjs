import { describe, expect, it } from "vitest";
import {
  appendOutboxText,
  buildReciteAttemptOperation,
  buildStudyLogAttemptConfig,
  materializeStudyLogAttempt,
} from "./attempt-producers.mjs";

describe("attempt producers", () => {
  it("没有显式尝试字段时不从 accuracy 猜分母", () => {
    expect(buildStudyLogAttemptConfig({ accuracy: "80" }, {
      date: "2026-08-10", subject: "英语", chapter: "2016 Text 1",
    })).toBeNull();
  });

  it("英语阅读显式分数可物化为与 study_log 关联的尝试", () => {
    const config = buildStudyLogAttemptConfig({
      "attempt-source": "objective_question",
      result: "partial",
      question: "2016 Text 1",
      session: "EN-20260810-2016-T1",
      score: "4",
      max: "5",
      context: "timed",
      seconds: "1080",
    }, { date: "2026-08-10", subject: "英语", chapter: "2016 Text 1" });
    const attempt = materializeStudyLogAttempt({
      op: "study_log",
      operation_id: "study-1",
      date: "2026-08-10",
      subject: "英语",
      activity: "做题",
      chapter: "2016 Text 1",
      attempt: config,
    }, 88);
    expect(attempt).toMatchObject({
      operation_id: "study-1:attempt",
      ingestOperationId: "study-1",
      sourceId: "88",
      sourceKind: "objective_question",
      questionRef: "2016 Text 1",
      score: "4",
      maxScore: "5",
      attemptRole: "primary",
    });
  });

  it("客观/主观评分缺稳定来源或分数时在写 outbox 前拒绝", () => {
    expect(() => buildStudyLogAttemptConfig({ result: "pass", score: "1", max: "1" }, {
      date: "2026-08-10", subject: "刑法", chapter: "题1",
    })).toThrow(/attempt-source/);
    expect(() => buildStudyLogAttemptConfig({ "attempt-source": "subjective_answer", result: "partial" }, {
      date: "2026-08-10", subject: "刑法", chapter: "2022-57",
    })).toThrow(/score\/maxScore/);
  });

  it("带背证据复用原 operationId 并作为 recheck 进入 outbox", () => {
    const operation = buildReciteAttemptOperation({
      operationId: "recite-op-1",
      entryId: "X1",
      date: "2026-08-10",
      dimension: "recall",
      result: "fail",
      cold: true,
      promptIntegrity: "clean",
      failurePatternCode: "degree_strength",
      diagnosisStatus: "pending",
      evidenceAnchor: "教材#68",
      note: "可以答成应当",
    }, { id: "X1", subject: "刑法", title: "程度词" });
    const appended = appendOutboxText("", operation, "2026-08-10T00:00:00.000Z");
    expect(operation).toMatchObject({
      operation_id: "recite-op-1",
      sourceKind: "recite_ledger",
      sourceId: "X1",
      attemptRole: "recheck",
      projectEvidence: false,
    });
    expect(JSON.parse(appended.text)).toMatchObject({ operation_id: "recite-op-1", ts: "2026-08-10T00:00:00.000Z" });
  });

  it("带背污染题尝试由生产器固化为教练责任 void", () => {
    const operation = buildReciteAttemptOperation({
      operationId: "recite-void-1",
      entryId: "X1",
      date: "2026-08-12",
      dimension: "recall",
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      failurePatternCode: null,
      diagnosisStatus: null,
      evidenceAnchor: "污染题#1",
      note: "responsibility=teacher",
    }, { id: "X1", subject: "刑法", title: "程度词" });

    expect(operation).toMatchObject({
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      metadata: {
        responsibility: "teacher",
        count_as_valid_attempt: false,
        count_as_user_error: false,
        advance_cooldown: false,
        close_schedule: false,
      },
    });
  });
});
