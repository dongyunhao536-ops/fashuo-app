// [gpt] 2026-08-24：锁定双宿主身份字段、turn 来源与 host-only 降级。
import { describe, expect, it } from "vitest";
import {
  resolveHookIdentity,
  resolveRuntimeIdentity,
  runtimeSessionId,
} from "./host-identity.mjs";

describe("host identity", () => {
  it("Codex 使用 session_id + turn_id", () => {
    expect(resolveHookIdentity({
      session_id: "codex-session",
      turn_id: "codex-turn",
    }, { env: { CODEX_THREAD_ID: "fallback" } })).toEqual({
      producerHost: "codex",
      sessionId: "codex-session",
      turnId: "codex-turn",
      turnIdSource: "turn_id",
      identityState: "full",
    });
  });

  it("Claude 使用 prompt_id，不读取可能陈旧的 turn_id", () => {
    expect(resolveHookIdentity({
      session_id: "claude-session",
      prompt_id: "claude-prompt",
      turn_id: "stale-turn",
    }, { env: { FASHUO_PRODUCER_HOST: "claude" } })).toEqual({
      producerHost: "claude",
      sessionId: "claude-session",
      turnId: "claude-prompt",
      turnIdSource: "prompt_id",
      identityState: "full",
    });
  });

  it("Claude 会话注入失败时保留宿主分组并降级 host_only", () => {
    expect(resolveHookIdentity({ prompt_id: "claude-prompt" }, {
      env: { FASHUO_PRODUCER_HOST: "claude" },
    })).toMatchObject({
      producerHost: "claude",
      sessionId: null,
      turnId: "claude-prompt",
      identityState: "host_only",
    });
  });

  it("Claude Stop 无 prompt_id 时显式标记按 session 最新轮次回落", () => {
    expect(resolveHookIdentity({
      hook_event_name: "Stop",
      session_id: "claude-session",
      stop_hook_active: false,
    }, { env: { FASHUO_PRODUCER_HOST: "claude" } })).toEqual({
      producerHost: "claude",
      sessionId: "claude-session",
      turnId: null,
      turnIdSource: "session_latest",
      identityState: "host_only",
    });
  });

  it("Codex Stop 缺 turn_id 时不借用 Claude 的 session 回落", () => {
    expect(resolveHookIdentity({
      hook_event_name: "Stop",
      session_id: "codex-session",
      stop_hook_active: false,
    }, { env: { FASHUO_PRODUCER_HOST: "codex" } })).toMatchObject({
      producerHost: "codex",
      turnId: null,
      turnIdSource: "none",
      identityState: "host_only",
    });
  });

  it("运行时会话优先显式参数，再取 FASHUO_SESSION_ID，最后兼容 CODEX_THREAD_ID", () => {
    expect(runtimeSessionId({ env: { FASHUO_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" }, sessionId: "explicit" })).toBe("explicit");
    expect(runtimeSessionId({ env: { FASHUO_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" } })).toBe("claude");
    expect(runtimeSessionId({ env: { CODEX_THREAD_ID: "codex" } })).toBe("codex");
  });

  it("运行时未知宿主不伪装成 Codex", () => {
    expect(resolveRuntimeIdentity({ env: {}, sessionId: "session", turnId: "turn" })).toMatchObject({
      producerHost: "unknown",
      identityState: "full",
      turnIdSource: "explicit",
    });
  });
});
