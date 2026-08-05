const DAY = 86400000;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateDistance(from, to) {
  if (!validDate(from) || !validDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function resolveShortDate(token, referenceDate) {
  const clean = String(token ?? "").replace(/[^0-9-]/g, "");
  if (/^20\d{2}-\d{2}-\d{2}$/.test(clean)) return validDate(clean) ? clean : null;
  const match = clean.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const month = String(Number(match[1])).padStart(2, "0");
  const day = String(Number(match[2])).padStart(2, "0");
  let value = `${referenceDate.slice(0, 4)}-${month}-${day}`;
  if (!validDate(value)) return null;
  const future = dateDistance(referenceDate, value);
  if (future != null && future > 90) value = `${Number(referenceDate.slice(0, 4)) - 1}-${month}-${day}`;
  return validDate(value) ? value : null;
}

function blocks(markdown, heading) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const indexes = [];
  lines.forEach((line, index) => { if (heading.test(line)) indexes.push(index); });
  return indexes.map((start, position) => ({
    line: start + 1,
    heading: lines[start],
    body: lines.slice(start + 1, indexes[position + 1] ?? lines.length).join("\n"),
  }));
}

function field(body, label) {
  const match = String(body).match(new RegExp(`^- \\*\\*${label}\\*\\*[：:]\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function parseDailyLedger(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const entries = blocks(markdown, /^##\s+20\d{2}-\d{2}-\d{2}/).map((block) => {
    const date = block.heading.match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
    const dispatch = field(block.body, "派单");
    const settlement = field(block.body, "昨日结算");
    const activity = field(block.body, "今日流水");
    const warning = field(block.body, "断档");
    const priorityCounts = Object.fromEntries(["P0", "P1", "P2"].map((priority) => [priority, (dispatch?.match(new RegExp(`\\[${priority}\\]`, "g")) ?? []).length]));
    const marks = settlement?.match(/✅|⚠️?|❌/gu) ?? [];
    return {
      date,
      line: block.line,
      dispatch,
      settlement,
      activity,
      warning,
      priorityCounts,
      dispatched: priorityCounts.P0 + priorityCounts.P1 + priorityCounts.P2,
      settlementEvidence: marks.length > 0,
      settled: {
        total: marks.length,
        completed: marks.filter((mark) => mark === "✅").length,
        partial: marks.filter((mark) => mark.startsWith("⚠")).length,
        missed: marks.filter((mark) => mark === "❌").length,
      },
    };
  }).filter((entry) => validDate(entry.date));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const dates = new Set(entries.map((entry) => entry.date));
  const gaps = [];
  for (let index = 1; index < entries.length; index++) {
    const gap = dateDistance(entries[index - 1].date, entries[index].date);
    if (gap > 1) gaps.push({ after: entries[index - 1].date, before: entries[index].date, missingDays: gap - 1 });
  }
  const settled = entries.filter((entry) => entry.settlementEvidence).reduce((sum, entry) => ({
    total: sum.total + entry.settled.total,
    completed: sum.completed + entry.settled.completed,
    partial: sum.partial + entry.settled.partial,
    missed: sum.missed + entry.settled.missed,
  }), { total: 0, completed: 0, partial: 0, missed: 0 });
  const latestDate = entries.at(-1)?.date ?? null;
  return {
    referenceDate,
    entries,
    counts: {
      days: entries.length,
      dispatched: entries.reduce((sum, entry) => sum + entry.dispatched, 0),
      ...settled,
    },
    strictExecutionRate: settled.total ? Number((settled.completed / settled.total).toFixed(3)) : null,
    latestDate,
    daysSinceLatest: latestDate ? dateDistance(latestDate, referenceDate) : null,
    gaps,
    uniqueDates: dates.size,
  };
}

function legacyScheduleStatus(line) {
  if (/✅/.test(line) && /(已执行|达成|完成|结案|补齐)/.test(line)) return "completed";
  if (/❌/.test(line) && /(未执行|实际未执行|滚至|仍为\s*0|完败)/.test(line)) return "missed";
  if (/🟡/.test(line) || /部分达成/.test(line)) return "partial";
  return "pending";
}

function parseCanonicalScheduleLine(line, lineNumber) {
  const match = line.match(/^- \[([ xX])\]\s+(20\d{2}-\d{2}-\d{2})\s*\|\s*(P[0-2])\s*\|\s*id=([^|]+)\|\s*type=([^|]+)\|\s*task=([^|]+)(.*)$/);
  if (!match) return null;
  const tail = match[7] ?? "";
  const values = Object.fromEntries([...tail.matchAll(/\|\s*([a-z_]+)=([^|]+)/g)].map((item) => [item[1], item[2].trim()]));
  return {
    id: match[4].trim(),
    dueDate: match[2],
    priority: match[3],
    type: match[5].trim(),
    task: match[6].trim(),
    ref: values.ref ?? null,
    status: match[1].toLowerCase() === "x" ? "completed" : "pending",
    completedOn: values.completed ?? null,
    result: values.result ?? null,
    source: "canonical",
    line: lineNumber,
    raw: line,
  };
}

export function parseReviewSchedule(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const issues = [];
  let inheritedPriority = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const canonical = parseCanonicalScheduleLine(line, index + 1);
    if (canonical) {
      if (!validDate(canonical.dueDate)) issues.push({ severity: "error", code: "invalid_date", line: index + 1, message: `无效日期 ${canonical.dueDate}` });
      items.push(canonical);
      continue;
    }
    const priority = line.match(/【(P[0-2])(?:-[^】]+)?】/)?.[1];
    if (priority) inheritedPriority = priority;
    const acceptance = line.replace(/^\s*[-*>]+\s*/, "").replace(/[*_`✅❌🟡🔴📌〔〕]/g, "").trim();
    if (!/^验收[①②③④⑤0-9]/.test(acceptance)) continue;
    const dateToken = line.match(/(?<!\d)(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})(?!\d)/)?.[1];
    const dueDate = resolveShortDate(dateToken, referenceDate);
    if (!dueDate) {
      issues.push({ severity: "warning", code: "legacy_missing_date", line: index + 1, message: "含验收字样但未识别出明确日期" });
      continue;
    }
    items.push({
      id: `legacy-L${index + 1}`,
      dueDate,
      priority: priority ?? inheritedPriority ?? "P1",
      type: "legacy",
      task: line.replace(/^\s*[-*>]+\s*/, "").replace(/\s+/g, " ").trim(),
      ref: null,
      status: legacyScheduleStatus(line),
      completedOn: null,
      result: null,
      source: "legacy",
      line: index + 1,
      raw: line,
    });
  }
  const ids = new Set();
  for (const item of items.filter((item) => item.source === "canonical")) {
    if (ids.has(item.id)) issues.push({ severity: "error", code: "duplicate_id", line: item.line, message: `排期 ID 重复：${item.id}` });
    ids.add(item.id);
  }
  // 旧散文无法可靠判断“后来是否被另一段回写结案”，只保留为证据候选；
  // 真正进入行动队列的必须是同文件内的 canonical 条目。
  const open = items.filter((item) => item.source === "canonical" && item.status !== "completed");
  const legacyOpenCandidates = items.filter((item) => item.source === "legacy" && item.status !== "completed");
  const overdue = open.filter((item) => item.dueDate < referenceDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.line - b.line);
  const dueToday = open.filter((item) => item.dueDate === referenceDate);
  const upcoming = open.filter((item) => item.dueDate > referenceDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.line - b.line);
  return {
    referenceDate,
    items,
    open,
    overdue,
    dueToday,
    upcoming,
    legacyOpenCandidates,
    counts: {
      items: items.length,
      canonical: items.filter((item) => item.source === "canonical").length,
      legacy: items.filter((item) => item.source === "legacy").length,
      completed: items.filter((item) => item.status === "completed").length,
      partial: items.filter((item) => item.status === "partial").length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      upcoming: upcoming.length,
      legacyOpenCandidates: legacyOpenCandidates.length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
    issues,
  };
}

function scoreFrom(body, label) {
  const match = String(body).match(new RegExp(`${label}[^0-9]{0,12}(\\d+(?:\\.\\d+)?)\\s*\\/\\s*15`));
  return match ? Number(match[1]) : null;
}

export function parseSubjectiveLedger(markdown, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  const activeText = text.match(/##\s+挂着的病灶([\s\S]*?)(?=\n##\s+)/)?.[1] ?? "";
  const practiceText = text.match(/##\s+练笔记录([\s\S]*?)(?=\n##\s+)/)?.[1] ?? "";
  const resolvedText = text.match(/##\s+已改掉([\s\S]*)$/)?.[1] ?? "";
  const parseDefects = (section, status) => blocks(section, /^###\s+[A-Z]\d+[｜|]/).map((block) => {
    const [id, title, detail] = block.heading.replace(/^###\s+/, "").split(/[｜|]/).map((part) => part.trim());
    const firstSeen = block.body.match(/首现\s+(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
    const lastTouched = block.body.match(/最后碰\s+(20\d{2}-\d{2}-\d{2})/)?.[1] ?? firstSeen;
    return { id, title, detail: detail ?? null, status, firstSeen, lastTouched, line: block.line };
  });
  const activeDefects = parseDefects(activeText, "active");
  const resolvedDefects = parseDefects(resolvedText, "resolved");
  const issues = [];
  const practices = blocks(practiceText, /^###\s+20\d{2}-\d{2}-\d{2}[｜|]/).map((block) => {
    const parts = block.heading.replace(/^###\s+/, "").split(/[｜|]/).map((part) => part.trim());
    const date = parts[0];
    const kind = /案例/.test(parts[1] ?? "") ? "案例" : /论述/.test(parts[1] ?? "") ? "论述" : "未知";
    const draftScore = scoreFrom(block.body, "首稿");
    const rewriteScore = scoreFrom(block.body, "重写稿");
    if (draftScore == null && rewriteScore == null) issues.push({ severity: "warning", code: "missing_score", line: block.line, message: `${date} 练笔未识别到 15 分制得分` });
    return {
      date,
      kind,
      title: parts.slice(1).join("｜"),
      draftScore,
      rewriteScore,
      latestScore: rewriteScore ?? draftScore,
      improvement: draftScore != null && rewriteScore != null ? Number((rewriteScore - draftScore).toFixed(2)) : null,
      line: block.line,
    };
  }).filter((practice) => validDate(practice.date));
  practices.sort((a, b) => a.date.localeCompare(b.date));
  const latestPracticeDate = practices.at(-1)?.date ?? null;
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
  const oldestActive = [...activeDefects].sort((a, b) => String(a.lastTouched ?? "9999").localeCompare(String(b.lastTouched ?? "9999")) || a.id.localeCompare(b.id))[0] ?? null;
  return {
    referenceDate,
    activeDefects,
    resolvedDefects,
    practices,
    counts: {
      activeDefects: activeDefects.length,
      resolvedDefects: resolvedDefects.length,
      practices: practices.length,
      cases: practices.filter((practice) => practice.kind === "案例").length,
      essays: practices.filter((practice) => practice.kind === "论述").length,
      rewrites: practices.filter((practice) => practice.rewriteScore != null).length,
      warnings: issues.length,
    },
    scores: {
      averageDraft: average(practices.map((practice) => practice.draftScore).filter((score) => score != null)),
      averageLatest: average(practices.map((practice) => practice.latestScore).filter((score) => score != null)),
      averageImprovement: average(practices.map((practice) => practice.improvement).filter((score) => score != null)),
    },
    oldestActive,
    latestPracticeDate,
    daysSinceLatestPractice: latestPracticeDate ? dateDistance(latestPracticeDate, referenceDate) : null,
    issues,
  };
}
