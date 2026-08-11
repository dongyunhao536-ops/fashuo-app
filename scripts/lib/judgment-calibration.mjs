// 判断校准（2026-08-07）：把判断台账的兑现率转成可行动的校准报告。
// 闭环：事前落预测 → 到期对账 → 这里统计偏差 → coach-engine 按可信执行量调整派单 → 下一次更准。
import { assertValidJudgmentLedger } from "./judgment-ledger.mjs";

const DAY = 86400000;
export const MIN_CALIBRATION_SAMPLES = 5;

export const CALIBRATION_GROUPS = Object.freeze([
  { key: "任务量", label: "任务量预测（排期）", types: ["排期"] },
  { key: "进度", label: "进度判断（不驱动自动减量）", types: ["进度"] },
  { key: "栽点", label: "栽点预测（栽点/病根候选）", types: ["栽点", "病根候选"] },
  { key: "掌握度", label: "掌握度预测（掌握度/复检期）", types: ["掌握度", "复检期"] },
  { key: "事实", label: "事实预测（事实）", types: ["事实"] },
]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDate(date, days) {
  if (!validDate(date)) return null;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value));
}

// [gpt] 2026-08-10：hit/partial/miss 只表达计划兑现不足，不能据此推断“计划低估”。
function deviationOf(result) {
  if (result === "hit") return 0;
  if (result === "partial") return -0.5;
  return -1; // miss：计划量没兑现，视为高估一档
}

/**
 * 校准报告（P1）。输入 parseJudgmentLedger 的输出；输出按类型分组的兑现率、
 * 任务量偏差方向与减量建议、以及派单可信执行量系数（供 P2 coach-engine 消费）。
 * 规则：
 * - 只统计非种子、已对账（hit/miss/partial）的条目；void 不计。
 * - 窗口默认最近 30 天，按对账日（resolvedDate，缺省回退落账日）过滤。
 * - 任务量偏差：hit=0 / partial=-0.5 / miss=-1；只能识别“计划高估/兑现不足”，不能凭这些结果推断低估。
 * - 减量建议 = 高估幅度 ×0.75 就近取 5% 档，上限 30%；执行量系数钳在 [0.6, 1]，绝不自动加量。
 * - 样本 <5 一律不给建议、不给执行量系数——避免在噪声上调策略。
 */
export function calibrateJudgments(parsed, { referenceDate, windowDays = 30 } = {}) {
  assertValidJudgmentLedger(parsed, "校准");
  if (!validDate(referenceDate)) throw new Error("判断校准 referenceDate 必须是 YYYY-MM-DD");
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("判断校准 windowDays 必须是正整数");
  const to = referenceDate;
  const from = shiftDate(to, -(windowDays - 1));
  const items = (parsed?.items ?? []).filter((item) => {
    if (item.seed) return false;
    if (!["hit", "miss", "partial"].includes(item.result)) return false;
    const when = item.resolvedDate ?? item.date;
    return when >= from && when <= to;
  });

  const groupReports = CALIBRATION_GROUPS.map((group) => {
    const members = items.filter((item) => group.types.includes(item.type));
    const hit = members.filter((item) => item.result === "hit").length;
    const miss = members.filter((item) => item.result === "miss").length;
    const partial = members.filter((item) => item.result === "partial").length;
    const total = members.length;
    const hitRate = total ? Math.round((hit / total) * 100) : null;
    let deviation = null;
    let advice = null;

    if (group.key === "任务量" && total >= MIN_CALIBRATION_SAMPLES) {
      const mean = members.reduce((sum, item) => sum + deviationOf(item.result), 0) / total;
      if (mean <= -0.1) {
        const percent = Math.round(Math.abs(mean) * 100);
        const reductionPct = clamp(Math.round((percent * 0.75) / 5) * 5, 5, 30);
        deviation = { direction: "optimistic", percent, reductionPct };
        advice = `每日计划自动减少 ${reductionPct}%（可信执行量 = 计划量 × ${((100 - reductionPct) / 100).toFixed(2)}）`;
      } else {
        advice = "偏差不明显，保持当前计划量";
      }
    }

    if (!advice) {
      if (total < MIN_CALIBRATION_SAMPLES) advice = `样本不足（N<${MIN_CALIBRATION_SAMPLES}）：暂不调策略，继续对账`;
      else if (group.key === "事实") advice = hitRate >= 75 ? "保持" : "「查无即真」风险：事实断言必须二次证伪后再落账";
      else if (group.key === "栽点") advice = hitRate >= 75 ? "保持" : hitRate >= 60 ? "偏低：检查栽点认定是否偏松，或把伪栽点剔掉" : "明显偏低：出题前先拉原文锚点，判错从严、别宽进";
      else if (group.key === "掌握度") advice = hitRate >= 75 ? "保持" : hitRate >= 60 ? "复检判✓偏松：按硬闸收紧（缺关键限定语只给半✓）" : "判✓太宽：先贴原文限定语清单再逐项比对";
      else if (group.key === "进度") advice = hitRate >= 75 ? "保持；仅用于校正进度判断，不驱动自动派单减量" : "进度判断偏乐观：先核对真实学习流水与带背进度线，再报进度";
    }

    return { key: group.key, label: group.label, countable: total, hit, miss, partial, hitRate, deviation, advice };
  });

  const overallCountable = items.length;
  const overallHit = items.filter((item) => item.result === "hit").length;
  const overallRate = overallCountable ? Math.round((overallHit / overallCountable) * 100) : null;
  const quantity = groupReports.find((group) => group.key === "任务量");
  // [gpt] 2026-08-10：分科校准只审计栽点预测，不把兑现率冒充学生掌握率，也不直接驱动派单。
  const stumbleItems = items.filter((item) => ["栽点", "病根候选"].includes(item.type) && item.subject);
  const bySubject = Object.fromEntries([...new Set(stumbleItems.map((item) => item.subject))].sort().map((subject) => {
    const members = stumbleItems.filter((item) => item.subject === subject);
    const hit = members.filter((item) => item.result === "hit").length;
    const miss = members.filter((item) => item.result === "miss").length;
    const partial = members.filter((item) => item.result === "partial").length;
    const countable = members.length;
    const hitRate = countable ? Math.round((hit / countable) * 100) : null;
    const sufficient = countable >= MIN_CALIBRATION_SAMPLES;
    let advice = `样本不足（N<${MIN_CALIBRATION_SAMPLES}）：继续静默预测和逐题对账，不据此改变训练策略`;
    if (sufficient && hitRate >= 75) advice = "预测较稳：保持静默预测；仍须先取证，不能在题干中提示栽点";
    else if (sufficient && hitRate >= 60) advice = "预测偏低：降低诊断置信度，保留更多互斥病根候选，由用户认领";
    else if (sufficient) advice = "预测明显偏低：先核原始栽点和材料锚点，再出题；不得用画像替代逐题取证";
    return [subject, { subject, countable, hit, miss, partial, hitRate, sufficient, advice }];
  }));
  let executionFactor = null;
  if (quantity && quantity.countable >= MIN_CALIBRATION_SAMPLES && quantity.deviation?.direction === "optimistic") {
    const { percent, reductionPct } = quantity.deviation;
    executionFactor = { value: (100 - reductionPct) / 100, basis: `任务量历史高估 ${percent}%（按建议减量 ${reductionPct}%）` };
  }

  return {
    referenceDate: to,
    window: { from, to, days: windowDays },
    overall: { countable: overallCountable, hitRate: overallRate },
    groups: Object.fromEntries(groupReports.map((group) => [group.key, group])),
    stumblePredictionBySubject: bySubject,
    executionFactor,
  };
}

export function formatCalibrationReport(report) {
  const lines = [
    "=== 教练判断校准 ===",
    "",
    `周期：最近${report.window.days}天（${report.window.from} ~ ${report.window.to}）｜已对账 ${report.overall.countable} 条（种子不计）｜全局兑现率 ${report.overall.hitRate == null ? "—" : `${report.overall.hitRate}%`}`,
  ];
  for (const group of Object.values(report.groups)) {
    lines.push(
      "",
      group.label,
      `  兑现率 ${group.hitRate == null ? "—" : `${group.hitRate}%`}｜${group.countable} 条（命中 ${group.hit} / 未中 ${group.miss} / 部分 ${group.partial}）`,
    );
    if (group.deviation?.direction === "optimistic") lines.push(`  偏差 +${group.deviation.percent}% 乐观`);
    lines.push(`  建议 ${group.advice}`);
  }
  const subjects = Object.values(report.stumblePredictionBySubject ?? {});
  if (subjects.length) {
    lines.push("", "栽点预测·分科校准（教练预测兑现率，不是学生掌握率）");
    for (const subject of subjects) {
      lines.push(
        `  ${subject.subject}：兑现率 ${subject.hitRate}%｜${subject.countable} 条（命中 ${subject.hit} / 未中 ${subject.miss} / 部分 ${subject.partial}）${subject.sufficient ? "" : "｜低样本"}`,
        `    ${subject.advice}`,
      );
    }
  }
  if (report.executionFactor) {
    lines.push("", `派单校准：${report.executionFactor.basis} → 可信执行量系数 ${report.executionFactor.value.toFixed(2)}（已接 coach-engine dispatch）`);
  }
  lines.push("", "自纠偏闭环：提出判断 → 执行 → 验证 → 统计偏差 → 修改策略 → 下一次更准。");
  return lines.join("\n");
}
