import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";
import { parseReciteLedger } from "./lib/recite-ledger.mjs";

// [gpt] 2026-08-10：覆盖“证据 → 状态 → 排期”原子结案，以及任何预检失败都不改账。
describe("schedule CLI", () => {
  it("新增与完成都落在唯一 Markdown 事实源", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-"));
    const file = join(directory, "schedule.md");
    try {
      writeFileSync(file, "# 复盘排期\n", "utf8");
      execFileSync(process.execPath, ["scripts/schedule.mjs", "add", "--date", "2026-08-05", "--priority", "P0", "--type", "错题复检", "--task", "打 T#1", "--route", "cuoti-fupan", "--dimension", "application", "--id", "R1", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
      execFileSync(process.execPath, ["scripts/schedule.mjs", "done", "R1", "--result", "跨日通过", "--today", "2026-08-05", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
      const parsed = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });

      expect(parsed.counts).toMatchObject({ canonical: 1, completed: 1, dueToday: 0, errors: 0 });
      expect(parsed.items[0]).toMatchObject({ id: "R1", status: "completed", completedOn: "2026-08-05", result: "跨日通过", route: "cuoti-fupan", dimension: "application" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("通用协议化 episode 可结构化结案，不要求伪装成带背联动", () => {
    // [gpt] 2026-08-10：coach/lunshu/yingyu 等通用 owner 也必须能回写 outcome 并生成延迟窗口。
    const directory = mkdtempSync(join(tmpdir(), "schedule-generic-episode-"));
    const file = join(directory, "schedule.md");
    try {
      writeFileSync(file, `# 复盘排期
- [ ] 2026-08-05 | P1 | id=GENERIC | type=病根诊断 | task=只改一个验证轴 | route=coach-pc | dimension=exposure | subject=宪法 | pattern=other | pattern_scope=subject | intervention=other@coach-pc:exposure | episode=EP-GENERIC | protocol=diagnostic_probe | protocol_version=1 | window=immediate | baseline_risk=60 | expect=clean-pass | ref=本周P1
`, "utf8");
      execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "GENERIC",
        "--result", "诊断探针通过", "--outcome", "pass", "--cold", "false", "--prompt", "clean",
        "--today", "2026-08-05", "--file", file,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const parsed = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });
      expect(parsed.counts.errors).toBe(0);
      expect(parsed.items.find((item) => item.id === "GENERIC")).toMatchObject({ status: "completed", outcome: "pass", episodeStartedOn: "2026-08-05" });
      expect(parsed.items.find((item) => item.id === "EP-GENERIC-D3")).toMatchObject({ status: "pending", observationWindow: "d3", dueDate: "2026-08-08" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("route 命令只补执行路由并保留原任务与结案证据", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-route-"));
    const file = join(directory, "schedule.md");
    try {
      const original = "# 复盘排期\n- [x] 2026-08-05 | P1 | id=R1 | type=带背复检 | task=L9：冷检 | ref=本周周报 | completed=2026-08-06 | result=已拆单\n";
      writeFileSync(file, original, "utf8");
      execFileSync(process.execPath, [
        "scripts/schedule.mjs", "route", "R1",
        "--route", "daibei-pc", "--dimension", "recall",
        "--today", "2026-08-06", "--file", file,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const parsed = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-06" });
      expect(parsed.items[0]).toMatchObject({
        id: "R1", task: "L9：冷检", route: "daibei-pc", dimension: "recall",
        completedOn: "2026-08-06", result: "已拆单", status: "completed",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("done 联动回写带背挂账后再结案排期（一条命令一致性回写）", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-recite-"));
    const file = join(directory, "schedule.md");
    const reciteFile = join(directory, "ledger.md");
    const outbox = join(directory, "pending.jsonl");
    try {
      writeFileSync(file, "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=AUTO-RL9 | type=带背复检 | task=L9：冷启动复检 | ref=coach-engine:recite:L9:2026-08-05\n", "utf8");
      writeFileSync(reciteFile, `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L9｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`, "utf8");
      execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "AUTO-RL9",
        "--result", "四块全过",
        "--recite", "L9", "--event", "withdraw", "--outcome", "pass",
        "--cold", "true", "--prompt", "clean", "--evidence", "教材行20，四块覆盖",
        "--today", "2026-08-05", "--file", file, "--recite-file", reciteFile, "--outbox", outbox,
      ], { cwd: process.cwd(), encoding: "utf8" });

      const parsed = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-05" });
      expect(parsed.counts).toMatchObject({ canonical: 1, completed: 1, errors: 0 });
      expect(parsed.items[0]).toMatchObject({ id: "AUTO-RL9", status: "completed", result: "四块全过" });

      const ledgerText = readFileSync(reciteFile, "utf8");
      expect(ledgerText).toContain("状态：撤 08-05");
      expect(ledgerText).toContain("recite-evidence-v2");
      expect(ledgerText).toContain("recite-transition-v1");
      const ledger = parseReciteLedger(ledgerText, { referenceDate: "2026-08-05" });
      expect(ledger.records[0]).toMatchObject({ id: "L9", status: "withdrawn" });
      expect(ledger.records[0].explicitEvidence).toEqual([
        expect.objectContaining({ entryId: "L9", dimension: "recall", result: "pass", cold: true, promptIntegrity: "clean" }),
      ]);
      const attempt = JSON.parse(readFileSync(outbox, "utf8").trim());
      expect(attempt).toMatchObject({
        op: "learning_attempt",
        operation_id: ledger.evidenceEvents[0].operationId,
        sourceKind: "recite_ledger",
        sourceId: "L9",
        attemptRole: "recheck",
        result: "pass",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("延迟带背窗口用 observe 追加证据而不反复迁移状态", () => {
    // [gpt] 2026-08-10：撤池后的 D3/D14/D30 仍可冷检；通过只留证据，失败才 rehang。
    const directory = mkdtempSync(join(tmpdir(), "schedule-recite-observe-"));
    const file = join(directory, "schedule.md");
    const reciteFile = join(directory, "ledger.md");
    try {
      writeFileSync(file, `# 复盘排期
- [ ] 2026-08-08 | P1 | id=EP-R-D3 | type=带背复检·D3冷检 | task=【干预复检 D3】L9：结构化提取 | route=daibei-pc | dimension=recall | subject=法理 | kp=FL-0001 | pattern=memory_decay | pattern_scope=point | intervention=memory_decay@daibei-pc:recall | episode=EP-R | protocol=structured_recall | protocol_version=1 | window=d3 | episode_start=2026-08-05 | baseline_risk=70 | expect=clean-pass | ref=coach-engine:recite:L9:2026-08-05
`, "utf8");
      writeFileSync(reciteFile, `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L9｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-05** ｜ 状态：撤 08-05
`, "utf8");
      execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "EP-R-D3",
        "--result", "D3冷检通过",
        "--recite", "L9", "--event", "observe", "--outcome", "pass",
        "--cold", "true", "--prompt", "clean", "--evidence", "教材行20，冷启动复述",
        "--today", "2026-08-08", "--file", file, "--recite-file", reciteFile,
      ], { cwd: process.cwd(), encoding: "utf8" });

      const schedule = parseReviewSchedule(readFileSync(file, "utf8"), { referenceDate: "2026-08-08" });
      expect(schedule.counts.errors).toBe(0);
      expect(schedule.items.find((item) => item.id === "EP-R-D14")).toMatchObject({ status: "pending", observationWindow: "d14", dueDate: "2026-08-19" });
      const ledgerText = readFileSync(reciteFile, "utf8");
      expect(ledgerText).toContain("recite-evidence-v2");
      expect(ledgerText).not.toContain("recite-transition-v1");
      expect(parseReciteLedger(ledgerText, { referenceDate: "2026-08-08" }).records[0]).toMatchObject({ status: "withdrawn" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("排期预校验失败时绝不修改带背账本", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-preflight-"));
    const file = join(directory, "schedule.md");
    const reciteFile = join(directory, "ledger.md");
    try {
      writeFileSync(file, "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=REAL | type=带背复检 | task=L9：冷启动复检\n", "utf8");
      const originalLedger = `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L9｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
      writeFileSync(reciteFile, originalLedger, "utf8");
      expect(() => execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "MISSING",
        "--result", "四块全过",
        "--recite", "L9", "--event", "withdraw", "--outcome", "pass",
        "--cold", "true", "--prompt", "clean", "--evidence", "教材行20，四块覆盖",
        "--today", "2026-08-05", "--file", file, "--recite-file", reciteFile,
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })).toThrow();
      expect(readFileSync(reciteFile, "utf8")).toBe(originalLedger);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("排期与带背条目不对应时两份文件都不修改", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-link-mismatch-"));
    const file = join(directory, "schedule.md");
    const reciteFile = join(directory, "ledger.md");
    try {
      const originalSchedule = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=AUTO-RL9 | type=带背复检 | task=L9：冷启动复检 | ref=coach-engine:recite:L9:2026-08-05\n";
      const originalLedger = `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L10｜法理｜另一条挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
      writeFileSync(file, originalSchedule, "utf8");
      writeFileSync(reciteFile, originalLedger, "utf8");
      expect(() => execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "AUTO-RL9",
        "--result", "四块全过",
        "--recite", "L10", "--event", "withdraw", "--outcome", "pass",
        "--cold", "true", "--prompt", "clean", "--evidence", "教材行20",
        "--today", "2026-08-05", "--file", file, "--recite-file", reciteFile,
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })).toThrow();
      expect(readFileSync(file, "utf8")).toBe(originalSchedule);
      expect(readFileSync(reciteFile, "utf8")).toBe(originalLedger);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("缺少结构化结论时拒绝无证据结案，且两份文件保持不变", () => {
    const directory = mkdtempSync(join(tmpdir(), "schedule-missing-evidence-"));
    const file = join(directory, "schedule.md");
    const reciteFile = join(directory, "ledger.md");
    try {
      const originalSchedule = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=AUTO-RL9 | type=带背复检 | task=L9：冷启动复检 | ref=coach-engine:recite:L9:2026-08-05\n";
      const originalLedger = `# 带背挂账
<!-- recite-ledger: ignore-heading-counts -->
### L9｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
      writeFileSync(file, originalSchedule, "utf8");
      writeFileSync(reciteFile, originalLedger, "utf8");
      expect(() => execFileSync(process.execPath, [
        "scripts/schedule.mjs", "done", "AUTO-RL9",
        "--result", "四块全过",
        "--recite", "L9", "--event", "withdraw", "--cold", "true", "--prompt", "clean",
        "--evidence", "教材行20",
        "--today", "2026-08-05", "--file", file, "--recite-file", reciteFile,
      ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })).toThrow();
      expect(readFileSync(file, "utf8")).toBe(originalSchedule);
      expect(readFileSync(reciteFile, "utf8")).toBe(originalLedger);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
