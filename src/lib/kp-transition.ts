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

/**
 * 难度 D → 可达的最高间隔档（rung cap）。这是把"一直被无视的 difficulty 字段"真正接进算法的开关：
 * 正常卡（D≤6）满档（可到 30 天），happy path 与旧版完全一致；越难（老错/老勉强 → D 越高）
 * 复习间隔封得越近，逼着你稳定答对、把难度降下来，才允许把间隔放长。防"半生不熟的卡漂到 30 天"。
 *   D≤6→30天 / D7→15天 / D8→7天 / D≥9→3天
 */
function rungCapForDifficulty(d: number): number {
  if (d <= 6) return MAX_INTERVAL; // 4 → 30 天
  if (d === 7) return 3; // 15 天
  if (d === 8) return 2; // 7 天
  return 1; // D≥9 → 3 天，老大难压在近端高频滚
}

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
 * 给定 (考点当前态, 检测档, 评分) 算出新状态。规则（2026-06-14 优化，难度 D 真正接进间隔）：
 * - 干净通过：难度-1、间隔升一档【但不超过难度门控 rungCap】、当前档<封顶则升档；status=passed
 * - 勉强：同档重测，难度+1，间隔/档级不动；status=untested（难度+1 会在下次通过时压低封顶间隔）
 * - 未过(遗忘)：难度+2、间隔【退两档】(忘了就尽快再见)、档级不动、error_count+1；status=failed
 * - mastered：按 cap_level 看对应档是否都 passed（本次结果实时并入）；失手会复算掉 mastered → 回炉
 * difficulty 是"忘性指数"：错/勉强累加、稳过递减，越高复习间隔封得越近（见 rungCapForDifficulty）。
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
    // 门控用【复习前】的难度：硬卡这一轮先压住，本次通过把难度降下来，下一轮才解锁更长间隔
    //（"先证明变简单，才放长"）。否则一次通过就立刻 -1 解锁，门控等于没接。
    const rungCap = rungCapForDifficulty(difficulty);
    difficulty = clamp(difficulty - 1, DIFF_MIN, DIFF_MAX);
    if (interval_idx < rungCap) interval_idx = Math.min(interval_idx + 1, MAX_INTERVAL);
    const curIdx = LEVEL_ORDER.indexOf(level);
    const capIdx = LEVEL_ORDER.indexOf(cap);
    if (curIdx < capIdx) cur_level = LEVEL_ORDER[curIdx + 1];
  } else if (grade === "勉强") {
    difficulty = clamp(difficulty + 1, DIFF_MIN, DIFF_MAX);
  } else {
    // 未过=遗忘：难度+2、间隔退两档尽快再见（旧版只退一档，30天的卡忘了还要等15天才回，太松）
    difficulty = clamp(difficulty + 2, DIFF_MIN, DIFF_MAX);
    interval_idx = Math.max(interval_idx - 2, 0);
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
