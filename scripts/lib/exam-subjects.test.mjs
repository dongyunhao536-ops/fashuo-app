import { describe, expect, it } from "vitest";
import {
  applySubjectLabels,
  EXAM_SUBJECT_LABEL_VERSION,
  labelPaperSubjects,
} from "./exam-subjects.mjs";

function question(no, 题型, extra = {}) {
  return { no, 题型, text: `题干 ${no}`, ...extra };
}

function range(from, to, 题型) {
  return Array.from({ length: to - from + 1 }, (_, index) =>
    question(from + index, 题型),
  );
}

function foundation2024() {
  return {
    year: 2024,
    paperType: "专业基础",
    questions: [
      ...range(1, 40, "单选"),
      ...range(41, 50, "多选"),
      ...range(51, 54, "简答题"),
      ...range(55, 56, "法条分析题"),
      ...range(57, 58, "案例分析题"),
    ],
  };
}

function byNumber(result) {
  return new Map(result.labels.map((item) => [item.questionNo, item]));
}

describe("exam subject labels", () => {
  it("labels every validated foundation section by its criminal/civil half", () => {
    const result = labelPaperSubjects(foundation2024());
    const labels = byNumber(result);

    expect(result.issues).toEqual([]);
    expect(labels.get(1)).toMatchObject({ subject: "刑法", status: "structural" });
    expect(labels.get(20)).toMatchObject({ subject: "刑法", status: "structural" });
    expect(labels.get(21)).toMatchObject({ subject: "民法", status: "structural" });
    expect(labels.get(41)).toMatchObject({ subject: "刑法", status: "structural" });
    expect(labels.get(46)).toMatchObject({ subject: "民法", status: "structural" });
    expect(labels.get(52)).toMatchObject({ subject: "刑法", status: "structural" });
    expect(labels.get(53)).toMatchObject({ subject: "民法", status: "structural" });
    expect(labels.get(57)).toMatchObject({ subject: "刑法", status: "structural" });
    expect(labels.get(58)).toMatchObject({ subject: "民法", status: "structural" });
  });

  it("leaves a malformed foundation section manual instead of shifting the half", () => {
    const paper = foundation2024();
    paper.questions = paper.questions.filter(({ no }) => no !== 20);
    const result = labelPaperSubjects(paper);
    const labels = byNumber(result);

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "foundation_section_invalid",
      questionType: "单选",
      actualCount: 39,
      expectedCount: 40,
    }));
    expect(labels.get(19)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(41)).toMatchObject({ subject: "刑法", status: "structural" });
  });

  it("uses only conservative safe-core ranges for comprehensive objective items", () => {
    const result = labelPaperSubjects({
      year: 2015,
      paperType: "综合",
      questions: [
        question(10, "单选"), question(14, "单选"), question(15, "单选"),
        question(18, "单选"), question(25, "单选"), question(29, "单选"),
        question(33, "单选"), question(45, "单选"),
        question(46, "多选"), question(49, "多选"), question(50, "多选"),
        question(53, "多选"), question(57, "多选"), question(58, "多选"),
        question(61, "多选"), question(63, "多选"),
      ],
    });
    const labels = byNumber(result);

    expect(labels.get(10)).toMatchObject({ subject: "法理", status: "safe_core" });
    expect(labels.get(14)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(15)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(18)).toMatchObject({ subject: "宪法", status: "safe_core" });
    expect(labels.get(29)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(33)).toMatchObject({ subject: "法制史", status: "safe_core" });
    expect(labels.get(49)).toMatchObject({ subject: "法理", status: "safe_core" });
    expect(labels.get(50)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(57)).toMatchObject({ subject: "宪法", status: "safe_core" });
    expect(labels.get(58)).toMatchObject({ subject: null, status: "manual_review" });
    expect(labels.get(61)).toMatchObject({ subject: "法制史", status: "safe_core" });
  });

  it("labels fixed comprehensive subjective slots but always leaves 58 manual", () => {
    const result = labelPaperSubjects({
      year: 2024,
      paperType: "综合",
      questions: [
        question(51, "简答题"), question(52, "简答题"), question(53, "简答题"),
        question(54, "分析题"), question(55, "分析题"), question(56, "分析题"),
        question(57, "论述题"), question(58, "论述题"),
      ],
    });
    const labels = byNumber(result);

    expect(labels.get(51)).toMatchObject({ subject: "法理", status: "structural" });
    expect(labels.get(52)).toMatchObject({ subject: "宪法", status: "structural" });
    expect(labels.get(53)).toMatchObject({ subject: "法制史", status: "structural" });
    expect(labels.get(54)).toMatchObject({ subject: "法理", status: "structural" });
    expect(labels.get(55)).toMatchObject({ subject: "宪法", status: "structural" });
    expect(labels.get(56)).toMatchObject({ subject: "法制史", status: "structural" });
    expect(labels.get(57)).toMatchObject({ subject: "法理", status: "structural" });
    expect(labels.get(58)).toMatchObject({ subject: null, status: "manual_review" });
  });

  it("makes an explicitly cross-subject fixed slot manual", () => {
    const result = labelPaperSubjects({
      year: 2024,
      paperType: "综合",
      questions: [question(57, "论述题", { subjects: ["法理", "宪法"] })],
    });

    expect(result.labels[0]).toMatchObject({
      subject: null,
      subjects: ["法理", "宪法"],
      status: "manual_review",
      rule: "explicit_cross_subject",
    });
  });

  it("applies labels without mutating the parsed paper", () => {
    const paper = foundation2024();
    const firstQuestion = paper.questions[0];
    const labelled = applySubjectLabels(paper);

    expect(labelled).not.toBe(paper);
    expect(labelled.questions[0]).not.toBe(firstQuestion);
    expect(firstQuestion).not.toHaveProperty("subject");
    expect(labelled.questions[0]).toMatchObject({
      subject: "刑法",
      subjectLabel: {
        version: EXAM_SUBJECT_LABEL_VERSION,
        status: "structural",
        rule: "foundation_section_half",
      },
    });
  });
});
