import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveExamTextRoot } from "./workspace-paths.mjs";

// [gpt] 2026-08-23：默认真题根随档案根跨平台解析，仍可由环境变量覆盖。
export const DEFAULT_EXAM_TEXT_ROOT = resolveExamTextRoot();
export const EXAM_CORPUS_PARSER_VERSION = "exam-corpus-v1";

const SECTION_RE =
  /^[一二三四五六七八九十]+、\s*(单项选择题|多项选择题|简答题|辨析题|法条分析题|案例分析题|分析题|论述题)/;
const NUMBERED_LINE_RE = /^(\d{1,2})[.．、]\s*(.*)$/;
const NOISE_RE = /^(公众号[:：]|--\s*\d+\s*of\s*\d+\s*--|\d+\s*$|第\s*\d+\s*页)/i;
const OBJECTIVE_TYPES = new Set(["单选", "多选"]);
const SUBJECTIVE_ANSWER_MARKER_RE = /【(?:答案|答案要点)】/;
const ANSWER_REVIEW_SIGNAL_RULES = [
  ["original_answer_reference", /原答案/u],
  [
    "official_author_conflict",
    /(?:官方答案[\s\S]{0,160}作者认为|作者认为[\s\S]{0,160}官方答案)/u,
  ],
  [
    "answer_dispute",
    /(?:(?:本题(?:的)?(?:答案)?|答案|选项\s*[A-D]|[A-D]\s*选项)\s*(?:可能)?\s*(?:存在|有)\s*(?:一定)?\s*争议)/u,
  ],
  ["answer_revised", /改答|答案(?:发生|出现|有所)?变化|答案调整|应改为|现改为/u],
  [
    "law_change",
    /旧题新做|(?:本题)?因(?:新法|法律|法条)(?:的)?修改|(?:新法|法律|法条)修改(?:后|导致|造成|使得|答案)|修法(?:导致|后)/u,
  ],
];

function cleanSourceText(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r/g, "");
}

function cleanLine(line) {
  return String(line).replace(/\t/g, "").trim();
}

function paperTypeFromFilename(fileName) {
  if (fileName.includes("综合")) return "综合";
  if (fileName.includes("专业基础")) return "专业基础";
  return null;
}

function detectExamYear(text) {
  const head = cleanSourceText(text).split("\n").slice(0, 12).join("");
  const match = head.match(/(20\d{2})\s*年全国硕士研究生招生考试/u);
  return match ? Number(match[1]) : null;
}

function detectSourceProvider(text) {
  return /法硕小精灵/u.test(cleanSourceText(text)) ? "法硕小精灵" : "unknown";
}

function buildCanonicalId(year, paperType, questionNo = null) {
  if (!Number.isInteger(year) || !paperType) return null;
  const paperId = `FS-${year}-${paperType}`;
  return Number.isInteger(questionNo) ? `${paperId}-${questionNo}` : paperId;
}

export function isSealedExamYear(year) {
  return Number.isInteger(year) && year >= 2025;
}

export function detectPaperType(text) {
  const head = cleanSourceText(text).split("\n").slice(0, 12).join("");
  if (head.includes("综合")) return "综合";
  if (head.includes("专业基础")) return "专业基础";
  return null;
}

export function normalizeQuestionType(raw) {
  if (raw === "单项选择题") return "单选";
  if (raw === "多项选择题") return "多选";
  return raw;
}

function findAnswerStart(lines) {
  // 有些卷头文件名本身含“及参考答案解析”，不能把第 1 行误当答案区。
  // 只有已经见到至少一道连续编号的题后，后续“参考答案”标题才算分界。
  let expected = 1;
  let sawQuestion = false;
  for (let i = 0; i < lines.length; i++) {
    const line = cleanLine(lines[i]);
    const numbered = line.match(NUMBERED_LINE_RE);
    if (numbered && Number(numbered[1]) === expected) {
      sawQuestion = true;
      expected++;
    }
    if (sawQuestion && /参考答案/.test(line)) return i;
    if (sawQuestion && /^1[.．、]\s*【答案】/.test(line)) return i;
  }
  return lines.length;
}

function appendPart(target, raw, lineNo) {
  if (!target || NOISE_RE.test(cleanLine(raw))) return;
  const value = cleanLine(raw);
  if (!value) return;
  target.parts.push(value);
  target.endLine = lineNo;
}

function parseQuestions(lines, endIndex) {
  const questions = [];
  let current = null;
  let questionType = "单选";
  let expected = 1;

  for (let i = 0; i < endIndex; i++) {
    const line = cleanLine(lines[i]);
    if (!line || NOISE_RE.test(line)) continue;

    const section = line.match(SECTION_RE);
    if (section) {
      if (current) questions.push(current);
      current = null;
      questionType = normalizeQuestionType(section[1]);
      continue;
    }

    const numbered = line.match(NUMBERED_LINE_RE);
    const no = numbered ? Number(numbered[1]) : null;
    if (numbered && no === expected) {
      if (current) questions.push(current);
      current = {
        no,
        题型: questionType,
        startLine: i + 1,
        endLine: i + 1,
        parts: [numbered[2]],
      };
      expected++;
      continue;
    }
    appendPart(current, lines[i], i + 1);
  }
  if (current) questions.push(current);

  return questions.map(({ parts, ...question }) => ({
    ...question,
    text: parts.join(""),
  }));
}

function parseAnswers(lines, startIndex, questions) {
  const known = new Set(questions.map((question) => question.no));
  const blocks = new Map();
  let current = null;
  let expected = questions[0]?.no ?? 1;

  for (let i = startIndex; i < lines.length; i++) {
    const line = cleanLine(lines[i]);
    if (!line || NOISE_RE.test(line)) continue;

    const numbered = line.match(NUMBERED_LINE_RE);
    const no = numbered ? Number(numbered[1]) : null;
    if (numbered && no === expected && known.has(no)) {
      if (current) blocks.set(current.no, current);
      current = {
        no,
        startLine: i + 1,
        endLine: i + 1,
        parts: [line],
      };
      expected++;
      continue;
    }
    appendPart(current, lines[i], i + 1);
  }
  if (current) blocks.set(current.no, current);

  return blocks;
}

function parseAnswerKey(answerText) {
  const normalized = String(answerText).normalize("NFKC");
  const explicit = normalized.match(/【答案】\s*([A-D]{1,4})(?=\s|$|\(|（)/i);
  if (explicit) return { key: explicit[1].toUpperCase(), status: "explicit" };
  if (/【答案】\s*无(?:答案)?/.test(normalized)) return { key: null, status: "invalidated" };
  const inferred = normalized.match(/选项\s*([A-D])\s*(?:正确|应当选|当选)/i);
  if (inferred) return { key: inferred[1].toUpperCase(), status: "inferred_from_analysis" };
  return { key: null, status: "missing" };
}

function reviewAnswer({ questionType, answerText, parsedKey }) {
  const normalized = String(answerText).normalize("NFKC");
  const reasons = [];

  for (const [reason, pattern] of ANSWER_REVIEW_SIGNAL_RULES) {
    if (pattern.test(normalized)) reasons.push(reason);
  }

  if (OBJECTIVE_TYPES.has(questionType)) {
    if (parsedKey.status === "inferred_from_analysis") {
      reasons.push("answer_key_inferred");
    } else if (parsedKey.status === "invalidated") {
      reasons.push("answer_key_invalidated");
    } else if (parsedKey.status === "missing") {
      reasons.push("answer_key_missing");
    } else if (parsedKey.status !== "explicit") {
      reasons.push("answer_key_not_explicit");
    }

    const validKey =
      questionType === "单选"
        ? /^[A-D]$/u.test(parsedKey.key ?? "")
        : /^[A-D]{2,4}$/u.test(parsedKey.key ?? "");
    if (parsedKey.status === "explicit" && !validKey) {
      reasons.push("answer_key_shape_invalid");
    }
  } else {
    if (!SUBJECTIVE_ANSWER_MARKER_RE.test(normalized)) {
      reasons.push("subjective_answer_marker_missing");
    }
    if (parsedKey.status === "invalidated") reasons.push("answer_invalidated");
    if (parsedKey.status === "inferred_from_analysis") reasons.push("answer_inferred");
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    reasons: uniqueReasons,
    status: uniqueReasons.length === 0 ? "clean" : "manual_review",
  };
}

export function parseExamPaper({ fileName, content }) {
  const source = cleanSourceText(content);
  const sourceSha256 = createHash("sha256").update(source, "utf8").digest("hex");
  const lines = source.split("\n");
  const yearMatch = String(fileName).match(/(20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const detectedYear = detectExamYear(source);
  const canonicalYear = detectedYear ?? year;
  const paperType = detectPaperType(source);
  const declaredPaperType = paperTypeFromFilename(fileName);
  const canonicalId = buildCanonicalId(canonicalYear, paperType);
  const sealed = isSealedExamYear(canonicalYear);
  const sourceProvider = detectSourceProvider(source);
  const answerStartIndex = findAnswerStart(lines);
  const questions = parseQuestions(lines, answerStartIndex);
  const answers = parseAnswers(lines, answerStartIndex, questions);

  for (const question of questions) {
    const block = answers.get(question.no);
    const answer = block?.parts.join("\n") ?? "";
    const parsedKey = parseAnswerKey(answer);
    const answerReview = reviewAnswer({
      questionType: question.题型,
      answerText: answer,
      parsedKey,
    });
    question.answer = answer;
    question.解析 = answer; // 兼容现有 fenzhang.mjs 的字段名。
    question.answerKey = parsedKey.key;
    question.answerKeyStatus = parsedKey.status;
    question.answerReviewReasons = answerReview.reasons;
    question.answerReviewStatus = answerReview.status;
    question.answerStartLine = block?.startLine ?? null;
    question.answerEndLine = block?.endLine ?? null;
    question.canonicalId = buildCanonicalId(canonicalYear, paperType, question.no);
    question.sealed = sealed;
    question.sourceProvider = sourceProvider;
  }

  const warnings = [];
  if (!year) warnings.push("filename_year_missing");
  if (year && detectedYear && year !== detectedYear) warnings.push("filename_year_mismatch");
  if (!paperType) warnings.push("paper_type_missing");
  if (declaredPaperType && paperType && declaredPaperType !== paperType) {
    warnings.push("filename_paper_type_mismatch");
  }
  if (answerStartIndex === lines.length) warnings.push("answer_section_missing");
  if (!questions.length) warnings.push("questions_missing");
  const missingObjectiveAnswers = questions
    .filter(
      (question) =>
        ["单选", "多选"].includes(question.题型) && question.answerKeyStatus === "missing",
    )
    .map((question) => question.no);
  if (missingObjectiveAnswers.length) {
    warnings.push(`objective_answer_missing:${missingObjectiveAnswers.join(",")}`);
  }

  return {
    fileName,
    parserVersion: EXAM_CORPUS_PARSER_VERSION,
    sourceSha256,
    year,
    detectedYear,
    canonicalYear,
    canonicalId,
    sealed,
    sourceProvider,
    卷: paperType,
    paperType,
    declaredPaperType,
    fileNameMismatch: declaredPaperType !== null && paperType !== null && declaredPaperType !== paperType,
    answerSectionLine: answerStartIndex < lines.length ? answerStartIndex + 1 : null,
    questions,
    warnings,
  };
}

export function loadExamPaper(fileName, root = DEFAULT_EXAM_TEXT_ROOT) {
  const content = readFileSync(join(root, fileName), "utf8");
  return parseExamPaper({ fileName, content });
}

export function loadExamCorpus(root = DEFAULT_EXAM_TEXT_ROOT) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => loadExamPaper(entry.name, root))
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || String(a.paperType).localeCompare(String(b.paperType), "zh-CN"));
}
