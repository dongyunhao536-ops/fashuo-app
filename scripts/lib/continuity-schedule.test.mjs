// [gpt] 2026-08-24：锁定北京时间、跨夏令时和失败不推进状态。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as runScheduledBackup } from "../continuity-backup-scheduler.mjs";
import { backupDue, beijingScheduleSlot, readContinuityState } from "./continuity-schedule.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stateFile() {
  const directory = mkdtempSync(join(tmpdir(), "continuity-schedule-"));
  directories.push(directory);
  return join(directory, "state.json");
}

describe("Beijing continuity schedule", () => {
  it("PDT 与 PST 都映射到同一个北京 22:30 槽位", () => {
    expect(beijingScheduleSlot("2026-08-24T14:30:00.000Z")).toMatchObject({
      beijingDate: "2026-08-24",
      beijingTime: "22:30",
      eligibleDate: "2026-08-24",
    });
    expect(beijingScheduleSlot("2026-12-01T14:30:00.000Z")).toMatchObject({
      beijingDate: "2026-12-01",
      beijingTime: "22:30",
      eligibleDate: "2026-12-01",
    });
  });

  it("北京 22:30 前补前一日，之后结算当日", () => {
    expect(beijingScheduleSlot("2026-08-24T14:29:00.000Z").eligibleDate).toBe("2026-08-23");
    expect(beijingScheduleSlot("2026-08-24T14:30:00.000Z").eligibleDate).toBe("2026-08-24");
    expect(backupDue({ lastCompletedBeijingDate: "2026-08-24" }, { eligibleDate: "2026-08-24" })).toBe(false);
  });

  it("只有备份成功才推进北京日状态，失败留待下次补跑", () => {
    const file = stateFile();
    expect(() => runScheduledBackup([], {
      now: new Date("2026-08-24T14:30:00.000Z"),
      appRoot: "/tmp/fashuo-app",
      stateFile: file,
      runBackup: () => { throw new Error("network down"); },
    })).toThrow(/network down/);
    expect(existsSync(file)).toBe(false);

    let calls = 0;
    expect(runScheduledBackup([], {
      now: new Date("2026-08-24T14:31:00.000Z"),
      appRoot: "/tmp/fashuo-app",
      stateFile: file,
      runBackup: () => { calls += 1; },
    })).toBe(0);
    expect(calls).toBe(1);
    expect(readContinuityState(file)).toMatchObject({ lastCompletedBeijingDate: "2026-08-24" });
    expect(JSON.parse(readFileSync(file, "utf8")).schemaVersion).toBe(1);

    runScheduledBackup([], {
      now: new Date("2026-08-24T15:30:00.000Z"),
      appRoot: "/tmp/fashuo-app",
      stateFile: file,
      runBackup: () => { calls += 1; },
    });
    expect(calls).toBe(1);
  });
});
