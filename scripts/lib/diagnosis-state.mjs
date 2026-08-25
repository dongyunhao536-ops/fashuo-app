// [gpt] 2026-08-25：病根候选只活在当前 Run 的临时 artifact；数据库不再持久化 pending。
export const DIAGNOSIS_TERMINAL_STATUSES = Object.freeze(["confirmed", "rejected", "untraceable"]);
export const PERSISTED_DIAGNOSIS_STATUSES = Object.freeze(["unassessed", ...DIAGNOSIS_TERMINAL_STATUSES]);

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeDiagnosisTransition({
  fromStatus,
  fromDecisionRunId = null,
  fromUntraceableBy = null,
  toStatus,
  decisionRunId = null,
  untraceableAt = null,
  untraceableBy = null,
  untraceableReason = null,
  migration = false,
} = {}) {
  const from = clean(fromStatus) || "unassessed";
  const priorDecision = clean(fromDecisionRunId) || null;
  const priorUntraceableBy = clean(fromUntraceableBy) || null;
  const to = clean(toStatus) || "unassessed";
  const decision = clean(decisionRunId) || null;

  if (to === "pending") {
    throw new Error("PENDING_DIAGNOSIS_ARTIFACT_ONLY｜pending 候选只能存在于当前 Run 的临时判题 artifact，禁止写入学习事实");
  }
  if (!PERSISTED_DIAGNOSIS_STATUSES.includes(to)) {
    throw new Error(`DIAGNOSIS_STATUS_INVALID｜持久诊断状态不合法：${to}`);
  }

  if (from === "untraceable" && to !== "untraceable") {
    // [gpt] 2026-08-25：当场制允许同一 Run 内撤回“忘了”；跨 Run、政策封账和换成非判定态仍是终态。
    const sameRunCorrection = priorUntraceableBy === "user"
      && priorDecision != null
      && decision === priorDecision
      && ["confirmed", "rejected"].includes(to);
    if (!sameRunCorrection) {
      throw new Error("UNTRACEABLE_DIAGNOSIS_TERMINAL｜不可追溯病根仅允许用户在原决定 Run 内更正为 confirmed/rejected；跨 Run、政策封账和与老账并案均禁止");
    }
  }
  if (["confirmed", "rejected"].includes(to) && !migration && !decision) {
    throw new Error("DIAGNOSIS_DECISION_RUN_REQUIRED｜病根认领或排除必须由当前 Run 的 Gate 留下决定回执");
  }
  if (to === "untraceable") {
    const at = clean(untraceableAt);
    const by = clean(untraceableBy);
    const reason = clean(untraceableReason);
    if (!at || Number.isNaN(Date.parse(at))) throw new Error("UNTRACEABLE_AT_REQUIRED｜untraceable 必须有有效时间");
    if (by !== "user") throw new Error("UNTRACEABLE_USER_DECISION_REQUIRED｜只有用户明确说忘了或不认领，才能写 untraceable；断网/Stop/Run 中止只记遥测");
    if (!reason) throw new Error("UNTRACEABLE_REASON_REQUIRED｜untraceable 必须记录原因");
    if (!migration && !decision) throw new Error("DIAGNOSIS_DECISION_RUN_REQUIRED｜用户的明确决定必须绑定当前 Run");
    return {
      fromStatus: from,
      toStatus: to,
      decisionRunId: decision,
      untraceableAt: at,
      untraceableBy: by,
      untraceableReason: reason,
    };
  }
  return {
    fromStatus: from,
    toStatus: to,
    decisionRunId: decision,
    untraceableAt: null,
    untraceableBy: null,
    untraceableReason: null,
  };
}

export function diagnosisProbePolicy(status) {
  if (status === "untraceable") {
    return Object.freeze({
      mode: "positive_knowledge_only",
      allowMisconceptionProbe: false,
      allowRootCauseClaim: false,
      allowMerge: false,
    });
  }
  return Object.freeze({
    mode: status === "confirmed" ? "confirmed_diagnosis" : "neutral",
    allowMisconceptionProbe: status === "confirmed",
    allowRootCauseClaim: status === "confirmed",
    allowMerge: status !== "untraceable",
  });
}
