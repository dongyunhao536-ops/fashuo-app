// [gpt] 2026-08-12：只按本地同版试卷答案键判阅读；不接受调用方口头声明“已对答案”。

import { createHash } from "node:crypto";

function normalizeAnswers(value, label = "answers") {
  const answers = String(value ?? "").toUpperCase().match(/[A-D]/gu) ?? [];
  if (answers.length !== 5) throw new Error(`${label} 必须恰好包含 5 个 A-D 选项`);
  return answers;
}

export function parseEnglishReadingAnswerKey(markdown) {
  const rows = {};
  for (const line of String(markdown ?? "").replace(/\r\n/gu, "\n").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (!/^20\d{2}$/u.test(cells[0] ?? "") || cells.length !== 5) continue;
    // 同一文件下方还有“年度 + 四篇主题”表；只接受每格恰为五个 A-D 的答案行。
    if (!cells.slice(1).every((cell) => /^(?:[A-D]\s*){5}$/u.test(cell.toUpperCase()))) continue;
    const year = Number(cells[0]);
    const texts = cells.slice(1).map((cell, index) => normalizeAnswers(cell, `${year} Text ${index + 1}`));
    rows[year] = texts;
  }
  if (!Object.keys(rows).length) throw new Error("答案键未识别到任何年度阅读行");
  return rows;
}

export function gradeEnglishReading({ answerKeyMarkdown, year, text, answers } = {}) {
  const normalizedYear = Number(year);
  const normalizedText = Number(text);
  if (!Number.isInteger(normalizedYear)) throw new Error("--year 必须是四位年份");
  if (!Number.isInteger(normalizedText) || normalizedText < 1 || normalizedText > 4) throw new Error("--text 必须是 1-4");
  const answerKey = parseEnglishReadingAnswerKey(answerKeyMarkdown);
  const expected = answerKey[normalizedYear]?.[normalizedText - 1];
  if (!expected) throw new Error(`答案键没有 ${normalizedYear} Text ${normalizedText}`);
  const actual = normalizeAnswers(answers, "--answers");
  const firstQuestion = 21 + (normalizedText - 1) * 5;
  const items = expected.map((key, index) => ({
    question: firstQuestion + index,
    answer: actual[index],
    expected: key,
    correct: actual[index] === key,
  }));
  return {
    year: normalizedYear,
    text: normalizedText,
    firstQuestion,
    lastQuestion: firstQuestion + 4,
    score: items.filter((item) => item.correct).length,
    maximum: 5,
    answers: actual,
    expected,
    items,
  };
}

export function shortContentHash(value, length = 12) {
  return createHash("sha256").update(String(value ?? "").replace(/\r\n/gu, "\n"), "utf8").digest("hex").slice(0, length);
}
