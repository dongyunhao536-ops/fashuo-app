// [gpt] 2026-08-24：把连续性备份锚定到北京时间，避免 macOS 本机时区和夏令时改写计划。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONTINUITY_STATE_SCHEMA_VERSION = 1;

function isoDate(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(normalized)) throw new Error(`${label} 必须是 YYYY-MM-DD`);
  return normalized;
}

function previousDate(value) {
  const date = new Date(`${isoDate(value, "北京日")}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function beijingScheduleSlot(now = new Date(), { hour = 22, minute = 30 } = {}) {
  const parsed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error("连续性备份调度时间无效");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("hour 必须是 0~23 的整数");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("minute 必须是 0~59 的整数");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const beijingDate = `${parts.year}-${parts.month}-${parts.day}`;
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const thresholdMinutes = hour * 60 + minute;
  return {
    beijingDate,
    beijingTime: `${parts.hour}:${parts.minute}`,
    eligibleDate: currentMinutes >= thresholdMinutes ? beijingDate : previousDate(beijingDate),
    threshold: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function readContinuityState(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`连续性备份状态不可读：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.schemaVersion !== CONTINUITY_STATE_SCHEMA_VERSION) throw new Error("连续性备份状态 schemaVersion 不兼容");
  return {
    schemaVersion: CONTINUITY_STATE_SCHEMA_VERSION,
    lastCompletedBeijingDate: isoDate(parsed.lastCompletedBeijingDate, "lastCompletedBeijingDate"),
    completedAt: String(parsed.completedAt ?? ""),
  };
}

export function backupDue(state, slot) {
  return !state?.lastCompletedBeijingDate || state.lastCompletedBeijingDate < slot.eligibleDate;
}

export function writeContinuityState(file, eligibleDate, now = new Date()) {
  const targetDate = isoDate(eligibleDate, "eligibleDate");
  const completedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const staging = `${file}.next-${process.pid}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(staging, `${JSON.stringify({
    schemaVersion: CONTINUITY_STATE_SCHEMA_VERSION,
    lastCompletedBeijingDate: targetDate,
    completedAt,
  }, null, 2)}\n`, "utf8");
  renameSync(staging, file);
}
