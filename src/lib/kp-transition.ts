import schedulerCfg from "../../config/scheduler.json";
import { bjDateStr } from "./dates";
import type { KpRow } from "./scheduler";

/**
 * kp_state 升降档状态机（纯逻辑，零 I/O）——从 detection.applyStateUpdate 抽出，便于单测。
 * 这是飞轮命门：升降档错=假掌握/假未过。所有写库/投递事件留在 detection 里，本模块只算"该变成什么"。
 *
 * Level/Grade 用本地字面量联合（与 detection 的同名类型结构等价，避免 detection↔本模块循环依赖）。
 */
export type Level = "L1" | "L2" | "L3";
export type Grade = "干净通过" | "勉强" | "未过";

const CFG = schedulerCfg;
const INTERVALS: number[] = CFG.间隔档_天 as number[];
const MAX_INTERVAL = INTERVALS.length - 1;
const DIFF_MIN = CFG.难度D.min;
const DIFF_MAX = CFG.难度D.max;
const LEVEL_ORDER: Level[] = ["L1", "L2", "L3"];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export interface TransitionResult {
  cur_level: Level;
  interval_idx: number;
  difficulty: number;
  mastered: boolean;
  statusField: "l1_status" | "l2_status" | "l3_status";
  statusValue: "passed" | "failed" | "untested";
  errorCountDelta: 0 | 1;
  nextDue: string; // 北京日历日
  lastReview: string; // 北京日历日
  /** 复测前该考点是否算"弱项"（曾错过 / 任一档 failed）——已强化判定用 */
  wasWeak: boolean;
  /** 是否应投「已强化」事件：曾弱 + 本次首次达成 mastered */
  shouldEmitStrengthened: boolean;
}

/**
 * 给定 (考点当前态, 检测档, 评分) 算出新状态。规则（与历史一致，已被单测锁定）：
 * - 干净通过：难度-1、间隔升一档、当前档<封顶则升档；该档 status=passed
 * - 勉强：同档重测，难度+1，间隔/档级不动；该档 status=untested
 * - 未过：难度+1、间隔退半档(-1)、档级不动、error_count+1；该档 status=failed
 * - mastered：按 cap_level 看对应档是否都 passed（本次结果实时并入）
 */
export function computeTransition(
  kp: KpRow,
  level: Level,
  grade: Grade,
  now: Date = new Date(),
): TransitionResult {
  let cur_level = kp.cur_level as Level;
  let interval_idx = kp.interval_idx;
  let difficulty = kp.difficulty;
  const cap = kp.cap_level as Level;

  if (grade === "干净通过") {
    difficulty = clamp(difficulty - 1, DIFF_MIN, DIFF_MAX);
    interval_idx = Math.min(interval_idx + 1, MAX_INTERVAL);
    const curIdx = LEVEL_ORDER.indexOf(level);
    const capIdx = LEVEL_ORDER.indexOf(cap);
    if (curIdx < capIdx) cur_level = LEVEL_ORDER[curIdx + 1];
  } else if (grade === "勉强") {
    difficulty = clamp(difficulty + 1, DIFF_MIN, DIFF_MAX);
  } else {
    difficulty = clamp(difficulty + 1, DIFF_MIN, DIFF_MAX);
    interval_idx = Math.max(interval_idx - 1, 0);
  }

  // 三档按 cap 全过 = mastered（本次档结果实时并入，其余档读历史 status）
  const l1ok = level === "L1" ? grade === "干净通过" : kp.l1_status === "passed";
  const l2ok = level === "L2" ? grade === "干净通过" : kp.l2_status === "passed";
  const l3ok = level === "L3" ? grade === "干净通过" : kp.l3_status === "passed";
  const mastered = cap === "L1" ? l1ok : cap === "L2" ? l1ok && l2ok : l1ok && l2ok && l3ok;

  const nextDays = INTERVALS[interval_idx];
  const nextDue = bjDateStr(new Date(now.getTime() + nextDays * 86400000));
  const lastReview = bjDateStr(now);

  const statusField = level === "L1" ? "l1_status" : level === "L2" ? "l2_status" : "l3_status";
  const statusValue = grade === "干净通过" ? "passed" : grade === "未过" ? "failed" : "untested";

  const wasWeak =
    kp.error_count > 0 || [kp.l1_status, kp.l2_status, kp.l3_status].includes("failed");

  return {
    cur_level,
    interval_idx,
    difficulty,
    mastered,
    statusField,
    statusValue,
    errorCountDelta: grade === "未过" ? 1 : 0,
    nextDue,
    lastReview,
    wasWeak,
    shouldEmitStrengthened: mastered && !kp.mastered && wasWeak,
  };
}
