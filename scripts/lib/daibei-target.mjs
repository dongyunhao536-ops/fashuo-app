// [gpt] 2026-08-14：只从明确条目语法提取带背 ID，避免把排期 R2026 或母版 v1 误认成条目。

const LEGACY_RECITE_PREFIXES = "LXMS";

export function extractDaibeiReciteIds(...values) {
  const source = values.map((value) => String(value ?? "")).join(" ");
  const ids = new Set();
  const exact = source.trim().match(/^([A-Z]\d+)$/u);
  if (exact) ids.add(exact[1]);
  for (const match of source.matchAll(/(?:RECITE-|recite:)([A-Z]\d+)(?=$|[^A-Z0-9])/gu)) ids.add(match[1]);
  for (const match of source.matchAll(new RegExp(`(?:^|[^A-Z0-9])([${LEGACY_RECITE_PREFIXES}]\\d+)(?=$|[^A-Z0-9])`, "gu"))) ids.add(match[1]);
  return [...ids];
}
