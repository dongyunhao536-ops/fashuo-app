// [gpt] 2026-08-10：统一定义题目迁移等级与测试环境，错题证据和知识证据共用一套枚举。

export const EVIDENCE_VARIANTS = Object.freeze({
  original: Object.freeze({ label: "原题复现", dimension: "application", transferLevel: 1 }),
  rule_recall: Object.freeze({ label: "规则复述", dimension: "recall", transferLevel: 2 }),
  counterfactual: Object.freeze({ label: "反事实变式", dimension: "application", transferLevel: 3 }),
  novel_case: Object.freeze({ label: "陌生新案例", dimension: "application", transferLevel: 4 }),
  integrated_case: Object.freeze({ label: "综合案例", dimension: "application", transferLevel: 4 }),
  teach_back: Object.freeze({ label: "教给别人", dimension: "recall", transferLevel: 5 }),
  invalid: Object.freeze({ label: "题干作废", dimension: "application", transferLevel: 0 }),
});

export const ASSESSMENT_CONTEXTS = Object.freeze({
  practice: Object.freeze({ label: "普通练习", timed: false }),
  timed: Object.freeze({ label: "限时训练", timed: true }),
  full_mock: Object.freeze({ label: "成套模考", timed: true }),
});

export function normalizeTransferMetadata({
  dimension,
  result,
  promptIntegrity = "clean",
  cold = false,
  variantKind = null,
  transferLevel = null,
  assessmentContext = "practice",
  durationSeconds = null,
} = {}) {
  const variant = variantKind == null || variantKind === "" ? null : String(variantKind);
  const level = transferLevel == null || transferLevel === "" ? null : Number(transferLevel);
  const context = String(assessmentContext ?? "practice");
  const duration = durationSeconds == null || durationSeconds === "" ? null : Number(durationSeconds);
  if ((variant == null) !== (level == null)) throw new Error("variantKind/transferLevel 必须成对提供");
  if (!(context in ASSESSMENT_CONTEXTS)) throw new Error(`assessmentContext 不合法：${context}`);
  if (duration != null && (!Number.isInteger(duration) || duration < 1 || duration > 43200)) throw new Error("durationSeconds 必须是 1-43200 整数");
  if (ASSESSMENT_CONTEXTS[context].timed && duration == null) throw new Error(`${context} 证据必须记录 durationSeconds`);
  if (variant) {
    const spec = EVIDENCE_VARIANTS[variant];
    if (!spec) throw new Error(`variantKind 不合法：${variant}`);
    if (level !== spec.transferLevel) throw new Error(`${variant} 的 transferLevel 必须是 ${spec.transferLevel}`);
    if (dimension !== spec.dimension) throw new Error(`${variant} 的 dimension 必须是 ${spec.dimension}`);
    if (variant === "invalid" && !(result === "void" && promptIntegrity === "invalid" && cold === false)) throw new Error("作废复检必须同时使用 void + invalid prompt + 非冷检（invalid 变式）");
  }
  return { variantKind: variant, transferLevel: level, assessmentContext: context, durationSeconds: duration };
}
