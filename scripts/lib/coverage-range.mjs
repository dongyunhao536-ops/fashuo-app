// [gpt] 2026-08-25：8-03 进度只报最新章却被当成唯一覆盖单元；只在可确定的同轨向前跳章时拦截。
import { readFileSync } from "node:fs";

const SEQUENTIAL_ACTIVITIES = new Set(["听课", "看书", "背诵"]);
const CHINESE_DIGITS = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

function parseChineseNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  if (token === "十") return 10;
  const tens = token.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tens) return (tens[1] ? CHINESE_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);
  return CHINESE_DIGITS[token] ?? null;
}

function normalizeLabel(value) {
  return String(value ?? "")
    .replace(/[\s，,、：:；;·（）()《》【】\[\]“”"'的]/gu, "")
    .trim();
}

export function loadGeneratedExamOutline() {
  const source = readFileSync(new URL("../../src/lib/exam-outline.gen.ts", import.meta.url), "utf8");
  const literal = source.match(/export const EXAM_OUTLINE\s*=\s*("(?:\\.|[^"\\])*")\s*;/s)?.[1];
  if (!literal) throw new Error("无法从 src/lib/exam-outline.gen.ts 读取 EXAM_OUTLINE");
  return JSON.parse(literal);
}

export function parseExamOutlineChapters(examOutline) {
  const bySubject = new Map();
  for (const block of String(examOutline ?? "").split("◆").slice(1)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const subject = lines[0]?.match(/^([^（\s]+)/u)?.[1] ?? null;
    if (!subject) continue;
    const chapters = [];
    for (const line of lines.slice(1)) {
      const match = line.match(/^第([0-9一二三四五六七八九十]+)章\s*([^：:]*)(?:[：:].*)?$/u);
      if (!match) continue;
      const number = parseChineseNumber(match[1]);
      if (!number) continue;
      const title = match[2].trim();
      chapters.push({ number, title, label: `第${match[1]}章${title ? ` ${title}` : ""}` });
    }
    bySubject.set(subject, chapters.sort((a, b) => a.number - b.number));
  }
  return bySubject;
}

function resolveChapterFromList(chapters, value) {
  const text = String(value ?? "").trim();
  if (!text || chapters.length === 0) return { state: "unresolved", value: text, chapter: null };

  const explicitNumbers = [...text.matchAll(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/gu)]
    .map((match) => parseChineseNumber(match[1]))
    .filter((number) => chapters.some((chapter) => chapter.number === number));
  const uniqueExplicit = [...new Set(explicitNumbers)];
  if (uniqueExplicit.length === 1) {
    return { state: "resolved", value: text, chapter: chapters.find((item) => item.number === uniqueExplicit[0]) };
  }
  if (uniqueExplicit.length > 1) return { state: "ambiguous", value: text, chapter: null };

  const normalized = normalizeLabel(text);
  const semanticMatches = chapters
    .map((chapter) => ({ chapter, key: normalizeLabel(chapter.title) }))
    .filter(({ key }) => key.length >= 2 && (normalized.includes(key) || key.includes(normalized)));
  const mostSpecific = semanticMatches.filter(({ key }) => !semanticMatches.some(({ key: other }) => other.length > key.length && other.includes(key)));
  const uniqueSemantic = [...new Map(mostSpecific.map(({ chapter }) => [chapter.number, chapter])).values()];
  if (uniqueSemantic.length === 1) return { state: "resolved", value: text, chapter: uniqueSemantic[0] };
  if (uniqueSemantic.length > 1) return { state: "ambiguous", value: text, chapter: null };
  return { state: "unresolved", value: text, chapter: null };
}

export function resolveOutlineChapter(examOutline, subject, value) {
  const chapters = parseExamOutlineChapters(examOutline).get(subject) ?? [];
  return resolveChapterFromList(chapters, value);
}

export function isSequentialCoverageActivity(activity) {
  return SEQUENTIAL_ACTIVITIES.has(activity);
}

function resolveLatestPrior(chapters, priorRows) {
  for (const row of priorRows ?? []) {
    const resolved = resolveChapterFromList(chapters, row.chapter);
    if (resolved.state === "resolved") return { row, chapter: resolved.chapter };
  }
  return null;
}

function chapterRange(chapters, fromNumber, toNumber) {
  return chapters.filter((chapter) => chapter.number >= fromNumber && chapter.number <= toNumber);
}

/**
 * 纯函数：规划一次学习流水写入。没有可确认顺序时只返回 hint；可确认且向前跳章时才 block。
 */
export function planCoverageRange({
  examOutline,
  subject,
  activity,
  target,
  priorRows = [],
  coverageFrom = null,
  coverageGapConfirmed = false,
  coverageGapReason = null,
}) {
  if (!isSequentialCoverageActivity(activity)) {
    return { status: "not_applicable", code: null, unitsToWrite: [{ label: target, isTarget: true }] };
  }

  const chapters = parseExamOutlineChapters(examOutline).get(subject) ?? [];
  const targetResolved = resolveChapterFromList(chapters, target);
  if (targetResolved.state !== "resolved") {
    if (coverageFrom || coverageGapConfirmed) {
      return { status: "invalid", code: "COVERAGE_SEQUENCE_UNRESOLVED", message: `无法把目标“${target ?? ""}”唯一归入《考试分析》章节顺序` };
    }
    return {
      status: "hint",
      code: "COVERAGE_SEQUENCE_UNRESOLVED",
      message: `目标“${target ?? ""}”无法唯一归入章节顺序，本次不硬拦；不得据此推断中间单元已覆盖`,
      unitsToWrite: [{ label: target, isTarget: true }],
    };
  }

  const prior = resolveLatestPrior(chapters, priorRows);
  const targetChapter = targetResolved.chapter;
  const hasForwardGap = prior && targetChapter.number > prior.chapter.number + 1;
  const pendingUnits = hasForwardGap
    ? chapterRange(chapters, prior.chapter.number + 1, targetChapter.number - 1)
    : [];

  const gapReason = coverageGapReason == null ? "" : String(coverageGapReason).trim();
  if (coverageGapConfirmed && !gapReason) {
    return { status: "invalid", code: "COVERAGE_GAP_REASON_REQUIRED", message: "显式确认跳过覆盖区间时必须提供 --coverage-gap-reason" };
  }

  if (coverageFrom) {
    const fromResolved = resolveChapterFromList(chapters, coverageFrom);
    if (fromResolved.state !== "resolved") {
      return { status: "invalid", code: "COVERAGE_FROM_UNRESOLVED", message: `无法把区间起点“${coverageFrom}”唯一归入《考试分析》章节顺序` };
    }
    if (fromResolved.chapter.number > targetChapter.number) {
      return { status: "invalid", code: "COVERAGE_RANGE_REVERSED", message: "--coverage-from 必须不晚于本次 --chapter；倒序复盘请逐单元记账" };
    }
    if (hasForwardGap && fromResolved.chapter.number > prior.chapter.number + 1 && !coverageGapConfirmed) {
      const stillMissing = chapterRange(chapters, prior.chapter.number + 1, fromResolved.chapter.number - 1);
      return {
        status: "blocked",
        code: "COVERAGE_RANGE_UNCONFIRMED",
        message: "补录区间仍未覆盖上一落点与本次起点之间的单元",
        prior,
        target: targetChapter,
        pendingUnits: stillMissing,
      };
    }
    const confirmedSkippedUnits = hasForwardGap && fromResolved.chapter.number > prior.chapter.number + 1
      ? chapterRange(chapters, prior.chapter.number + 1, fromResolved.chapter.number - 1)
      : [];
    const effectiveFrom = prior && targetChapter.number > prior.chapter.number
      ? Math.max(fromResolved.chapter.number, prior.chapter.number + 1)
      : fromResolved.chapter.number;
    const units = chapterRange(chapters, effectiveFrom, targetChapter.number);
    return {
      status: "pass",
      code: confirmedSkippedUnits.length
        ? "COVERAGE_RANGE_WITH_GAP_CONFIRMED"
        : units.length > 1
          ? "COVERAGE_RANGE_EXPLICIT"
          : null,
      prior,
      target: targetChapter,
      pendingUnits: confirmedSkippedUnits,
      coverageFrom: fromResolved.chapter,
      coverageGapReason: confirmedSkippedUnits.length ? gapReason : null,
      unitsToWrite: units.map((chapter) => ({ ...chapter, isTarget: chapter.number === targetChapter.number })),
    };
  }

  if (coverageGapConfirmed) {
    return {
      status: "pass",
      code: hasForwardGap ? "COVERAGE_GAP_CONFIRMED" : null,
      prior,
      target: targetChapter,
      pendingUnits,
      coverageGapReason: gapReason,
      unitsToWrite: [{ ...targetChapter, isTarget: true }],
    };
  }

  if (hasForwardGap) {
    return {
      status: "blocked",
      code: "COVERAGE_RANGE_UNCONFIRMED",
      message: "最新汇报是进度终点，不能把中间单元默认为未学或已学",
      prior,
      target: targetChapter,
      pendingUnits,
    };
  }

  return {
    status: "pass",
    code: null,
    prior,
    target: targetChapter,
    pendingUnits: [],
    unitsToWrite: [{ ...targetChapter, label: target, isTarget: true }],
  };
}
