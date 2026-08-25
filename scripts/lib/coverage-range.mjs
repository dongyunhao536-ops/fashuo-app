// [gpt] 2026-08-25：8-03 进度只报最新节却被当成唯一覆盖单元；只在可确定的同轨向前跳章/节时拦截。
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
      const match = line.match(/^第([0-9一二三四五六七八九十]+)章\s*([^：:]*)(?:[：:](.*))?$/u);
      if (!match) continue;
      const chapterNumber = parseChineseNumber(match[1]);
      if (!chapterNumber) continue;
      const title = match[2].trim();
      const chapterLabel = `第${match[1]}章${title ? ` ${title}` : ""}`;
      const sections = String(match[3] ?? "").split(/[；;]/u).map((value) => value.trim()).filter(Boolean)
        .map((value) => {
          const section = value.match(/^第([0-9一二三四五六七八九十]+)节\s*(.*)$/u);
          const sectionNumber = section ? parseChineseNumber(section[1]) : null;
          if (!sectionNumber) return null;
          const sectionTitle = section[2].trim();
          return {
            level: "section",
            number: sectionNumber,
            position: sectionNumber,
            chapterNumber,
            sectionNumber,
            title: sectionTitle,
            label: `第${match[1]}章第${section[1]}节${sectionTitle ? ` ${sectionTitle}` : ""}`,
          };
        })
        .filter(Boolean);
      chapters.push({
        level: "chapter",
        number: chapterNumber,
        position: chapterNumber,
        chapterNumber,
        sectionNumber: null,
        title,
        label: chapterLabel,
        sections,
      });
    }
    bySubject.set(subject, chapters.sort((a, b) => a.number - b.number));
  }
  return bySubject;
}

function uniqueSemanticMatch(units, text) {
  const normalized = normalizeLabel(text);
  const matches = units
    .map((unit) => ({ unit, key: normalizeLabel(unit.title) }))
    .filter(({ key }) => key.length >= 2 && (normalized.includes(key) || key.includes(normalized)));
  const mostSpecific = matches.filter(({ key }) => !matches.some(({ key: other }) => other.length > key.length && other.includes(key)));
  return [...new Map(mostSpecific.map(({ unit }) => [`${unit.chapterNumber}:${unit.sectionNumber ?? 0}`, unit])).values()];
}

function resolveUnitFromList(chapters, value) {
  const text = String(value ?? "").trim();
  if (!text || chapters.length === 0) return { state: "unresolved", value: text, chapter: null };

  const explicitChapters = [...text.matchAll(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/gu)]
    .map((match) => parseChineseNumber(match[1]))
    .filter((number) => chapters.some((chapter) => chapter.number === number));
  const chapterNumbers = [...new Set(explicitChapters)];
  if (chapterNumbers.length > 1) return { state: "ambiguous", value: text, chapter: null };

  const explicitSections = [...text.matchAll(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*节/gu)]
    .map((match) => parseChineseNumber(match[1]));
  const sectionNumbers = [...new Set(explicitSections)];
  if (sectionNumbers.length > 1) return { state: "ambiguous", value: text, chapter: null };
  if (chapterNumbers.length === 1 && sectionNumbers.length === 1) {
    const section = chapters.find((chapter) => chapter.number === chapterNumbers[0])?.sections
      .find((item) => item.sectionNumber === sectionNumbers[0]);
    return section
      ? { state: "resolved", value: text, chapter: section }
      : { state: "unresolved", value: text, chapter: null };
  }
  if (chapterNumbers.length === 1) {
    return { state: "resolved", value: text, chapter: chapters.find((item) => item.number === chapterNumbers[0]) };
  }

  const sectionMatches = uniqueSemanticMatch(chapters.flatMap((chapter) => chapter.sections), text);
  if (sectionMatches.length === 1) return { state: "resolved", value: text, chapter: sectionMatches[0] };
  if (sectionMatches.length > 1) return { state: "ambiguous", value: text, chapter: null };
  const chapterMatches = uniqueSemanticMatch(chapters, text);
  if (chapterMatches.length === 1) return { state: "resolved", value: text, chapter: chapterMatches[0] };
  if (chapterMatches.length > 1) return { state: "ambiguous", value: text, chapter: null };
  return { state: "unresolved", value: text, chapter: null };
}

export function resolveOutlineChapter(examOutline, subject, value) {
  const chapters = parseExamOutlineChapters(examOutline).get(subject) ?? [];
  return resolveUnitFromList(chapters, value);
}

export function isSequentialCoverageActivity(activity) {
  return SEQUENTIAL_ACTIVITIES.has(activity);
}

function comparablePrior(chapters, target, priorRows) {
  const resolvedRows = (priorRows ?? []).map((row) => ({ row, resolved: resolveUnitFromList(chapters, row.chapter) }))
    .filter(({ resolved }) => resolved.state === "resolved");
  if (target.level === "chapter") {
    const latest = resolvedRows[0];
    if (!latest) return null;
    const chapter = chapters.find((item) => item.chapterNumber === latest.resolved.chapter.chapterNumber);
    return { row: latest.row, chapter };
  }

  const sameChapter = resolvedRows.find(({ resolved }) => resolved.chapter.chapterNumber === target.chapterNumber);
  if (sameChapter) return { row: sameChapter.row, chapter: sameChapter.resolved.chapter };
  const latest = resolvedRows[0];
  if (latest?.resolved.chapter.chapterNumber > target.chapterNumber) {
    return { row: latest.row, chapter: latest.resolved.chapter, reverse: true };
  }
  return {
    row: null,
    chapter: {
      level: "section",
      number: 0,
      position: 0,
      chapterNumber: target.chapterNumber,
      sectionNumber: 0,
      title: "本章起点",
      label: `第${target.chapterNumber}章起点`,
    },
    synthetic: true,
  };
}

function sequenceForTarget(chapters, target) {
  return target.level === "section"
    ? chapters.find((chapter) => chapter.number === target.chapterNumber)?.sections ?? []
    : chapters;
}

function positionInTargetSequence(prior, target, sequence) {
  if (!prior) return null;
  if (prior.reverse) return Number.POSITIVE_INFINITY;
  if (target.level === "section" && prior.chapter.level === "chapter") return sequence.length;
  return prior.chapter.position;
}

function unitRange(sequence, fromPosition, toPosition) {
  return sequence.filter((unit) => unit.position >= fromPosition && unit.position <= toPosition);
}

function sameSequence(from, target) {
  return from.level === target.level
    && (target.level === "chapter" || from.chapterNumber === target.chapterNumber);
}

/**
 * 纯函数：规划一次学习流水写入。章级与章内节级分开判序；无法确认顺序时只返回 hint。
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
  const targetResolved = resolveUnitFromList(chapters, target);
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

  // 课程目录与《考试分析》偶有同章内节号差异；顺序位置用受控目录，终点标签保留用户原始汇报。
  const targetChapter = { ...targetResolved.chapter, label: String(target).trim() || targetResolved.chapter.label };
  const sequence = sequenceForTarget(chapters, targetChapter);
  const prior = comparablePrior(chapters, targetChapter, priorRows);
  const priorPosition = positionInTargetSequence(prior, targetChapter, sequence);
  const hasForwardGap = priorPosition != null && targetChapter.position > priorPosition + 1;
  const pendingUnits = hasForwardGap
    ? unitRange(sequence, priorPosition + 1, targetChapter.position - 1)
    : [];

  const gapReason = coverageGapReason == null ? "" : String(coverageGapReason).trim();
  if (coverageGapConfirmed && !gapReason) {
    return { status: "invalid", code: "COVERAGE_GAP_REASON_REQUIRED", message: "显式确认跳过覆盖区间时必须提供 --coverage-gap-reason" };
  }

  if (coverageFrom) {
    const fromResolved = resolveUnitFromList(chapters, coverageFrom);
    if (fromResolved.state !== "resolved") {
      return { status: "invalid", code: "COVERAGE_FROM_UNRESOLVED", message: `无法把区间起点“${coverageFrom}”唯一归入《考试分析》章节顺序` };
    }
    if (!sameSequence(fromResolved.chapter, targetChapter)) {
      return { status: "invalid", code: "COVERAGE_SEQUENCE_MISMATCH", message: "--coverage-from 必须与本次终点属于同一章级或同一章内节级顺序" };
    }
    if (fromResolved.chapter.position > targetChapter.position) {
      return { status: "invalid", code: "COVERAGE_RANGE_REVERSED", message: "--coverage-from 必须不晚于本次 --chapter；倒序复盘请逐单元记账" };
    }
    if (hasForwardGap && fromResolved.chapter.position > priorPosition + 1 && !coverageGapConfirmed) {
      const stillMissing = unitRange(sequence, priorPosition + 1, fromResolved.chapter.position - 1);
      return {
        status: "blocked",
        code: "COVERAGE_RANGE_UNCONFIRMED",
        message: "补录区间仍未覆盖上一落点与本次起点之间的单元",
        prior,
        target: targetChapter,
        pendingUnits: stillMissing,
      };
    }
    const confirmedSkippedUnits = hasForwardGap && fromResolved.chapter.position > priorPosition + 1
      ? unitRange(sequence, priorPosition + 1, fromResolved.chapter.position - 1)
      : [];
    const effectiveFrom = priorPosition != null && targetChapter.position > priorPosition
      ? Math.max(fromResolved.chapter.position, priorPosition + 1)
      : fromResolved.chapter.position;
    const units = unitRange(sequence, effectiveFrom, targetChapter.position);
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
      coverageGapReason: coverageGapConfirmed ? gapReason : null,
      unitsToWrite: units.map((chapter) => chapter.position === targetChapter.position
        ? { ...chapter, label: targetChapter.label, isTarget: true }
        : { ...chapter, isTarget: false }),
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
