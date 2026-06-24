/**
 * 答疑答案排版解析（纯函数，单测锁定）。
 *
 * 模型按 v2.3 教义会用框线符号拼两块半结构化内容：
 *  - 「答疑预检清单」：□ 1. 问题归类：… □ 2. 心得文件检索：… ＋末尾「判权规则：…」
 *  - 「证据卡」：│ 教材：… │ 真题：…（多行）或 | 教材：… | 真题：…（一行管道分隔）
 * 直接喂 Markdown 会把 ━┌│└□| 这些渲染成一堵墙。这里把两块从正文切出来，
 * 交给 AskAnswer 渲染成结构化卡片；其余散文仍走 Markdown。
 *
 * 对历史两种写法都容错：预检 □逐条 / 一行流；证据卡 │多行 / | 管道。
 * 解析失败（识别不到字段）则把该区间留回散文，绝不吞答案。
 */

const META_OPEN = "<<<ASK_META";

export interface PreflightItem {
  n: string; // 序号 "1".."6"，缺省空
  label: string; // 冒号前小标题，如「问题归类」
  value: string; // 冒号后内容
}
export interface PreflightBlock {
  items: PreflightItem[];
  ruling: string; // 判权规则一句话（可空）
}
export interface EvidenceField {
  label: string; // 教材 / 真题 / 心得 / 法硕立场 / 法律更新 / 信心度 / …
  value: string;
}
export type AnswerSegment =
  | { type: "md"; text: string }
  | { type: "preflight"; data: PreflightBlock }
  | { type: "evidence"; data: EvidenceField[] };

// 框线 / 项目符号字符（内容里的 ✨ 等表情不在内，保留）
const BOX = /[━─┄┅┈┉╌╍┃┌┐└┘├┤┬┴┼│⌐□▢☐◻▪◦•]/g;
function stripBox(s: string): string {
  return s
    .replace(BOX, " ")
    .replace(/[—–]{2,}/g, " ") // 破折号分隔线
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parsePreflightItems(region: string): PreflightItem[] {
  // 去掉「… 答疑预检清单 …」那行表头
  const afterHeader = region.replace(/[\s\S]*?答疑预检清单[^\n]*/, "");
  const parts = afterHeader.includes("□") ? afterHeader.split("□") : afterHeader.split(/\n+/);
  const items: PreflightItem[] = [];
  for (const p of parts) {
    const t = stripBox(p);
    if (!t || /^\d+$/.test(t)) continue;
    const m = t.match(/^(\d+)?\s*[.、]?\s*([^：:]{1,14})[：:]\s*([\s\S]*)$/);
    if (m) {
      items.push({ n: m[1] ?? "", label: m[2].trim(), value: m[3].trim() });
    } else if (items.length) {
      // 没冒号的续行，并入上一条，避免丢内容
      items[items.length - 1].value += (items[items.length - 1].value ? " " : "") + t;
    }
  }
  return items;
}

function parseEvidenceFields(content: string): EvidenceField[] {
  let body = content.replace(/[\s\S]*?证据卡/, ""); // 去表头到「证据卡」
  body = body.replace(/[└┘⌐─━\s]+$/, ""); // 去尾部收口
  const parts = body.split(/[|│\n]+/);
  const fields: EvidenceField[] = [];
  for (const p of parts) {
    const t = stripBox(p);
    if (!t) continue;
    const m = t.match(/^([^：:]{1,8})[：:]\s*([\s\S]*)$/);
    if (m && m[2].trim()) {
      fields.push({ label: m[1].trim(), value: m[2].trim() });
    } else if (fields.length) {
      fields[fields.length - 1].value += " " + t; // 续行
    }
  }
  return fields;
}

/** 把答案切成有序段：散文(md) / 预检清单 / 证据卡。识别不到块时整体回退为一段 md。 */
export function parseAskAnswer(raw0: string): AnswerSegment[] {
  const metaAt = raw0.indexOf(META_OPEN);
  const raw = (metaAt === -1 ? raw0 : raw0.slice(0, metaAt)).replace(/\r/g, "").trim();
  if (!raw) return [];

  // —— 预检清单区间：表头行 … 判权规则行（含）——
  let pre: { start: number; end: number; block: PreflightBlock } | null = null;
  const pHead = raw.match(/[^\n]*答疑预检清单[^\n]*/);
  if (pHead && pHead.index != null) {
    const lineStart = raw.lastIndexOf("\n", pHead.index - 1) + 1;
    const rIdx = raw.indexOf("判权规则", pHead.index);
    if (rIdx !== -1) {
      const rLineEnd = raw.indexOf("\n", rIdx);
      const end = rLineEnd === -1 ? raw.length : rLineEnd;
      const ruling = stripBox(raw.slice(rIdx, end)).replace(/^判权规则[：:]?\s*/, "");
      const items = parsePreflightItems(raw.slice(pHead.index, rIdx));
      if (items.length > 0) pre = { start: lineStart, end, block: { items, ruling } };
    }
  }

  // —— 证据卡区间：表头行 … 文末（META 已切）——
  let ev: { start: number; end: number; fields: EvidenceField[] } | null = null;
  const eHead = raw.match(/[^\n]*证据卡[^\n]*/);
  if (eHead && eHead.index != null && (!pre || eHead.index >= pre.end)) {
    const lineStart = raw.lastIndexOf("\n", eHead.index - 1) + 1;
    const fields = parseEvidenceFields(raw.slice(eHead.index));
    if (fields.length > 0) ev = { start: lineStart, end: raw.length, fields };
  }

  // —— 按文档顺序拼装 ——
  const blocks = [
    pre && { kind: "pre" as const, start: pre.start, end: pre.end, pre },
    ev && { kind: "ev" as const, start: ev.start, end: ev.end, ev },
  ]
    .filter((b): b is NonNullable<typeof b> => b != null)
    .sort((a, b) => a.start - b.start);

  const segs: AnswerSegment[] = [];
  const pushMd = (a: number, b: number) => {
    const t = raw.slice(a, b).trim();
    if (t) segs.push({ type: "md", text: t });
  };
  let cur = 0;
  for (const b of blocks) {
    pushMd(cur, b.start);
    if (b.kind === "pre") segs.push({ type: "preflight", data: b.pre.block });
    else segs.push({ type: "evidence", data: b.ev.fields });
    cur = b.end;
  }
  pushMd(cur, raw.length);
  return segs;
}
