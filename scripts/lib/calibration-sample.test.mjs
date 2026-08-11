import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCalibrationSample,
  buildFiveSubjectCalibrationSample,
  eligibleExamFileName,
  finalCalibrationCanonicalId,
  FINAL_CALIBRATION_RANK_SEED,
  FINAL_CALIBRATION_SUBJECTS,
  SEALED_EXAM_FROM_YEAR,
} from "./calibration-sample.mjs";

const FOUNDATION_TYPES = [
  "单选",
  "多选",
  "简答题",
  "辨析题",
  "法条分析题",
  "案例分析题",
];
const COMPREHENSIVE_TYPES = ["单选", "多选", "简答题", "分析题", "论述题"];

function syntheticQuestion(no, type, answerStatus = "good", subject) {
  const objective = ["单选", "多选"].includes(type);
  const startLine = no * 3;
  const answerStartLine = 500 + no * 3;
  const statusByFixture = {
    good: objective ? "explicit" : "missing",
    inferred: "inferred_from_analysis",
    invalidated: "invalidated",
    missing: "missing",
    disputed: "explicit",
  };
  return {
    no,
    题型: type,
    startLine,
    endLine: startLine + 1,
    text: `不应出现在输出中的题干 ${no}`,
    answerStartLine: answerStatus === "broken" ? null : answerStartLine,
    answerEndLine: answerStatus === "broken" ? null : answerStartLine + 1,
    answer: answerStatus === "broken" ? "" : `不应出现在输出中的答案 ${no}`,
    answerKey: objective ? (type === "单选" ? "A" : "AB") : null,
    answerKeyStatus: statusByFixture[answerStatus] ?? "missing",
    answerReviewStatus: answerStatus === "disputed" ? "disputed" : "clean",
    ...(subject
      ? {
          subject,
          subjectLabel: { status: "structural", version: "subjects-v1" },
        }
      : {}),
  };
}

function syntheticPaper(year, paperType) {
  const types = paperType === "专业基础" ? FOUNDATION_TYPES : COMPREHENSIVE_TYPES;
  const questions = [];
  for (let no = 1; no <= 30; no += 1) {
    questions.push(syntheticQuestion(no, types[(no - 1) % types.length]));
  }
  questions.push(syntheticQuestion(91, "单选", "inferred"));
  questions.push(syntheticQuestion(92, "单选", "invalidated"));
  questions.push(syntheticQuestion(93, "单选", "missing"));
  questions.push(syntheticQuestion(94, "简答题", "broken"));
  questions.push(syntheticQuestion(95, "单选", "disputed"));
  return {
    year,
    paperType,
    fileName: `${year}-${paperType}.txt`,
    questions,
  };
}

function syntheticCorpus() {
  const papers = [];
  for (let year = 2014; year <= 2024; year += 1) {
    papers.push(syntheticPaper(year, "专业基础"));
    papers.push(syntheticPaper(year, "综合"));
  }
  return papers;
}

const FINAL_SUBJECTIVE_TYPES = {
  刑法: ["辨析题", "法条分析题", "简答题", "案例分析题"],
  民法: ["辨析题", "法条分析题", "简答题", "案例分析题"],
  法理: ["分析题", "简答题", "论述题"],
  宪法: ["分析题", "简答题", "论述题"],
  法制史: ["简答题", "分析题"],
};

const EXPECTED_SUBJECTIVE_BY_ERA = {
  刑法: { E1: ["辨析题"], E2: ["法条分析题"], E3: ["简答题", "案例分析题"] },
  民法: { E1: ["辨析题"], E2: ["法条分析题"], E3: ["简答题", "案例分析题"] },
  法理: { E1: ["分析题"], E2: ["简答题"], E3: ["分析题", "论述题"] },
  宪法: { E1: ["分析题"], E2: ["简答题"], E3: ["简答题", "分析题"] },
  法制史: { E1: ["简答题"], E2: ["分析题"], E3: ["简答题", "分析题"] },
};

const SUBJECT_QUESTION_OFFSET = {
  刑法: 0,
  民法: 20,
  法理: 0,
  宪法: 20,
  法制史: 40,
};

function syntheticFiveSubjectCorpus() {
  const papers = [];
  for (let year = 2014; year <= 2024; year += 1) {
    for (const paperType of ["专业基础", "综合"]) {
      const subjects = paperType === "专业基础"
        ? ["刑法", "民法"]
        : ["法理", "宪法", "法制史"];
      const questions = subjects.flatMap((subject) => {
        const types = [
          "单选",
          "单选",
          "单选",
          "单选",
          "多选",
          "多选",
          ...FINAL_SUBJECTIVE_TYPES[subject],
        ];
        return types.map((type, index) => {
          const questionNo = SUBJECT_QUESTION_OFFSET[subject] + index + 1;
          return {
            ...syntheticQuestion(questionNo, type, "good", subject),
            canonicalId: `FS-${year}-${paperType}-${questionNo}`,
          };
        });
      });
      papers.push({
        year,
        canonicalYear: year,
        paperType,
        canonicalId: `FS-${year}-${paperType}`,
        parserVersion: "exam-parser-v1",
        sourceSha256: createHash("sha256")
          .update(`${year}|${paperType}`)
          .digest("hex"),
        sealed: year >= 2025,
        fileName: `${year}-${paperType}.txt`,
        questions,
      });
    }
  }
  return papers;
}

describe("calibration sample", () => {
  it("deterministically selects the same 50 questions independent of input order", () => {
    const corpus = syntheticCorpus();
    const forward = buildCalibrationSample(corpus);
    const reversed = buildCalibrationSample(
      [...corpus]
        .reverse()
        .map((paper) => ({ ...paper, questions: [...paper.questions].reverse() })),
    );

    expect(forward.questions).toHaveLength(50);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(reversed.selectionSha256).toBe(forward.selectionSha256);
  });

  it("covers every 2014-2024 year, both papers, every cell and all available types", () => {
    const sample = buildCalibrationSample(syntheticCorpus());
    expect(sample.coverage.years).toEqual([
      2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
    ]);
    expect(sample.coverage.papers).toEqual(["专业基础", "综合"]);
    expect(sample.coverage.yearPaperCellCount).toBe(22);
    expect(sample.coverage.selectedQuestionTypeCount).toBe(
      sample.coverage.availableQuestionTypeCount,
    );
    expect(new Set(sample.coverage.questionTypes)).toEqual(
      new Set([...FOUNDATION_TYPES, ...COMPREHENSIVE_TYPES]),
    );
    expect(Object.values(sample.coverage.byYear).every((count) => count > 0)).toBe(true);
    expect(Object.values(sample.coverage.byPaper).every((count) => count > 0)).toBe(true);
  });

  it("never includes sealed years or non-explicit/non-clean answers", () => {
    const sample = buildCalibrationSample(syntheticCorpus());
    expect(sample.policy.sealedFromYear).toBe(SEALED_EXAM_FROM_YEAR);
    expect(sample.questions.every((question) => question.year < 2025)).toBe(true);
    expect(
      sample.questions.every((question) => ["explicit", "clean"].includes(question.answerStatus)),
    ).toBe(true);
    expect(sample.questions.some((question) => question.questionNo >= 91)).toBe(false);
    expect(() => buildCalibrationSample(syntheticCorpus(), { lastYear: 2025 })).toThrow(
      "封卷保护",
    );
  });

  it("returns evidence metadata only, never question/answer bodies or answer keys", () => {
    const sample = buildCalibrationSample(syntheticCorpus());
    const question = sample.questions[0];
    expect(Object.keys(question).sort()).toEqual(
      [
        "answerLines",
        "answerStatus",
        "paper",
        "questionLines",
        "questionNo",
        "questionType",
        "sourceFile",
        "year",
      ].sort(),
    );
    expect(JSON.stringify(sample)).not.toContain("不应出现在输出中");
    expect(JSON.stringify(sample)).not.toContain("answerKey");
  });

  it("filters filenames before a sealed paper can be loaded", () => {
    expect(eligibleExamFileName("2024年法律硕士综合.txt")).toBe(true);
    expect(eligibleExamFileName("2025年法律硕士综合.txt")).toBe(false);
    expect(eligibleExamFileName("2026年法律硕士综合.txt")).toBe(false);
    expect(eligibleExamFileName("README.md")).toBe(false);
  });
});

describe("final five-subject calibration sample", () => {
  it("selects exactly 10 per subject with a 4/2/4 objective-subjective split", () => {
    const sample = buildFiveSubjectCalibrationSample(syntheticFiveSubjectCorpus());
    expect(sample.questions).toHaveLength(50);
    expect(sample.coverage.total).toBe(50);

    for (const subject of FINAL_CALIBRATION_SUBJECTS) {
      expect(sample.coverage.bySubject[subject]).toEqual({
        total: 10,
        single: 4,
        multiple: 2,
        subjective: 4,
      });
    }
    expect(
      sample.questions.every(
        (question) =>
          question.subjectLabelStatus === "structural" &&
          question.subjectLabelVersion === "subjects-v1",
      ),
    ).toBe(true);
  });

  it("fills the exact era and audited subjective subtype slots", () => {
    const sample = buildFiveSubjectCalibrationSample(syntheticFiveSubjectCorpus());
    expect(sample.coverage.byEra).toEqual({ E1: 15, E2: 15, E3: 20 });

    for (const subject of FINAL_CALIBRATION_SUBJECTS) {
      const subjectQuestions = sample.questions.filter(
        (question) => question.subject === subject,
      );
      for (const era of ["E1", "E2", "E3"]) {
        const eraQuestions = subjectQuestions.filter((question) => question.era === era);
        const single = eraQuestions.filter((question) => question.questionType === "单选").length;
        const multiple = eraQuestions.filter((question) => question.questionType === "多选").length;
        const subjective = eraQuestions
          .filter((question) => !["单选", "多选"].includes(question.questionType))
          .map((question) => question.questionType);

        if (era === "E1") expect({ single, multiple }).toEqual({ single: 1, multiple: 1 });
        if (era === "E2") expect({ single, multiple }).toEqual({ single: 2, multiple: 0 });
        if (era === "E3") expect({ single, multiple }).toEqual({ single: 1, multiple: 1 });
        expect(subjective).toEqual(EXPECTED_SUBJECTIVE_BY_ERA[subject][era]);
      }
    }
  });

  it("is deterministic and uses the exact codex-calibration-v1 rank digest", () => {
    const corpus = syntheticFiveSubjectCorpus();
    const forward = buildFiveSubjectCalibrationSample(corpus);
    const reversed = buildFiveSubjectCalibrationSample(
      [...corpus]
        .reverse()
        .map((paper) => ({ ...paper, questions: [...paper.questions].reverse() })),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));

    for (const question of forward.questions) {
      expect(question.canonicalId).toBe(
        `FS-${question.year}-${question.paper}-${question.questionNo}`,
      );
      const expectedRank = createHash("sha256")
        .update(`${FINAL_CALIBRATION_RANK_SEED}|${question.canonicalId}`)
        .digest("hex");
      expect(question.rankSha256).toBe(expectedRank);
      expect(
        finalCalibrationCanonicalId({
          ...question,
          subject: "重审后的科目标签",
          questionType: "重审后的题型标签",
          sourceFile: "renamed.txt",
        }),
      ).toBe(question.canonicalId);
    }
    expect(new Set(forward.questions.map((question) => question.canonicalId)).size).toBe(50);
  });

  it("excludes 2025+, never guesses subjects, and caps each subject/year at two", () => {
    const corpus = syntheticFiveSubjectCorpus();
    corpus.push({
      year: 2025,
      canonicalYear: 2025,
      paperType: "专业基础",
      canonicalId: "FS-2025-专业基础",
      parserVersion: "exam-parser-v1",
      sourceSha256: "0".repeat(64),
      sealed: true,
      fileName: "2025-专业基础.txt",
      questions: [],
    });
    corpus
      .find((paper) => paper.year === 2024 && paper.paperType === "专业基础")
      .questions.push(syntheticQuestion(99, "单选"));
    const sample = buildFiveSubjectCalibrationSample(corpus);

    expect(sample.questions.every((question) => question.year <= 2024)).toBe(true);
    expect(
      sample.questions.every((question) => FINAL_CALIBRATION_SUBJECTS.includes(question.subject)),
    ).toBe(true);
    const counts = new Map();
    for (const question of sample.questions) {
      const key = `${question.subject}/${question.year}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(sample.coverage.sameSubjectYearMaxObserved).toBeLessThanOrEqual(2);
  });

  it("rejects an otherwise explicit answer when answerReviewStatus is not clean", () => {
    const corpus = syntheticFiveSubjectCorpus().map((paper) => {
      if (paper.year > 2017) return paper;
      return {
        ...paper,
        questions: paper.questions.map((question) =>
          question.subject === "刑法" && question.题型 === "单选"
            ? { ...question, answerReviewStatus: "disputed" }
            : question,
        ),
      };
    });
    expect(() => buildFiveSubjectCalibrationSample(corpus)).toThrow(
      "刑法/E1:single:1",
    );
  });

  it("rejects a parser canonicalId that disagrees with the body identity", () => {
    const corpus = syntheticFiveSubjectCorpus();
    corpus[0].questions[0].canonicalId = "FS-2014-专业基础-99";
    expect(() => buildFiveSubjectCalibrationSample(corpus)).toThrow(
      "题本体 canonicalId 不一致",
    );
  });

  it("records stable input and labelling provenance without sealed papers", () => {
    const sample = buildFiveSubjectCalibrationSample(syntheticFiveSubjectCorpus());
    expect(sample.inputs).toHaveLength(22);
    expect(sample.inputs.every((input) => !input.canonicalId.startsWith("FS-2025-"))).toBe(true);
    expect(sample.inputs[0]).toEqual({
      canonicalId: "FS-2014-专业基础",
      sourceFile: "2014-专业基础.txt",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      questionCount: expect.any(Number),
    });
    expect(sample.parserVersions).toEqual(["exam-parser-v1"]);
    expect(sample.subjectLabelVersions).toEqual(["subjects-v1"]);
    expect(sample.policy.acceptedSubjectLabelStatuses).toEqual([
      "structural",
      "safe_core",
      "reviewed",
    ]);
    expect(sample.inputManifestSha256).toBe(
      createHash("sha256").update(JSON.stringify(sample.inputs)).digest("hex"),
    );
  });

  it("rejects subject labels outside the accepted evidence statuses", () => {
    const corpus = syntheticFiveSubjectCorpus().map((paper) => {
      if (paper.year > 2017) return paper;
      return {
        ...paper,
        questions: paper.questions.map((question) =>
          question.subject === "刑法" && question.题型 === "单选"
            ? {
                ...question,
                subjectLabel: { status: "manual_review", version: "subjects-v1" },
              }
            : question,
        ),
      };
    });
    expect(() => buildFiveSubjectCalibrationSample(corpus)).toThrow(
      "刑法/E1:single:1",
    );
  });
});
