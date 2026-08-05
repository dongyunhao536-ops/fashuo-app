import { describe, expect, it } from "vitest";
import { summarizeErrorBookRows, topicLabel } from "./error-book-summary.mjs";

function row(overrides = {}) {
  return {
    study_error_id: 1,
    log_date: "2026-08-05",
    event_subject: "民法",
    knowledge: "监护顺位误选",
    event_status: "open",
    topic_id: 10,
    topic_subject: "民法",
    topic_title: "监护人顺位",
    classification_status: "confirmed",
    mastery_status: "open",
    role: "primary",
    root_cause_code: "boundary_miss",
    diagnosis_status: "confirmed",
    ...overrides,
  };
}

describe("error book summary", () => {
  it("同一事件挂多个主题时事件只计一次，主题各自保留", () => {
    const summary = summarizeErrorBookRows([
      row(),
      row({ topic_id: 11, topic_title: "履职能力门槛", role: "related" }),
    ]);

    expect(summary.eventCounts.open).toBe(1);
    expect(summary.topics).toHaveLength(2);
    expect(summary.events[0].topicIds).toEqual([10, 11]);
  });

  it("区分尚有 open 事件的活跃主题与只缺冷复检证据的主题", () => {
    const summary = summarizeErrorBookRows([
      row(),
      row({
        study_error_id: 2,
        topic_id: 20,
        topic_title: "法律行为效力分层",
        knowledge: "性质和效力混淆",
        event_status: "absorbed",
        mastery_status: "monitoring",
      }),
      row({
        study_error_id: 3,
        topic_id: 30,
        topic_title: "孳息归属",
        knowledge: "孳息题",
        event_status: "absorbed",
        mastery_status: "stable",
      }),
    ]);

    expect(summary.activeTopics.map((topic) => topic.id)).toEqual([10]);
    expect(summary.awaitingColdReviewTopics.map((topic) => topic.id)).toEqual([20]);
    expect(summary.masteryCounts).toMatchObject({ open: 1, monitoring: 1, stable: 1 });
  });

  it("未归类事件完整保留，且重复事件会成为优先主题", () => {
    const summary = summarizeErrorBookRows([
      row({ study_error_id: 4, topic_id: null, topic_title: null, event_subject: "英语", knowledge: "定位句误读" }),
      row({ study_error_id: 5, topic_id: 40, topic_title: "法条竞合例外", event_subject: "刑法", topic_subject: "刑法" }),
      row({ study_error_id: 6, topic_id: 40, topic_title: "法条竞合例外", event_subject: "刑法", topic_subject: "刑法", event_status: "absorbed", log_date: "2026-07-01" }),
      row({ study_error_id: 7, topic_id: 50, topic_title: "犯罪中止自动性", event_subject: "刑法", topic_subject: "刑法" }),
    ]);

    expect(summary.unclassifiedEvents.map((event) => event.id)).toEqual([4]);
    expect(summary.activeTopics[0]).toMatchObject({ id: 40, recurrent: true, eventTotal: 2 });
    expect(topicLabel(summary.activeTopics[0])).toBe("T#40 [刑法] 法条竞合例外");
  });

  it("dismissed 事件不进入待归类池，但仍单独保留审计", () => {
    const summary = summarizeErrorBookRows([
      row({ study_error_id: 8, topic_id: null, topic_title: null, event_status: "dismissed" }),
    ]);

    expect(summary.unclassifiedEvents).toEqual([]);
    expect(summary.dismissedUnclassifiedEvents.map((event) => event.id)).toEqual([8]);
  });
});
