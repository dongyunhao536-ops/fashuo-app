const SMOOTH_K = 5;
const QUALITY_FLOOR = 0.5;
const READ_MIN_N = 4;

export const QUANT_V3_VERSION = "3.1";
export const QUANT_SUBJECTS = Object.freeze(["刑法", "民法", "法理", "宪法", "法制史"]);
export const QUANT_TOTAL_CHAPTERS = Object.freeze({ 刑法: 21, 民法: 21, 法理: 13, 宪法: 5, 法制史: 7 });
export const QUANT_WEIGHTS = Object.freeze({ 刑法: 75, 民法: 75, 法理: 60, 宪法: 50, 法制史: 40 });

// [gpt] 2026-08-10：刑法官方目录只有章名，历史流水却大量使用节级概念；这些别名只负责归章，不直接加台阶。
const CHAPTER_ALIASES = Object.freeze({
  刑法: Object.freeze({
    1: ["刑法概说", "刑法的基本原则", "刑法解释", "刑法的效力范围", "刑法的空间效力", "刑法的时间效力"],
    2: ["犯罪的概念", "犯罪的基本特征", "犯罪的分类"],
    3: [
      "犯罪客体", "犯罪客观方面", "危害行为", "危害结果", "刑法上的因果关系", "犯罪主体", "刑事责任年龄",
      "刑事责任能力", "单位犯罪", "犯罪主观方面", "犯罪故意", "犯罪过失", "事实认识错误", "法律认识错误",
    ],
    4: ["正当行为", "正当防卫", "紧急避险"],
    5: ["犯罪预备", "犯罪未遂", "犯罪中止"],
    6: ["共同犯罪的形式", "共同犯罪人的种类", "主犯", "从犯", "胁从犯", "教唆犯"],
    7: ["实质的一罪", "法定的一罪", "处断的一罪", "想象竞合犯", "法条竞合", "牵连犯", "吸收犯"],
    8: ["刑事责任的概念", "刑事责任的解决方式"],
    10: ["量刑情节", "累犯", "自首", "坦白", "立功", "数罪并罚", "缓刑"],
    11: ["减刑", "假释"],
    12: ["时效", "赦免"],
  }),
});

function closureQuality(open, absorbed, repeat) {
  const seen = open + absorbed;
  return (absorbed / (seen + SMOOTH_K)) * (seen > 0 ? 1 - 0.5 * (repeat / seen) : 1);
}

export function scoreSubjectV3(ev) {
  const covered = ev.chapSteps.length;
  const progress = Math.round((covered / ev.total) * 100);
  const recitePct = Math.round((ev.outChapters / ev.total) * 100);
  const depthSum = ev.chapSteps.reduce((sum, steps) => sum + Math.min(steps, 3) / 3, 0);
  const depth = Math.round((depthSum / ev.total) * 100);
  const seen = ev.open + ev.absorbed;
  const closure = seen > 0 ? Math.round((ev.absorbed / seen) * (1 - 0.5 * (ev.repeat / seen)) * 100) : null;
  const quality = Math.round((QUALITY_FLOOR + (1 - QUALITY_FLOOR) * closureQuality(ev.open, ev.absorbed, ev.repeat)) * 100);
  const substance = (0.25 * progress + 0.20 * depth + 0.25 * recitePct) / 0.70;
  const ability = Math.round(substance * (quality / 100));
  return { covered, progress, depth, recitePct, open: ev.open, absorbed: ev.absorbed, repeat: ev.repeat, closure, quality, ability };
}

export function scoreEnglishV3(ev) {
  const reading = ev.accs.length > 0 ? Math.round(ev.accs.reduce((sum, value) => sum + value, 0) / ev.accs.length) : null;
  const seen = ev.open + ev.absorbed;
  const closure = seen > 0 ? Math.round((ev.absorbed / seen) * (1 - 0.5 * (ev.repeat / seen)) * 100) : null;
  const readingFactor = ((reading ?? 0) / 100) * Math.min(1, ev.accs.length / READ_MIN_N);
  const paceFactor = Math.min(1, ev.papers14d / 4);
  const writingFactor = Math.min(1, ev.essays30d / 2);
  const closureFactor = closureQuality(ev.open, ev.absorbed, ev.repeat);
  const ability = Math.round(100 * (0.45 * readingFactor + 0.20 * paceFactor + 0.20 * writingFactor + 0.15 * closureFactor));
  return { ability, reading, papers14d: ev.papers14d, essays30d: ev.essays30d, open: ev.open, absorbed: ev.absorbed, closure };
}

function parseChineseNumber(token) {
  if (/^[0-9]+$/.test(token)) return Number(token);
  const chars = "一二三四五六七八九十";
  if (token === "十") return 10;
  if (token.startsWith("二十")) return token === "二十" ? 20 : 20 + chars.indexOf(token[2]) + 1;
  if (token.startsWith("十")) return 10 + chars.indexOf(token[1]) + 1;
  const index = chars.indexOf(token);
  return index >= 0 ? index + 1 : null;
}

function normalizeChapterKey(value) {
  return String(value ?? "").replace(/[\s，,、：:；;·（）()《》]/g, "");
}

function semanticChapterMatches(chapters, text, minimumLength) {
  const normalizedText = normalizeChapterKey(text);
  if (!normalizedText) return new Set();
  const matches = [];
  for (const chapter of chapters) {
    for (const key of chapter.keys) {
      const normalizedKey = normalizeChapterKey(key);
      if (normalizedKey.length >= minimumLength && normalizedText.includes(normalizedKey)) {
        matches.push({ number: chapter.number, key: normalizedKey });
      }
    }
  }
  // “非法人组织”同时包含“法人”；只保留更具体的长标题，避免一条流水误记两章。
  return new Set(matches
    .filter((match) => !matches.some((other) => other.key.length > match.key.length && other.key.includes(match.key)))
    .map((match) => match.number));
}

export function createChapterDetector(examOutline) {
  const outline = {};
  for (const block of String(examOutline ?? "").split("◆").slice(1)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const subject = QUANT_SUBJECTS.find((item) => lines[0]?.startsWith(item));
    if (!subject) continue;
    const chapters = [];
    for (const line of lines.slice(1)) {
      const match = line.match(/^第([0-9一二三四五六七八九十]+)章\s*([^：:]*)(?:[：:](.*))?$/);
      if (!match) continue;
      const number = parseChineseNumber(match[1]);
      if (number == null) continue;
      const title = (match[2] || "").trim();
      const sections = (match[3] || "").split(/[；;]/)
        .map((section) => section.replace(/^第[0-9一二三四五六七八九十]+节\s*/, "").trim())
        .filter((section) => section.length >= 2);
      const aliases = CHAPTER_ALIASES[subject]?.[number] ?? [];
      chapters.push({ number, keys: [title, ...sections, ...aliases].filter((key) => key.length >= 2) });
    }
    outline[subject] = chapters;
  }

  return function detectChapters(subject, text, raw = null) {
    const controlledText = String(text ?? "");
    const rawText = String(raw ?? "");
    const total = QUANT_TOTAL_CHAPTERS[subject] ?? 99;
    let found = semanticChapterMatches(outline[subject] ?? [], controlledText, 2);
    if (found.size === 0 && rawText) {
      found = semanticChapterMatches(outline[subject] ?? [], rawText, 4);
    }
    if (found.size === 0) {
      const regex = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/g;
      for (const match of controlledText.matchAll(regex)) {
        const number = parseChineseNumber(match[1]);
        if (number && number >= 1 && number <= total) found.add(number);
      }
      if (found.size === 0 && /绪论/.test(controlledText)) found.add(1);
    }
    return found;
  };
}

function minusDays(date, days) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * @param {{
 *   logs?: Array<Record<string, any>>,
 *   errors?: Array<Record<string, any>>,
 *   referenceDate: string,
 *   examOutline: string
 * }} input
 */
export function buildQuantV3({ logs = [], errors = [], referenceDate, examOutline }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate ?? "")) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const detectChapters = createChapterDetector(examOutline);
  const stepsBy = new Map();
  const stepOf = (activity) => activity === "听课" || activity === "看书"
    ? "in"
    : activity === "做题" || activity === "复盘"
      ? "test"
      : activity === "背诵" || activity === "带背"
        ? "out"
        : null;

  for (const row of logs) {
    const subject = row.subject;
    const chapter = row.chapter;
    const step = stepOf(row.activity);
    if (!QUANT_SUBJECTS.includes(subject) || !chapter || !step) continue;
    const chapters = stepsBy.get(subject) ?? new Map();
    stepsBy.set(subject, chapters);
    for (const number of detectChapters(subject, chapter, row.raw_input)) {
      const steps = chapters.get(number) ?? new Set();
      steps.add(step);
      chapters.set(number, steps);
    }
  }

  const errorBySubject = new Map();
  const seenKeys = new Set();
  for (const row of errors) {
    const subject = row.subject ?? "未分类";
    const current = errorBySubject.get(subject) ?? { open: 0, absorbed: 0, repeat: 0 };
    if (row.status === "absorbed") current.absorbed += 1;
    else current.open += 1;
    const explicitRecurrence = /复发/.test(String(row.source ?? ""));
    const key = `${subject}::${row.kp_id ?? row.knowledge}`;
    const duplicate = seenKeys.has(key);
    seenKeys.add(key);
    if (explicitRecurrence || duplicate) current.repeat += 1;
    errorBySubject.set(subject, current);
  }

  const subjects = QUANT_SUBJECTS.map((subject) => {
    const chapters = stepsBy.get(subject) ?? new Map();
    const error = errorBySubject.get(subject) ?? { open: 0, absorbed: 0, repeat: 0 };
    return {
      subject,
      weight: QUANT_WEIGHTS[subject],
      total: QUANT_TOTAL_CHAPTERS[subject],
      ...scoreSubjectV3({
        total: QUANT_TOTAL_CHAPTERS[subject],
        chapSteps: [...chapters.values()].map((steps) => steps.size),
        outChapters: [...chapters.values()].filter((steps) => steps.has("out")).length,
        ...error,
      }),
    };
  });
  const weightTotal = QUANT_SUBJECTS.reduce((sum, subject) => sum + QUANT_WEIGHTS[subject], 0);
  const balanced = Math.round(subjects.reduce((sum, subject) => sum + subject.weight * subject.ability, 0) / weightTotal);
  const weakest = subjects.reduce((current, subject) => subject.ability < current.ability ? subject : current, subjects[0]);
  const proIndex = Math.round(0.7 * balanced + 0.3 * weakest.ability);
  const notStarted = subjects.filter((subject) => subject.covered === 0 && subject.open === 0 && subject.absorbed === 0).length;

  const englishLogs = logs.filter((row) => row.subject === "英语");
  const accuracies = englishLogs.filter((row) => row.accuracy != null && !/作文/.test(String(row.chapter ?? ""))).slice(0, 8).map((row) => Number(row.accuracy));
  const day14 = minusDays(referenceDate, 14);
  const day30 = minusDays(referenceDate, 30);
  const papers14d = englishLogs.filter((row) => String(row.log_date) >= day14 && !/作文/.test(String(row.chapter ?? ""))).length;
  const essays30d = englishLogs.filter((row) => String(row.log_date) >= day30 && /作文/.test(String(row.chapter ?? ""))).length;
  const englishErrors = errorBySubject.get("英语") ?? { open: 0, absorbed: 0, repeat: 0 };
  const english = scoreEnglishV3({ accs: accuracies, papers14d, essays30d, ...englishErrors });
  const index = Math.round(0.75 * proIndex + 0.25 * english.ability);

  return {
    version: QUANT_V3_VERSION,
    referenceDate,
    subjects,
    overall: {
      index,
      proIndex,
      balanced,
      weakest: { subject: weakest.subject, ability: weakest.ability },
      notStarted,
      english,
    },
  };
}
