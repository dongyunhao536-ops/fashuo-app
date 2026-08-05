const STATUSES = ["open", "clarified", "dismissed", "superseded", "expired"];

function datePart(value) {
  return value == null ? "" : String(value).slice(0, 10);
}

function effectiveStatus(row, referenceDate) {
  if (row.effective_status) return String(row.effective_status);
  if (row.status === "open" && row.ttl_until && String(row.ttl_until) < referenceDate) return "expired";
  return String(row.status ?? "unknown");
}

function inPeriod(value, start, end) {
  const date = datePart(value);
  return Boolean(date && (!start || date >= start) && (!end || date <= end));
}

/** ask_summary 是“真实未收口卡点轴”，不是所有提问/答疑次数。 */
export function summarizeAskPoints(rows = [], { referenceDate, periodStart = null, periodEnd = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate ?? "")) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const points = rows.map((row) => ({
    id: Number(row.id),
    subject: row.subject ?? null,
    kpId: row.kp_id ?? null,
    questionType: row.question_type ?? null,
    stepStuck: row.step_stuck ?? null,
    confusion: String(row.confusion ?? "").trim(),
    status: row.status ?? "unknown",
    effectiveStatus: effectiveStatus(row, referenceDate),
    ttlUntil: row.ttl_until == null ? null : String(row.ttl_until),
    source: row.source ?? "app",
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolutionNote: row.resolution_note ?? null,
  })).filter((point) => Number.isInteger(point.id) && point.id > 0 && point.confusion);

  const counts = Object.fromEntries(STATUSES.map((status) => [status, points.filter((point) => point.effectiveStatus === status).length]));
  const activePoints = points.filter((point) => point.effectiveStatus === "open")
    .sort((a, b) => datePart(a.createdAt).localeCompare(datePart(b.createdAt)) || a.id - b.id);
  const periodCreated = points.filter((point) => inPeriod(point.createdAt, periodStart, periodEnd));
  const periodResolved = points.filter((point) => inPeriod(point.resolvedAt, periodStart, periodEnd));

  return {
    referenceDate,
    points,
    counts,
    activePoints,
    period: {
      start: periodStart,
      end: periodEnd,
      created: periodCreated.length,
      createdPoints: periodCreated,
      clarified: periodResolved.filter((point) => point.status === "clarified").length,
      dismissed: periodResolved.filter((point) => point.status === "dismissed").length,
      superseded: periodResolved.filter((point) => point.status === "superseded").length,
    },
  };
}

export function askPointLabel(point) {
  return `A#${point.id} [${point.subject ?? "未分类"}] ${point.confusion}`;
}
