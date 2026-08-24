// [gpt] 2026-08-10：yingyu-pc 英语成长系统纯函数。
// 只从结构化训练证据派生画像、调度与作文装配，不把篇级正确率或叙事备注脑补成能力。

import { createHash } from "node:crypto";

export const ENGLISH_GROWTH_SCHEMA_VERSION = 1;

export const ENGLISH_TRACKS = Object.freeze({
  reading: Object.freeze({
    kind: "阅读",
    label: "阅读提准",
    stages: ["attempt"],
    dimensions: Object.freeze([
      { key: "locating", label: "定位句锁定", aliases: ["定位", "定位句", "定位句锁定"], importance: 1 },
      { key: "paraphrase", label: "同义改写识别", aliases: ["改写", "同义改写", "同义改写识别"], importance: 1 },
      { key: "scopeDegree", label: "范围与程度词", aliases: ["范围程度", "范围与程度", "范围/程度", "程度词"], importance: 0.95 },
      { key: "attribution", label: "主体与观点归属", aliases: ["观点归属", "主体归属", "主体与观点归属"], importance: 0.85 },
      { key: "inferenceBoundary", label: "推理边界", aliases: ["推理", "推理边界"], importance: 0.95 },
      { key: "sentenceAttachment", label: "长句碎块归属", aliases: ["长句归属", "碎块归属", "长句碎块归属"], importance: 0.75 },
      { key: "confidenceCalibration", label: "置信校准", aliases: ["置信", "置信校准", "信心校准"], importance: 0.8 },
    ]),
  }),
  essay: Object.freeze({
    kind: "作文",
    label: "作文产出",
    stages: ["draft", "rewrite"],
    dimensions: Object.freeze([
      { key: "taskCompletion", label: "任务要素完整", aliases: ["任务完整", "要素完整", "任务要素完整"], importance: 1 },
      { key: "carrierHandling", label: "载体处理", aliases: ["载体", "载体处理"], importance: 0.9 },
      { key: "structure", label: "结构组织", aliases: ["结构", "结构组织"], importance: 0.85 },
      { key: "reasoning", label: "论证展开", aliases: ["论证", "论证展开", "理由展开"], importance: 0.9 },
      { key: "languageAccuracy", label: "语言准确", aliases: ["语言", "语言准确", "语言准确度"], importance: 0.95 },
      { key: "corpusRetrieval", label: "个人语料调用", aliases: ["语料", "语料调用", "个人语料调用"], importance: 0.75 },
    ]),
  }),
});

export const ENGLISH_GATES = Object.freeze([
  { key: "timing", label: "限时完成", aliases: ["限时", "限时完成"] },
  { key: "checklist", label: "要素清单", aliases: ["要素清单", "清单回扫"] },
]);

// [gpt] 2026-08-13：生命周期决定“练什么能力”，篇目分配必须另外给出可执行的年份/Text。
export function selectNextReadingAssignment(studyRows = [], { firstYear = 2016, lastYear = 2024 } = {}) {
  const completed = new Set();
  for (const row of studyRows) {
    if (row.subject && row.subject !== "英语") continue;
    const match = String(row.chapter ?? "").match(/(20\d{2})\s*Text\s*([1-4])/iu);
    if (match) completed.add(`${match[1]}-T${Number(match[2])}`);
  }
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (let text = 1; text <= 4; text += 1) {
      const key = `${year}-T${text}`;
      if (!completed.has(key)) return { year, text, key, label: `${year} Text ${text}` };
    }
  }
  return null;
}

const DIAGNOSTIC_SOURCES = new Map([
  ["答案键+原文", "answer_key"],
  ["答案键＋原文", "answer_key"],
  ["考研评分档", "exam_rubric"],
  ["用户指定标准", "user_standard"],
  ["用户指定答案", "user_standard"],
  ["估分", "estimated"],
]);

const OUTCOMES = new Map([
  ["pass", "pass"], ["通过", "pass"],
  ["partial", "partial"], ["部分", "partial"],
  ["fail", "fail"], ["未通过", "fail"],
  ["na", "na"], ["n/a", "na"], ["不适用", "na"],
]);

const CARRIER_ALIASES = new Map([
  ["cartoon", "cartoon"], ["漫画", "cartoon"], ["漫画型", "cartoon"],
  ["chart", "chart"], ["图表", "chart"], ["表格", "chart"], ["图表型", "chart"],
  ["reply", "reply"], ["回信", "reply"], ["回信型", "reply"],
  ["invitation", "invitation"], ["邀请", "invitation"], ["邀请型", "invitation"],
  ["recommendation", "recommendation"], ["建议", "recommendation"], ["推荐", "recommendation"],
  ["notice", "notice"], ["通知", "notice"], ["招聘", "notice"],
]);

const CARRIER_SECTIONS = Object.freeze({
  cartoon: ["A1", "A2", "C1", "C2", "C3", "C4"],
  chart: ["B1", "B2", "C1", "C2", "C3", "C4"],
  reply: ["E1", "E2"],
  invitation: ["E1", "E3"],
  recommendation: ["E1", "E4"],
  notice: ["E1", "E5"],
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function warning(code, line, message) {
  return { severity: "warning", code, line, message };
}

function field(body, label) {
  const match = String(body ?? "").match(new RegExp(`^-\\s*\\*\\*${escapeRegex(label)}\\*\\*[：:]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function splitCells(value) {
  return normalizeText(value).split(/\s*[｜|]\s*/).map((item) => item.trim()).filter(Boolean);
}

function normalizeOutcome(value) {
  return OUTCOMES.get(normalizeText(value).toLowerCase()) ?? null;
}

function parseRatingCells(raw, definitions, { line, stage }) {
  const values = {};
  const notApplicable = [];
  const issues = [];
  if (raw == null) return { values, notApplicable, issues };
  const aliases = new Map(definitions.flatMap((item) => item.aliases.map((alias) => [normalizeText(alias), item])));
  for (const cell of splitCells(raw)) {
    const match = cell.match(/^([^=＝]+)[=＝](.+)$/);
    if (!match) {
      issues.push(warning("invalid_english_dimension", line, `${stage}能力观测格式无效：${cell}`));
      continue;
    }
    const definition = aliases.get(normalizeText(match[1]));
    if (!definition) {
      issues.push(warning("unknown_english_dimension", line, `${stage}未知能力维度：${normalizeText(match[1])}`));
      continue;
    }
    if (Object.hasOwn(values, definition.key) || notApplicable.includes(definition.key)) {
      issues.push(warning("duplicate_english_dimension", line, `${stage}能力维度重复：${definition.label}`));
      continue;
    }
    const value = normalizeText(match[2]);
    if (/^(na|n\/a|不适用)$/i.test(value)) {
      notApplicable.push(definition.key);
      continue;
    }
    const score = value.match(/^([0-4])\s*\/\s*4$/)?.[1];
    if (score == null) {
      issues.push(warning("invalid_english_dimension_score", line, `${definition.label} 必须写 0/4 至 4/4 或 NA`));
      continue;
    }
    values[definition.key] = Number(score);
  }
  return { values, notApplicable, issues };
}

function parseGateCells(raw, { line, stage }) {
  const values = {};
  const issues = [];
  if (raw == null) return { values, issues };
  const aliases = new Map(ENGLISH_GATES.flatMap((item) => item.aliases.map((alias) => [normalizeText(alias), item])));
  for (const cell of splitCells(raw)) {
    const match = cell.match(/^([^=＝]+)[=＝](.+)$/);
    if (!match) {
      issues.push(warning("invalid_english_gate", line, `${stage}门槛观测格式无效：${cell}`));
      continue;
    }
    const gate = aliases.get(normalizeText(match[1]));
    const outcome = normalizeOutcome(match[2]);
    if (!gate) issues.push(warning("unknown_english_gate", line, `${stage}未知门槛：${normalizeText(match[1])}`));
    else if (!outcome) issues.push(warning("invalid_english_gate_outcome", line, `${gate.label} 只允许 pass/partial/fail/NA`));
    else if (Object.hasOwn(values, gate.key)) issues.push(warning("duplicate_english_gate", line, `${stage}门槛重复：${gate.label}`));
    else values[gate.key] = outcome;
  }
  return { values, issues };
}

function parsePhraseUsages(raw, line) {
  if (raw == null || /^(无|none|-)$/i.test(normalizeText(raw))) return { values: [], issues: [] };
  const values = [];
  const issues = [];
  for (const cell of splitCells(raw)) {
    const match = cell.match(/^([A-Z0-9-]+)[=＝](pass|partial|fail)$/i);
    if (!match) {
      issues.push(warning("invalid_english_phrase_usage", line, `语料调用必须写 句子ID=pass|partial|fail：${cell}`));
      continue;
    }
    values.push({ phraseId: match[1].toUpperCase(), result: match[2].toLowerCase() });
  }
  return { values, issues };
}

function parseScore(raw, line) {
  if (raw == null) return { value: null, issues: [] };
  const match = normalizeText(raw).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[2]) <= 0 || Number(match[1]) > Number(match[2])) {
    return { value: null, issues: [warning("invalid_english_score", line, `得分必须写成 4/5、7/10 或 15/20：${raw}`)] };
  }
  return { value: { earned: Number(match[1]), maximum: Number(match[2]) }, issues: [] };
}

function headingRecord(line, index) {
  const match = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*[｜|]\s*(阅读|作文)\s*[｜|]\s*(.+?)\s*$/);
  if (!match) return null;
  return { date: match[1], kind: match[2], title: match[3].trim(), line: index + 1 };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseEnglishLedger(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*```/.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      const heading = headingRecord(lines[index], index);
      if (heading) headings.push({ ...heading, index });
    }
  }
  const practices = [];
  const issues = [];
  const sessionKeys = new Map();
  for (let position = 0; position < headings.length; position += 1) {
    const heading = headings[position];
    const end = headings[position + 1]?.index ?? lines.length;
    const body = lines.slice(heading.index + 1, end).join("\n");
    const trackKey = heading.kind === "阅读" ? "reading" : "essay";
    const track = ENGLISH_TRACKS[trackKey];
    if (!validDate(heading.date)) issues.push(warning("invalid_english_practice_date", heading.line, `训练日期无效：${heading.date}`));
    const sessionKey = normalizeText(field(body, "会话键")) || null;
    if (!sessionKey) issues.push(warning("missing_english_session_key", heading.line, `${heading.title} 缺少会话键`));
    else if (sessionKeys.has(sessionKey)) issues.push(warning("duplicate_english_session_key", heading.line, `会话键 ${sessionKey} 与第 ${sessionKeys.get(sessionKey)} 行重复`));
    else sessionKeys.set(sessionKey, heading.line);

    const sourceRaw = normalizeText(field(body, "诊断依据"));
    const diagnosticSource = sourceRaw ? DIAGNOSTIC_SOURCES.get(sourceRaw) ?? null : null;
    if (sourceRaw && !diagnosticSource) issues.push(warning("invalid_english_diagnostic_source", heading.line, `未知诊断依据：${sourceRaw}`));
    if (trackKey === "reading" && diagnosticSource && diagnosticSource !== "answer_key") {
      issues.push(warning("unsafe_reading_diagnostic_source", heading.line, "阅读能力观测必须以答案键+原文为依据"));
    }

    const dimensions = {};
    const notApplicable = {};
    const gates = {};
    for (const stage of track.stages) {
      const stageLabel = trackKey === "reading" ? "本次" : stage === "draft" ? "首稿" : "重写";
      const ratingLabel = trackKey === "reading" ? "能力观测" : `能力观测·${stageLabel}`;
      const gateLabel = trackKey === "reading" ? "门槛观测" : `门槛观测·${stageLabel}`;
      const parsedRatings = parseRatingCells(field(body, ratingLabel), track.dimensions, { line: heading.line, stage: stageLabel });
      const parsedGates = parseGateCells(field(body, gateLabel), { line: heading.line, stage: stageLabel });
      dimensions[stage] = parsedRatings.values;
      notApplicable[stage] = parsedRatings.notApplicable;
      gates[stage] = parsedGates.values;
      issues.push(...parsedRatings.issues, ...parsedGates.issues);
    }
    const hasObservations = Object.values(dimensions).some((values) => Object.keys(values).length > 0)
      || Object.values(gates).some((values) => Object.keys(values).length > 0);
    if (hasObservations && !diagnosticSource) issues.push(warning("missing_english_diagnostic_source", heading.line, `${heading.title} 有结构化观测但没有诊断依据`));

    const phraseUsage = parsePhraseUsages(field(body, "语料调用"), heading.line);
    const score = parseScore(field(body, "得分"), heading.line);
    issues.push(...phraseUsage.issues, ...score.issues);
    let carrier = null;
    try {
      carrier = normalizeCarrier(field(body, "载体"), { allowNull: true });
    } catch (error) {
      issues.push(warning("invalid_english_carrier", heading.line, error instanceof Error ? error.message : String(error)));
    }
    practices.push({
      schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION,
      date: heading.date,
      line: heading.line,
      kind: trackKey,
      title: heading.title,
      sessionKey,
      diagnosticSource,
      carrier,
      score: score.value,
      minutes: Number(field(body, "用时")) || null,
      dimensions,
      notApplicable,
      gates,
      phraseUsages: phraseUsage.values,
      evidence: field(body, "证据锚点"),
      lifecycle: field(body, "生命周期动作"),
      defects: field(body, "三病根"),
    });
  }
  return { schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION, practices, issues };
}

function confidence(samples) {
  if (samples === 0) return "none";
  if (samples < 3) return "insufficient";
  if (samples < 5) return "provisional";
  return "stable";
}

function roundedPercent(total, count, maximum = 4) {
  return count ? Math.round((total / count / maximum) * 100) : null;
}

function summarizeRatings(observations) {
  const sorted = [...observations].sort((left, right) => left.date.localeCompare(right.date) || left.line - right.line);
  const samples = sorted.length;
  const observedPercent = roundedPercent(sorted.reduce((sum, item) => sum + item.value, 0), samples);
  let trendDelta = null;
  if (samples >= 6) {
    const previous = sorted.slice(-6, -3);
    const recent = sorted.slice(-3);
    trendDelta = roundedPercent(recent.reduce((sum, item) => sum + item.value, 0), recent.length)
      - roundedPercent(previous.reduce((sum, item) => sum + item.value, 0), previous.length);
  }
  return {
    samples,
    observedPercent,
    qualifiedPercent: samples >= 3 ? observedPercent : null,
    confidence: confidence(samples),
    trendDelta,
    lastObservedOn: sorted.at(-1)?.date ?? null,
  };
}

function summarizeOutcomes(observations) {
  const relevant = observations.filter((item) => item.outcome !== "na");
  const counts = Object.fromEntries(["pass", "partial", "fail"].map((outcome) => [outcome, relevant.filter((item) => item.outcome === outcome).length]));
  const observedPercent = relevant.length ? Math.round(((counts.pass + counts.partial * 0.5) / relevant.length) * 100) : null;
  return {
    samples: relevant.length,
    counts,
    observedPercent,
    qualifiedPercent: relevant.length >= 3 ? observedPercent : null,
    confidence: confidence(relevant.length),
    lastObservedOn: [...relevant].sort((left, right) => left.date.localeCompare(right.date) || left.line - right.line).at(-1)?.date ?? null,
  };
}

function buildStageProfile(practices, track, stage) {
  const dimensions = {};
  for (const definition of track.dimensions) {
    const observations = practices.flatMap((practice) => Object.hasOwn(practice.dimensions[stage] ?? {}, definition.key) ? [{
      date: practice.date,
      line: practice.line,
      title: practice.title,
      value: practice.dimensions[stage][definition.key],
      diagnosticSource: practice.diagnosticSource,
    }] : []);
    dimensions[definition.key] = { label: definition.label, importance: definition.importance, ...summarizeRatings(observations) };
  }
  const gates = {};
  for (const gate of ENGLISH_GATES) {
    const observations = practices.flatMap((practice) => Object.hasOwn(practice.gates[stage] ?? {}, gate.key) ? [{
      date: practice.date,
      line: practice.line,
      outcome: practice.gates[stage][gate.key],
    }] : []);
    gates[gate.key] = { label: gate.label, ...summarizeOutcomes(observations) };
  }
  return {
    observedPractices: practices.filter((practice) => Object.keys(practice.dimensions[stage] ?? {}).length > 0).length,
    qualified: track.dimensions.every((definition) => dimensions[definition.key].samples >= 3),
    dimensions,
    gates,
  };
}

function stagePriorities(trackKey, stageProfile) {
  const track = ENGLISH_TRACKS[trackKey];
  const weaknesses = [];
  const evidenceGaps = [];
  for (const definition of track.dimensions) {
    const summary = stageProfile.dimensions[definition.key];
    const base = { track: trackKey, dimension: definition.key, label: definition.label, importance: definition.importance, ...summary };
    if (summary.qualifiedPercent != null) {
      weaknesses.push({ ...base, priority: Math.round((100 - summary.qualifiedPercent) * definition.importance) });
    } else {
      evidenceGaps.push({ ...base, missingSamples: Math.max(0, 3 - summary.samples), priority: Math.round(60 * definition.importance + (3 - summary.samples) * 5) });
    }
  }
  weaknesses.sort((left, right) => right.priority - left.priority || left.qualifiedPercent - right.qualifiedPercent || right.importance - left.importance);
  evidenceGaps.sort((left, right) => right.priority - left.priority || right.importance - left.importance || left.samples - right.samples);
  return { weaknesses, evidenceGaps };
}

export function buildEnglishCapabilityProfile(parsed) {
  const practices = parsed?.practices ?? [];
  const readingPractices = practices.filter((practice) => practice.kind === "reading");
  const essayPractices = practices.filter((practice) => practice.kind === "essay");
  const readingAttempt = buildStageProfile(readingPractices, ENGLISH_TRACKS.reading, "attempt");
  const essayDraft = buildStageProfile(essayPractices, ENGLISH_TRACKS.essay, "draft");
  const essayRewrite = buildStageProfile(essayPractices, ENGLISH_TRACKS.essay, "rewrite");
  return {
    schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION,
    internalOnly: true,
    policy: "能力只从显式结构化观测派生；样本不足时拒绝给正式百分比。",
    scale: { min: 0, max: 4, anchors: { 0: "未出现或方向错误", 1: "有痕迹但主干错误", 2: "部分完成且缺关键环", 3: "基本正确但有小遗漏", 4: "完整准确且可稳定复现" } },
    sampleGate: { qualified: 3, stable: 5, trend: 6 },
    tracks: {
      reading: { key: "reading", label: ENGLISH_TRACKS.reading.label, attempt: readingAttempt },
      essay: { key: "essay", label: ENGLISH_TRACKS.essay.label, draft: essayDraft, rewrite: essayRewrite },
    },
    priorities: {
      reading: stagePriorities("reading", readingAttempt),
      essay: stagePriorities("essay", essayDraft),
    },
    issues: parsed?.issues ?? [],
  };
}

function phraseId(sectionId, text) {
  const digest = createHash("sha256").update(`${sectionId}\n${normalizeText(text)}`).digest("hex").slice(0, 8).toUpperCase();
  return `${sectionId}-${digest}`;
}

function sectionCarrier(sectionId) {
  if (sectionId.startsWith("A")) return ["cartoon"];
  if (sectionId.startsWith("B")) return ["chart"];
  if (sectionId.startsWith("C") || sectionId.startsWith("D")) return ["cartoon", "chart"];
  return ({ E1: ["reply", "invitation", "recommendation", "notice"], E2: ["reply"], E3: ["invitation"], E4: ["recommendation"], E5: ["notice"] })[sectionId] ?? [];
}

function themeForSection(sectionId) {
  if (sectionId === "D1") return "d1";
  if (sectionId === "D2") return "d2";
  return "general";
}

function collectBulletBlocks(lines, start, end) {
  const blocks = [];
  let current = null;
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^\s*-\s*(.*)$/);
    if (match) {
      if (current) blocks.push(current);
      const marker = match[1].match(/(🌱|✅)/)?.[1] ?? null;
      const first = normalizeText(marker ? match[1].replace(marker, "") : match[1]);
      current = { marker, first, lines: [first], line: index + 1 };
    } else if (current) {
      if (/^\s*(?:#{1,6}\s|---\s*$)/.test(lines[index])) {
        blocks.push(current);
        current = null;
      } else {
        current.lines.push(lines[index]);
      }
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function parseEnglishCorpus(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+([A-E]\d)\.\s*(.+)$/);
    if (match) sections.push({ id: match[1], title: match[2].trim(), index, line: index + 1 });
  }
  const phrases = [];
  const themeTerms = { d1: [], d2: [] };
  const issues = [];
  for (let position = 0; position < sections.length; position += 1) {
    const section = sections[position];
    const end = sections[position + 1]?.index ?? lines.length;
    const blocks = collectBulletBlocks(lines, section.index + 1, end);
    for (const block of blocks) {
      if (!block.marker && section.id !== "E1") continue;
      if (/待填|云的句子填这里/.test(block.lines.join(" "))) continue;
      const codeSpans = [...block.lines.join("\n").matchAll(/`([^`]+)`/g)].map((match) => normalizeText(match[1])).filter(Boolean);
      if (!codeSpans.length) continue;
      for (const text of codeSpans) {
        phrases.push({
          id: phraseId(section.id, text),
          sectionId: section.id,
          sectionTitle: section.title,
          status: section.id === "E1" && !block.marker ? "fixed" : block.marker === "✅" ? "owned" : "seed",
          text,
          label: normalizeText(block.first.replace(/`[^`]+`/g, "").replace(/[（(].*$/, "")) || section.title,
          carriers: sectionCarrier(section.id),
          theme: themeForSection(section.id),
          line: block.line,
        });
      }
    }
    if (section.id === "D1" || section.id === "D2") {
      const key = section.id.toLowerCase();
      const content = lines.slice(section.index + 1, end)
        .filter((line) => line.trim() && !/^\s*[>#-]/.test(line))
        .join(" ");
      themeTerms[key] = [...new Set(content.split(/\s*\/\s*/).map((item) => normalizeText(item)).filter((item) => item && item.length < 80))];
    }
  }
  const duplicateIds = phrases.filter((phrase, index) => phrases.findIndex((item) => item.id === phrase.id) !== index);
  for (const phrase of duplicateIds) issues.push(warning("duplicate_english_phrase", phrase.line, `语料重复生成同一ID：${phrase.id}`));
  return { schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION, sections, phrases, themeTerms, issues };
}

export function annotateCorpusUsage(corpus, practices = []) {
  const usage = new Map();
  for (const practice of practices) {
    for (const item of practice.phraseUsages ?? []) {
      const current = usage.get(item.phraseId) ?? { uses: 0, pass: 0, partial: 0, fail: 0, lastUsedOn: null };
      current.uses += 1;
      current[item.result] += 1;
      if (!current.lastUsedOn || practice.date > current.lastUsedOn) current.lastUsedOn = practice.date;
      usage.set(item.phraseId, current);
    }
  }
  const phraseIds = new Set((corpus?.phrases ?? []).map((phrase) => phrase.id));
  const issues = [...(corpus?.issues ?? [])];
  for (const [id] of usage) if (!phraseIds.has(id)) issues.push(warning("unknown_english_phrase_usage", 0, `训练台账引用了语料库中不存在的ID：${id}`));
  const phrases = (corpus?.phrases ?? []).map((phrase) => {
    const stats = usage.get(phrase.id) ?? { uses: 0, pass: 0, partial: 0, fail: 0, lastUsedOn: null };
    return {
      ...phrase,
      usage: stats,
      effectiveStatus: phrase.status === "fixed" ? "fixed" : phrase.status === "owned" ? "owned" : stats.uses > 0 ? "used" : "seed",
    };
  });
  return { ...corpus, phrases, issues };
}

export function normalizeCarrier(value, { allowNull = false } = {}) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw && allowNull) return null;
  const carrier = CARRIER_ALIASES.get(raw);
  if (!carrier) throw new Error(`未知作文载体「${value ?? "空"}」；可用：cartoon/chart/reply/invitation/recommendation/notice`);
  return carrier;
}

function weakestEssayDimension(profile) {
  return profile?.priorities?.essay?.weaknesses?.[0] ?? profile?.priorities?.essay?.evidenceGaps?.[0] ?? null;
}

function phraseRank(phrase) {
  return { fixed: 4, owned: 3, used: 2, seed: 1 }[phrase.effectiveStatus ?? phrase.status] ?? 0;
}

export function buildCompositionKit({ carrier, theme = "d2", requirements = [], corpus, profile, maxPhrases = 5 }) {
  const normalizedCarrier = normalizeCarrier(carrier);
  const normalizedTheme = ["d1", "d2", "general"].includes(String(theme).toLowerCase()) ? String(theme).toLowerCase() : "d2";
  const requiredSections = CARRIER_SECTIONS[normalizedCarrier];
  const annotated = corpus?.phrases?.[0]?.effectiveStatus ? corpus : annotateCorpusUsage(corpus, []);
  const candidates = (annotated?.phrases ?? [])
    .filter((phrase) => phrase.carriers.includes(normalizedCarrier) && (requiredSections.includes(phrase.sectionId) || phrase.sectionId === "D3"))
    .sort((left, right) => phraseRank(right) - phraseRank(left)
      || right.usage.pass - left.usage.pass
      || left.sectionId.localeCompare(right.sectionId)
      || left.id.localeCompare(right.id));
  const selected = [];
  const sectionCounts = new Map();
  for (const phrase of candidates) {
    if (selected.length >= maxPhrases) break;
    if ((sectionCounts.get(phrase.sectionId) ?? 0) >= 2) continue;
    selected.push(phrase);
    sectionCounts.set(phrase.sectionId, (sectionCounts.get(phrase.sectionId) ?? 0) + 1);
  }
  const checklist = requirements.map((item, index) => ({ id: `R${index + 1}`, text: normalizeText(item), required: true })).filter((item) => item.text);
  const blockers = [];
  if (["reply", "invitation", "recommendation", "notice"].includes(normalizedCarrier) && checklist.length === 0) {
    blockers.push("未提供题干必须回应的要素，不能生成可靠的小作文 checklist");
  }
  if (!selected.some((phrase) => phrase.effectiveStatus === "owned")) blockers.push("当前没有适配本题的✅个人句；本次只能调用已用句或🌱种子，不能冒充个人模板");
  const weak = weakestEssayDimension(profile);
  const constraintByDimension = {
    taskCompletion: "写前逐项圈题干要求，写后按 checklist 回扫，漏一项即不通过",
    carrierHandling: "首段只完成本载体规定动作，不借通用开头绕开图画、数据或来信",
    structure: "每段只承担一个功能，先写段落任务再落句",
    reasoning: "观点后至少补一层原因或例证，不用空泛口号收段",
    languageAccuracy: "本次最多引入1个新种子句，其余优先调用写熟表达，先保准确",
    corpusRetrieval: "至少主动调用1个✅或已用表达，并在交卷后记录句子ID",
  };
  return {
    schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION,
    policy: "只提供要素清单、功能骨架和个人语料；首稿前禁止生成完整范文。",
    carrier: normalizedCarrier,
    theme: normalizedTheme,
    checklist,
    outline: requiredSections.map((sectionId) => ({ sectionId, title: annotated.sections.find((section) => section.id === sectionId)?.title ?? sectionId })),
    phrases: selected,
    readingTransfer: (annotated?.phrases ?? [])
      .filter((phrase) => phrase.sectionId === "D3" && phrase.carriers.includes(normalizedCarrier))
      .sort((left, right) => phraseRank(right) - phraseRank(left) || right.usage.pass - left.usage.pass || left.id.localeCompare(right.id))[0] ?? null,
    themeTerms: annotated.themeTerms?.[normalizedTheme] ?? [],
    trainingConstraint: weak ? { dimension: weak.dimension, label: weak.label, instruction: constraintByDimension[weak.dimension] ?? "本次只修一个最弱能力，交卷后留结构化证据" } : null,
    blockers,
  };
}

function isDue(date, referenceDate) {
  return validDate(date) && date <= referenceDate;
}

export function buildEnglishTrainingPlan({ profile, lifecycle = [], corpus, referenceDate, essayDue = false }) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是有效的 YYYY-MM-DD 北京日");
  const candidates = [];
  for (const item of lifecycle) {
    if (item.computedMasteryStatus === "stable" || item.status === "stable") continue;
    const earliestDate = item.nextProbe?.earliestDate ?? item.earliestDate ?? null;
    if (!isDue(earliestDate, referenceDate)) continue;
    const essayLike = /作文|写作|要素|结构|表达/.test(item.title ?? "");
    candidates.push({
      priority: 100,
      kind: "lifecycle_review",
      track: essayLike ? "essay" : "reading",
      target: item.title,
      topicId: item.topicId ?? item.id ?? null,
      reason: `长期弱项已到复检日 ${earliestDate}，先取得无提示迁移证据`,
      evidenceRequired: item.nextProbe ? `${item.nextProbe.variantKind}/L${item.nextProbe.transferLevel}｜${item.nextProbe.probeAxis}` : "clean application L3+",
    });
  }
  const addProfileCandidate = (track, source, basePriority, kind) => {
    const item = source?.[0];
    if (!item) return;
    candidates.push({
      priority: basePriority + Math.min(20, item.priority ?? 0),
      kind,
      track,
      target: item.label,
      dimension: item.dimension,
      reason: kind === "targeted_training"
        ? `${item.confidence} 画像显示 ${item.label} 仅 ${item.qualifiedPercent}%`
        : `${item.label} 只有 ${item.samples} 个样本，还差 ${item.missingSamples} 个才允许正式判断`,
      evidenceRequired: "一次有答案/评分依据、无预输入的结构化观测",
    });
  };
  addProfileCandidate("reading", profile?.priorities?.reading?.weaknesses, 65, "targeted_training");
  addProfileCandidate("essay", profile?.priorities?.essay?.weaknesses, essayDue ? 72 : 55, "targeted_training");
  addProfileCandidate("reading", profile?.priorities?.reading?.evidenceGaps, 45, "evidence_probe");
  if (essayDue) addProfileCandidate("essay", profile?.priorities?.essay?.evidenceGaps, 70, "evidence_probe");

  const ownedCount = (corpus?.phrases ?? []).filter((phrase) => (phrase.effectiveStatus ?? phrase.status) === "owned").length;
  if (essayDue && ownedCount === 0) {
    candidates.push({
      priority: 95,
      kind: "essay_bootstrap",
      track: "essay",
      target: "产出第一批✅个人句",
      reason: "作文锚点已到且语料库仍无✅个人句；继续只攒种子不会形成22分产出能力",
      evidenceRequired: "完成一篇首稿、评分、最多3个病根、至少1个改后个人句",
    });
  }
  candidates.push({
    priority: 20,
    kind: "maintenance",
    track: "reading",
    target: "顺序精刷保温",
    reason: "没有更高优先级英语任务时维持手感，不清零",
    evidenceRequired: "17-18分钟完成一篇并补齐能力观测",
  });
  candidates.sort((left, right) => right.priority - left.priority || left.track.localeCompare(right.track) || left.target.localeCompare(right.target));
  return {
    schemaVersion: ENGLISH_GROWTH_SCHEMA_VERSION,
    referenceDate,
    policy: "到期迁移证据优先；其后处理高置信弱项，再补关键证据缺口。英语内部计划不得覆盖总盘P0。",
    selected: candidates[0],
    alternatives: candidates.slice(1, 4),
    candidates,
  };
}

function formatDimension(item) {
  const score = item.qualifiedPercent == null ? `样本 ${item.samples}/3` : `${item.qualifiedPercent}%`;
  const trend = item.trendDelta == null ? "" : `｜近6次趋势 ${item.trendDelta >= 0 ? "+" : ""}${item.trendDelta}`;
  return `${item.label} ${score}（${item.confidence}）${trend}`;
}

export function formatEnglishCapabilityProfile(profile) {
  const reading = profile.tracks.reading.attempt;
  const essay = profile.tracks.essay.draft;
  const lines = [
    `英语能力画像（schema v${profile.schemaVersion}｜只认结构化观测）`,
    `阅读：${reading.observedPractices} 篇有画像证据｜作文首稿：${essay.observedPractices} 篇有画像证据`,
  ];
  const readingWeak = profile.priorities.reading.weaknesses[0];
  const readingGap = profile.priorities.reading.evidenceGaps[0];
  const essayWeak = profile.priorities.essay.weaknesses[0];
  const essayGap = profile.priorities.essay.evidenceGaps[0];
  lines.push(`阅读靶心：${readingWeak ? formatDimension(readingWeak) : readingGap ? `${readingGap.label} 样本 ${readingGap.samples}/3（先补证据）` : "暂无"}`);
  lines.push(`作文靶心：${essayWeak ? formatDimension(essayWeak) : essayGap ? `${essayGap.label} 样本 ${essayGap.samples}/3（先补证据）` : "暂无"}`);
  if (profile.issues.length) lines.push(`⚠️ 台账告警 ${profile.issues.length} 条：${profile.issues.slice(0, 3).map((item) => item.message).join("；")}`);
  return lines.join("\n");
}

export function formatEnglishTrainingPlan(plan) {
  const item = plan.selected;
  const lines = [
    `英语下一训练（北京 ${plan.referenceDate}）`,
    `首选：${item.track === "reading" ? "阅读" : "作文"}｜${item.target}`,
    `理由：${item.reason}`,
    `验收：${item.evidenceRequired}`,
  ];
  if (plan.alternatives.length) lines.push(`备选：${plan.alternatives.map((candidate) => `${candidate.track === "reading" ? "阅读" : "作文"}-${candidate.target}`).join("；")}`);
  return lines.join("\n");
}

export function formatCompositionKit(kit) {
  const lines = [
    `作文个人装配包｜${kit.carrier}｜主题 ${kit.theme}`,
    kit.policy,
    `要素清单：${kit.checklist.length ? kit.checklist.map((item) => `${item.id}.${item.text}`).join("；") : "未提供"}`,
    `功能骨架：${kit.outline.map((item) => `${item.sectionId} ${item.title}`).join(" → ")}`,
    `个人语料：${kit.phrases.length ? kit.phrases.map((phrase) => `${phrase.id}[${phrase.effectiveStatus ?? phrase.status}] ${phrase.text}`).join("\n  ") : "暂无可调用句"}`,
  ];
  if (kit.readingTransfer) lines.push(`阅读迁移候选：${kit.readingTransfer.id}[${kit.readingTransfer.effectiveStatus ?? kit.readingTransfer.status}] ${kit.readingTransfer.text}`);
  if (kit.themeTerms.length) lines.push(`主题弹药：${kit.themeTerms.slice(0, 8).join(" / ")}`);
  if (kit.trainingConstraint) lines.push(`本篇专项：${kit.trainingConstraint.label}｜${kit.trainingConstraint.instruction}`);
  if (kit.blockers.length) lines.push(`⚠️ ${kit.blockers.join("；")}`);
  return lines.join("\n");
}
