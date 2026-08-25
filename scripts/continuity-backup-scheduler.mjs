#!/usr/bin/env node
// [gpt] 2026-08-24：LaunchAgent 高频轻检查、北京日只执行一次；成功后才推进状态。
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { backupDue, beijingScheduleSlot, readContinuityState, writeContinuityState } from "./lib/continuity-schedule.mjs";
import { resolveAppRoot } from "./lib/workspace-paths.mjs";

export function main(argv = process.argv.slice(2), {
  now = new Date(),
  appRoot = resolveAppRoot(),
  stateFile = process.env.FASHUO_CONTINUITY_BACKUP_STATE_FILE,
  runBackup = null,
} = {}) {
  const args = new Set(argv);
  const dryRun = args.has("--dry-run");
  const help = args.has("--help") || args.has("-h");
  const known = new Set(["--dry-run", "--help", "-h"]);
  const unknown = [...args].filter((argument) => !known.has(argument));
  if (help) {
    console.log("用法：node scripts/continuity-backup-scheduler.mjs [--dry-run]");
    return 0;
  }
  if (unknown.length) throw new Error(`未知参数：${unknown.join(", ")}`);
  const resolvedStateFile = stateFile || join(appRoot, ".local", "system-observability", "continuity-backup-state.json");
  const slot = beijingScheduleSlot(now);
  const state = readContinuityState(resolvedStateFile);
  const due = backupDue(state, slot);
  if (!due) {
    console.log(`CONTINUITY_BACKUP_NOT_DUE｜北京 ${slot.beijingDate} ${slot.beijingTime}｜最近完成 ${state.lastCompletedBeijingDate}`);
    return 0;
  }
  if (dryRun) {
    console.log(`CONTINUITY_BACKUP_DUE｜应结算北京日 ${slot.eligibleDate}｜本次未执行备份、未写状态`);
    return 0;
  }
  const execute = runBackup ?? (() => execFileSync(process.execPath, [join(appRoot, "scripts", "backup-memory.mjs")], {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
  }));
  execute();
  writeContinuityState(resolvedStateFile, slot.eligibleDate, now);
  console.log(`CONTINUITY_BACKUP_SCHEDULED_OK｜已完成北京日 ${slot.eligibleDate}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`CONTINUITY_BACKUP_SCHEDULED_ERROR｜${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
