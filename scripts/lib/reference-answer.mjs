// [gpt] 2026-08-24：主观题参考答案完整扫描、证据状态与稳定 hash；不把“没找到”写成“不存在”。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { resolveExamTextRoot } from "./workspace-paths.mjs";

const PAPER_TOKEN = Object.freeze({ case: "专业基础", essay: "综合" });
const NOISE_LINE = /^(?:--\s*\d+\s+of\s+\d+\s*--|公众号[:：].*|\d+)$/u;

function normalizedText(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").normalize("NFC").trim();
}

function referenceHash(value) {
  return createHash("sha256").update(normalizedText(value), "utf8").digest("hex");
}

function validateQuestion(question) {
  const value = Number(question);
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error("question 必须是 1-99 的题号");
  return value;
}

function answerMarker(line) {
  return /【答案(?:要点)?】/u.test(line);
}

export function extractReferenceAnswer(text, question) {
  const number = validateQuestion(question);
  const lines = normalizedText(text).split("\n");
  const questionLine = new RegExp(`^\\s*${number}[.．、]`, "u");
  const nextQuestionLine = new RegExp(`^\\s*${number + 1}[.．、]`, "u");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!questionLine.test(lines[index])) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (nextQuestionLine.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    let answerAt = -1;
    for (let cursor = index; cursor < end; cursor += 1) {
      if (answerMarker(lines[cursor])) {
        answerAt = cursor;
        break;
      }
    }
    if (answerAt < 0) continue;
    const answer = lines.slice(answerAt, end).filter((line) => !NOISE_LINE.test(line.trim())).join("\n").trim();
    if (answer) matches.push({ answer, lineStart: answerAt + 1, lineEnd: end });
  }
  if (matches.length > 1) throw new Error(`REFERENCE_AMBIGUOUS｜题号 ${number} 在同一文件命中 ${matches.length} 个答案块`);
  return matches[0] ?? null;
}

function foundResult({ answer, file, lineStart, lineEnd, sourceKind, sourceLabel, filesScanned, completeScan }) {
  return {
    state: "found",
    sourceKind,
    sourceLabel,
    sourceFile: file,
    lineStart,
    lineEnd,
    filesScanned,
    completeScan,
    answer,
    referenceHash: referenceHash(answer),
    referenceLength: answer.length,
  };
}

export function loadReferenceAnswer({
  type,
  year = null,
  question,
  referenceFile = null,
  sourceLabel = null,
  examTextRoot = resolveExamTextRoot(),
} = {}) {
  if (!Object.hasOwn(PAPER_TOKEN, type)) throw new Error("type 只接受 case|essay");
  const number = validateQuestion(question);
  if (referenceFile) {
    const file = resolve(referenceFile);
    if (!existsSync(file)) return { state: "source_unavailable", sourceFile: file, completeScan: false, filesScanned: 0 };
    const stats = statSync(file);
    if (!stats.isFile() || stats.size < 1 || stats.size > 2 * 1024 * 1024) {
      return { state: "source_unavailable", sourceFile: file, completeScan: false, filesScanned: 0 };
    }
    if (!new Set([".txt", ".md", ".json"]).has(extname(file).toLowerCase())) {
      throw new Error("用户参考答案文件只接受 txt|md|json");
    }
    const answer = normalizedText(readFileSync(file, "utf8"));
    if (!answer) return { state: "source_unavailable", sourceFile: file, completeScan: false, filesScanned: 1 };
    return foundResult({
      answer,
      file,
      lineStart: 1,
      lineEnd: answer.split("\n").length,
      sourceKind: "user_specified",
      sourceLabel: sourceLabel ?? "用户指定参考答案",
      filesScanned: 1,
      completeScan: true,
    });
  }

  if (!/^20\d{2}$/u.test(String(year ?? ""))) throw new Error("本地真题检索需要 year=20XX");
  const root = resolve(examTextRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { state: "source_unavailable", sourceFile: root, completeScan: false, filesScanned: 0 };
  }
  let files;
  try {
    files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".txt")
      .map((entry) => resolve(root, entry.name));
  } catch {
    return { state: "source_unavailable", sourceFile: root, completeScan: false, filesScanned: 0 };
  }
  const token = PAPER_TOKEN[type];
  const candidates = files.filter((file) => basename(file).includes(String(year)) && basename(file).includes(token));
  const matches = [];
  for (const file of candidates) {
    let extracted;
    try {
      extracted = extractReferenceAnswer(readFileSync(file, "utf8"), number);
    } catch (error) {
      if (String(error?.message ?? error).startsWith("REFERENCE_AMBIGUOUS")) throw error;
      return { state: "source_unavailable", sourceFile: file, completeScan: false, filesScanned: matches.length };
    }
    if (extracted) matches.push({ file, ...extracted });
  }
  if (!matches.length) {
    return {
      state: "not_found_after_complete_scan",
      sourceFile: root,
      completeScan: true,
      filesScanned: candidates.length,
      scannedFiles: candidates.map((file) => basename(file)),
    };
  }
  if (matches.length > 1) throw new Error(`REFERENCE_AMBIGUOUS｜${year}/${type}/Q${number} 跨文件命中 ${matches.length} 个答案块`);
  const match = matches[0];
  return foundResult({
    answer: match.answer,
    file: match.file,
    lineStart: match.lineStart,
    lineEnd: match.lineEnd,
    sourceKind: "local_companion_reference",
    sourceLabel: sourceLabel ?? `${year} ${token}卷随卷参考答案/解析`,
    filesScanned: candidates.length,
    completeScan: true,
  });
}

export function referenceEvidenceRef(result, { type, year = null, question } = {}) {
  if (result?.state !== "found") throw new Error("只有 found 参考答案可以生成绑定证据");
  const origin = result.sourceKind === "user_specified" ? "user" : `${year}/${type}`;
  return `reference:${origin}:Q${validateQuestion(question)}:${basename(result.sourceFile)}:L${result.lineStart}-${result.lineEnd}`.slice(0, 160);
}
