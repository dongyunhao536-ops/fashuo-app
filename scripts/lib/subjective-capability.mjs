// [gpt] 2026-08-10：lunshu-pc 内部能力画像与跨科病灶传播分析；只聚合结构化观测，不从散文或总分脑补。

export const SUBJECTIVE_CAPABILITY_SCHEMA_VERSION = 1;

export const SUBJECTIVE_ROOT_CAPABILITIES = Object.freeze({
  C1: { label: "规则—材料桥接", description: "把抽象规则、理论或要件明确扣到材料与事实" },
  C2: { label: "完整性扫描与落卷", description: "识别全部答题线索，并把草稿中的有效点完整写入答卷" },
  C3: { label: "理由链展开", description: "不只给标签或结论，能够写出成立理由与推理链" },
  C4: { label: "术语与指代精度", description: "概念、罪名、人名、财物流向和法律性质保持准确稳定" },
  C5: { label: "任务层级识别", description: "识别设问究竟要求概念、构成、处断、评价还是结合" },
  C6: { label: "考场执行与回扫", description: "在时限内完成结构、字数和交卷前检查" },
});

const TRACKS = Object.freeze({
  essay: {
    kind: "论述",
    label: "法综·论述",
    dimensions: [
      { key: "concept", label: "概念准确", aliases: ["概念", "概念准确", "概念准确度"] },
      { key: "structure", label: "结构完整", aliases: ["结构", "结构完整", "结构完整度"] },
      { key: "theory", label: "理论展开", aliases: ["理论", "理论展开"] },
      { key: "integration", label: "结合落地", aliases: ["结合", "结合能力", "结合落地"] },
    ],
  },
  case: {
    kind: "案例",
    label: "专基·案例",
    dimensions: [
      { key: "classification", label: "定性覆盖", aliases: ["定性", "定性覆盖", "定性准确"] },
      { key: "rule", label: "规则准确", aliases: ["规则", "规则引用", "规则准确", "规则援引"] },
      { key: "subsumption", label: "事实涵摄", aliases: ["涵摄", "事实涵摄"] },
      { key: "closure", label: "处断收口", aliases: ["收口", "收口完整", "处断收口"] },
    ],
  },
});

const GATES = Object.freeze([
  { key: "taskLevel", label: "设问层", aliases: ["设问层", "任务层级"] },
  { key: "timingReview", label: "时限回扫", aliases: ["时限回扫", "时间回扫", "考场执行"] },
]);

const SUBJECTS = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const DIAGNOSTIC_SOURCES = new Map([
  ["用户标准", "user"],
  ["用户指定", "user"],
  ["官方答案", "official"],
  ["估分", "estimated"],
]);
const OUTCOMES = new Map([
  ["pass", "pass"],
  ["通过", "pass"],
  ["partial", "partial"],
  ["部分", "partial"],
  ["fail", "fail"],
  ["未通过", "fail"],
  ["na", "na"],
  ["n/a", "na"],
  ["不适用", "na"],
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boldField(body, label) {
  const match = String(body ?? "").match(new RegExp(`^-\\s*\\*\\*${escapeRegex(label)}\\*\\*[：:]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function cells(raw) {
  return String(raw ?? "").split(/\s*[｜|]\s*/).map((cell) => cell.trim()).filter(Boolean);
}

function list(raw) {
  const clean = String(raw ?? "").trim();
  if (!clean || /^(无|none|-)$/i.test(clean)) return [];
  return clean.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
}

function warning(code, line, message) {
  return { severity: "warning", code, line, message };
}

function trackKey(kind) {
  if (kind === "论述") return "essay";
  if (kind === "案例") return "case";
  return null;
}

function parseTags(raw, line) {
  const tags = { primarySubject: null, secondarySubjects: [], topics: [] };
  const issues = [];
  if (raw == null) return { tags, issues };
  for (const cell of cells(raw)) {
    const match = cell.match(/^([^=＝]+)[=＝](.*)$/);
    if (!match) {
      issues.push(warning("invalid_subjective_profile_tag", line, `画像标签格式无效：${cell}`));
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "主科") tags.primarySubject = value || null;
    else if (key === "辅科") tags.secondarySubjects = list(value);
    else if (key === "专题") tags.topics = list(value);
    else issues.push(warning("unknown_subjective_profile_tag", line, `未知画像标签：${key}`));
  }
  for (const subject of [tags.primarySubject, ...tags.secondarySubjects].filter(Boolean)) {
    if (!SUBJECTS.has(subject)) issues.push(warning("unknown_subjective_subject", line, `未知主观题学科：${subject}`));
  }
  return { tags, issues };
}

function parseDimensionRatings(raw, track, line, stage) {
  const values = {};
  const notApplicable = [];
  const issues = [];
  if (raw == null) return { values, notApplicable, issues };
  if (!track) return { values, notApplicable, issues: [warning("unknown_subjective_kind", line, `${stage}能力观测无法归入论述或案例`)] };
  const aliases = new Map(track.dimensions.flatMap((dimension) => dimension.aliases.map((alias) => [alias, dimension])));
  for (const cell of cells(raw)) {
    const match = cell.match(/^([^=＝]+)[=＝](.+)$/);
    if (!match) {
      issues.push(warning("invalid_subjective_dimension", line, `${stage}能力观测格式无效：${cell}`));
      continue;
    }
    const label = match[1].trim();
    const rawValue = match[2].trim().toLowerCase();
    const dimension = aliases.get(label);
    if (!dimension) {
      issues.push(warning("unknown_subjective_dimension", line, `${track.label}没有维度：${label}`));
      continue;
    }
    if (Object.hasOwn(values, dimension.key) || notApplicable.includes(dimension.key)) {
      issues.push(warning("duplicate_subjective_dimension", line, `${stage}能力维度重复：${label}`));
      continue;
    }
    if (/^(na|n\/a|不适用)$/i.test(rawValue)) {
      notApplicable.push(dimension.key);
      continue;
    }
    const score = rawValue.match(/^([0-4])\s*\/\s*4$/)?.[1];
    if (score == null) {
      issues.push(warning("invalid_subjective_dimension_score", line, `${label} 必须写 0/4 至 4/4 或 NA`));
      continue;
    }
    values[dimension.key] = Number(score);
  }
  return { values, notApplicable, issues };
}

function normalizeOutcome(value) {
  return OUTCOMES.get(String(value ?? "").trim().toLowerCase()) ?? null;
}

function parseGateOutcomes(raw, line, stage) {
  const values = {};
  const issues = [];
  if (raw == null) return { values, issues };
  const aliases = new Map(GATES.flatMap((gate) => gate.aliases.map((alias) => [alias, gate])));
  for (const cell of cells(raw)) {
    const match = cell.match(/^([^=＝]+)[=＝](.+)$/);
    if (!match) {
      issues.push(warning("invalid_subjective_gate", line, `${stage}门槛观测格式无效：${cell}`));
      continue;
    }
    const gate = aliases.get(match[1].trim());
    const outcome = normalizeOutcome(match[2]);
    if (!gate) issues.push(warning("unknown_subjective_gate", line, `未知门槛：${match[1].trim()}`));
    else if (!outcome) issues.push(warning("invalid_subjective_gate_outcome", line, `${gate.label} 只允许 pass/partial/fail/NA`));
    else if (Object.hasOwn(values, gate.key)) issues.push(warning("duplicate_subjective_gate", line, `${stage}门槛重复：${gate.label}`));
    else values[gate.key] = outcome;
  }
  return { values, issues };
}

function parseDefectOutcomes(raw, line, stage, kind) {
  const values = [];
  const issues = [];
  if (raw == null) return { values, issues };
  const seen = new Set();
  const expectedPrefix = kind === "案例" ? "A" : kind === "论述" ? "B" : null;
  for (const cell of cells(raw)) {
    const match = cell.match(/^([AB]\d+)(?:@([A-Z]\d+))?[=＝](.+)$/i);
    if (!match) {
      issues.push(warning("invalid_subjective_defect_observation", line, `${stage}病灶观测格式无效：${cell}`));
      continue;
    }
    const defectId = match[1].toUpperCase();
    const rootCode = match[2]?.toUpperCase() ?? null;
    const outcome = normalizeOutcome(match[3]);
    if (seen.has(defectId)) issues.push(warning("duplicate_subjective_defect_observation", line, `${stage}病灶重复：${defectId}`));
    else if (expectedPrefix && !defectId.startsWith(expectedPrefix)) issues.push(warning("mismatched_subjective_defect_kind", line, `${kind}练笔不应记录 ${defectId}`));
    else if (rootCode && !Object.hasOwn(SUBJECTIVE_ROOT_CAPABILITIES, rootCode)) issues.push(warning("unknown_subjective_root_capability", line, `未知底层能力码：${rootCode}`));
    else if (!outcome) issues.push(warning("invalid_subjective_defect_outcome", line, `${defectId} 只允许 pass/partial/fail/NA`));
    else {
      seen.add(defectId);
      values.push({ defectId, rootCode, outcome });
    }
  }
  return { values, issues };
}

export function parseSubjectivePracticeSignals(body, { kind, line } = {}) {
  const key = trackKey(kind);
  const track = key ? TRACKS[key] : null;
  const issues = [];
  const { tags, issues: tagIssues } = parseTags(boldField(body, "画像标签"), line);
  issues.push(...tagIssues);
  const sourceRaw = boldField(body, "诊断依据");
  const diagnosticSource = sourceRaw == null ? null : DIAGNOSTIC_SOURCES.get(sourceRaw) ?? null;
  if (sourceRaw != null && diagnosticSource == null) issues.push(warning("invalid_subjective_diagnostic_source", line, `诊断依据只允许 用户标准/官方答案/估分：${sourceRaw}`));

  const dimensions = { draft: {}, rewrite: {} };
  const notApplicable = { draft: [], rewrite: [] };
  const gates = { draft: {}, rewrite: {} };
  const defectObservations = [];
  for (const [stageLabel, stage] of [["首稿", "draft"], ["重写", "rewrite"]]) {
    const parsedDimensions = parseDimensionRatings(boldField(body, `能力观测·${stageLabel}`), track, line, stageLabel);
    dimensions[stage] = parsedDimensions.values;
    notApplicable[stage] = parsedDimensions.notApplicable;
    issues.push(...parsedDimensions.issues);
    const parsedGates = parseGateOutcomes(boldField(body, `门槛观测·${stageLabel}`), line, stageLabel);
    gates[stage] = parsedGates.values;
    issues.push(...parsedGates.issues);
    const parsedDefects = parseDefectOutcomes(boldField(body, `病灶观测·${stageLabel}`), line, stageLabel, kind);
    issues.push(...parsedDefects.issues);
    defectObservations.push(...parsedDefects.values.map((observation) => ({ ...observation, stage })));
  }

  const hasStructuredObservations = Object.values(dimensions).some((values) => Object.keys(values).length)
    || Object.values(gates).some((values) => Object.keys(values).length)
    || defectObservations.length > 0;
  if (hasStructuredObservations && !tags.primarySubject) issues.push(warning("missing_subjective_primary_subject", line, "有结构化观测时必须在画像标签填写主科"));
  if (Object.values(dimensions).some((values) => Object.keys(values).length) && !diagnosticSource) {
    issues.push(warning("missing_subjective_diagnostic_source", line, "有能力观测时必须填写诊断依据"));
  }

  return {
    schemaVersion: SUBJECTIVE_CAPABILITY_SCHEMA_VERSION,
    track: key,
    ...tags,
    diagnosticSource,
    dimensions,
    notApplicable,
    gates,
    defectObservations,
    issues,
  };
}

function confidence(samples) {
  if (samples === 0) return "none";
  if (samples < 3) return "insufficient";
  if (samples < 5) return "provisional";
  return "stable";
}

function roundedPercent(total, count, max = 4) {
  return count ? Math.round((total / count / max) * 100) : null;
}

function summarizeRatings(observations) {
  const sorted = [...observations].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
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
  const weighted = counts.pass + counts.partial * 0.5;
  const observedPercent = relevant.length ? Math.round((weighted / relevant.length) * 100) : null;
  return {
    samples: relevant.length,
    counts,
    observedPercent,
    qualifiedPercent: relevant.length >= 3 ? observedPercent : null,
    confidence: confidence(relevant.length),
    lastObservedOn: [...relevant].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line).at(-1)?.date ?? null,
  };
}

function buildTrackProfile(practices, key) {
  const track = TRACKS[key];
  const relevant = practices.filter((practice) => practice.signals?.track === key);
  const stages = {};
  for (const stage of ["draft", "rewrite"]) {
    const dimensions = {};
    for (const dimension of track.dimensions) {
      const observations = relevant.flatMap((practice) => Object.hasOwn(practice.signals.dimensions[stage], dimension.key) ? [{
        date: practice.date,
        line: practice.line,
        title: practice.title,
        value: practice.signals.dimensions[stage][dimension.key],
        primarySubject: practice.signals.primarySubject,
        diagnosticSource: practice.signals.diagnosticSource,
      }] : []);
      dimensions[dimension.key] = { label: dimension.label, ...summarizeRatings(observations) };
    }
    const gates = {};
    for (const gate of GATES) {
      const observations = relevant.flatMap((practice) => Object.hasOwn(practice.signals.gates[stage], gate.key) ? [{
        date: practice.date,
        line: practice.line,
        outcome: practice.signals.gates[stage][gate.key],
      }] : []);
      gates[gate.key] = { label: gate.label, ...summarizeOutcomes(observations) };
    }
    const observedPractices = relevant.filter((practice) => Object.keys(practice.signals.dimensions[stage]).length > 0).length;
    stages[stage] = {
      observedPractices,
      qualified: track.dimensions.every((dimension) => dimensions[dimension.key].samples >= 3),
      dimensions,
      gates,
    };
  }
  return { key, kind: track.kind, label: track.label, draft: stages.draft, rewrite: stages.rewrite };
}

function spreadRank(level) {
  return { cross_task: 4, cross_subject: 3, candidate: 2, local: 1 }[level] ?? 0;
}

function rootSpread(issueEvents) {
  const subjects = new Set(issueEvents.flatMap((event) => event.subjects));
  const kinds = new Set(issueEvents.map((event) => event.kind));
  const contexts = new Set(issueEvents.map((event) => event.contextKey));
  if (issueEvents.length >= 3 && kinds.size >= 2) return "cross_task";
  if (issueEvents.length >= 3 && subjects.size >= 2) return "cross_subject";
  if (issueEvents.length >= 2 && contexts.size >= 2) return "candidate";
  return "local";
}

function propagationConfidence(level, issueCount, subjectCount) {
  if ((level === "cross_task" || level === "cross_subject") && issueCount >= 4 && subjectCount >= 3) return "high";
  if (level === "cross_task" || level === "cross_subject") return "medium";
  if (level === "candidate") return "low";
  return "insufficient";
}

function collapseRootEvents(events) {
  const groups = new Map();
  const outcomeRank = { na: 0, pass: 1, partial: 2, fail: 3 };
  for (const event of events) {
    const key = `${event.rootCode}::${event.contextKey}`;
    const current = groups.get(key);
    if (!current) groups.set(key, { ...event, defectIds: [event.defectId], surfaceDefects: event.defectTitle ? [event.defectTitle] : [] });
    else {
      current.defectIds = [...new Set([...current.defectIds, event.defectId])];
      current.surfaceDefects = [...new Set([...current.surfaceDefects, ...(event.defectTitle ? [event.defectTitle] : [])])];
      if (outcomeRank[event.outcome] > outcomeRank[current.outcome]) current.outcome = event.outcome;
    }
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line || a.contextKey.localeCompare(b.contextKey));
}

function buildPropagation(practices, defects) {
  const issues = [];
  const catalog = new Map(defects.map((defect) => [defect.id, defect]));
  const rawEvents = [];
  for (const practice of practices) {
    for (const observation of practice.signals?.defectObservations ?? []) {
      if (observation.stage !== "draft" || observation.outcome === "na") continue;
      const defect = catalog.get(observation.defectId);
      if (!defect) issues.push(warning("unknown_subjective_defect_id", practice.line, `病灶观测引用了不存在的 ${observation.defectId}`));
      if (defect?.rootCode && observation.rootCode && defect.rootCode !== observation.rootCode) {
        issues.push(warning("subjective_root_capability_drift", practice.line, `${observation.defectId} 的事件能力码 ${observation.rootCode} 与病灶定义 ${defect.rootCode} 不一致`));
      }
      const rootCode = defect?.rootCode ?? observation.rootCode;
      if (!rootCode) {
        issues.push(warning("missing_subjective_root_capability", practice.line, `${observation.defectId} 未绑定底层能力码，不能进入传播分析`));
        continue;
      }
      if (!Object.hasOwn(SUBJECTIVE_ROOT_CAPABILITIES, rootCode)) {
        issues.push(warning("unknown_subjective_root_capability", practice.line, `未知底层能力码：${rootCode}`));
        continue;
      }
      const subjects = [practice.signals.primarySubject, ...practice.signals.secondarySubjects].filter(Boolean);
      rawEvents.push({
        rootCode,
        defectId: observation.defectId,
        defectTitle: defect?.title ?? null,
        outcome: observation.outcome,
        date: practice.date,
        line: practice.line,
        kind: practice.kind,
        subjects,
        topics: practice.signals.topics,
        practiceTitle: practice.title,
        contextKey: `${practice.date}｜${practice.title}`,
      });
    }
  }

  const collapsed = collapseRootEvents(rawEvents);
  const roots = [];
  for (const rootCode of [...new Set(collapsed.map((event) => event.rootCode))]) {
    const events = collapsed.filter((event) => event.rootCode === rootCode);
    const issueEvents = events.filter((event) => event.outcome === "fail" || event.outcome === "partial");
    const spreadLevel = rootSpread(issueEvents);
    const subjects = [...new Set(issueEvents.flatMap((event) => event.subjects))].sort();
    const kinds = [...new Set(issueEvents.map((event) => event.kind))].sort();
    const lastIssueIndex = events.reduce((last, event, index) => event.outcome === "fail" || event.outcome === "partial" ? index : last, -1);
    const passesAfterLastIssue = lastIssueIndex < 0 ? [] : events.slice(lastIssueIndex + 1).filter((event) => event.outcome === "pass");
    const passContexts = new Set(passesAfterLastIssue.map((event) => event.contextKey));
    const passSubjects = new Set(passesAfterLastIssue.flatMap((event) => event.subjects));
    const passKinds = new Set(passesAfterLastIssue.map((event) => event.kind));
    const resolutionScopeQualified = spreadLevel === "cross_task" ? passKinds.size >= 2
      : spreadLevel === "cross_subject" ? passSubjects.size >= 2
        : passContexts.size >= 2;
    const resolved = issueEvents.length > 0 && passesAfterLastIssue.length >= 2 && resolutionScopeQualified;
    const status = resolved ? "resolved" : issueEvents.length ? "active" : "monitoring";
    const nextProbe = resolved ? null : spreadLevel === "cross_task" ? "跨题型无提示首稿复检"
      : spreadLevel === "cross_subject" ? "换科无提示首稿复检"
        : spreadLevel === "candidate" ? "换专题无提示首稿复检"
          : "同类异题无提示首稿复检";
    roots.push({
      rootCode,
      ...SUBJECTIVE_ROOT_CAPABILITIES[rootCode],
      status,
      spreadLevel,
      confidence: propagationConfidence(spreadLevel, issueEvents.length, subjects.length),
      issueEpisodes: issueEvents.length,
      observedEpisodes: events.length,
      subjects,
      kinds,
      surfaceDefects: [...new Set(events.flatMap((event) => event.surfaceDefects))],
      lastIssueOn: issueEvents.at(-1)?.date ?? null,
      lastObservedOn: events.at(-1)?.date ?? null,
      resolution: {
        cleanPassesAfterLastIssue: passesAfterLastIssue.length,
        distinctContexts: passContexts.size,
        scopeQualified: resolutionScopeQualified,
      },
      nextProbe,
      events,
    });
  }
  roots.sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved")
    || spreadRank(b.spreadLevel) - spreadRank(a.spreadLevel)
    || b.issueEpisodes - a.issueEpisodes
    || a.rootCode.localeCompare(b.rootCode));
  return {
    schemaVersion: SUBJECTIVE_CAPABILITY_SCHEMA_VERSION,
    catalog: SUBJECTIVE_ROOT_CAPABILITIES,
    counts: {
      roots: roots.length,
      active: roots.filter((root) => root.status === "active").length,
      resolved: roots.filter((root) => root.status === "resolved").length,
      crossSubject: roots.filter((root) => root.spreadLevel === "cross_subject" || root.spreadLevel === "cross_task").length,
      crossTask: roots.filter((root) => root.spreadLevel === "cross_task").length,
    },
    roots,
    issues,
  };
}

export function buildSubjectiveAnalytics(practices, { defects = [] } = {}) {
  const capabilityProfile = {
    schemaVersion: SUBJECTIVE_CAPABILITY_SCHEMA_VERSION,
    internalOnly: true,
    scale: {
      min: 0,
      max: 4,
      anchors: {
        0: "未出现或根本错误",
        1: "有痕迹但主干错误",
        2: "部分完成且缺关键环",
        3: "基本正确但有小遗漏",
        4: "完整准确且可稳定复现",
      },
    },
    sampleGate: { qualified: 3, stable: 5, trend: 6 },
    tracks: {
      essay: buildTrackProfile(practices, "essay"),
      case: buildTrackProfile(practices, "case"),
    },
  };
  const propagation = buildPropagation(practices, defects);
  return { capabilityProfile, propagation, issues: propagation.issues };
}
