// [claude] 2026-08-25：ask-pc 证据卡渲染与硬校验。
//
// 起因：`完整运行参考.md` 第 53 行早就规定"引用不许只报行号，科目·章节·页码·
// 标题缺一不可"，但它只是一段文字。2026-08-25 答疑实测中我给的出处是
// 「教材文本行 60；讲义第 34 页·行 1308-1319」——缺科目、缺章节、缺标题，
// 云无法据此回教材复核，而这正是他要证据的全部意义。
//
// 对照组是 cuoti-fupan 的 judgment-result.mjs：同样叫"证据卡"，有渲染器加硬校验，
// 我一次都没绕过。所以这里照抄那套做法，把纯文字规定变成会 BLOCK 的闸。

export class AskEvidenceCardError extends Error {
  constructor(issues) {
    super(`证据卡校验未通过｜${issues.length} 项`);
    this.name = "AskEvidenceCardError";
    this.issues = issues;
  }
}

const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 100;

function text(value) {
  return String(value ?? "").trim();
}

function issue(code, field, message) {
  return { code, field, message };
}

/**
 * 教材/讲义引用必须四件套齐全。页码允许写"该书页码未知"，但必须显式写出来，
 * 不许省略——省略和"查不到"在读者那里是两回事。
 */
function normalizeTextbookCitation(value, issues) {
  const subject = text(value?.subject);
  const chapter = text(value?.chapter);
  const title = text(value?.title);
  const page = text(value?.page);
  const lines = text(value?.lines);
  const excerpt = text(value?.excerpt);
  if (!subject) issues.push(issue("textbook_subject_missing", "textbook.subject", "教材引用缺科目"));
  if (!chapter) issues.push(issue("textbook_chapter_missing", "textbook.chapter", "教材引用缺章节"));
  if (!title) issues.push(issue("textbook_title_missing", "textbook.title", "教材引用缺标题（目/小节名）"));
  if (!page) {
    issues.push(issue("textbook_page_missing", "textbook.page", "教材引用缺页码；确实查不到必须显式写「该书页码未知」，不许省略"));
  }
  if (!lines) issues.push(issue("textbook_lines_missing", "textbook.lines", "教材引用缺行号"));
  if (!excerpt) issues.push(issue("textbook_excerpt_missing", "textbook.excerpt", "教材引用缺原文摘引；只给出处不给原文等于让用户自己去翻"));
  return { subject, chapter, title, page, lines, excerpt };
}

function normalizeOptional(value, label, issues, field) {
  const normalized = text(value);
  if (!normalized) {
    issues.push(issue(`${field}_missing`, field, `${label}缺失；不适用要显式写「不适用」并能解释为什么`));
    return "";
  }
  return normalized;
}

export function validateAskEvidenceCard(input) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AskEvidenceCardError([issue("card_type", "$", "证据卡必须是对象")]);
  }
  const textbook = normalizeTextbookCitation(input.textbook, issues);
  const zhenti = normalizeOptional(input.zhenti, "真题锚点", issues, "zhenti");
  const xinde = normalizeOptional(input.xinde, "心得来源", issues, "xinde");
  const yixiao = normalizeOptional(input.yixiao, "易混库结果", issues, "yixiao");
  const updated = normalizeOptional(input.updated, "法律更新", issues, "updated");

  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_MIN || confidence > CONFIDENCE_MAX) {
    issues.push(issue("confidence_invalid", "confidence", "信心度必须是 0-100 的数字"));
  }

  // 纯法硕口径：证据卡里出现"法考"直接阻断。云 7-03 定的红线，混进来会污染答案。
  const haystack = JSON.stringify(input);
  if (haystack.includes("法考")) {
    issues.push(issue("fakao_contamination", "$", "证据卡出现「法考」；本仓一律纯法硕口径，不引法考观点"));
  }

  if (issues.length) throw new AskEvidenceCardError(issues);
  return { textbook, zhenti, xinde, yixiao, updated, confidence };
}

export function renderAskEvidenceCard(card) {
  const { textbook: t } = card;
  const lowConfidence = card.confidence < 70;
  const lines = [
    "┌─ 证据卡 ─",
    `│ 教材：《考试分析》·${t.subject}·${t.chapter}·${t.title}·${t.page}·${t.lines}`,
    `│       「${t.excerpt}」`,
    `│ 真题：${card.zhenti}`,
    `│ 心得：${card.xinde}`,
    `│ 易混：${card.yixiao}`,
    "│ 法硕立场：纯法硕口径（不掺教材外观点）",
    `│ 法律更新：${card.updated}`,
    `│ 信心度：${card.confidence}%${lowConfidence ? "（<70%，必须提醒核对标答）" : ""}`,
    "└─",
  ];
  return lines.join("\n");
}
