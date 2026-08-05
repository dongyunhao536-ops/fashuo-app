import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReciteLedger, summarizeReciteTransitions } from "./lib/recite-ledger.mjs";

describe("daibei-ledger transition CLI", () => {
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
});
