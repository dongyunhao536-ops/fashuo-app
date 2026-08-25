// [gpt] 2026-08-24：锁定 Claude 空会话禁止建 Run、完整身份落 v2，以及 v1 只读兼容。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSkillTurnEvent, createPromptRoutedEvent } from "./skill-turn-guard.mjs";
import { endSkillRun, readSkillRunEvents, startSkillRun } from "./skill-run.mjs";

describe("Skill Run 宿主身份", () => {
  let directory;
  let runFile;
  let turnFile;
  let previous;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "skill-run-identity-"));
    runFile = join(directory, "runs.jsonl");
    turnFile = join(directory, "turns.jsonl");
    previous = {
      producerHost: process.env.FASHUO_PRODUCER_HOST,
      sessionId: process.env.FASHUO_SESSION_ID,
      codexThreadId: process.env.CODEX_THREAD_ID,
      turnFile: process.env.FASHUO_SKILL_TURN_FILE,
    };
    process.env.FASHUO_PRODUCER_HOST = "claude";
    process.env.FASHUO_SKILL_TURN_FILE = turnFile;
    delete process.env.FASHUO_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
  });

  afterEach(() => {
    for (const [key, value] of [
      ["FASHUO_PRODUCER_HOST", previous.producerHost],
      ["FASHUO_SESSION_ID", previous.sessionId],
      ["CODEX_THREAD_ID", previous.codexThreadId],
      ["FASHUO_SKILL_TURN_FILE", previous.turnFile],
    ]) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("Claude 缺 sessionId 时禁止新建 Run", () => {
    expect(() => startSkillRun({ skill: "coach-pc", file: runFile })).toThrow(/SKILL_IDENTITY_REQUIRED/);
  });

  it("Claude prompt_id 归一化后写入完整 v2 身份", () => {
    process.env.FASHUO_SESSION_ID = "claude-session";
    appendSkillTurnEvent(createPromptRoutedEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session",
      prompt_id: "claude-prompt",
      prompt: "帮我规划今晚",
    }), turnFile);

    const run = startSkillRun({ skill: "coach-pc", file: runFile });
    expect(run).toMatchObject({
      producerHost: "claude",
      sessionId: "claude-session",
      turnId: "claude-prompt",
      turnIdSource: "prompt_id",
      identityState: "full",
      runPurpose: "learning",
    });
    expect(run.events[0]).toMatchObject({ schemaVersion: 2, producerHost: "claude" });
  });

  it("Run 用途与中止归因有诚实默认值，也可记录确定原因", () => {
    process.env.FASHUO_SESSION_ID = "claude-session";
    appendSkillTurnEvent(createPromptRoutedEvent({
      session_id: "claude-session",
      prompt_id: "claude-prompt",
      prompt: "帮我规划今晚",
    }), turnFile);
    const first = startSkillRun({ skill: "coach-pc", file: runFile, runPurpose: "simulation" });
    const attributed = endSkillRun({
      runId: first.runId,
      outcome: "aborted",
      abortReason: "network_interrupted",
      abortSource: "system",
      file: runFile,
    });
    expect(attributed.runPurpose).toBe("simulation");
    expect(attributed.end).toMatchObject({ abortReason: "network_interrupted", abortSource: "system" });

    const second = startSkillRun({ skill: "coach-pc", file: runFile });
    const unattributed = endSkillRun({ runId: second.runId, outcome: "aborted", file: runFile });
    expect(unattributed.end).toMatchObject({ abortReason: "unattributed", abortSource: "unattributed" });
  });

  it("历史 v1 事件只读映射为 unknown/legacy，不回填文件", () => {
    const legacy = {
      schemaVersion: 1,
      eventId: "SE-LEGACY",
      runId: "SR-LEGACY",
      event: "started",
      observedAt: "2026-08-01T00:00:00.000Z",
      sessionId: "old-session",
      turnId: "old-turn",
      skill: "coach-pc",
    };
    appendFileSync(runFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const parsed = readSkillRunEvents(runFile);
    expect(parsed.issues).toEqual([]);
    expect(parsed.events[0]).toMatchObject({
      schemaVersion: 1,
      producerHost: "unknown",
      turnIdSource: "legacy",
      identityState: "legacy",
    });
  });
});
