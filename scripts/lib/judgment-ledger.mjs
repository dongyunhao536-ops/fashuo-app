export const JUDGMENT_TYPES = Object.freeze(["掌握度", "栽点", "病根候选", "复检期", "排期", "进度", "事实"]);
export const JUDGMENT_RESULTS = Object.freeze(["pending", "hit", "miss", "partial", "void"]);
const HEADER = "| id | date | type | subject | ref | prediction | basis | verify_date | result | resolved_date | seed | note |";
const RULE_LINE = "<!-- 列：落账日 ｜ 类型 ｜ 科目 ｜ 关联 ｜ 预测内容 ｜ 依据 ｜ 验证时点 ｜ 结果 ｜ 对账日 ｜ 种子 ｜ 备注 -->";

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function beijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function cleanCell(value) {
  return String(value ?? "")
    .replace(/[\r\n|]/g, (character) => (character === "|" ? "／" : " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseCell(value) {
  const cell = String(value ?? "").trim();
  return cell === "—" || cell === "" ? null : cell;
}

/**
 * 解析判断台账。规则：
 * - 机器读取区从 `| id |` 头开始，其后 `| J` 开头的行是一条预测。
 * - 回溯种子（seed=1）不计入兑现率分母，只用于错误类型分布。
 * - 任何结构错误都进 issues；check/summary 依赖它拒绝在坏账上算数。
 */
// [gpt] 2026-08-10：解析本身不依赖参考日；保留调用方传入多余参数的 JS 兼容性。
export function parseJudgmentLedger(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const items = [];
  const issues = [];
  const seenIds = new Set();
  let inTable = false;

  for (const [index, line] of lines.entries()) {
    if (!inTable) {
      if (line.trim() === HEADER) inTable = true;
      continue;
    }
    if (!/^\| J/.test(line)) {
      if (/^\|/.test(line) && !/^\|\s*:?-{2,}/.test(line)) issues.push({ severity: "error", code: "bad-row", line: index + 1, message: "机器区出现非 J 开头的数据行" });
      continue;
    }
    const cells = line.split("|").slice(1, -1).map(parseCell);
    if (cells.length !== 12) {
      issues.push({ severity: "error", code: "bad-column-count", line: index + 1, message: `列数应为 12，实际 ${cells.length}` });
    }
    const [id, date, type, subject, ref, prediction, basis, verifyDate, result, resolvedDate, seed, note] = cells;
    if (!id || !/^J\d+$/.test(id)) {
      issues.push({ severity: "error", code: "bad-id", line: index + 1, message: `id 无效：${id ?? "(空)"}` });
      continue;
    }
    if (seenIds.has(id)) {
      issues.push({ severity: "error", code: "duplicate-id", line: index + 1, message: `id 重复：${id}` });
      continue;
    }
    seenIds.add(id);
    if (!validDate(date)) issues.push({ severity: "error", code: "bad-date", line: index + 1, message: `${id} 落账日期无效：${date}` });
    if (!JUDGMENT_TYPES.includes(type)) issues.push({ severity: "error", code: "bad-type", line: index + 1, message: `${id} 类型无效：${type}（允许 ${JUDGMENT_TYPES.join("/")}）` });
    if (!JUDGMENT_RESULTS.includes(result)) issues.push({ severity: "error", code: "bad-result", line: index + 1, message: `${id} 结果无效：${result}` });
    if (verifyDate && !validDate(verifyDate)) issues.push({ severity: "error", code: "bad-verify-date", line: index + 1, message: `${id} 验证时点无效：${verifyDate}` });
    if (resolvedDate && !validDate(resolvedDate)) issues.push({ severity: "error", code: "bad-resolved-date", line: index + 1, message: `${id} 对账日无效：${resolvedDate}` });
    if (result === "pending" && resolvedDate) issues.push({ severity: "error", code: "pending-has-resolved-date", line: index + 1, message: `${id} 仍 pending 却已有对账日` });
    if (result && result !== "pending" && !resolvedDate) issues.push({ severity: "error", code: "resolved-missing-date", line: index + 1, message: `${id} 已对账但缺对账日` });
    if (date && resolvedDate && validDate(date) && validDate(resolvedDate) && resolvedDate < date) issues.push({ severity: "error", code: "resolved-before-created", line: index + 1, message: `${id} 对账日早于落账日` });
    if (!["0", "1"].includes(seed ?? "0")) issues.push({ severity: "error", code: "bad-seed", line: index + 1, message: `${id} seed 只能是 0/1` });
    if (!prediction) issues.push({ severity: "error", code: "missing-prediction", line: index + 1, message: `${id} 缺预测内容` });
    items.push({
      id,
      date,
      type: type ?? "",
      subject: subject ?? "",
      ref: ref ?? "",
      prediction: prediction ?? "",
      basis: basis ?? "",
      verifyDate,
      result: result ?? "pending",
      resolvedDate,
      seed: seed === "1" ? 1 : 0,
      note: note ?? "",
      line: index + 1,
    });
  }

  if (!inTable) issues.push({ severity: "error", code: "no-table", line: 1, message: "未找到机器读取表头" });
  return { items, issues, counts: { items: items.length, errors: issues.filter((issue) => issue.severity === "error").length } };
}

export function assertValidJudgmentLedger(parsed, operation = "统计") {
  const errors = parsed?.counts?.errors
    ?? (parsed?.issues ?? []).filter((issue) => issue.severity === "error").length;
  if (errors) throw new Error(`判断台账有 ${errors} 个结构错误，拒绝${operation}`);
  return parsed;
}

function nextId(items) {
  let max = 0;
  for (const item of items) {
    const match = String(item.id).match(/^J(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `J${String(max + 1).padStart(4, "0")}`;
}

function rowFor(item) {
  return `| ${[item.id, item.date, item.type, item.subject || "—", item.ref || "—", item.prediction, item.basis || "—", item.verifyDate || "—", item.result, item.resolvedDate || "—", item.seed ? "1" : "0", item.note || "—"].join(" | ")} |`;
}

/**
 * 追加一条预测。追加前先复验现有文件结构；追加后再次复验。
 * 返回 { markdown, added, item, id }；调用方决定何时落盘。
 */
export function appendJudgment(markdown, fields, { referenceDate = beijingDate() } = {}) {
  const before = parseJudgmentLedger(markdown, { referenceDate });
  const onlyMissingTable = before.issues.length === 1 && before.issues[0].code === "no-table";
  if (before.counts.errors && !onlyMissingTable) throw new Error(`现有判断台账有 ${before.counts.errors} 个结构错误，拒绝追加`);
  const type = cleanCell(fields.type);
  if (!JUDGMENT_TYPES.includes(type)) throw new Error(`类型必须是 ${JUDGMENT_TYPES.join("/")} 之一`);
  const prediction = cleanCell(fields.prediction);
  if (!prediction) throw new Error("--prediction 必填（要验证的判断内容）");
  const date = validDate(fields.date) ? fields.date : referenceDate;
  const verifyDate = fields.verifyDate ? (validDate(fields.verifyDate) ? fields.verifyDate : null) : null;
  if (fields.verifyDate && !verifyDate) throw new Error("--verify-date 必须是 YYYY-MM-DD");
  const item = {
    id: nextId(before.items),
    date,
    type,
    subject: cleanCell(fields.subject) || "",
    ref: cleanCell(fields.ref) || "",
    prediction,
    basis: cleanCell(fields.basis) || "",
    verifyDate,
    result: "pending",
    resolvedDate: null,
    seed: fields.seed ? 1 : 0,
    note: cleanCell(fields.note) || "",
    line: 0,
  };
  const current = String(markdown ?? "").trimEnd();
  const hasTable = current.includes(HEADER);
  const prefix = current || "# 判断台账";
  const section = hasTable ? "" : `\n\n## 结构化台账（机器读取）\n\n${HEADER}\n${RULE_LINE}`;
  const next = `${prefix}${section}\n${rowFor(item)}\n`;
  const after = parseJudgmentLedger(next, { referenceDate });
  if (after.counts.errors) throw new Error(`追加后的判断台账有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, added: true, id: item.id, item };
}

/**
 * 对账一条预测。可把 pending 置为 hit/miss/partial/void；幂等：重复对账直接返回。
 */
export function resolveJudgment(markdown, id, result, { date = beijingDate(), note = "" } = {}) {
  if (!JUDGMENT_RESULTS.includes(result)) throw new Error(`结果必须是 ${JUDGMENT_RESULTS.join("/")} 之一`);
  if (result === "pending") throw new Error("resolve 不能把结果设回 pending");
  if (!validDate(date)) throw new Error("对账日期必须是 YYYY-MM-DD");
  const parsed = parseJudgmentLedger(markdown, { referenceDate: date });
  if (parsed.counts.errors) throw new Error(`现有判断台账有 ${parsed.counts.errors} 个结构错误，拒绝对账`);
  const index = parsed.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`未找到预测：${id}`);
  const item = parsed.items[index];
  if (item.result !== "pending") return { markdown: String(markdown), changed: false, item, reason: "already-resolved" };
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const lineIndex = item.line - 1;
  const cells = lines[lineIndex].split("|").slice(1, -1);
  cells[8] = result;
  cells[9] = date;
  if (note) cells[11] = cleanCell(note);
  lines[lineIndex] = `| ${cells.map((cell) => String(cell ?? "").trim()).join(" | ")} |`;
  const next = `${lines.join("\n").trimEnd()}\n`;
  const after = parseJudgmentLedger(next, { referenceDate: date });
  if (after.counts.errors) throw new Error(`对账后的判断台账有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, changed: true, item: { ...item, result, resolvedDate: date } };
}

function isDue(item, referenceDate) {
  return item.result === "pending" && item.verifyDate && item.verifyDate <= referenceDate;
}

/**
 * 兑现率统计（2026-08-07）：
 * - 分母 = 非种子、已对账（hit/miss/partial）的预测数；void 不计。
 * - 命中率 = hit / 分母；partial 单列（部分命中），不给半分以免制造伪精确。
 * - 种子（seed=1）只输出错误类型分布，绝不并入分母——回溯样本 100% 偏"判错的"。
 */
export function summarizeJudgmentLedger(parsed, { referenceDate = beijingDate() } = {}) {
  assertValidJudgmentLedger(parsed, "汇总");
  const countable = parsed.items.filter((item) => !item.seed && ["hit", "miss", "partial"].includes(item.result));
  const hits = countable.filter((item) => item.result === "hit").length;
  const misses = countable.filter((item) => item.result === "miss").length;
  const partials = countable.filter((item) => item.result === "partial").length;
  const denominator = hits + misses + partials;
  const hitRate = denominator ? Math.round((hits / denominator) * 100) : null;

  const byType = new Map();
  for (const item of countable) {
    const bucket = byType.get(item.type) ?? { hit: 0, miss: 0, partial: 0 };
    bucket[item.result === "partial" ? "partial" : item.result]++;
    byType.set(item.type, bucket);
  }
  const bySubject = new Map();
  for (const item of countable) {
    const key = item.subject || "（无科目）";
    const bucket = bySubject.get(key) ?? { hit: 0, miss: 0, partial: 0 };
    bucket[item.result === "partial" ? "partial" : item.result]++;
    bySubject.set(key, bucket);
  }

  const seedDistribution = new Map();
  for (const item of parsed.items.filter((item) => item.seed && item.result !== "pending")) {
    const bucket = seedDistribution.get(item.type) ?? { miss: 0, partial: 0 };
    bucket[item.result === "partial" ? "partial" : "miss"]++;
    seedDistribution.set(item.type, bucket);
  }

  const due = parsed.items.filter((item) => isDue(item, referenceDate));
  const formatBucket = (bucket) => {
    const total = bucket.hit + bucket.miss + bucket.partial;
    return { ...bucket, total, hitRate: total ? Math.round((bucket.hit / total) * 100) : null };
  };
  return {
    referenceDate,
    counts: {
      items: parsed.items.length,
      pending: parsed.items.filter((item) => item.result === "pending").length,
      dueUnresolved: due.length,
      countable: countable.length,
      hit: hits,
      miss: misses,
      partial: partials,
      void: parsed.items.filter((item) => item.result === "void").length,
      seed: parsed.items.filter((item) => item.seed).length,
    },
    hitRate,
    byType: Object.fromEntries([...byType.entries()].map(([key, value]) => [key, formatBucket(value)])),
    bySubject: Object.fromEntries([...bySubject.entries()].map(([key, value]) => [key, formatBucket(value)])),
    seedDistribution: Object.fromEntries([...seedDistribution.entries()].map(([key, value]) => [key, { miss: value.miss, partial: value.partial }])),
    due: due.map((item) => ({ id: item.id, type: item.type, subject: item.subject, ref: item.ref, prediction: item.prediction, verifyDate: item.verifyDate })),
    errors: parsed.counts.errors,
  };
}

export function formatJudgmentLedgerSummary(summary) {
  const rate = summary.hitRate == null ? "（尚无已对账预测）" : `${summary.hitRate}%`;
  const lines = [
    `判断台账（北京 ${summary.referenceDate}）：共 ${summary.counts.items} 条（种子 ${summary.counts.seed}）｜已对账 ${summary.counts.countable}（命中 ${summary.counts.hit} / 未中 ${summary.counts.miss} / 部分 ${summary.counts.partial}）｜兑现率 ${rate}`,
    `到期未对账 ${summary.counts.dueUnresolved} 条${summary.counts.dueUnresolved ? `：${summary.due.map((item) => `${item.id}(${item.type})`).join("、")}` : ""}`,
  ];
  const typeText = Object.entries(summary.byType).map(([type, bucket]) => `${type} ${bucket.hit}/${bucket.total}（${bucket.hitRate}%）`).join(" ｜ ");
  if (typeText) lines.push(`按类型：${typeText}`);
  const seedText = Object.entries(summary.seedDistribution).map(([type, bucket]) => `${type}×${bucket.miss}${bucket.partial ? `（含部分 ${bucket.partial}）` : ""}`).join(" ｜ ");
  if (seedText) lines.push(`种子错误分布（回溯样本·100%偏判错·不计入兑现率）：${seedText}`);
  lines.push("预测只记「判断」本身；兑现率是「我在哪类判断上系统性偏」的唯一事实源，不是能力或卷面指标。");
  return lines.join("\n");
}
