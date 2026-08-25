// [gpt] 2026-08-24：统一 Codex turn_id 与 Claude prompt_id，避免 Run 身份写死 CODEX_THREAD_ID。

export const PRODUCER_HOSTS = Object.freeze(["codex", "claude", "unknown"]);
export const IDENTITY_STATES = Object.freeze(["full", "host_only", "legacy"]);
export const TURN_ID_SOURCES = Object.freeze(["turn_id", "prompt_id", "session_latest", "explicit", "none", "legacy"]);

function token(value, { max = 100 } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized.length > max || /[\r\n]/u.test(normalized)) throw new Error(`宿主身份字段必须是 ${max} 字符内的单行值`);
  return normalized;
}

export function normalizeProducerHost(value) {
  const normalized = token(value, { max: 20 })?.toLowerCase() ?? null;
  if (!normalized) return null;
  if (!PRODUCER_HOSTS.includes(normalized)) throw new Error(`producerHost 只接受 ${PRODUCER_HOSTS.join("|")}`);
  return normalized;
}

export function inferProducerHost({ payload = {}, env = process.env } = {}) {
  const explicit = normalizeProducerHost(payload.producer_host ?? env.FASHUO_PRODUCER_HOST);
  if (explicit) return explicit;
  if (payload.prompt_id && !payload.turn_id) return "claude";
  if (payload.turn_id || env.CODEX_THREAD_ID) return "codex";
  return "unknown";
}

export function runtimeSessionId({ env = process.env, sessionId = null } = {}) {
  return token(sessionId ?? env.FASHUO_SESSION_ID ?? env.CODEX_THREAD_ID);
}

export function resolveHookIdentity(payload = {}, {
  env = process.env,
  sessionEvent = false,
} = {}) {
  const producerHost = inferProducerHost({ payload, env });
  const sessionId = runtimeSessionId({ env, sessionId: payload.session_id });
  let turnId = null;
  let turnIdSource = "none";
  if (!sessionEvent && producerHost === "claude") {
    turnId = token(payload.prompt_id);
    // [gpt] 2026-08-25：Claude Code 官方 Stop schema 不保证 prompt_id（部分真实版本会额外提供）。
    // 缺失时保留“按本 session 最新 prompt_routed 对账”的显式来源，后续只允许 Claude 使用该回落。
    turnIdSource = turnId
      ? "prompt_id"
      : payload.hook_event_name === "Stop" && sessionId
        ? "session_latest"
        : "none";
  } else if (!sessionEvent && producerHost === "codex") {
    turnId = token(payload.turn_id);
    turnIdSource = turnId ? "turn_id" : "none";
  } else if (!sessionEvent) {
    turnId = token(payload.turn_id ?? payload.prompt_id);
    turnIdSource = payload.turn_id ? "turn_id" : payload.prompt_id ? "prompt_id" : "none";
  }
  return {
    producerHost,
    sessionId,
    turnId: sessionEvent ? "__session__" : turnId,
    turnIdSource,
    identityState: sessionId && (sessionEvent || turnId) ? "full" : "host_only",
  };
}

export function resolveRuntimeIdentity({
  env = process.env,
  producerHost = null,
  sessionId = null,
  turnId = null,
  turnIdSource = null,
} = {}) {
  const normalizedHost = normalizeProducerHost(producerHost ?? env.FASHUO_PRODUCER_HOST)
    ?? (env.CODEX_THREAD_ID ? "codex" : "unknown");
  const normalizedSessionId = runtimeSessionId({ env, sessionId });
  const normalizedTurnId = token(turnId);
  const normalizedSource = turnIdSource == null
    ? (normalizedTurnId ? "explicit" : "none")
    : token(turnIdSource, { max: 20 });
  if (!TURN_ID_SOURCES.includes(normalizedSource)) {
    throw new Error(`turnIdSource 只接受 ${TURN_ID_SOURCES.join("|")}`);
  }
  return {
    producerHost: normalizedHost,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    turnIdSource: normalizedSource,
    identityState: normalizedSessionId && normalizedTurnId ? "full" : "host_only",
  };
}

export function legacyIdentity(event = {}) {
  return {
    producerHost: event.producerHost ?? "unknown",
    turnIdSource: event.turnIdSource ?? "legacy",
    identityState: event.identityState ?? "legacy",
  };
}
