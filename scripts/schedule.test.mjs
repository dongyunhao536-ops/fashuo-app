import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";

describe("schedule CLI", () => {
  it("新增与完成都落在唯一 Markdown 事实源", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-"));
    const file = join(directory, "schedule.md");
    try {
      writeFileSync(file, "# 复盘排期\n", "utf8");
      execFileSync(process.execPath, ["scripts/schedule.mjs", "add", "--date", "2026-08-05", "--priority", "P0", "--type", "错题复检", "--task", "打 T#1", "--id", "R1", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
      execFileSync(process.execPath, ["scripts/schedule.mjs", "done", "R1", "--result", "跨日通过", "--today", "2026-08-05", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
      const parsed = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });

      expect(parsed.counts).toMatchObject({ canonical: 1, completed: 1, dueToday: 0, errors: 0 });
      expect(parsed.items[0]).toMatchObject({ id: "R1", status: "completed", completedOn: "2026-08-05", result: "跨日通过" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
