import { describe, expect, it } from "vitest";
import {
  detectPaperType,
  EXAM_CORPUS_PARSER_VERSION,
  isSealedExamYear,
  parseExamPaper,
} from "./exam-corpus.mjs";

const sample = `2024年全国硕士研究生招生考试法律硕士专业基础（非法学）试题
一、单项选择题
1.第一题（ ）
A.甲
B.乙
2.第二题（ ）
A.丙
B.丁
二、多项选择题
3.第三题（ ）
A.戊
B.己
法律硕士专业基础（非法学）参考答案（2024年）
一、单项选择题
1.【答案】A
【分析】第一题解析。
2.这一行丢了【答案】标签，但答案是B。
【分析】第二题解析。
二、多项选择题
3.【答案】AB
【分析】第三题解析。`;

describe("exam corpus parser", () => {
  it("为规范化后的完整输入生成稳定的 SHA-256 与解析器版本", () => {
    const first = parseExamPaper({ fileName: "2024专业基础.txt", content: sample });
    const normalizedEquivalent = parseExamPaper({
      fileName: "2024专业基础.txt",
      content: `\uFEFF${sample.replace(/\n/g, "\r\n")}`,
    });
    const changed = parseExamPaper({
      fileName: "2024专业基础.txt",
      content: sample.replace("第一题", "第一道题"),
    });

    expect(EXAM_CORPUS_PARSER_VERSION).toBe("exam-corpus-v1");
    expect(first.parserVersion).toBe(EXAM_CORPUS_PARSER_VERSION);
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizedEquivalent.sourceSha256).toBe(first.sourceSha256);
    expect(changed.sourceSha256).not.toBe(first.sourceSha256);
  });

  it("按卷头而不是文件名判断卷种，并用卷内标题生成2023错名卷 canonicalId", () => {
    const sample2023 = sample.replace(
      "2024年全国硕士研究生招生考试",
      "2023年全国硕士研究生招生考试",
    );
    const paper = parseExamPaper({
      fileName: "2023年全国硕士研究生招生考试法律硕士综合（非法学）及参考答案解析.txt",
      content: sample2023,
    });
    expect(paper.paperType).toBe("专业基础");
    expect(paper.declaredPaperType).toBe("综合");
    expect(paper.canonicalId).toBe("FS-2023-专业基础");
    expect(paper.questions[0].canonicalId).toBe("FS-2023-专业基础-1");
    expect(paper.fileNameMismatch).toBe(true);
    expect(paper.warnings).toContain("filename_paper_type_mismatch");
  });

  it("仅用年份元数据判定封卷边界", () => {
    expect(isSealedExamYear(2024)).toBe(false);
    expect(isSealedExamYear(2025)).toBe(true);
    expect(isSealedExamYear(2026)).toBe(true);
  });

  it("分开题干和答案，并保留源文件真实行号", () => {
    const paper = parseExamPaper({ fileName: "2024专业基础.txt", content: sample });
    expect(paper.questions).toHaveLength(3);
    expect(paper.questions[0]).toMatchObject({
      no: 1,
      题型: "单选",
      startLine: 3,
      answerKey: "A",
      answerKeyStatus: "explicit",
      answerReviewReasons: [],
      answerReviewStatus: "clean",
    });
    expect(paper.questions[0].text).toContain("A.甲");
    expect(paper.questions[0].text).not.toContain("参考答案");
    expect(paper.questions[0].answer).toContain("第一题解析");
    expect(paper.questions[0].answerStartLine).toBeGreaterThan(paper.questions[0].endLine);
    expect(paper.questions[2].题型).toBe("多选");
    expect(paper.questions[2].answerKey).toBe("AB");
  });

  it("答案编号连续即可切块，不要求每条都有【答案】标签", () => {
    const paper = parseExamPaper({ fileName: "2024专业基础.txt", content: sample });
    expect(paper.questions[1].answer).toContain("答案是B");
    expect(paper.questions[2].answer).not.toContain("第二题解析");
    expect(paper.warnings).toContain("objective_answer_missing:2");
  });

  it("区分题库作废答案与从解析句推得的答案", () => {
    const invalidated = sample.replace("2.这一行丢了【答案】标签，但答案是B。", "2.【答案】无（原答案为B）");
    const invalidPaper = parseExamPaper({ fileName: "2024专业基础.txt", content: invalidated });
    expect(invalidPaper.questions[1]).toMatchObject({
      answerKey: null,
      answerKeyStatus: "invalidated",
      answerReviewStatus: "manual_review",
    });
    expect(invalidPaper.questions[1].answerReviewReasons).toEqual(
      expect.arrayContaining(["original_answer_reference", "answer_key_invalidated"]),
    );
    expect(invalidPaper.warnings.some((warning) => warning.includes("objective_answer_missing:2"))).toBe(false);

    const inferred = sample.replace(
      "2.这一行丢了【答案】标签，但答案是B。",
      "2.本题只有选项 B 正确。",
    );
    const inferredPaper = parseExamPaper({ fileName: "2024专业基础.txt", content: inferred });
    expect(inferredPaper.questions[1]).toMatchObject({
      answerKey: "B",
      answerKeyStatus: "inferred_from_analysis",
      answerReviewStatus: "manual_review",
    });
    expect(inferredPaper.questions[1].answerReviewReasons).toContain("answer_key_inferred");
  });

  it("隔离显式但存在原答案、争议或作者与参考答案冲突的客观题", () => {
    const disputed = sample.replace(
      "1.【答案】A\n【分析】第一题解析。",
      "1.【答案】A（原答案为B）\n【分析】本题存在争议。官方答案为B，但作者认为A也应当选。",
    );
    const paper = parseExamPaper({ fileName: "2024专业基础.txt", content: disputed });
    expect(paper.questions[0]).toMatchObject({
      answerKey: "A",
      answerKeyStatus: "explicit",
      answerReviewStatus: "manual_review",
    });
    expect(paper.questions[0].answerReviewReasons).toEqual(
      expect.arrayContaining([
        "original_answer_reference",
        "official_author_conflict",
        "answer_dispute",
      ]),
    );
  });

  it("不把题目所涉实体争议或法律修改程序误判为答案争议", () => {
    const neutral = sample.replace(
      "【分析】第一题解析。",
      "【分析】本题中双方对合同履行地存在争议；宪法修改程序通常比法律修改程序严格。",
    );
    const paper = parseExamPaper({ fileName: "2024专业基础.txt", content: neutral });
    expect(paper.questions[0]).toMatchObject({
      answerReviewReasons: [],
      answerReviewStatus: "clean",
    });
  });

  it("主观题只有存在答案标记且没有争议信号时才 clean", () => {
    const subjective = `2024年全国硕士研究生招生考试法律硕士综合（非法学）试题
三、简答题
1.简述某制度。
法律硕士综合（非法学）参考答案（2024年）
三、简答题
1.【答案要点】制度要点。`;
    const clean = parseExamPaper({ fileName: "2024综合.txt", content: subjective });
    expect(clean.questions[0]).toMatchObject({
      answerKeyStatus: "missing",
      answerReviewReasons: [],
      answerReviewStatus: "clean",
    });

    const missingMarker = subjective.replace("【答案要点】", "");
    const review = parseExamPaper({ fileName: "2024综合.txt", content: missingMarker });
    expect(review.questions[0].answerReviewStatus).toBe("manual_review");
    expect(review.questions[0].answerReviewReasons).toContain(
      "subjective_answer_marker_missing",
    );
  });

  it("识别法硕小精灵为随卷解析提供方，不把它称为官方来源", () => {
    const paper = parseExamPaper({
      fileName: "2024专业基础.txt",
      content: `公众号：法硕小精灵\n${sample}`,
    });
    expect(paper.sourceProvider).toBe("法硕小精灵");
    expect(paper.questions[0].sourceProvider).toBe("法硕小精灵");
  });

  it("卷头检测容忍文件名前几行的分页噪音", () => {
    expect(detectPaperType(`1\n-- 1 of 20 --\n${sample}`)).toBe("专业基础");
  });
});
