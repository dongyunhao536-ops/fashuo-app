// [gpt] 2026-08-14：统一教材名、用户自然说法与内部六科键，避免不同入口各自保存别名。

export const STUDY_SUBJECTS = Object.freeze(["刑法", "民法", "法理", "宪法", "法制史", "英语"]);

export const STUDY_SUBJECT_ALIASES = new Map([
  ["刑法学", "刑法"],
  ["民法学", "民法"],
  ["法理学", "法理"],
  ["宪法学", "宪法"],
  ["中国法制史", "法制史"],
  ["英语一", "英语"],
]);

export function normalizeStudySubject(value) {
  const normalized = String(value ?? "").trim();
  return (STUDY_SUBJECT_ALIASES.get(normalized) ?? normalized) || null;
}

export function assertStudySubject(value, label = "科目") {
  const normalized = normalizeStudySubject(value);
  if (!normalized || !STUDY_SUBJECTS.includes(normalized)) {
    throw new Error(`未知${label}：${normalized ?? "(空)"}`);
  }
  return normalized;
}
