// [gpt] 2026-08-24：锁定宿主载荷缺字段时 fail-open 但可见，缺展示正文时不误判 drift。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPromptRoutedEvent, evaluateTurnCompliance, findGuardNotInvokedRuns } from "./skill-turn-guard.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function invoke(input) {
  const directory = mkdtempSync(join(tmpdir(), "guard-portability-"));
  directories.push(directory);
  const turnFile = join(directory, "turns.jsonl");
  const result = spawnSync(process.execPath, ["scripts/codex-skill-guard.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FASHUO_PRODUCER_HOST: "codex",
      CODEX_THREAD_ID: "session-1",
      FASHUO_SKILL_TURN_FILE: turnFile,
      FASHUO_SKILL_RUN_FILE: join(directory, "runs.jsonl"),
    },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return {
    result,
    events: readFileSync(turnFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
  };
}

describe("Skill guard 宿主可移植性", () => {
  it("UserPromptSubmit 缺 turn_id 时放行会话但落 hook_payload_invalid", () => {
    const { result, events } = invoke({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "复盘错题",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(events.at(-1)).toMatchObject({ event: "guard_error", failureCode: "hook_payload_invalid" });
  });

  it("Stop 缺 stop_hook_active 时可见 fail-open，不进入阻断循环", () => {
    const { result, events } = invoke({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(events.at(-1)).toMatchObject({ event: "guard_error", failureCode: "hook_payload_invalid" });
  });

  it("宿主不提供 last_assistant_message 时不把已过题面 Gate 误判 display_drift", () => {
    const prompt = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "复盘错题",
    });
    const run = {
      runId: "SR-1",
      skill: "cuoti-fupan",
      sessionId: "session-1",
      status: "waiting_user",
      steps: {
        question_integrity_pass: { artifactHash: "a".repeat(64), artifactLength: 10 },
      },
      events: [
        { event: "started", turnId: "turn-1" },
        { event: "checkpoint_passed", phase: "question", turnId: "turn-1" },
      ],
    };
    expect(evaluateTurnCompliance(prompt, new Map([[run.runId, run]]), { lastAssistantMessage: null })).toMatchObject({
      compliant: true,
      failureCode: null,
    });
  });

  it("学习 Run 已启动但同宿主轮次没有 prompt_routed 时给出活性反证", () => {
    const started = {
      schemaVersion: 2,
      event: "started",
      runId: "SR-1",
      skill: "cuoti-fupan",
      runPurpose: "learning",
      producerHost: "codex",
      identityState: "full",
      sessionId: "session-1",
      turnId: "turn-1",
      observedAt: "2026-08-24T01:00:00.000Z",
    };
    expect(findGuardNotInvokedRuns([started], [])).toHaveLength(1);
    expect(findGuardNotInvokedRuns([started], [{
      event: "prompt_routed",
      producerHost: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
    }])).toEqual([]);
    expect(findGuardNotInvokedRuns([{ ...started, runPurpose: "simulation" }], [])).toEqual([]);
  });
});
