// [gpt] 2026-08-12：复检题发送前的确定性命题完整性 Gate；只审计题面，不保存答案。

export const REVIEW_QUESTION_TYPES = Object.freeze(["single-choice", "multiple-choice", "non-choice"]);

const TYPE_LABELS = Object.freeze({
  "single-choice": "【单选题】",
  "multiple-choice": "【多选题】",
});

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";
const LABEL_TOKEN = `[A-H${CIRCLED}]`;
const REFERENCE_TOKEN = `(?:[A-H](?=$|[\s、,，和及与并+＋/至到两各错误不正答应选排除])|[${CIRCLED}])`;
const NUMBER_WORD = "(?:[一二两三四五六七八]|[1-8])";

function normalizeText(value) {
  // NFKC 会把 ① 转成 1，破坏法硕题常用的圈号选项；这里只做不兼容折叠的 NFC。
  return String(value ?? "").normalize("NFC").replace(/\r\n/g, "\n").trim();
}

function surfaceRows(input) {
  return [
    ["stem", normalizeText(input?.stem)],
    ["requirements", normalizeText(input?.requirements)],
    ["hints", normalizeText(input?.hints)],
  ].filter(([, value]) => value);
}

function optionBodyFreeStem(stem) {
  return normalizeText(stem)
    .split("\n")
    .filter((line) => !new RegExp(`^\\s*${LABEL_TOKEN}[.．、:：)）\\s]`, "u").test(line))
    .join("\n");
}

function canonicalLabel(value) {
  const text = String(value ?? "").normalize("NFC").toUpperCase();
  return /^[A-H]$/u.test(text) || CIRCLED.includes(text) ? text : null;
}

export function extractChoiceReferences(value) {
  const text = normalizeText(value).toUpperCase();
  const output = [];
  // 拉丁选项需有右边界，避免把“请说明 REASON”里的 A/E 等普通字母误当选项。
  for (const token of text.match(new RegExp(REFERENCE_TOKEN, "gu")) ?? []) {
    const label = canonicalLabel(token);
    if (label && !output.includes(label)) output.push(label);
  }
  return output;
}

function parseAnswerKey(value) {
  // 答案键是专用内部字段，允许常见紧凑写法 “AC”；题面引用仍使用带边界的严格解析。
  const text = normalizeText(value).toUpperCase();
  return [...new Set((text.match(new RegExp(LABEL_TOKEN, "gu")) ?? []).map(canonicalLabel).filter(Boolean))].sort();
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function comparableText(value) {
  return normalizeText(value).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function verbatimAnswerViolations(rows, source, code, message) {
  const needle = comparableText(source);
  // 短术语常须自然出现在题干中；只对足够长的原答/参考答案做确定性逐字污染拦截。
  if (needle.length < 8) return [];
  return rows
    .filter(([, value]) => comparableText(value).includes(needle))
    .map(([field]) => evidence(code, field, message, "[redacted-answer-text]"));
}

function optionLabels(stem) {
  const text = normalizeText(stem).toUpperCase();
  const labels = [];
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(${LABEL_TOKEN})[.．、:：)）\\s]`, "gu"),
    /(?:^|\s)([A-H])[.．、:：)）]\s*/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const label = canonicalLabel(match[1]);
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  for (const label of text.match(new RegExp(`[${CIRCLED}]`, "gu")) ?? []) {
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function evidence(code, field, message, match = null) {
  return {
    code,
    field,
    message,
    match: match ? String(match).slice(0, 120) : null,
    responsibility: "teacher",
  };
}

function regexEvidence(rows, code, pattern, message, { stemWithoutOptions = false } = {}) {
  const violations = [];
  for (const [field, raw] of rows) {
    const value = field === "stem" && stemWithoutOptions ? optionBodyFreeStem(raw) : raw;
    const match = value.match(pattern);
    if (match) violations.push(evidence(code, field, message, match[0]));
  }
  return violations;
}

function explicitTypeLabel(stem) {
  return normalizeText(stem).match(/^【(单选题|多选题)】/u)?.[1] ?? null;
}

function isAllOptionsInstruction(value) {
  return /(?:逐项|各项|每项|每一项|全部选项|所有选项|逐一)/u.test(value)
    || /A\s*[-—~至]\s*[D-H]/iu.test(value)
    || /①\s*[-—~至]\s*[④-⑩]/u.test(value);
}

function targetedSubsetViolations(input, labels, answerKey, originalAnswer) {
  if (!labels.length) return [];
  const violations = [];
  for (const [field, value] of surfaceRows(input).filter(([name]) => name !== "stem")) {
    const references = extractChoiceReferences(value).filter((label) => labels.includes(label));
    if (!references.length || isAllOptionsInstruction(value) || sameSet(references, labels)) continue;
    if (answerKey.length && sameSet(references, answerKey)) {
      violations.push(evidence("targeted-answer-subset", field, "附加要求或提示只点名了全部正确项，间接暴露答案", references.join("")));
      continue;
    }
    const wrong = labels.filter((label) => !answerKey.includes(label));
    if (answerKey.length && sameSet(references, wrong)) {
      violations.push(evidence("targeted-wrong-subset", field, "附加要求或提示只点名了全部错误项，间接暴露答案", references.join("")));
      continue;
    }
    if (originalAnswer.length && sameSet(references, originalAnswer)) {
      violations.push(evidence("original-answer-disclosed", field, "附加要求或提示复现了用户原错答案", references.join("")));
    }
  }
  return violations;
}

/**
 * 审计一份尚未展示的复检题草稿。选择题必须提供教练侧 answerKey，才能检查
 * “只点正确项/错误项/原错答案”等间接污染；answerKey 永不进入 displayText。
 */
export function auditReviewQuestion(input = {}) {
  const questionType = String(input.questionType ?? "").trim();
  if (!REVIEW_QUESTION_TYPES.includes(questionType)) throw new Error(`未知复检题型：${questionType || "空"}`);
  const stem = normalizeText(input.stem);
  const requirements = normalizeText(input.requirements);
  const hints = normalizeText(input.hints);
  const rawAnswer = normalizeText(input.answerKey);
  const rawOriginalAnswer = normalizeText(input.originalAnswer);
  const rows = surfaceRows({ stem, requirements, hints });
  const labels = optionLabels(stem);
  const answerKey = parseAnswerKey(input.answerKey);
  const originalAnswer = parseAnswerKey(input.originalAnswer);
  const violations = [];

  if (!stem) violations.push(evidence("missing-stem", "stem", "复检题缺少题干"));
  const expectedLabel = TYPE_LABELS[questionType] ?? null;
  const actualLabel = explicitTypeLabel(stem);
  if (expectedLabel && !actualLabel) {
    violations.push(evidence("missing-choice-label", "stem", `选择题必须以 ${expectedLabel} 显式标注题型`));
  } else if (expectedLabel && actualLabel && expectedLabel !== `【${actualLabel}】`) {
    violations.push(evidence("choice-label-mismatch", "stem", `题型参数与题面标签不一致，应为 ${expectedLabel}`, `【${actualLabel}】`));
  }
  if (questionType === "non-choice" && labels.length >= 2 && /(?:选择|选项|应选|正确项|错误项)/u.test(stem)) {
    violations.push(evidence("choice-type-required", "stem", "题面实际是选择题，不能以 non-choice 绕过单选/多选标签闸门"));
  }
  if (expectedLabel && !labels.length) violations.push(evidence("missing-options", "stem", "选择题未识别到可审计的选项编号"));
  // [claude] 2026-08-26：deferAnswerKey——答案键推迟到用户作答之后再审。
  //
  // 原设计假定答案键只在教练侧，但 Claude Code 会把工具调用渲染给用户看，
  // 命令行、文件写入、参数一律可见，所以「展示前把答案交给 Gate」在这个宿主上
  // 等于每道题自带答案（2026-08-26 云截图实证）。答案键在本文件里只被
  // targetedSubsetViolations 使用，用途是查「题干是否只点了正解集或其补集」——
  // 这个检查放到作答之后跑，结论完全一样，而作答之后再泄已经无害。
  // 代价说清楚：污染改为事后发现，会浪费用户一次作答；但那比直接把答案给他强。
  // 防绕过：延迟审计不是取消审计，judgment-result 会拒绝为仍处于延迟态的 Run 判分。
  const deferAnswerKey = Boolean(input.deferAnswerKey);
  if (!deferAnswerKey) {
    if (expectedLabel && !answerKey.length) violations.push(evidence("missing-answer-key", "answerKey", "选择题 Gate 需要教练侧答案键，才能检测间接答案污染"));
    if (questionType === "non-choice" && !rawAnswer) violations.push(evidence("missing-answer-key", "answerKey", "非选择复检题也需要教练侧参考答案，才能检测答案文本污染"));
  } else if (rawAnswer) {
    violations.push(evidence("deferred-answer-key-supplied", "answerKey", "已声明延迟审答案键，就不能同时把答案键传进来"));
  }
  if (answerKey.some((label) => labels.length && !labels.includes(label))) {
    violations.push(evidence("answer-key-outside-options", "answerKey", "答案键含题面不存在的选项编号", answerKey.join("")));
  }
  if (hints) {
    violations.push(evidence("preanswer-hint-present", "hints", "复检题展示前不得附带提示语；需要提示时应退出 clean 复检流程", hints));
  }
  violations.push(...regexEvidence(
    rows.filter(([field]) => field === "stem"),
    "answer-salience-markup",
    /(?:\*\*|__|<mark\b|<strong\b|<b\b|<u\b|font-weight\s*:|text-decoration\s*:\s*underline|==)[^\n]{0,160}/iu,
    "题干使用显著标记突出事实，可能把决定答案的线索预先加粗",
  ));

  violations.push(...regexEvidence(
    rows,
    "correct-count-disclosed",
    new RegExp(`(?:(?:正确|错误|应选|不应选|符合题意|不符合题意)(?:的)?(?:选项|项)?(?:有|共|为|是)?\\s*${NUMBER_WORD}\\s*(?:个|项)|(?:只有|仅有|有且仅有|恰有|恰好|共(?:有|计)?|至少|至多)?\\s*${NUMBER_WORD}\\s*(?:个|项)?(?:正确|错误|应选|不应选|符合题意|不符合题意)|(?:选择|选出)\\s*(?:只有|仅有|恰好|至少|至多)?\\s*${NUMBER_WORD}\\s*(?:个|项)|答案[^。！？\\n]{0,12}(?:由|含|包含|包括|共(?:有|计)?)\\s*${NUMBER_WORD}\\s*(?:个|项))`, "iu"),
    "题面、附加要求或提示泄露了正确项数量",
    { stemWithoutOptions: true },
  ));
  violations.push(...regexEvidence(
    rows,
    "answer-structure-disclosed",
    new RegExp(`(?:答案|正确项|错误项|应选项?|不应选项?)\\s*(?:为|是|包括|包含|选|[:：])?\\s*(?:${LABEL_TOKEN})(?:[\\s、,，和及与+＋/]+${LABEL_TOKEN})*`, "iu"),
    "题面、附加要求或提示直接给出了答案结构",
    { stemWithoutOptions: true },
  ));
  violations.push(...regexEvidence(
    rows.filter(([field]) => field !== "stem"),
    "named-option-verdict",
    new RegExp(`(?:(?:指出|说明|解释|分析|改正|比较)?\\s*(?:${LABEL_TOKEN})(?:[\\s、,，和及与+＋/]*${LABEL_TOKEN})*[^。！？\\n]{0,18}(?:错(?:误)?|不正确|不能选|不成立|有问题|应?排除|为何错|正确|必选|应选)|(?:正确|应选|答案)[^。！？\\n]{0,12}(?:${LABEL_TOKEN})(?:[\\s、,，和及与+＋/]*${LABEL_TOKEN})*|除\\s*(?:${LABEL_TOKEN})\\s*外[^。！？\\n]{0,18}(?:均|都|全部)[^。！？\\n]{0,8}(?:正确|错误|应选|不应选))`, "iu"),
    "附加要求或提示对点名选项预先作出正误判断",
  ));
  // 延迟态下 answerKey 为空，子集比对无从谈起；originalAnswer 仍照常审。
  violations.push(...targetedSubsetViolations({ stem, requirements, hints }, labels, answerKey, originalAnswer));
  violations.push(...verbatimAnswerViolations(
    rows,
    rawAnswer,
    "reference-answer-disclosed",
    "题面逐字复现较长参考答案，直接污染作答",
  ));
  violations.push(...verbatimAnswerViolations(
    rows,
    rawOriginalAnswer,
    "original-answer-disclosed",
    "题面逐字复现用户原错答案，形成记忆提示",
  ));

  if (originalAnswer.length) {
    for (const [field, value] of rows) {
      if (!/(?:上次|原答|原错|曾经|你选|之前选择|避免再选)/u.test(value)) continue;
      const references = extractChoiceReferences(value);
      if (sameSet(references, originalAnswer)) {
        violations.push(evidence("original-answer-disclosed", field, "题面复述了用户原错答案，形成记忆提示", references.join("")));
      }
    }
  }

  const unique = [...new Map(violations.map((item) => [`${item.code}:${item.field}:${item.match ?? ""}`, item])).values()];
  return {
    schemaVersion: 1,
    ok: unique.length === 0,
    action: unique.length ? "rewrite" : "allow",
    displayAllowed: unique.length === 0,
    questionType,
    choiceLabel: expectedLabel,
    optionLabels: labels,
    violations: unique,
    displayText: [stem, requirements, hints].filter(Boolean).join("\n\n"),
    internal: { answerKeyPresent: Boolean(rawAnswer), originalAnswerPresent: Boolean(rawOriginalAnswer) },
  };
}

/**
 * 对常见“附加追问/提示污染”给确定性安全改写。题干本体若已泄题则只阻断，
 * 不擅自删除事实；调用方必须人工重写题干后再次运行 audit，直到 PASS。
 */
export function rewriteReviewQuestion(input = {}, audit = auditReviewQuestion(input)) {
  if (audit.ok) return { rewritten: false, manualRewriteRequired: false, draft: { ...input }, audit };
  const stemViolations = audit.violations.filter((item) => item.field === "stem"
    && !["missing-choice-label", "choice-label-mismatch"].includes(item.code));
  const answerKeyFailure = audit.violations.some((item) => ["missing-answer-key", "answer-key-outside-options", "missing-options", "missing-stem", "choice-type-required"].includes(item.code));
  if (stemViolations.length || answerKeyFailure) {
    return { rewritten: false, manualRewriteRequired: true, draft: null, audit };
  }
  const expected = TYPE_LABELS[audit.questionType] ?? "";
  const strippedStem = normalizeText(input.stem).replace(/^【(?:单选题|多选题)】\s*/u, "");
  const draft = {
    ...input,
    stem: expected ? `${expected}${strippedStem}` : strippedStem,
    requirements: audit.questionType === "non-choice" ? "请独立作答，并简述判断依据。" : "请选择，并简述判断依据。",
    hints: "",
  };
  const rewrittenAudit = auditReviewQuestion(draft);
  return {
    rewritten: true,
    manualRewriteRequired: !rewrittenAudit.ok,
    draft,
    audit: rewrittenAudit,
  };
}

/** 漏检后发现污染时的统一归责；保留审计行，但不消耗用户的有效复检。 */
export function invalidReviewDisposition(reason = "题面答案污染") {
  return {
    reason: normalizeText(reason) || "题面答案污染",
    result: "void",
    variantKind: "invalid",
    promptIntegrity: "invalid",
    cold: false,
    responsibility: "teacher",
    countAsValidAttempt: false,
    countAsUserError: false,
    advanceCooldown: false,
    closeSchedule: false,
    nextAction: "rewrite-and-regate",
  };
}

export function questionIntegrityContext(runId = null) {
  const runFlag = runId ? ` --run ${runId}` : "";
  return {
    requiredBeforeDisplay: true,
    command: `node scripts/question-integrity.mjs check --type <single-choice|multiple-choice|non-choice> --stem <题干> [--requirements <附加要求>] [--hints <提示语>] --answer <教练侧答案键或参考答案> [--original-answer <原错答案>]${runFlag}`,
    passToken: "QUESTION_INTEGRITY_PASS",
    rule: "所有复检题先审计再展示，并提供仅教练侧使用的答案键或参考答案；选择题必须显式标【单选题】或【多选题】且提示语为空；BLOCK 时重写并重新运行，只有 PASS 草稿可进入用户作答流程",
    lateDetection: invalidReviewDisposition(),
  };
}
