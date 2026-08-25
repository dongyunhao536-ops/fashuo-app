#!/usr/bin/env node
// [gpt] 2026-08-24：为 macOS 建立北京时间每日连续性备份 LaunchAgent；默认只预演。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAppRoot } from "./lib/workspace-paths.mjs";

export const LAUNCHD_LABEL = "com.fashuo.continuity-backup";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent({
  appRoot,
  nodePath = process.execPath,
  minute = 30,
} = {}) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("minute 必须是 0~59 的整数");
  const script = join(appRoot, "scripts", "continuity-backup-scheduler.mjs");
  const envFile = join(appRoot, ".env.local");
  const logDir = join(appRoot, ".local", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>--env-file=${xml(envFile)}</string>
    <string>${xml(script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(appRoot)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "continuity-backup.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "continuity-backup.error.log"))}</string>
</dict>
</plist>
`;
}

export function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const install = args.has("--install");
  const help = args.has("--help") || args.has("-h");
  const known = new Set(["--install", "--help", "-h"]);
  const unknown = [...args].filter((argument) => !known.has(argument));
  if (help) {
    console.log([
      "用法：node scripts/install-continuity-backup-launchd.mjs [--install]",
      "",
      "  无参数     只打印安装计划，不写 ~/Library/LaunchAgents、不调用 launchctl",
      "  --install  安装并加载北京时间每日 22:30 连续性备份任务",
    ].join("\n"));
    return;
  }
  if (unknown.length) throw new Error(`未知参数：${unknown.join(", ")}`);
  if (process.platform !== "darwin") throw new Error("LaunchAgent 只支持 macOS");

  const appRoot = resolveAppRoot();
  const envFile = join(appRoot, ".env.local");
  if (!existsSync(envFile)) throw new Error(`缺少环境文件：${envFile}`);
  const agentFile = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const plist = renderLaunchAgent({ appRoot });
  if (!install) {
    console.log(`预演：将安装 ${agentFile}`);
    console.log("计划：每小时半点做轻量到期检查，只在北京时间 22:30 后为当天成功备份一次；本次未写文件、未加载任务。");
    return;
  }

  mkdirSync(dirname(agentFile), { recursive: true });
  mkdirSync(join(appRoot, ".local", "logs"), { recursive: true });
  writeFileSync(agentFile, plist, "utf8");
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("launchctl", ["bootout", domain, agentFile], { stdio: "ignore" });
  } catch {
    // 尚未加载是正常的；随后 bootstrap 会给出真实结果。
  }
  execFileSync("launchctl", ["bootstrap", domain, agentFile], { stdio: "inherit" });
  execFileSync("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  console.log(`✓ 已安装并加载 ${LAUNCHD_LABEL}；未立即执行备份，下一次半点按北京时间日槽判断。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
