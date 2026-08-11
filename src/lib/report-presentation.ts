// [gpt] 2026-08-10：报告展示层只做结构解析与渐进披露，不改写任何学习事实。

export type ReportPriority = "P0" | "P1" | "P2";

export interface MarkdownSection {
  title: string;
  body: string;
}

export interface PriorityAction {
  priority: ReportPriority;
  title: string;
  body: string;
}

export interface WeeklyPresentation {
  verdict: string | null;
  actionSection: MarkdownSection | null;
  actionIntro: string;
  actions: PriorityAction[];
  reviewSections: MarkdownSection[];
  evidenceSections: MarkdownSection[];
  preamble: string;
}

const ACTION_TITLE = /(下周指导|下周作战|作战卡|行动处方)/;
const VERDICT_TITLE = /(本周结论|周结论|总评|先看结论)/;
const EVIDENCE_TITLE = /(证据附录|数据附录|事实依据)/;

function trimBlock(lines: string[]) {
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n");
}

export function splitH2Sections(markdown: string): { preamble: string; sections: MarkdownSection[] } {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const sections: MarkdownSection[] = [];
  let current: { title: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    sections.push({ title: current.title, body: trimBlock(current.lines) });
  };

  for (const line of lines) {
    const heading = line.match(/^##(?!#)\s+(.+?)\s*$/);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();
  return { preamble: trimBlock(preamble), sections };
}

function cleanInlineMarkdown(value: string) {
  return value
    .replace(/^\s*(?:[-*>]+|#{1,6})\s*/, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, limit = 220) {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function extractVerdict(markdown: string, verdictSection: MarkdownSection | null) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const labels = ["一句话钉死", "一句话结论", "一句话对账"];
  for (const label of labels) {
    const line = lines.find((item) => item.includes(label));
    if (line) {
      const colon = line.search(/[：:]/);
      const text = cleanInlineMarkdown(colon >= 0 ? line.slice(colon + 1) : line);
      if (text) return clip(text);
    }
  }

  const quote = lines.find((line) => /^>\s*(?:一句话|结论|判定)?[：:]?\s*\S/.test(line));
  if (quote) return clip(cleanInlineMarkdown(quote));

  if (verdictSection) {
    const first = verdictSection.body.split("\n").find((line) => cleanInlineMarkdown(line));
    if (first) return clip(cleanInlineMarkdown(first));
  }
  return null;
}

function parsePriorityHeading(line: string): { priority: ReportPriority; title: string } | null {
  let text = line.trim().replace(/^#{2,4}\s+/, "");
  if (text.startsWith("**") && text.endsWith("**")) text = text.slice(2, -2).trim();
  const match = text.match(/^(?:第\s*\d+\s*件\s*)?[【[]\s*(P[012])(?:[-－]\d+)?\s*[】\]]\s*(.*)$/i);
  if (!match) return null;
  return { priority: match[1].toUpperCase() as ReportPriority, title: cleanInlineMarkdown(match[2]) || match[1].toUpperCase() };
}

export function splitPriorityActions(markdown: string): { intro: string; actions: PriorityAction[] } {
  const intro: string[] = [];
  const actions: PriorityAction[] = [];
  let current: { priority: ReportPriority; title: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    actions.push({ priority: current.priority, title: current.title, body: trimBlock(current.lines) });
  };

  for (const line of String(markdown ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = parsePriorityHeading(line);
    if (heading) {
      flush();
      current = { ...heading, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  flush();
  return { intro: trimBlock(intro), actions };
}

export function splitDispatchItems(dispatch: string | null | undefined): Array<{ priority: ReportPriority | null; text: string }> {
  const result: Array<{ priority: ReportPriority | null; text: string }> = [];
  const parts = String(dispatch ?? "").split(/\s*[｜|]\s*|\n+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^[【[]\s*(P[012])\s*[】\]]\s*(.+)$/i);
    if (match) {
      result.push({ priority: match[1].toUpperCase() as ReportPriority, text: match[2].trim() });
    } else if (result.length) {
      result[result.length - 1].text += `｜${part}`;
    } else {
      result.push({ priority: null, text: part });
    }
  }
  return result;
}

export function buildWeeklyPresentation(content: string): WeeklyPresentation {
  const { preamble, sections } = splitH2Sections(content);
  const actionSection = sections.find((section) => ACTION_TITLE.test(section.title)) ?? null;
  const verdictSection = sections.find((section) => VERDICT_TITLE.test(section.title)) ?? null;
  const evidenceSections = sections.filter((section) => EVIDENCE_TITLE.test(section.title));
  // 首屏只抽取 verdict 的第一句，但完整结论仍属于可追溯复盘，不能在折叠层丢失。
  const reviewSections = sections.filter((section) => section !== actionSection && !evidenceSections.includes(section));
  const actionParts = splitPriorityActions(actionSection?.body ?? "");
  return {
    verdict: extractVerdict(content, verdictSection),
    actionSection,
    actionIntro: actionParts.intro,
    actions: actionParts.actions,
    reviewSections,
    evidenceSections,
    preamble,
  };
}
