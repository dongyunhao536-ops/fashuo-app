// [gpt] 2026-08-26：Claude enforce 规范 handler 的真实子进程回归；锁定注入、单次阻断与防循环。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "claude-enforce-hook-"));
  directories.push(directory);
  return {
    directory,
    runFile: join(directory, "runs.jsonl"),
    turnFile: join(directory, "turns.jsonl"),
    env: {
      ...process.env,
      FASHUO_REPO_ROOT: process.cwd(),
      FASHUO_PRODUCER_HOST: "claude",
      FASHUO_SESSION_ID: "claude-session",
      FASHUO_SKILL_RUN_FILE: join(directory, "runs.jsonl"),
      FASHUO_SKILL_TURN_FILE: join(directory, "turns.jsonl"),
    },
  };
}

function invoke(env, input) {
  const result = spawnSync(process.execPath, ["scripts/claude-skill-guard.mjs"], {
    cwd: process.cwd(),
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function events(file) {
  return readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

describe("Claude Skill enforce 规范 handler", () => {
  it("命中时注入执行契约，缺 Run 只阻断一次并以双锁防循环", () => {
    const { env, turnFile } = fixture();
    const routed = invoke(env, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session",
      prompt_id: "prompt-1",
      prompt: "复盘错题",
    });
    expect(routed.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(routed.hookSpecificOutput.additionalContext).toContain("expected=cuoti-fupan");

    const blocked = invoke(env, {
      hook_event_name: "Stop",
      session_id: "claude-session",
      stop_hook_active: false,
      last_assistant_message: "没有执行 Run 就回答",
    });
    expect(blocked).toMatchObject({ decision: "block" });
    expect(blocked.reason).toContain("code=missing_run");
    expect(events(turnFile).at(-1)).toMatchObject({
      event: "stop_checked",
      guardProfile: "enforce",
      guardHandler: "claude-enforce@6",
      continued: true,
      failureCode: "missing_run",
    });

    const finalFailure = invoke(env, {
      hook_event_name: "Stop",
      session_id: "claude-session",
      stop_hook_active: true,
      last_assistant_message: "第二次仍然没有执行 Run",
    });
    expect(finalFailure).not.toHaveProperty("decision");
    expect(finalFailure.systemMessage).toContain("未再次续跑以避免死循环");
    expect(events(turnFile).at(-1)).toMatchObject({ continued: false, guardProfile: "enforce" });
  });

  it("Stop 载荷缺防循环字段时 fail-open 但落可见错误", () => {
    const { env, turnFile } = fixture();
    const result = invoke(env, {
      hook_event_name: "Stop",
      session_id: "claude-session",
      last_assistant_message: "测试",
    });
    expect(result).toEqual({});
    expect(events(turnFile).at(-1)).toMatchObject({
      event: "guard_error",
      guardProfile: "enforce",
      guardHandler: "claude-enforce@6",
      failureCode: "hook_payload_invalid",
    });
  });
});
