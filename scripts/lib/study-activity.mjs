// [gpt] 2026-08-16：学习活动统一用“背诵”；带背/自背只作为方式详情，不再拆成两个 activity。
export const STUDY_ACTIVITIES = Object.freeze(["听课", "看书", "做题", "背诵", "复盘", "其他"]);

const ACTIVITY_SET = new Set(STUDY_ACTIVITIES);
const ACTIVITY_ALIASES = new Map([
  ["阅读精刷", "做题"],
  ["带背", "背诵"],
  ["自背", "背诵"],
]);

const RECITATION_MODE_BY_ALIAS = new Map([
  ["带背", "带背"],
  ["自背", "自背"],
]);
const RECITATION_MODE_MARKER = /\[背诵方式=(带背|自背)\]/u;

export function normalizeStudyActivity(value, { defaultActivity = "其他" } = {}) {
  if (value == null || value === "" || value === false) return defaultActivity;

  const raw = String(value).trim();
  if (!raw) return defaultActivity;

  const normalized = ACTIVITY_ALIASES.get(raw) ?? raw;
  if (!ACTIVITY_SET.has(normalized)) {
    throw new Error(`activity 不合法：${raw}；允许 ${STUDY_ACTIVITIES.join("|")}`);
  }
  return normalized;
}

export function recitationModeFromActivity(value) {
  const raw = value == null ? "" : String(value).trim();
  return RECITATION_MODE_BY_ALIAS.get(raw) ?? null;
}

export function withRecitationModeMarker(rawInput, mode) {
  const raw = rawInput == null || rawInput === false ? "" : String(rawInput).trim();
  if (!mode) return raw || null;
  const marker = `[背诵方式=${mode}]`;
  if (RECITATION_MODE_MARKER.test(raw)) {
    return raw.replace(RECITATION_MODE_MARKER, marker);
  }
  return raw ? `${marker} ${raw}` : marker;
}
