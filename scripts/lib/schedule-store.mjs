import { parseReviewSchedule } from "./assessment-ledgers.mjs";

export function cleanScheduleValue(value) {
  return String(value ?? "")
    .replace(/[\r\n|]/g, (character) => character === "|" ? "／" : " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateItem(item) {
  const normalized = {
    id: cleanScheduleValue(item.id),
    date: cleanScheduleValue(item.date),
    priority: cleanScheduleValue(item.priority).toUpperCase(),
    type: cleanScheduleValue(item.type),
    task: cleanScheduleValue(item.task),
    ref: cleanScheduleValue(item.ref),
  };
  if (!normalized.id) throw new Error("排期缺少 id");
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.date)) throw new Error("排期 date 必须是 YYYY-MM-DD");
  if (!/^P[0-2]$/.test(normalized.priority)) throw new Error("排期 priority 只能是 P0/P1/P2");
  if (!normalized.type) throw new Error("排期缺少 type");
  if (!normalized.task) throw new Error("排期缺少 task");
  return normalized;
}

/**
 * 只生成一个通过 parseReviewSchedule 复验的排期文档；调用方决定何时落盘。
 * dedupeRefPrefix 用于自动派单：同一知识对象已有未完成任务时，不重复追加。
 */
export function appendScheduleItem(markdown, item, { referenceDate, dedupeRefPrefix = null } = {}) {
  const normalized = validateItem(item);
  const before = parseReviewSchedule(markdown, { referenceDate });
  if (before.counts.errors) throw new Error(`现有复盘排期有 ${before.counts.errors} 个结构错误，拒绝追加`);
  if (before.items.some((entry) => entry.source === "canonical" && entry.id === normalized.id)) {
    return { markdown: String(markdown), added: false, reason: "duplicate-id", item: normalized };
  }
  const refPrefix = cleanScheduleValue(dedupeRefPrefix);
  if (refPrefix && before.open.some((entry) => String(entry.ref ?? "").startsWith(refPrefix))) {
    return { markdown: String(markdown), added: false, reason: "open-ref", item: normalized };
  }
  const section = String(markdown).includes("## 结构化排期（机器读取）")
    ? ""
    : "\n## 结构化排期（机器读取）\n\n> 新条目只用下列格式；旧散文保留作历史证据，不再复制第二份状态。\n";
  const ref = normalized.ref ? ` | ref=${normalized.ref}` : "";
  const line = `- [ ] ${normalized.date} | ${normalized.priority} | id=${normalized.id} | type=${normalized.type} | task=${normalized.task}${ref}`;
  const next = `${String(markdown).trimEnd()}${section}\n${line}\n`;
  const after = parseReviewSchedule(next, { referenceDate });
  if (after.counts.errors) throw new Error(`追加后的复盘排期有 ${after.counts.errors} 个结构错误，拒绝落盘`);
  return { markdown: next, added: true, reason: null, item: normalized };
}
