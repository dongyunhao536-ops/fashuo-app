import { describe, expect, it } from "vitest";
import {
  cleanTopicTitle,
  nextMasteryStatus,
  normalizeSubject,
  parseAddArgs,
  parseTopicOptions,
  topicInsertPayload,
  topicKey,
  validateRootCause,
} from "./error-taxonomy.mjs";

describe("error taxonomy", () => {
  it("归一科目全称和主题排版，但保留可读标题", () => {
    expect(normalizeSubject(" 法理学 ")).toBe("法理");
    expect(cleanTopicTitle("  监护人   顺位  ")).toBe("监护人 顺位");
    expect(topicKey("法理学", "法律 继承")).toBe(topicKey("法理", "法律继承"));
  });

  it("同一科目同一主题生成稳定键，不把不同主题误合并", () => {
    expect(topicKey("刑法", "共同犯罪成立前提")).toBe(topicKey("刑法", "共同犯罪成立前提"));
    expect(topicKey("刑法", "共同犯罪成立前提")).not.toBe(topicKey("刑法", "主犯认定"));
  });

  it("解析兼容旧 add，同时接受结构化分类参数", () => {
    const parsed = parseAddArgs([
      "民法", "监护顺位题误选", "--topic", "监护人顺位的法定条件",
      "--chapter", "第三章 自然人", "--cause", "boundary_miss",
      "--diagnosis", "confirmed", "--anchor", "考试分析L120-126",
      "--recur-of", "81",
    ]);
    expect(parsed).toMatchObject({
      subject: "民法",
      knowledge: "监护顺位题误选",
      recurOf: 81,
      topic: {
        title: "监护人顺位的法定条件",
        chapter: "第三章 自然人",
        rootCauseCode: "boundary_miss",
        diagnosisStatus: "confirmed",
        classificationStatus: "confirmed",
      },
    });
  });

  it("没有主题时不允许悬空填写病根或章节", () => {
    expect(() => parseTopicOptions(["--cause-note", "漏了原则例外"])).toThrow("必须先给 --topic");
    expect(() => validateRootCause("粗心")).toThrow("未知病根代码");
  });

  it("主题分类与病根认领分开：主题可确认而病根仍待认领", () => {
    const { topic } = parseTopicOptions(["--topic", "审题层级错位"]);
    expect(topic).toMatchObject({
      classificationStatus: "confirmed",
      rootCauseCode: "unclassified",
      diagnosisStatus: "pending",
    });
  });

  it("主题 payload 不把事件长文本当主题键", () => {
    const payload = topicInsertPayload("宪法学", {
      title: "国家机构领导与指导关系",
      chapter: "第五章 国家机构",
      classificationStatus: "confirmed",
    }, "2026-08-05T00:00:00.000Z");
    expect(payload).toMatchObject({
      subject: "宪法",
      title: "国家机构领导与指导关系",
      chapter: "第五章 国家机构",
      classification_status: "confirmed",
      updated_at: "2026-08-05T00:00:00.000Z",
    });
    expect(payload.topic_key).toMatch(/^宪法:[a-f0-9]{20}$/);
  });

  it("冷复检至少跨两个日期通过才进入 stable，失败立即回 open", () => {
    expect(nextMasteryStatus([])).toBe("open");
    expect(nextMasteryStatus([{ id: 1, review_date: "2026-08-03", result: "pass" }])).toBe("monitoring");
    expect(nextMasteryStatus([
      { id: 2, review_date: "2026-08-05", result: "pass" },
      { id: 1, review_date: "2026-08-03", result: "pass" },
    ])).toBe("stable");
    expect(nextMasteryStatus([
      { id: 3, review_date: "2026-08-06", result: "fail" },
      { id: 2, review_date: "2026-08-05", result: "pass" },
      { id: 1, review_date: "2026-08-03", result: "pass" },
    ])).toBe("open");
  });
});
