export const EXAM_SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
export const EXAM_SUBJECT_LABEL_VERSION = "exam-subject-safe-core-v1";

const FOUNDATION = "专业基础";
const COMPREHENSIVE = "综合";
const OBJECTIVE_TYPES = new Set(["单选", "多选"]);

const FOUNDATION_SECTION_COUNTS = {
  legacy: {
    单选: 40,
    多选: 10,
    简答题: 4,
    辨析题: 2,
    法条分析题: 2,
    案例分析题: 2,
  },
  modern: {
    单选: 40,
    多选: 10,
    简答题: 4,
    法条分析题: 2,
    案例分析题: 2,
  },
};

const COMPREHENSIVE_SUBJECTIVE_SLOTS = {
  legacy: new Map([
    [64, ["法理", "简答题"]],
    [65, ["宪法", "简答题"]],
    [66, ["法制史", "简答题"]],
    [67, ["法理", "分析题"]],
    [68, ["宪法", "分析题"]],
    [69, ["法制史", "分析题"]],
    [70, ["法理", "论述题"]],
  ]),
  modern: new Map([
    [51, ["法理", "简答题"]],
    [52, ["宪法", "简答题"]],
    [53, ["法制史", "简答题"]],
    [54, ["法理", "分析题"]],
    [55, ["宪法", "分析题"]],
    [56, ["法制史", "分析题"]],
    [57, ["法理", "论述题"]],
    // 58 会在法理、宪法、法制史之间轮换或跨科，禁止结构猜测。
  ]),
};

const COMPREHENSIVE_OBJECTIVE_SAFE_CORE = {
  legacy: {
    单选: [
      [1, 10, "法理"],
      [18, 25, "宪法"],
      [33, 45, "法制史"],
    ],
    多选: [
      [46, 49, "法理"],
      [53, 57, "宪法"],
      [61, 63, "法制史"],
    ],
  },
  modern: {
    单选: [
      [1, 10, "法理"],
      [15, 25, "宪法"],
      [30, 40, "法制史"],
    ],
    多选: [
      [41, 43, "法理"],
      [46, 47, "宪法"],
      [48, 50, "法制史"],
    ],
  },
};

function paperYear(paper) {
  const year = Number(paper?.canonicalYear ?? paper?.detectedYear ?? paper?.year);
  return Number.isInteger(year) ? year : null;
}

function paperType(paper) {
  return paper?.paperType ?? paper?.卷 ?? null;
}

function eraForYear(year) {
  if (year >= 2014 && year <= 2017) return "legacy";
  if (year >= 2018 && year <= 2024) return "modern";
  return null;
}

function explicitSubjects(question) {
  const values = Array.isArray(question?.subjects)
    ? question.subjects
    : Array.isArray(question?.subjectCandidates)
      ? question.subjectCandidates
      : [];
  return [...new Set(values.filter((subject) => EXAM_SUBJECTS.includes(subject)))];
}

function isExplicitlyCrossSubject(question) {
  return question?.crossSubject === true || explicitSubjects(question).length > 1;
}

function label(question, subject, status, rule, evidence = {}) {
  return {
    version: EXAM_SUBJECT_LABEL_VERSION,
    questionNo: question?.no ?? null,
    questionType: question?.题型 ?? null,
    subject,
    subjects: subject ? [subject] : explicitSubjects(question),
    status,
    rule,
    evidence,
  };
}

function manualLabel(question, rule, evidence = {}) {
  return label(question, null, "manual_review", rule, evidence);
}

function labelFoundation(paper, year, era) {
  const questions = Array.isArray(paper.questions) ? paper.questions : [];
  const entries = questions.map((question, index) => ({ question, index }));
  const byType = Map.groupBy(entries, ({ question }) => question.题型);
  const labels = Array(questions.length);
  const issues = [];

  for (const [questionType, sectionEntries] of byType) {
    const ordered = [...sectionEntries].sort(
      (left, right) => left.question.no - right.question.no,
    );
    const expectedCount = FOUNDATION_SECTION_COUNTS[era]?.[questionType];
    const numbersAreContiguous = ordered.every(
      ({ question }, index) =>
        Number.isInteger(question.no) &&
        (index === 0 || question.no === ordered[index - 1].question.no + 1),
    );
    const valid =
      Number.isInteger(expectedCount) &&
      ordered.length === expectedCount &&
      ordered.length % 2 === 0 &&
      numbersAreContiguous;

    if (!valid) {
      const evidence = {
        year,
        paper: FOUNDATION,
        questionType,
        actualCount: ordered.length,
        expectedCount: expectedCount ?? null,
        numbersAreContiguous,
      };
      issues.push({ code: "foundation_section_invalid", ...evidence });
      for (const entry of sectionEntries) {
        labels[entry.index] = manualLabel(
          entry.question,
          "foundation_section_invalid",
          evidence,
        );
      }
      continue;
    }

    const half = ordered.length / 2;
    ordered.forEach((entry, ordinal) => {
      const subject = ordinal < half ? "刑法" : "民法";
      const evidence = {
        year,
        paper: FOUNDATION,
        questionType,
        ordinal,
        sectionCount: ordered.length,
        half,
      };
      labels[entry.index] = isExplicitlyCrossSubject(entry.question)
        ? manualLabel(entry.question, "explicit_cross_subject", evidence)
        : label(
            entry.question,
            subject,
            "structural",
            "foundation_section_half",
            evidence,
          );
    });
  }

  return { labels, issues };
}

function labelComprehensiveQuestion(question, year, era) {
  const evidence = {
    year,
    paper: COMPREHENSIVE,
    questionType: question?.题型 ?? null,
    questionNo: question?.no ?? null,
  };
  if (isExplicitlyCrossSubject(question)) {
    return manualLabel(question, "explicit_cross_subject", evidence);
  }

  if (OBJECTIVE_TYPES.has(question?.题型)) {
    const ranges = COMPREHENSIVE_OBJECTIVE_SAFE_CORE[era]?.[question.题型] ?? [];
    const hit = ranges.find(([from, to]) => question.no >= from && question.no <= to);
    if (!hit) return manualLabel(question, "comprehensive_objective_boundary", evidence);
    const [from, to, subject] = hit;
    return label(
      question,
      subject,
      "safe_core",
      "comprehensive_objective_safe_core",
      { ...evidence, from, to },
    );
  }

  const slot = COMPREHENSIVE_SUBJECTIVE_SLOTS[era]?.get(question?.no);
  if (!slot || slot[1] !== question?.题型) {
    return manualLabel(question, "comprehensive_subjective_manual", evidence);
  }
  return label(
    question,
    slot[0],
    "structural",
    "comprehensive_subjective_slot",
    evidence,
  );
}

/**
 * Pure subject labelling. It never reads files, mutates questions, or invokes
 * semantic scoring. Ambiguous boundaries remain `manual_review` with no subject.
 */
export function labelPaperSubjects(paper) {
  const questions = Array.isArray(paper?.questions) ? paper.questions : [];
  const year = paperYear(paper);
  const type = paperType(paper);
  const era = eraForYear(year);

  if (!era || ![FOUNDATION, COMPREHENSIVE].includes(type)) {
    return {
      year,
      paperType: type,
      labels: questions.map((question) =>
        manualLabel(question, "unsupported_paper", { year, paper: type }),
      ),
      issues: [{ code: "unsupported_paper", year, paper: type }],
    };
  }

  const result = type === FOUNDATION
    ? labelFoundation(paper, year, era)
    : {
        labels: questions.map((question) =>
          labelComprehensiveQuestion(question, year, era),
        ),
        issues: [],
      };
  return { year, paperType: type, ...result };
}

/** Return a labelled copy of one parsed paper; the input paper is unchanged. */
export function applySubjectLabels(paper) {
  const result = labelPaperSubjects(paper);
  const questions = Array.isArray(paper?.questions) ? paper.questions : [];
  return {
    ...paper,
    questions: questions.map((question, index) => ({
      ...question,
      subject: result.labels[index].subject,
      subjectLabel: result.labels[index],
    })),
    subjectLabelIssues: result.issues,
  };
}
