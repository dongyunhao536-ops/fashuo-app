import { createHash } from "node:crypto";

export const DEFAULT_CALIBRATION_FIRST_YEAR = 2014;
export const DEFAULT_CALIBRATION_LAST_YEAR = 2024;
export const SEALED_EXAM_FROM_YEAR = 2025;
export const DEFAULT_CALIBRATION_SAMPLE_SIZE = 50;

const PAPER_TYPES = ["专业基础", "综合"];
const QUESTION_TYPE_ORDER = [
  "单选",
  "多选",
  "简答题",
  "辨析题",
  "法条分析题",
  "案例分析题",
  "分析题",
  "论述题",
];
const OBJECTIVE_TYPES = new Set(["单选", "多选"]);
const CALIBRATION_SEED = "fashuo-independent-calibration-v1";

export const FINAL_CALIBRATION_SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
export const FINAL_CALIBRATION_RANK_SEED = "codex-calibration-v1";
export const FINAL_ACCEPTED_SUBJECT_LABEL_STATUSES = [
  "structural",
  "safe_core",
  "reviewed",
];

const FINAL_ERA_DEFINITIONS = [
  { id: "E1", firstYear: 2014, lastYear: 2017 },
  { id: "E2", firstYear: 2018, lastYear: 2021 },
  { id: "E3", firstYear: 2022, lastYear: 2024 },
];

const SUBJECTIVE_SLOT_TYPES = {
  刑法: { E1: ["辨析题"], E2: ["法条分析题"], E3: ["简答题", "案例分析题"] },
  民法: { E1: ["辨析题"], E2: ["法条分析题"], E3: ["简答题", "案例分析题"] },
  法理: { E1: ["分析题"], E2: ["简答题"], E3: ["分析题", "论述题"] },
  // 2022–2024 综合 #58 均为跨科题，不能为了凑“宪法论述”强贴单科标签；
  // E3 改取可安全单标签的 #52 简答与 #55 分析。
  宪法: { E1: ["分析题"], E2: ["简答题"], E3: ["简答题", "分析题"] },
  法制史: { E1: ["简答题"], E2: ["分析题"], E3: ["简答题", "分析题"] },
};

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function paperOrder(paper) {
  const index = PAPER_TYPES.indexOf(paper);
  return index === -1 ? PAPER_TYPES.length : index;
}

function questionTypeOrder(type) {
  const index = QUESTION_TYPE_ORDER.indexOf(type);
  return index === -1 ? QUESTION_TYPE_ORDER.length : index;
}

function stableRank(candidate) {
  return createHash("sha256")
    .update(
      [
        CALIBRATION_SEED,
        candidate.year,
        candidate.paper,
        candidate.questionNo,
        candidate.questionType,
        candidate.sourceFile,
      ].join("\0"),
    )
    .digest("hex");
}

function isValidLineRange(start, end) {
  return Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start;
}

function cleanAnswerStatus(question) {
  if (
    Object.hasOwn(question, "answerReviewStatus") &&
    question.answerReviewStatus !== "clean"
  ) {
    return null;
  }
  if (
    !isValidLineRange(question.answerStartLine, question.answerEndLine) ||
    !String(question.answer ?? question.解析 ?? "").trim()
  ) {
    return null;
  }

  if (OBJECTIVE_TYPES.has(question.题型)) {
    const expectedKey = question.题型 === "单选" ? /^[A-D]$/u : /^[A-D]{2,4}$/u;
    return question.answerKeyStatus === "explicit" && expectedKey.test(question.answerKey ?? "")
      ? "explicit"
      : null;
  }

  // 主观题的 parser 状态通常是 `missing`，因为它没有 A-D 答案键；这里用
  // 独立且完整的答案块作为 clean 证据，但仍排除明确作废或推断所得答案。
  if (["invalidated", "inferred_from_analysis"].includes(question.answerKeyStatus)) {
    return null;
  }
  return "clean";
}

function candidateFromQuestion(paper, question) {
  const year = Number(paper.year);
  const paperType = paper.paperType ?? paper.卷;
  if (!Number.isInteger(year) || !PAPER_TYPES.includes(paperType)) return null;
  if (!Number.isInteger(question.no) || question.no < 1 || !question.题型) return null;
  if (!isValidLineRange(question.startLine, question.endLine)) return null;

  const answerStatus = cleanAnswerStatus(question);
  if (!answerStatus || question.answerStartLine <= question.endLine) return null;

  const candidate = {
    year,
    paper: paperType,
    questionNo: question.no,
    questionType: question.题型,
    sourceFile: String(paper.fileName ?? ""),
    questionLines: { start: question.startLine, end: question.endLine },
    answerLines: { start: question.answerStartLine, end: question.answerEndLine },
    answerStatus,
  };
  return { ...candidate, rank: stableRank(candidate) };
}

function canonicalCandidateCompare(left, right) {
  return (
    left.year - right.year ||
    paperOrder(left.paper) - paperOrder(right.paper) ||
    left.questionNo - right.questionNo ||
    questionTypeOrder(left.questionType) - questionTypeOrder(right.questionType) ||
    compareText(left.sourceFile, right.sourceFile)
  );
}

function cellKey(candidate) {
  return `${candidate.year}\0${candidate.paper}`;
}

function questionKey(candidate) {
  return `${candidate.year}\0${candidate.paper}\0${candidate.questionNo}`;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function count(map, key) {
  return map.get(key) ?? 0;
}

function pickBest(candidates, scoreParts) {
  return [...candidates].sort((left, right) => {
    for (const scorePart of scoreParts) {
      const difference = scorePart(left) - scorePart(right);
      if (difference !== 0) return difference;
    }
    return compareText(left.rank, right.rank) || canonicalCandidateCompare(left, right);
  })[0];
}

function countBy(items, keySelector, orderedKeys) {
  const counts = new Map(orderedKeys.map((key) => [key, 0]));
  for (const item of items) increment(counts, keySelector(item));
  return Object.fromEntries([...counts]);
}

function publicQuestion(candidate) {
  return {
    year: candidate.year,
    paper: candidate.paper,
    questionNo: candidate.questionNo,
    questionType: candidate.questionType,
    sourceFile: candidate.sourceFile,
    questionLines: candidate.questionLines,
    answerLines: candidate.answerLines,
    answerStatus: candidate.answerStatus,
  };
}

function validateOptions({ firstYear, lastYear, sampleSize }) {
  if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear > lastYear) {
    throw new Error("校准年份范围无效");
  }
  if (lastYear >= SEALED_EXAM_FROM_YEAR) {
    throw new Error(`封卷保护：不得抽取 ${SEALED_EXAM_FROM_YEAR} 年及以后真题`);
  }
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new Error("sampleSize 必须是正整数");
  }
}

/**
 * Build a deterministic evidence-only calibration sample. Question and answer
 * bodies are used only to verify clean answer blocks and are never returned.
 */
export function buildCalibrationSample(
  corpus,
  {
    firstYear = DEFAULT_CALIBRATION_FIRST_YEAR,
    lastYear = DEFAULT_CALIBRATION_LAST_YEAR,
    sampleSize = DEFAULT_CALIBRATION_SAMPLE_SIZE,
  } = {},
) {
  if (!Array.isArray(corpus)) throw new Error("corpus 必须是试卷数组");
  validateOptions({ firstYear, lastYear, sampleSize });

  const candidates = corpus
    .filter(
      (paper) =>
        Number.isInteger(paper.year) &&
        paper.year >= firstYear &&
        paper.year <= lastYear &&
        paper.year < SEALED_EXAM_FROM_YEAR,
    )
    .flatMap((paper) =>
      Array.isArray(paper.questions)
        ? paper.questions.map((question) => candidateFromQuestion(paper, question)).filter(Boolean)
        : [],
    )
    .sort(canonicalCandidateCompare);

  const duplicateQuestion = candidates.find(
    (candidate, index) =>
      index > 0 && questionKey(candidate) === questionKey(candidates[index - 1]),
  );
  if (duplicateQuestion) {
    throw new Error(
      `语料存在重复题目标识：${duplicateQuestion.year}/${duplicateQuestion.paper}/${duplicateQuestion.questionNo}`,
    );
  }
  if (candidates.length < sampleSize) {
    throw new Error(`干净候选题不足：需要 ${sampleSize}，只有 ${candidates.length}`);
  }

  const requiredYears = Array.from(
    { length: lastYear - firstYear + 1 },
    (_, index) => firstYear + index,
  );
  const requiredCells = requiredYears.flatMap((year) =>
    PAPER_TYPES.map((paper) => `${year}\0${paper}`),
  );
  const availableCells = new Set(candidates.map(cellKey));
  const missingCells = requiredCells.filter((cell) => !availableCells.has(cell));
  if (missingCells.length > 0) {
    const labels = missingCells.map((cell) => cell.replace("\0", "/"));
    throw new Error(`缺少可校准的年份/试卷：${labels.join("、")}`);
  }
  if (sampleSize < requiredCells.length) {
    throw new Error(`样本数 ${sampleSize} 无法覆盖 ${requiredCells.length} 个年份/试卷组合`);
  }

  const availableTypes = [...new Set(candidates.map((candidate) => candidate.questionType))]
    .sort((left, right) => {
      const order = questionTypeOrder(left) - questionTypeOrder(right);
      return order || compareText(left, right);
    });
  if (sampleSize < availableTypes.length) {
    throw new Error(`样本数 ${sampleSize} 无法覆盖 ${availableTypes.length} 种题型`);
  }

  const selected = [];
  const selectedKeys = new Set();
  const cellCounts = new Map();
  const typeCounts = new Map();
  const yearCounts = new Map();
  const paperCounts = new Map();

  function add(candidate) {
    const key = questionKey(candidate);
    if (selectedKeys.has(key)) return;
    selected.push(candidate);
    selectedKeys.add(key);
    increment(cellCounts, cellKey(candidate));
    increment(typeCounts, candidate.questionType);
    increment(yearCounts, candidate.year);
    increment(paperCounts, candidate.paper);
  }

  // First secure every available question type. Rarer types go first and each
  // representative prefers a still-uncovered year/paper cell.
  const typesByRarity = [...availableTypes].sort((left, right) => {
    const leftCount = candidates.filter((candidate) => candidate.questionType === left).length;
    const rightCount = candidates.filter((candidate) => candidate.questionType === right).length;
    return leftCount - rightCount || questionTypeOrder(left) - questionTypeOrder(right);
  });
  for (const type of typesByRarity) {
    const pool = candidates.filter(
      (candidate) =>
        candidate.questionType === type && !selectedKeys.has(questionKey(candidate)),
    );
    add(
      pickBest(pool, [
        (candidate) => count(cellCounts, cellKey(candidate)),
        (candidate) => count(yearCounts, candidate.year),
        (candidate) => count(paperCounts, candidate.paper),
      ]),
    );
  }

  // Then guarantee both papers in every eligible year.
  for (const requiredCell of requiredCells) {
    if (count(cellCounts, requiredCell) > 0) continue;
    const pool = candidates.filter(
      (candidate) =>
        cellKey(candidate) === requiredCell && !selectedKeys.has(questionKey(candidate)),
    );
    add(
      pickBest(pool, [
        (candidate) => count(typeCounts, candidate.questionType),
      ]),
    );
  }

  if (selected.length > sampleSize) {
    throw new Error(
      `样本数 ${sampleSize} 无法同时覆盖全部题型与年份/试卷；至少需要 ${selected.length}`,
    );
  }

  // Fill the remainder evenly across year/paper cells, then question types.
  while (selected.length < sampleSize) {
    const pool = candidates.filter((candidate) => !selectedKeys.has(questionKey(candidate)));
    const next = pickBest(pool, [
      (candidate) => count(cellCounts, cellKey(candidate)),
      (candidate) => count(typeCounts, candidate.questionType),
      (candidate) => count(yearCounts, candidate.year),
      (candidate) => count(paperCounts, candidate.paper),
    ]);
    if (!next) throw new Error("无法补足校准样本");
    add(next);
  }

  selected.sort(canonicalCandidateCompare);
  const questions = selected.map(publicQuestion);
  const selectedYears = [...new Set(questions.map((question) => question.year))].sort(
    (left, right) => left - right,
  );
  const selectedPapers = PAPER_TYPES.filter((paper) =>
    questions.some((question) => question.paper === paper),
  );
  const selectedTypes = availableTypes.filter((type) =>
    questions.some((question) => question.questionType === type),
  );

  return {
    schemaVersion: 1,
    policy: {
      eligibleYears: { first: firstYear, last: lastYear },
      sealedFromYear: SEALED_EXAM_FROM_YEAR,
      requestedSize: sampleSize,
      questionBodyIncluded: false,
      acceptedAnswerStatuses: ["explicit", "clean"],
    },
    coverage: {
      years: selectedYears,
      papers: selectedPapers,
      questionTypes: selectedTypes,
      yearPaperCellCount: new Set(questions.map(cellKey)).size,
      availableQuestionTypeCount: availableTypes.length,
      selectedQuestionTypeCount: selectedTypes.length,
      byYear: countBy(questions, (question) => question.year, requiredYears),
      byPaper: countBy(questions, (question) => question.paper, PAPER_TYPES),
      byQuestionType: countBy(
        questions,
        (question) => question.questionType,
        availableTypes,
      ),
    },
    questions,
    selectionSha256: createHash("sha256")
      .update(JSON.stringify(questions))
      .digest("hex"),
  };
}

export function eligibleExamFileName(
  fileName,
  {
    firstYear = DEFAULT_CALIBRATION_FIRST_YEAR,
    lastYear = DEFAULT_CALIBRATION_LAST_YEAR,
  } = {},
) {
  const match = String(fileName).match(/(20\d{2})/u);
  const year = match ? Number(match[1]) : null;
  return (
    String(fileName).endsWith(".txt") &&
    Number.isInteger(year) &&
    year >= firstYear &&
    year <= lastYear &&
    year < SEALED_EXAM_FROM_YEAR
  );
}

function finalEraForYear(year) {
  return FINAL_ERA_DEFINITIONS.find(
    (era) => year >= era.firstYear && year <= era.lastYear,
  )?.id;
}

function finalSlotsForSubject(subject) {
  const subjective = SUBJECTIVE_SLOT_TYPES[subject];
  const blueprints = [
    { era: "E1", role: "single", questionType: "单选", ordinal: 1 },
    { era: "E1", role: "multiple", questionType: "多选", ordinal: 1 },
    { era: "E1", role: "subjective", questionType: subjective.E1[0], ordinal: 1 },
    { era: "E2", role: "single", questionType: "单选", ordinal: 1 },
    { era: "E2", role: "single", questionType: "单选", ordinal: 2 },
    { era: "E2", role: "subjective", questionType: subjective.E2[0], ordinal: 1 },
    { era: "E3", role: "single", questionType: "单选", ordinal: 1 },
    { era: "E3", role: "multiple", questionType: "多选", ordinal: 1 },
    { era: "E3", role: "subjective", questionType: subjective.E3[0], ordinal: 1 },
    { era: "E3", role: "subjective", questionType: subjective.E3[1], ordinal: 2 },
  ];
  return blueprints.map((slot, order) => ({
    ...slot,
    order,
    id:
      slot.role === "subjective"
        ? `${slot.era}:subjective:${slot.questionType}`
        : `${slot.era}:${slot.role}:${slot.ordinal}`,
  }));
}

export function finalCalibrationCanonicalId(question) {
  if (
    !Number.isInteger(question.year) ||
    !question.paper ||
    !Number.isInteger(question.questionNo)
  ) {
    return null;
  }
  return `FS-${question.year}-${question.paper}-${question.questionNo}`;
}

function finalCandidateFromQuestion(paper, question) {
  if (!FINAL_CALIBRATION_SUBJECTS.includes(question.subject)) return null;
  const subjectLabel = question.subjectLabel;
  if (
    subjectLabel !== undefined &&
    (subjectLabel === null ||
      typeof subjectLabel !== "object" ||
      !FINAL_ACCEPTED_SUBJECT_LABEL_STATUSES.includes(subjectLabel.status))
  ) {
    return null;
  }
  const canonicalYear = Number(paper.canonicalYear ?? paper.year);
  const base = candidateFromQuestion({ ...paper, year: canonicalYear }, question);
  if (!base || base.year >= SEALED_EXAM_FROM_YEAR) return null;
  const era = finalEraForYear(base.year);
  if (!era) return null;

  const candidate = {
    subject: question.subject,
    era,
    year: base.year,
    paper: base.paper,
    questionNo: base.questionNo,
    questionType: base.questionType,
    sourceFile: base.sourceFile,
    questionLines: base.questionLines,
    answerLines: base.answerLines,
    answerStatus: base.answerStatus,
    subjectLabelStatus: subjectLabel?.status ?? null,
    subjectLabelVersion: subjectLabel?.version ?? null,
  };
  const expectedCanonicalId = finalCalibrationCanonicalId(candidate);
  const parserHasCanonicalId = Object.hasOwn(question, "canonicalId");
  if (parserHasCanonicalId && question.canonicalId !== expectedCanonicalId) {
    throw new Error(
      `题本体 canonicalId 不一致：parser=${question.canonicalId}，expected=${expectedCanonicalId}`,
    );
  }
  const canonicalId = parserHasCanonicalId ? question.canonicalId : expectedCanonicalId;
  return {
    ...candidate,
    canonicalId,
    rankSha256: createHash("sha256")
      .update(`${FINAL_CALIBRATION_RANK_SEED}|${canonicalId}`)
      .digest("hex"),
  };
}

function finalCandidateCompare(left, right) {
  return (
    FINAL_CALIBRATION_SUBJECTS.indexOf(left.subject) -
      FINAL_CALIBRATION_SUBJECTS.indexOf(right.subject) ||
    left.year - right.year ||
    paperOrder(left.paper) - paperOrder(right.paper) ||
    left.questionNo - right.questionNo ||
    compareText(left.canonicalId, right.canonicalId)
  );
}

function assignFinalSubjectSlots(subject, candidates) {
  const slots = finalSlotsForSubject(subject).map((slot) => {
    const pool = candidates
      .filter(
        (candidate) =>
          candidate.subject === subject &&
          candidate.era === slot.era &&
          candidate.questionType === slot.questionType,
      )
      .sort(
        (left, right) =>
          compareText(left.rankSha256, right.rankSha256) ||
          compareText(left.canonicalId, right.canonicalId),
      );
    if (pool.length === 0) {
      throw new Error(`五科校准槽无干净候选：${subject}/${slot.id}`);
    }
    return { ...slot, pool };
  });

  // Search constrained slots first. Candidate order remains the exact SHA-256
  // order required by the calibration contract.
  const searchOrder = [...slots].sort(
    (left, right) => left.pool.length - right.pool.length || left.order - right.order,
  );
  const assignedBySlot = new Map();
  const selectedIds = new Set();
  const yearCounts = new Map();

  function search(index) {
    if (index === searchOrder.length) return true;
    const slot = searchOrder[index];
    for (const candidate of slot.pool) {
      if (selectedIds.has(candidate.canonicalId) || count(yearCounts, candidate.year) >= 2) {
        continue;
      }
      assignedBySlot.set(slot.id, candidate);
      selectedIds.add(candidate.canonicalId);
      increment(yearCounts, candidate.year);
      if (search(index + 1)) return true;
      assignedBySlot.delete(slot.id);
      selectedIds.delete(candidate.canonicalId);
      yearCounts.set(candidate.year, count(yearCounts, candidate.year) - 1);
    }
    return false;
  }

  if (!search(0)) {
    throw new Error(`五科校准槽无法同时满足同科同年最多 2 题：${subject}`);
  }

  return slots
    .sort((left, right) => left.order - right.order)
    .map((slot) => ({ slot, candidate: assignedBySlot.get(slot.id) }));
}

function publicFinalQuestion({ slot, candidate }) {
  return {
    subject: candidate.subject,
    era: slot.era,
    slot: slot.id,
    canonicalId: candidate.canonicalId,
    rankSha256: candidate.rankSha256,
    year: candidate.year,
    paper: candidate.paper,
    questionNo: candidate.questionNo,
    questionType: candidate.questionType,
    sourceFile: candidate.sourceFile,
    questionLines: candidate.questionLines,
    answerLines: candidate.answerLines,
    answerStatus: candidate.answerStatus,
    subjectLabelStatus: candidate.subjectLabelStatus,
    subjectLabelVersion: candidate.subjectLabelVersion,
  };
}

function finalSubjectCoverage(questions, subject) {
  const selected = questions.filter((question) => question.subject === subject);
  return {
    total: selected.length,
    single: selected.filter((question) => question.questionType === "单选").length,
    multiple: selected.filter((question) => question.questionType === "多选").length,
    subjective: selected.filter(
      (question) => !OBJECTIVE_TYPES.has(question.questionType),
    ).length,
  };
}

function finalPaperYear(paper) {
  const year = Number(paper.canonicalYear ?? paper.year);
  return Number.isInteger(year) ? year : null;
}

function isFinalEligiblePaper(paper) {
  const year = finalPaperYear(paper);
  return (
    year >= DEFAULT_CALIBRATION_FIRST_YEAR &&
    year <= DEFAULT_CALIBRATION_LAST_YEAR &&
    year < SEALED_EXAM_FROM_YEAR &&
    paper.sealed !== true &&
    PAPER_TYPES.includes(paper.paperType ?? paper.卷)
  );
}

function buildFinalInputManifest(papers) {
  const inputs = papers
    .map((paper) => {
      const year = finalPaperYear(paper);
      const paperType = paper.paperType ?? paper.卷;
      const expectedCanonicalId = `FS-${year}-${paperType}`;
      const parserHasCanonicalId = Object.hasOwn(paper, "canonicalId");
      if (parserHasCanonicalId && paper.canonicalId !== expectedCanonicalId) {
        throw new Error(
          `试卷 canonicalId 不一致：parser=${paper.canonicalId}，expected=${expectedCanonicalId}`,
        );
      }
      return {
        canonicalId: parserHasCanonicalId ? paper.canonicalId : expectedCanonicalId,
        sourceFile: String(paper.fileName ?? ""),
        sourceSha256: paper.sourceSha256 ?? null,
        questionCount: Array.isArray(paper.questions) ? paper.questions.length : 0,
      };
    })
    .sort((left, right) => compareText(left.canonicalId, right.canonicalId));

  for (let index = 1; index < inputs.length; index += 1) {
    if (inputs[index - 1].canonicalId === inputs[index].canonicalId) {
      throw new Error(`final inputs 存在重复试卷：${inputs[index].canonicalId}`);
    }
  }
  return inputs;
}

function distinctVersions(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined).map(String))]
    .sort(compareText);
}

/**
 * Final five-subject calibration contract: exactly 10 questions per subject,
 * fixed era/type slots, deterministic SHA-ranked candidates, and at most two
 * questions from the same subject/year. Subjects must be supplied explicitly
 * as `question.subject`; this function never infers them from paper or number.
 */
export function buildFiveSubjectCalibrationSample(corpus) {
  if (!Array.isArray(corpus)) throw new Error("corpus 必须是试卷数组");
  const eligiblePapers = corpus.filter(isFinalEligiblePaper);
  const inputs = buildFinalInputManifest(eligiblePapers);
  const parserVersions = distinctVersions(
    eligiblePapers.map((paper) => paper.parserVersion),
  );
  const subjectLabelVersions = distinctVersions(
    eligiblePapers.flatMap((paper) =>
      Array.isArray(paper.questions)
        ? paper.questions.map((question) => question.subjectLabel?.version)
        : [],
    ),
  );
  const candidates = eligiblePapers
    .flatMap((paper) =>
      Array.isArray(paper.questions)
        ? paper.questions
            .map((question) => finalCandidateFromQuestion(paper, question))
            .filter(Boolean)
        : [],
    )
    .sort(finalCandidateCompare);

  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.canonicalId)) {
      throw new Error(`五科校准语料存在重复 canonicalId：${candidate.canonicalId}`);
    }
    candidateIds.add(candidate.canonicalId);
  }

  const assignments = FINAL_CALIBRATION_SUBJECTS.flatMap((subject) =>
    assignFinalSubjectSlots(subject, candidates),
  );
  const questions = assignments.map(publicFinalQuestion);

  const subjectYearCounts = new Map();
  for (const question of questions) {
    increment(subjectYearCounts, `${question.subject}\0${question.year}`);
  }
  const sameSubjectYearMaxObserved = Math.max(...subjectYearCounts.values());

  return {
    schemaVersion: 2,
    policy: {
      eligibleYears: {
        first: DEFAULT_CALIBRATION_FIRST_YEAR,
        last: DEFAULT_CALIBRATION_LAST_YEAR,
      },
      sealedFromYear: SEALED_EXAM_FROM_YEAR,
      subjects: FINAL_CALIBRATION_SUBJECTS,
      questionsPerSubject: 10,
      sameSubjectYearMaximum: 2,
      rankExpression: `SHA256('${FINAL_CALIBRATION_RANK_SEED}|' + canonicalId)`,
      acceptedAnswerStatuses: ["explicit", "clean"],
      acceptedSubjectLabelStatuses: FINAL_ACCEPTED_SUBJECT_LABEL_STATUSES,
      questionBodyIncluded: false,
    },
    inputs,
    parserVersions,
    subjectLabelVersions,
    inputManifestSha256: createHash("sha256")
      .update(JSON.stringify(inputs))
      .digest("hex"),
    coverage: {
      total: questions.length,
      bySubject: Object.fromEntries(
        FINAL_CALIBRATION_SUBJECTS.map((subject) => [
          subject,
          finalSubjectCoverage(questions, subject),
        ]),
      ),
      byEra: countBy(questions, (question) => question.era, ["E1", "E2", "E3"]),
      sameSubjectYearMaxObserved,
    },
    questions,
    selectionSha256: createHash("sha256")
      .update(JSON.stringify(questions))
      .digest("hex"),
  };
}
