// [gpt] 2026-08-24：锁定 LaunchAgent 命令、环境文件和北京时间调度入口。
import { describe, expect, it } from "vitest";
import { renderLaunchAgent } from "../install-continuity-backup-launchd.mjs";

describe("continuity backup LaunchAgent", () => {
  it("使用绝对 Node/调度器/env 路径，每小时半点检查并写日志", () => {
    const plist = renderLaunchAgent({
      appRoot: "/Users/test/Projects/fashuo-app",
      nodePath: "/opt/homebrew/bin/node",
    });
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>--env-file=/Users/test/Projects/fashuo-app/.env.local</string>");
    expect(plist).toContain("<string>/Users/test/Projects/fashuo-app/scripts/continuity-backup-scheduler.mjs</string>");
    expect(plist).not.toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("continuity-backup.error.log");
  });

  it("拒绝非法分钟", () => {
    expect(() => renderLaunchAgent({ appRoot: "/tmp/app", minute: 60 })).toThrow(/minute/);
  });
});
