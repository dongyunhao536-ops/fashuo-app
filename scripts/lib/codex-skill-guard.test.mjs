// [gpt] 2026-08-12：以真实子进程和 UTF-8 stdin 验证 Codex hook 的注入、阻断与合规放行。

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function invoke(args, { env, input = null } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    input: input == null ? undefined : JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("Codex Skill 宿主 hook 子进程", () => {
  it("命中时注入约束，无 Run 时阻断一次，合规 Run 正常放行", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-skill-hook-"));
    const env = {
      ...process.env,
      CODEX_THREAD_ID: "hook-session",
      FASHUO_SKILL_RUN_FILE: join(directory, "runs.jsonl"),
      FASHUO_SKILL_TURN_FILE: join(directory, "turns.jsonl"),
    };

    expect(JSON.parse(invoke(["scripts/codex-skill-guard.mjs"], {
      env,
      input: { hook_event_name: "SessionStart", session_id: "hook-session", source: "startup", model: "gpt-test" },
    }))).toEqual({});

    const routed = JSON.parse(invoke(["scripts/codex-skill-guard.mjs"], {
      env,
      input: { hook_event_name: "UserPromptSubmit", session_id: "hook-session", turn_id: "turn-missing", prompt: "复盘错题", model: "gpt-test" },
    }));
    expect(routed.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(routed.hookSpecificOutput.additionalContext).toContain("expected=cuoti-fupan");

    const blocked = JSON.parse(invoke(["scripts/codex-skill-guard.mjs"], {
      env,
      input: { hook_event_name: "Stop", session_id: "hook-session", turn_id: "turn-missing", stop_hook_active: false, last_assistant_message: "未执行 Skill 就直接回答" },
    }));
    expect(blocked).toMatchObject({ decision: "block" });
    expect(blocked.reason).toContain("code=missing_run");

    invoke(["scripts/codex-skill-guard.mjs"], {
      env,
      input: { hook_event_name: "UserPromptSubmit", session_id: "hook-session", turn_id: "turn-pass", prompt: "帮我规划今晚", model: "gpt-test" },
    });
    const started = invoke(["scripts/skill-run.mjs", "start", "--skill", "coach-pc"], { env });
    const runId = started.match(/SKILL_RUN_STARTED｜([^｜\r\n]+)/u)?.[1];
    expect(runId).toBeTruthy();
    invoke(["--input-type=module", "-e", `import('./scripts/lib/skill-run.mjs').then((m) => m.recordAutomaticSkillStep({ runId: '${runId}', step: 'context_loaded', source: 'hook-test' }))`], { env });
    invoke(["scripts/skill-run.mjs", "end", "--run", runId, "--phase", "plan", "--done", "priority_checked,response_verified", "--ref", "weekly:P0+schedule"], { env });

    const allowed = JSON.parse(invoke(["scripts/codex-skill-guard.mjs"], {
      env,
      input: { hook_event_name: "Stop", session_id: "hook-session", turn_id: "turn-pass", stop_hook_active: false, last_assistant_message: "今晚先完成周 P0。" },
    }));
    expect(allowed).toEqual({});
  });
});
