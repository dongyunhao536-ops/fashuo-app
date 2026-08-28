// [claude] 2026-08-25：`coach.mjs log --auto-run` 的准入判定。
// 抽成独立模块只为一件事——让它可被单测覆盖：这段逻辑决定"要不要替用户建一个会写学习事实的 Run"，
// 判错的代价是留下孤儿 Run 或写出无归属流水，不能只靠 CLI 冒烟。

// 刻意做成具名事务而不是裸开关：写学习事实的自动化一旦无条件，下一步就是拿它绕过目标冻结。
export const AUTO_RUN_TRANSACTIONS = new Map([
  ["daibei-progress", { skill: "daibei-pc", kind: "progress" }],
  ["daibei-progress-only", { skill: "daibei-pc", kind: "progress-only" }],
]);

export const AUTO_RUN_NAMES = [...AUTO_RUN_TRANSACTIONS.keys()];

/**
 * 返回 null 表示调用方没要求自动建 Run；抛错表示要求了但不满足准入条件。
 * 所有拒绝都必须发生在 startSkillRun 之前——建了 Run 再失败就是孤儿 Run。
 */
export function resolveAutoRunTransaction({
  autoRun,
  run = null,
  stage = false,
  activity = null,
  recitationMode = null,
  chapter = null,
} = {}) {
  if (autoRun == null) return null;
  if (autoRun === true) {
    throw new Error(`--auto-run 必须指名事务：${AUTO_RUN_NAMES.join(" | ")}`);
  }
  const name = String(autoRun).trim();
  const transaction = AUTO_RUN_TRANSACTIONS.get(name);
  if (!transaction) {
    throw new Error(`--auto-run 不认识事务「${name}」；可用：${AUTO_RUN_NAMES.join(" | ")}`);
  }
  if (run != null && run !== true && String(run).trim()) {
    throw new Error("--run 与 --auto-run 互斥：已有 Run 就直接传 --run，不要再自动建一个");
  }
  // --stage 故意不同步，而 progress Run 目前没有"先暂存、事后补签回执"的恢复桥；
  // 放行只会造出一个永远签不上 progress_recorded 的 Run。等有了正式恢复桥再开。
  if (stage) {
    throw new Error("--auto-run 与 --stage 互斥：暂存不同步会留下永远补不上回执的 Run；要暂存就手工 skill-run start 再 log --run，或去掉 --stage");
  }
  if (activity !== "背诵") {
    throw new Error(`--auto-run ${name} 只用于背诵进度；本次规范化后的活动是「${activity ?? "空"}」，请手工 start 对应 Skill 的 Run`);
  }
  // 光看规范活动名不够：--activity 带背 会规范成「背诵」但方式是带背，
  // --activity 背诵 则连方式都没有，两者都过不了写回预检。必须在建 Run 前就拦下。
  if (recitationMode !== "自背") {
    throw new Error(
      `--auto-run ${name} 只受理自背进度（--activity 自背）；本次背诵方式是「${recitationMode ?? "未标注"}」，`
      + "带背与未标注方式都过不了 progress 写回预检，放行只会留下一个孤儿 Run",
    );
  }
  if (chapter == null || chapter === true || !String(chapter).trim()) {
    throw new Error(`--auto-run ${name} 需要 --chapter <规范章节>；没有章节就没有可冻结的目标`);
  }
  return { name, ...transaction };
}
