import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";

describe("daibei-ledger CLI", () => {
  it("一次命令同步当前状态与 append-only 流水", () => {
    const directory = mkdtempSync(join(tmpdir(), "daibei-ledger-"));
    const file = join(directory, "ledger.md");
    try {
      writeFileSync(file, `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L1｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`, "utf8");
      execFileSync(process.execPath, ["scripts/daibei-ledger.mjs", "transition", "L1", "--event", "withdraw", "--evidence", "教材行10，跨日冷检通过", "--today", "2026-08-05", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
      const parsed = parseReciteLedger(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });
      const flow = summarizeReciteTransitions(parsed, { start: "2026-08-05", end: "2026-08-05" });

      expect(parsed.records[0]).toMatchObject({ id: "L1", status: "withdrawn", lastTouchedOn: "2026-08-05" });
      expect(flow.total).toBe(1);
      expect(flow.transitions[0]).toMatchObject({ event: "withdraw", fromStatus: "active", toStatus: "withdrawn", evidence: "教材行10，跨日冷检通过" });
      expect(parsed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("evidence 命令同步人读复检行与结构化栽点证据", () => {
    const directory = mkdtempSync(join(tmpdir(), "daibei-evidence-"));
    const file = join(directory, "ledger.md");
    try {
      writeFileSync(file, `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### X1｜刑法｜程度词
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`, "utf8");
      execFileSync(process.execPath, [
        "scripts/daibei-ledger.mjs", "evidence", "X1",
        "--dimension", "recall", "--result", "fail", "--cold", "true", "--prompt", "clean",
        "--pattern", "degree_strength", "--diagnosis", "pending",
        "--anchor", "教材#第68条", "--note", "把可以答成应当",
        "--today", "2026-08-05", "--file", file,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const markdown = readFileSync(file, "utf8");
      const parsed = parseReciteLedger(markdown, { referenceDate: "2026-08-05" });

      expect(parsed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(parsed.records[0].explicitEvidence).toEqual([
        expect.objectContaining({ result: "fail", cold: true, failurePatternCode: "degree_strength", diagnosisStatus: "pending" }),
      ]);
      expect(markdown).toContain("**冷复检（08-05）**：✗");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("真实复检证据与统一尝试 outbox 使用同一个稳定 operation_id", () => {
    // [gpt] 2026-08-10：显式 --outbox 让临时账本也能验证双文件联动，不触碰真实学习账。
    const directory = mkdtempSync(join(tmpdir(), "daibei-attempt-"));
    const file = join(directory, "ledger.md");
    const outbox = join(directory, "pending.jsonl");
    try {
      writeFileSync(file, `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### X1｜刑法｜程度词
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`, "utf8");
      execFileSync(process.execPath, [
        "scripts/daibei-ledger.mjs", "evidence", "X1",
        "--dimension", "recall", "--result", "pass", "--cold", "true", "--prompt", "clean",
        "--anchor", "教材#第18行", "--note", "能区分可以与应当",
        "--today", "2026-08-05", "--file", file, "--outbox", outbox,
      ], { cwd: process.cwd(), encoding: "utf8" });

      const parsed = parseReciteLedger(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });
      const operation = JSON.parse(readFileSync(outbox, "utf8").trim());
      expect(operation).toMatchObject({
        op: "learning_attempt",
        operation_id: parsed.evidenceEvents[0].operationId,
        subject: "刑法",
        questionRef: "recite:X1",
        sourceKind: "recite_ledger",
        sourceId: "X1",
        attemptRole: "recheck",
        dimension: "recall",
        result: "pass",
        cold: true,
        projectEvidence: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
