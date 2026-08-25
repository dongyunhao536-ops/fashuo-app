// [gpt] 2026-08-24：回归 8-01 从犯事故：完整扫描必须找到“也是主犯”，并把同一答案 hash 锁到 grading。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReferenceAnswer, referenceEvidenceRef } from "./reference-answer.mjs";
import { recordManualSkillStep, recordReferenceAnswerBinding, startSkillRun } from "./skill-run.mjs";

const CASE_TEXT = `五、案例分析题
57.甲乙与 A 公司共同生产伪劣口罩。
58.另一道题。
五、案例分析题
57.【答案】
（1）甲、乙均系主犯。
（2）A 公司与甲、乙成立共同犯罪，也是主犯。
【点评及思路】回答时应全面评价材料事实。
58.【答案】
另一题答案。`;

describe("reference answer loader", () => {
  let root;
  let examRoot;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reference-answer-"));
    examRoot = join(root, "真题", "_文本");
    mkdirSync(examRoot, { recursive: true });
    writeFileSync(join(examRoot, "2022年法律硕士专业基础（非法学）及参考答案解析.txt"), CASE_TEXT, "utf8");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("跳过无答案的题干区，在答案区加载完整答案与点评", () => {
    const result = loadReferenceAnswer({ type: "case", year: "2022", question: 57, examTextRoot: examRoot });
    expect(result).toMatchObject({
      state: "found",
      completeScan: true,
      filesScanned: 1,
      sourceKind: "local_companion_reference",
    });
    expect(result.answer).toContain("A 公司与甲、乙成立共同犯罪，也是主犯");
    expect(result.answer).toContain("【点评及思路】");
    expect(result.referenceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("完整读完候选仍无答案时只返回 not_found_after_complete_scan", () => {
    const result = loadReferenceAnswer({ type: "case", year: "2022", question: 56, examTextRoot: examRoot });
    expect(result).toMatchObject({ state: "not_found_after_complete_scan", completeScan: true, filesScanned: 1 });
  });

  it("资料根不可用时返回 source_unavailable，不生成不存在断言", () => {
    const result = loadReferenceAnswer({ type: "essay", year: "2022", question: 57, examTextRoot: join(root, "missing") });
    expect(result).toMatchObject({ state: "source_unavailable", completeScan: false });
  });

  it("同一 Run 绑定 reference_answer_checked + grading_bound，之后禁止换 hash", () => {
    const runFile = join(root, "runs.jsonl");
    const previousSession = process.env.FASHUO_SESSION_ID;
    const previousTurnFile = process.env.FASHUO_SKILL_TURN_FILE;
    process.env.FASHUO_SESSION_ID = "session-1";
    process.env.FASHUO_SKILL_TURN_FILE = join(root, "turns.jsonl");
    try {
      const run = startSkillRun({
        skill: "lunshu-pc",
        subject: "刑法",
        kind: "case",
        sessionId: "session-1",
        turnId: "turn-1",
        file: runFile,
      });
      expect(() => recordManualSkillStep({
        runId: run.runId,
        step: "reference_answer_checked",
        evidenceRef: "口头声称已检查",
        file: runFile,
      })).toThrow(/只能由 reference-answer 加载器绑定/);
      const loaded = loadReferenceAnswer({ type: "case", year: "2022", question: 57, examTextRoot: examRoot });
      const evidenceRef = referenceEvidenceRef(loaded, { type: "case", year: "2022", question: 57 });
      const bound = recordReferenceAnswerBinding({
        runId: run.runId,
        referenceHash: loaded.referenceHash,
        evidenceRef,
        file: runFile,
      });
      expect(bound.steps.reference_answer_checked).toMatchObject({ status: "pass", referenceHash: loaded.referenceHash });
      expect(bound.steps.grading_bound).toMatchObject({ status: "pass", referenceHash: loaded.referenceHash });
      expect(() => recordReferenceAnswerBinding({
        runId: run.runId,
        referenceHash: "b".repeat(64),
        evidenceRef: "reference:changed",
        file: runFile,
      })).toThrow(/REFERENCE_BINDING_IMMUTABLE/);
    } finally {
      if (previousSession == null) delete process.env.FASHUO_SESSION_ID;
      else process.env.FASHUO_SESSION_ID = previousSession;
      if (previousTurnFile == null) delete process.env.FASHUO_SKILL_TURN_FILE;
      else process.env.FASHUO_SKILL_TURN_FILE = previousTurnFile;
    }
  });
});
