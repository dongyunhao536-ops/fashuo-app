// [gpt] 2026-08-10：概率预测单独留账并在结果发生后用 Brier 分数校准；不与普通命中率台账混算。

export const FORECAST_STATUSES = Object.freeze(["pending", "resolved", "void"]);
export const FORECAST_CONFIDENCE = Object.freeze(["low", "medium", "high"]);
const HEADER = "| id | date | target_date | subject | event | probability | lower | upper | confidence | model | evidence_ref | status | resolved_date | outcome | actual | note |";
const RULE_LINE = "<!-- 列：预测日 ｜ 目标日 ｜ 科目 ｜ 二元事件 ｜ 概率% ｜ 概率下界% ｜ 概率上界% ｜ 信心 ｜ 模型 ｜ 证据版本 ｜ 状态 ｜ 对账日 ｜ 结果0/1 ｜ 实际值 ｜ 备注 -->";

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function cleanForecastCell(value) {
  return String(value ?? "")
    .replace(/[\r\n|]/g, (character) => (character === "|" ? "／" : " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseCell(value) {
  const cell = String(value ?? "").trim();
  return cell === "—" || cell === "" ? null : cell;
}

function numberCell(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function issueForItem(item, line) {
  const issues = [];
  const add = (code, message) => issues.push({ severity: "error", code, line, message });
  if (!/^F\d+$/.test(item.id ?? "")) add("bad-id", `id 无效：${item.id ?? "(空)"}`);
  if (!validDate(item.date)) add("bad-date", `${item.id} 预测日无效：${item.date}`);
  if (!validDate(item.targetDate)) add("bad-target-date", `${item.id} 目标日无效：${item.targetDate}`);
  if (validDate(item.date) && validDate(item.targetDate) && item.targetDate < item.date) add("target-before-created", `${item.id} 目标日早于预测日`);
  if (!item.subject) add("missing-subject", `${item.id} 缺科目`);
  if (!item.event) add("missing-event", `${item.id} 缺二元事件定义`);
  if (!Number.isInteger(item.probability) || item.probability < 0 || item.probability > 100) add("bad-probability", `${item.id} probability 必须是 0-100 整数`);
  if (!Number.isInteger(item.lower) || !Number.isInteger(item.upper) || item.lower < 0 || item.upper > 100 || item.lower > item.probability || item.upper < item.probability) add("bad-band", `${item.id} 概率区间必须满足 0≤lower≤probability≤upper≤100`);
  if (!FORECAST_CONFIDENCE.includes(item.confidence)) add("bad-confidence", `${item.id} confidence 必须是 ${FORECAST_CONFIDENCE.join("/")}`);
  if (!item.model) add("missing-model", `${item.id} 缺模型版本`);
  if (!item.evidenceRef) add("missing-evidence-ref", `${item.id} 缺证据版本，禁止裸概率`);
  if (!FORECAST_STATUSES.includes(item.status)) add("bad-status", `${item.id} status 必须是 ${FORECAST_STATUSES.join("/")}`);
  if (item.status === "pending" && (item.resolvedDate || item.outcome != null || item.actual != null)) add("pending-has-result", `${item.id} pending 却已有对账结果`);
  if (item.status === "resolved") {
    if (!validDate(item.resolvedDate)) add("resolved-missing-date", `${item.id} resolved 缺合法对账日`);
    if (![0, 1].includes(item.outcome)) add("bad-outcome", `${item.id} resolved 的 outcome 必须是 0/1`);
    if (validDate(item.resolvedDate) && validDate(item.targetDate) && item.resolvedDate < item.targetDate) add("resolved-before-target", `${item.id} 不能在目标日前对账`);
  }
  if (item.status === "void" && !validDate(item.resolvedDate)) add("void-missing-date", `${item.id} void 缺合法对账日`);
  if (item.status === "void" && item.outcome != null) add("void-has-outcome", `${item.id} void 不得写 outcome`);
  if (item.actual != null && !Number.isFinite(item.actual)) add("bad-actual", `${item.id} actual 必须是数字`);
  if (validDate(item.resolvedDate) && validDate(item.date) && item.resolvedDate < item.date) add("resolved-before-created", `${item.id} 对账日早于预测日`);
  return issues;
}

export function parseProbabilityForecastLedger(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const issues = [];
  const seen = new Set();
  let inTable = false;
  for (const [index, line] of lines.entries()) {
    if (!inTable) {
      if (line.trim() === HEADER) inTable = true;
      continue;
    }
    if (!/^\| F/.test(line)) {
      if (/^\|/.test(line) && !/^\|\s*:?-{2,}/.test(line)) issues.push({ severity: "error", code: "bad-row", line: index + 1, message: "机器区出现非 F 开头的数据行" });
      continue;
    }
    const cells = line.split("|").slice(1, -1).map(parseCell);
    if (cells.length !== 16) issues.push({ severity: "error", code: "bad-column-count", line: index + 1, message: `列数应为 16，实际 ${cells.length}` });
    const [id, date, targetDate, subject, event, probability, lower, upper, confidence, model, evidenceRef, status, resolvedDate, outcome, actual, note] = cells;
    if (seen.has(id)) {
      issues.push({ severity: "error", code: "duplicate-id", line: index + 1, message: `id 重复：${id}` });
      continue;
    }
    seen.add(id);
    const item = {
      id: id ?? "",
      date: date ?? "",
      targetDate: targetDate ?? "",
      subject: subject ?? "",
      event: event ?? "",
      probability: numberCell(probability),
      lower: numberCell(lower),
      upper: numberCell(upper),
      confidence: confidence ?? "",
      model: model ?? "",
      evidenceRef: evidenceRef ?? "",
      status: status ?? "pending",
      resolvedDate,
      outcome: numberCell(outcome),
      actual: numberCell(actual),
      note: note ?? "",
      line: index + 1,
    };
    issues.push(...issueForItem(item, index + 1));
    items.push(item);
  }
  if (!inTable) issues.push({ severity: "error", code: "no-table", line: 1, message: "未找到概率预测机器表头" });
  return { items, issues, counts: { items: items.length, errors: issues.filter((issue) => issue.severity === "error").length } };
}

export function assertValidProbabilityForecastLedger(parsed, operation = "读取") {
  if (parsed?.counts?.errors) throw new Error(`概率预测台账有 ${parsed.counts.errors} 个结构错误，拒绝${operation}`);
  return parsed;
}

function nextId(items) {
  const maximum = items.reduce((max, item) => Math.max(max, Number(String(item.id).match(/^F(\d+)$/)?.[1] ?? 0)), 0);
  return `F${String(maximum + 1).padStart(4, "0")}`;
}

function rowFor(item) {
  return `| ${[
    item.id, item.date, item.targetDate, item.subject, item.event,
    item.probability, item.lower, item.upper, item.confidence, item.model,
    item.evidenceRef, item.status, item.resolvedDate || "—",
    item.outcome == null ? "—" : item.outcome,
    item.actual == null ? "—" : item.actual,
    item.note || "—",
  ].join(" | ")} |`;
}

function fingerprint(item) {
  return [item.targetDate, item.subject, item.event, item.model, item.evidenceRef].join("|");
}

export function appendProbabilityForecast(markdown, fields, { referenceDate } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const before = parseProbabilityForecastLedger(markdown);
  const onlyMissingTable = before.issues.length === 1 && before.issues[0].code === "no-table";
  if (before.counts.errors && !onlyMissingTable) throw new Error(`现有概率预测台账有 ${before.counts.errors} 个结构错误，拒绝追加`);
  const item = {
    id: nextId(before.items),
    date: validDate(fields.date) ? fields.date : referenceDate,
    targetDate: String(fields.targetDate ?? ""),
    subject: cleanForecastCell(fields.subject),
    event: cleanForecastCell(fields.event),
    probability: Number(fields.probability),
    lower: Number(fields.lower),
    upper: Number(fields.upper),
    confidence: cleanForecastCell(fields.confidence),
    model: cleanForecastCell(fields.model),
    evidenceRef: cleanForecastCell(fields.evidenceRef),
    status: "pending",
    resolvedDate: null,
    outcome: null,
    actual: null,
    note: cleanForecastCell(fields.note),
  };
  const itemIssues = issueForItem(item, 0);
  if (itemIssues.length) throw new Error(itemIssues.map((issue) => issue.message).join("；"));
  const existing = before.items.find((value) => fingerprint(value) === fingerprint(item));
  if (existing) return { markdown: String(markdown), added: false, id: existing.id, item: existing, reason: "same-evidence-version" };
  const current = String(markdown ?? "").trimEnd();
  const prefix = current || "# 概率预测台账";
  const section = current.includes(HEADER) ? "" : `\n\n## 结构化台账（机器读取）\n\n${HEADER}\n${RULE_LINE}`;
  const next = `${prefix}${section}\n${rowFor(item)}\n`;
  const after = parseProbabilityForecastLedger(next);
  if (after.counts.errors) throw new Error(`追加后的概率预测台账有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, added: true, id: item.id, item };
}

function resolveRow(markdown, id, values, { date, note }) {
  if (!validDate(date)) throw new Error("对账日期必须是 YYYY-MM-DD");
  const parsed = assertValidProbabilityForecastLedger(parseProbabilityForecastLedger(markdown), "对账");
  const item = parsed.items.find((value) => value.id === id);
  if (!item) throw new Error(`未找到概率预测：${id}`);
  if (item.status !== "pending") return { markdown: String(markdown), changed: false, item, reason: "already-resolved" };
  if (values.status === "resolved" && date < item.targetDate) throw new Error(`不能在目标日 ${item.targetDate} 前对账`);
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const cells = lines[item.line - 1].split("|").slice(1, -1).map((cell) => String(cell ?? "").trim());
  cells[11] = values.status;
  cells[12] = date;
  cells[13] = values.outcome == null ? "—" : String(values.outcome);
  cells[14] = values.actual == null ? "—" : String(values.actual);
  if (note) cells[15] = cleanForecastCell(note);
  lines[item.line - 1] = `| ${cells.join(" | ")} |`;
  const next = `${lines.join("\n").trimEnd()}\n`;
  const after = parseProbabilityForecastLedger(next);
  if (after.counts.errors) throw new Error(`对账后的概率预测台账有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, changed: true, item: after.items.find((value) => value.id === id) };
}

export function resolveProbabilityForecast(markdown, id, outcome, { date, actual = null, note = "" } = {}) {
  const binary = Number(outcome);
  if (![0, 1].includes(binary)) throw new Error("outcome 必须是 0 或 1");
  const actualNumber = actual == null || actual === "" ? null : Number(actual);
  if (actualNumber != null && !Number.isFinite(actualNumber)) throw new Error("actual 必须是数字");
  return resolveRow(markdown, id, { status: "resolved", outcome: binary, actual: actualNumber }, { date, note });
}

export function voidProbabilityForecast(markdown, id, { date, note = "" } = {}) {
  return resolveRow(markdown, id, { status: "void", outcome: null, actual: null }, { date, note });
}

function scoreRows(rows) {
  const count = rows.length;
  if (!count) return { count: 0, meanProbability: null, observedRate: null, brierScore: null, logLoss: null, biasPoints: null };
  const probabilities = rows.map((item) => item.probability / 100);
  const meanProbability = probabilities.reduce((sum, value) => sum + value, 0) / count;
  const observedRate = rows.reduce((sum, item) => sum + item.outcome, 0) / count;
  const brier = rows.reduce((sum, item, index) => sum + (probabilities[index] - item.outcome) ** 2, 0) / count;
  const logLoss = rows.reduce((sum, item, index) => {
    const probability = Math.max(0.01, Math.min(0.99, probabilities[index]));
    return sum - (item.outcome * Math.log(probability) + (1 - item.outcome) * Math.log(1 - probability));
  }, 0) / count;
  return {
    count,
    meanProbability: Math.round(meanProbability * 1000) / 10,
    observedRate: Math.round(observedRate * 1000) / 10,
    brierScore: Math.round(brier * 10000) / 10000,
    logLoss: Math.round(logLoss * 1000) / 1000,
    biasPoints: Math.round((meanProbability - observedRate) * 1000) / 10,
  };
}

export function summarizeProbabilityForecastLedger(parsed, { referenceDate } = {}) {
  assertValidProbabilityForecastLedger(parsed, "汇总");
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const resolved = parsed.items.filter((item) => item.status === "resolved");
  const bucketRanges = [[0, 20], [21, 40], [41, 60], [61, 80], [81, 100]];
  const buckets = bucketRanges.map(([lower, upper]) => {
    const rows = resolved.filter((item) => item.probability >= lower && item.probability <= upper);
    return { range: `${lower}-${upper}`, ...scoreRows(rows) };
  }).filter((bucket) => bucket.count);
  const expectedCalibrationError = resolved.length
    ? Math.round((buckets.reduce((sum, bucket) => sum + Math.abs(bucket.meanProbability - bucket.observedRate) * bucket.count, 0) / resolved.length) * 10) / 10
    : null;
  const bySubject = Object.fromEntries([...new Set(resolved.map((item) => item.subject))].sort().map((subject) => [subject, scoreRows(resolved.filter((item) => item.subject === subject))]));
  const byModel = Object.fromEntries([...new Set(resolved.map((item) => item.model))].sort().map((model) => [model, scoreRows(resolved.filter((item) => item.model === model))]));
  const due = parsed.items.filter((item) => item.status === "pending" && item.targetDate <= referenceDate);
  const calibrationStatus = resolved.length >= 30 ? "reviewable" : resolved.length >= 10 ? "provisional" : "collecting";
  return {
    referenceDate,
    calibrationStatus,
    counts: {
      items: parsed.items.length,
      pending: parsed.items.filter((item) => item.status === "pending").length,
      resolved: resolved.length,
      void: parsed.items.filter((item) => item.status === "void").length,
      dueUnresolved: due.length,
    },
    overall: { ...scoreRows(resolved), expectedCalibrationError },
    buckets,
    bySubject,
    byModel,
    due: due.map((item) => ({ id: item.id, subject: item.subject, event: item.event, targetDate: item.targetDate, probability: item.probability })),
    policy: "Brier 越低越好；N<10 只收集，10-29 仅作初步观察，N≥30 才允许审查模型偏差。重复快照必须由新的证据版本触发。",
  };
}

export function formatProbabilityForecastSummary(summary) {
  const brier = summary.overall.brierScore == null ? "—" : summary.overall.brierScore;
  const lines = [
    `概率预测台账（北京 ${summary.referenceDate}）：${summary.calibrationStatus}｜共 ${summary.counts.items} 条 / 已对账 ${summary.counts.resolved} / pending ${summary.counts.pending} / void ${summary.counts.void}`,
    `Brier ${brier}｜平均预测 ${summary.overall.meanProbability ?? "—"}%｜实际发生率 ${summary.overall.observedRate ?? "—"}%｜偏差 ${summary.overall.biasPoints ?? "—"} 个百分点｜ECE ${summary.overall.expectedCalibrationError ?? "—"}`,
    `到期未对账 ${summary.counts.dueUnresolved} 条${summary.counts.dueUnresolved ? `：${summary.due.map((item) => item.id).join("、")}` : ""}`,
  ];
  if (summary.buckets.length) lines.push(`可靠性分桶：${summary.buckets.map((bucket) => `${bucket.range}% N=${bucket.count} 预测${bucket.meanProbability}%/实际${bucket.observedRate}%`).join(" ｜ ")}`);
  lines.push(summary.policy);
  return lines.join("\n");
}

export function appendMockCalibrationForecasts(markdown, mockCalibration, { referenceDate, targetDate } = {}) {
  let next = String(markdown ?? "");
  const additions = [];
  if (!mockCalibration?.canProjectProbability) return { markdown: next, additions };
  for (const subject of mockCalibration.subjects ?? []) {
    const projection = subject.projection;
    if (projection?.attainmentProbability == null) continue;
    const result = appendProbabilityForecast(next, {
      date: referenceDate,
      targetDate,
      subject: subject.subject,
      event: `${subject.subject}卷面分≥${subject.targetScore}`,
      probability: projection.attainmentProbability,
      lower: projection.probabilityBand[0],
      upper: projection.probabilityBand[1],
      confidence: projection.probabilityConfidence,
      model: projection.modelVersion,
      evidenceRef: `complete-mock-dates:${subject.evidenceDates.join(",")}`,
      note: `N=${subject.samples}；投影 ${projection.projected}；分数区间 ${projection.band.join("-")}`,
    }, { referenceDate });
    next = result.markdown;
    if (result.added) additions.push(result.item);
  }
  return { markdown: next, additions };
}
