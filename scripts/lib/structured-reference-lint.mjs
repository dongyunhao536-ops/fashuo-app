// [gpt] 2026-08-25：F6 只 lint 新增的用户可见结构化文本；历史台账不回写，并列编号串整体豁免。

const BARE_REFERENCE = /(?<![A-Za-z0-9])(?:#\d+|[LTEX]\d+)/gu;
const CJK = /\p{Script=Han}/u;
const LEADING_PUNCTUATION = /^[\s:：\-—|｜·；;,.。()（）[\]【】]+/u;

function isParallelSeparator(value) {
  const withoutDates = String(value).replace(/[（(]\d{2}-\d{2}[）)]/gu, "");
  return withoutDates.length > 0 && /^[\s／/、，＋]+$/u.test(withoutDates);
}

function lineIssues(line, lineNumber, summaryWindow) {
  const matches = [...String(line).matchAll(BARE_REFERENCE)];
  const groups = [];
  for (const match of matches) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    if (previous && isParallelSeparator(line.slice(previous.index + previous[0].length, match.index))) {
      previousGroup.push(match);
    } else {
      groups.push([match]);
    }
  }

  const issues = [];
  for (const group of groups) {
    // “L28／L29／L30”作为一个可读列表，不要求给每个编号机械重复摘要。
    if (group.length > 1) continue;
    const match = group[0];
    const tail = line.slice(match.index + match[0].length).replace(LEADING_PUNCTUATION, "");
    const window = [...tail].slice(0, summaryWindow).join("");
    if (!CJK.test(window)) {
      issues.push(Object.freeze({
        code: "bare_reference_summary_required",
        reference: match[0],
        line: lineNumber,
        column: match.index + 1,
      }));
    }
  }
  return issues;
}

export function findBareStructuredReferences(value, { summaryWindow = 10 } = {}) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line, index) => lineIssues(line, index + 1, summaryWindow));
}

export function assertStructuredReferencesHaveSummary(value, { field = "结构化文本", summaryWindow = 10 } = {}) {
  const issues = findBareStructuredReferences(value, { summaryWindow });
  if (!issues.length) return String(value ?? "");
  const refs = [...new Set(issues.map((item) => item.reference))].join("、");
  throw new Error(`BARE_REFERENCE_SUMMARY_REQUIRED｜${field} 中 ${refs} 是孤立裸编号；编号后 10 字内须有内容摘要，并列编号串可整体列举`);
}
