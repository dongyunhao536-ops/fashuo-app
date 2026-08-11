// [gpt] 2026-08-10：从唯一排期账派生学习控制器模式；不另存可手改的“运行状态真相”。

const DAY = 86400000;

export const LEARNING_CONTROLLER_VERSION = "1.0";
export const CONTROLLER_MODES = Object.freeze(["normal", "constrained", "rescue", "recovery"]);

const MODE_POLICY = Object.freeze({
  normal: Object.freeze({ maxNewDaily: 3, maxP1PerWeek: 3, allowP2: true }),
  constrained: Object.freeze({ maxNewDaily: 2, maxP1PerWeek: 1, allowP2: false }),
  rescue: Object.freeze({ maxNewDaily: 1, maxP1PerWeek: 0, allowP2: false }),
  recovery: Object.freeze({ maxNewDaily: 2, maxP1PerWeek: 1, allowP2: false }),
});

function validDate(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDate(date, days) {
  if (!validDate(date)) throw new Error(`无效日期：${date}`);
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function weekMonday(date) {
  if (!validDate(date)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();
  return shiftDate(date, -(day === 0 ? 6 : day - 1));
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(3)) : null;
}

function weightOf(item) {
  const value = Number(item.acceptanceWeight ?? 1);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 1;
}

function completedBy(item, cutoff) {
  return item.status === "completed" && validDate(item.completedOn) && item.completedOn <= cutoff;
}

function bucket(items, cutoff) {
  const plannedWeight = items.reduce((sum, item) => sum + weightOf(item), 0);
  const completed = items.filter((item) => completedBy(item, cutoff));
  const completedWeight = completed.reduce((sum, item) => sum + weightOf(item), 0);
  const onTime = completed.filter((item) => item.completedOn <= item.dueDate);
  const onTimeWeight = onTime.reduce((sum, item) => sum + weightOf(item), 0);
  return {
    plannedUnits: items.length,
    plannedWeight,
    completedUnits: completed.length,
    completedWeight,
    strictRate: rate(completedWeight, plannedWeight),
    onTimeUnits: onTime.length,
    onTimeWeight,
    onTimeRate: rate(onTimeWeight, plannedWeight),
  };
}

function weekSummary(planItems, weekStart) {
  const weekEnd = shiftDate(weekStart, 6);
  const items = planItems.filter((item) => item.planWeek === weekStart);
  const byPriority = Object.fromEntries(["P0", "P1", "P2"].map((priority) => [priority, bucket(items.filter((item) => item.priority === priority), weekEnd)]));
  return {
    weekStart,
    weekEnd,
    ...bucket(items, weekEnd),
    byPriority,
    planIds: [...new Set(items.map((item) => item.planId))].sort(),
  };
}

function hasRate(week, predicate) {
  const p0 = week?.byPriority?.P0;
  return p0?.plannedWeight > 0 && p0.strictRate != null && predicate(p0.strictRate);
}

export function buildLearningController({ schedule, referenceDate, milestoneRisk = null, historyWeeks = 6 } = {}) {
  if (!validDate(referenceDate)) throw new Error("referenceDate 必须是 YYYY-MM-DD");
  if (!Number.isInteger(historyWeeks) || historyWeeks < 3 || historyWeeks > 12) throw new Error("historyWeeks 必须是 3-12 整数");
  const canonical = (schedule?.items ?? []).filter((item) => item.source === "canonical");
  const planItems = canonical.filter((item) => item.planId && item.planWeek && item.planSource);
  const currentWeek = weekMonday(referenceDate);
  const starts = Array.from({ length: historyWeeks + 1 }, (_, index) => shiftDate(currentWeek, (index - historyWeeks) * 7));
  const weeks = starts.map((start) => weekSummary(planItems, start));
  const completedWeeks = weeks.filter((week) => week.weekEnd < currentWeek);
  const last2 = completedWeeks.slice(-2);
  const last3 = completedWeeks.slice(-3);
  // [gpt] 2026-08-10：一周即使只有一个 P0，它也是明确承诺；连续两周失约就应降载，不能用“样本少”掩掉核心失败。
  const low2 = last2.length === 2 && last2.every((week) => hasRate(week, (value) => value < 0.6));
  const low3 = last3.length === 3 && last3.every((week) => hasRate(week, (value) => value < 0.6));
  const recovered = last3.length === 3
    && hasRate(last3[0], (value) => value < 0.6)
    && last3.slice(1).every((week) => hasRate(week, (value) => value >= 0.8));
  const overdueP0 = planItems.filter((item) => item.priority === "P0" && item.status !== "completed" && item.dueDate < referenceDate);

  let mode = "normal";
  let reason = "近三周没有触发自动降载条件";
  if (milestoneRisk === "red" || low3) {
    mode = "rescue";
    reason = milestoneRisk === "red" ? "里程碑风险已转红" : "连续三周 P0 严格兑现率低于 60%";
  } else if (low2 || overdueP0.length >= 2) {
    mode = "constrained";
    reason = low2 ? "连续两周 P0 严格兑现率低于 60%" : `当前已有 ${overdueP0.length} 个 P0 验收单元逾期`;
  } else if (recovered && overdueP0.length === 0) {
    mode = "recovery";
    reason = "一次低兑现周后连续两周 P0 严格兑现率达到 80%，进入观察恢复";
  }

  const policy = MODE_POLICY[mode];
  const weeksWithP0 = completedWeeks.filter((week) => week.byPriority.P0.plannedWeight > 0).length;
  return {
    version: LEARNING_CONTROLLER_VERSION,
    referenceDate,
    currentWeek,
    mode,
    reason,
    policy: {
      ...policy,
      preserveP0Acceptance: true,
      preserveDueMaintenance: true,
      strategicTargetChangesRequireReview: true,
    },
    triggers: {
      twoLowWeeks: low2,
      threeLowWeeks: low3,
      recoveredTwoWeeks: recovered,
      milestoneRisk: milestoneRisk ?? "unknown",
      overdueP0: overdueP0.length,
    },
    dataQuality: {
      attributedPlanUnits: planItems.length,
      weeksWithP0,
      sampleGateMet: last2.length === 2 && last2.every((week) => week.byPriority.P0.plannedWeight > 0),
      note: planItems.length ? null : "尚无带 plan_id/plan_week/plan_source 的结构化验收单元；控制器保持 normal，不把缺数据当执行良好",
    },
    weeks,
    current: weeks.at(-1),
    overdueP0: overdueP0.map((item) => ({ id: item.id, planId: item.planId, dueDate: item.dueDate, task: item.task })),
    policyText: mode === "normal"
      ? "正常承载 P0/P1/P2"
      : mode === "constrained"
        ? "冻结 P2、P1 每周最多 1 件、每日新增派单最多 2 件"
        : mode === "rescue"
          ? "只新增 P0，保留已到期维护义务；每日新增派单最多 1 件"
          : "继续冻结 P2、限制 P1；连续稳定后再恢复 normal",
  };
}

export function formatLearningController(controller) {
  const latest = controller.weeks.slice(-3).map((week) => {
    const p0 = week.byPriority.P0;
    return `${week.weekStart}:${p0.plannedWeight ? `${Math.round((p0.strictRate ?? 0) * 100)}%(${p0.completedWeight}/${p0.plannedWeight})` : "无P0数据"}`;
  }).join(" / ");
  return `学习控制器：${controller.mode}｜${controller.reason}｜${controller.policyText}｜近三周P0 ${latest}`;
}
