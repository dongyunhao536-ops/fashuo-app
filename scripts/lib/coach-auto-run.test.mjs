// [claude] 2026-08-25：`coach.mjs log --auto-run` 的准入判定回归。
// 这段逻辑决定要不要替用户建一个会写学习事实的 Run，判错就留孤儿 Run；
// 每条拒绝都必须发生在 startSkillRun 之前，所以这里逐条钉死。

import { describe, expect, it } from "vitest";
import { AUTO_RUN_NAMES, resolveAutoRunTransaction } from "./coach-auto-run.mjs";

const base = { activity: "背诵", recitationMode: "自背", chapter: "第二章 夏商西周春秋战国法律制度" };

describe("coach log --auto-run 准入", () => {
  it("没要求自动建 Run 时返回 null，不干扰原有手工路径", () => {
    expect(resolveAutoRunTransaction({ autoRun: null, ...base })).toBeNull();
    expect(resolveAutoRunTransaction({})).toBeNull();
  });

  it("自背进度正常建立 daibei-pc/progress 事务", () => {
    expect(resolveAutoRunTransaction({ autoRun: "daibei-progress", ...base }))
      .toEqual({ name: "daibei-progress", skill: "daibei-pc", kind: "progress" });
  });

  it("progress-only 是独立事务，用于用户明确不抽查", () => {
    expect(resolveAutoRunTransaction({ autoRun: "daibei-progress-only", ...base }))
      .toEqual({ name: "daibei-progress-only", skill: "daibei-pc", kind: "progress-only" });
    expect(AUTO_RUN_NAMES).toEqual(["daibei-progress", "daibei-progress-only"]);
  });

  it("裸 --auto-run 与未知事务都拒绝，不给无条件开关", () => {
    expect(() => resolveAutoRunTransaction({ autoRun: true, ...base })).toThrow(/必须指名事务/);
    expect(() => resolveAutoRunTransaction({ autoRun: "cuoti-intake", ...base })).toThrow(/不认识事务/);
  });

  // 核心回归：--activity 带背 会规范成「背诵」但方式不合法，
  // --activity 背诵 连方式都没有；旧实现只看规范活动名，两者都会先建 Run 再在写回预检失败。
  it("带背与裸背诵在建 Run 之前就被拒，不留孤儿 Run", () => {
    expect(() => resolveAutoRunTransaction({
      autoRun: "daibei-progress", activity: "背诵", recitationMode: "带背", chapter: base.chapter,
    })).toThrow(/只受理自背进度/);
    expect(() => resolveAutoRunTransaction({
      autoRun: "daibei-progress", activity: "背诵", recitationMode: null, chapter: base.chapter,
    })).toThrow(/只受理自背进度/);
  });

  it("非背诵活动、缺章节、与 --run 冲突时拒绝", () => {
    expect(() => resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", activity: "看书" }))
      .toThrow(/只用于背诵进度/);
    expect(() => resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", chapter: null }))
      .toThrow(/需要 --chapter/);
    expect(() => resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", chapter: true }))
      .toThrow(/需要 --chapter/);
    expect(() => resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", run: "SR-20260825-000000-abcdef12" }))
      .toThrow(/互斥/);
  });

  // --stage 不同步，而 progress Run 没有事后补签回执的恢复桥；放行等于造一个永远签不上的 Run。
  it("--auto-run 与 --stage 互斥", () => {
    expect(() => resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", stage: true }))
      .toThrow(/--stage 互斥/);
  });

  it("--run 传成布尔或空串时不算冲突，仍按未提供处理", () => {
    expect(resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", run: true }))
      .toMatchObject({ kind: "progress" });
    expect(resolveAutoRunTransaction({ ...base, autoRun: "daibei-progress", run: "  " }))
      .toMatchObject({ kind: "progress" });
  });
});
