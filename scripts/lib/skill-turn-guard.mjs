// [gpt] 2026-08-12：Codex 宿主级 Skill 路由与 Stop 审计；只保存 prompt hash，不保存用户原文。
// [gpt] 2026-08-24：v2 统一 Codex turn_id 与 Claude prompt_id，并允许 host_only 观察降级。

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalObservabilityFile, discoverObservabilityFiles } from "./observability-paths.mjs";
import {
  IDENTITY_STATES,
  TURN_ID_SOURCES,
  legacyIdentity,
  normalizeProducerHost,
  resolveHookIdentity,
  resolveRuntimeIdentity,
  runtimeSessionId,
} from "./host-identity.mjs";

export const SKILL_TURN_SCHEMA_VERSION = 2;
export const DEFAULT_SKILL_TURN_FILE = process.env.FASHUO_SKILL_TURN_FILE
  ?? canonicalObservabilityFile("skill-turns.jsonl", { moduleUrl: import.meta.url });

const CONTROLLED_SKILLS = new Set([
  "ask-pc",
  "coach-pc",
  "cuoti-fupan",
  "daibei-pc",
  "lunshu-pc",
  "yingyu-pc",
]);

// [gpt] 2026-08-26：已撤下的 Skill 只保留历史遥测兼容，不再参与显式路由、续跑或 Stop 硬闸。
const RETIRED_SKILLS = new Set(["shouke-pc"]);

const RETRY_PATTERN = /^SKILL_EXECUTION_GUARD_RETRY\|skill=([a-z-]+)\|code=([a-z_]+)/u;
const RUN_PURPOSES = new Set(["learning", "diagnostic", "simulation"]);
const SYSTEM_DIAGNOSTIC_INTENT = /(?:诊断|监控|迁移|升级|代码|脚本|配置|故障|速度慢|日志|遥测|机制|执行.{0,8}(?:慢|异常|问题|不严格|不完整)|为什么.{0,8}(?:不执行|没执行|失效))/u;
// [gpt] 2026-08-26：“Claude 那边也可以正常授课吗”是在核验宿主能力，不是要求立即开课。
const SYSTEM_CAPABILITY_INTENT = /(?:(?:claude|codex|skill|入口|守卫|系统|那边|这边).{0,20}(?:可以|能|能否|是否|能不能|可不可以).{0,12}(?:正常)?(?:授课|上课|运行|使用)|(?:可以|能|能否|是否|能不能|可不可以).{0,12}(?:在)?(?:claude|codex|那边|这边).{0,12}(?:正常)?(?:授课|上课|运行|使用))/iu;
// [gpt] 2026-08-26：文档名含“授课Skill方案”不等于开课；仅在技术表面与维护动作同时出现时排除。
const SYSTEM_DOCUMENT_MAINTENANCE_INTENT = /(?:(?:docs\/|\.md\b|skill|hook|handler|claude-enforce|codex|claude).{0,50}(?:文档|说明|版本|更新|同步|没更新|未更新|漂移)|(?:文档|说明|版本|更新|同步|漂移).{0,50}(?:docs\/|\.md\b|skill|hook|handler|claude-enforce|codex|claude))/iu;
const EXPLICIT_SKILL_USE = /(?:使用|调用|按|走)\s*(?:ask-pc|coach-pc|cuoti-fupan|daibei-pc|lunshu-pc|yingyu-pc)/iu;
const LEGAL_DOMAIN = /(?:法硕|法律|刑法|民法|法理|宪法|法制史|犯罪|罪名|合同|侵权|物权|债权|人格权|婚姻|继承|居住权|租赁权|占有|所有权|监护|代理|时效|法条|司法解释|案例)/u;

const ROUTE_RULES = Object.freeze([
  {
    skill: "cuoti-fupan",
    pattern: /(?:记录|登记|上传).{0,8}(?:错题|错题截图)|(?:复盘|回看|重做|再考|销账|清理|清|抽查|考|检验).{0,8}(?:错题|老题|旧题|错题本)|(?:错题|老题|旧题).{0,8}(?:复盘|销账|重做|再考|抽查)|检验.{0,12}(?:做题弱项|应用弱项).{0,6}(?:掌握|会了)/u,
  },
  {
    skill: "daibei-pc",
    // [gpt] 2026-08-21：覆盖“记录进度，法制史第三章背诵完毕”这类先报章节、后说背完的真实口语。
    pattern: /(?:带我背|带背|领背|陪我背|背给你听|听我背|检验.{0,6}背诵|抽查.{0,6}背诵|今天.{0,8}背什么|这周.{0,8}背什么|背诵.{0,4}(?:进度|计划|安排|方法)|(?:记录|登记|汇报).{0,8}(?:背诵进度|背完|背诵完毕|背诵完成)|(?:刑法|民法|法理|宪法|法制史).{0,24}(?:背完|背诵完毕|背诵完成)|怎么背.{0,12}(?:刑法|民法|法理|宪法|法制史|这一章|这一节)?|各科背诵方法)/u,
  },
  {
    skill: "yingyu-pc",
    pattern: /(?:做|练|刷|精刷|带我做|讲|对答案|对一下).{0,12}(?:英语一?|阅读|Text\s*\d|真题)|(?:英语一?|阅读|作文).{0,12}(?:对答案|答案|讲解|复盘|怎么复习|怎么写|批改|改作文)|(?:批改|帮我改|修改|评分).{0,8}(?:英语)?作文|(?:考|检验).{0,8}英语套路/u,
  },
  {
    skill: "lunshu-pc",
    pattern: /(?:(?:练|写|做|来|出|考我)\s*(?:一(?:道|篇)?|个)?\s*(?:法综)?\s*(?:论述(?:题)?|案例(?:分析)?题|主观题))|(?:批改|修改|看看|评分).{0,12}(?:论述|案例(?:分析)?|主观题)|(?:我写好了|写完了|答完了).{0,12}(?:论述|案例(?:分析)?|主观题)?|(?:论述|案例(?:分析)?|主观题).{0,8}(?:写好了|写完了|答完了|怎么答|怎么写|如何拿分)/u,
  },
  {
    skill: "coach-pc",
    pattern: /(?:当|做).{0,4}(?:我的)?(?:教练|家教)|(?:聊聊|分析|调整|看看).{0,8}(?:规划|策略|节奏|备考安排)|(?:帮我)?(?:规划|安排).{0,6}(?:今晚|明天|今天|本周|这周)|(?:检验|考考|看看).{0,8}(?:掌握|理解|学会)|(?:我最近|最近|这两天|这周).{0,6}(?:学了|学习|进度|状态)|(?:我的|看看我的).{0,6}(?:弱项|进度|水平)|(?:有点|很|比较|最近)?(?:迷茫|焦虑|慌|崩|没状态|学不动)|(?:照这个|按这个|现在这个).{0,8}(?:节奏|进度).{0,8}(?:怎么办|来得及|能考上)/u,
  },
]);

// [gpt] 2026-08-25：“精讲讲义”曾跨词命中裸“讲讲”；排除教材/课程词形。
const ANSWER_INTENT = /(?:讲讲(?!义|完|课|稿|座)|解释|什么是|是什么意思|如何理解|怎么理解|为什么|区别|辨析|比较|这题选什么|选什么|怎么定性|如何认定|是否构成|法条什么意思|这个概念|这道题|如何评价|怎么判断)/u;
const CONTINUATION_INTENT = /^(?:继续|接着|再来|下一题|下一个|再来一(?:道|个|篇)|继续刚才的|往下)(?:吧|一下|一个|一题|一道|一篇)?[。！!？?]*$/u;
const SUBMISSION_CONTINUATION_INTENT = /(?:^|[，,。！!？?\s])(?:我)?(?:写好了|写完了|答完了|做完了|交卷|我的答案(?:是|：|:)?)(?:$|[，,。！!？?\s])/u;

function isSystemDiagnosticPrompt(text) {
  return SYSTEM_DIAGNOSTIC_INTENT.test(text)
    || SYSTEM_CAPABILITY_INTENT.test(text)
    || SYSTEM_DOCUMENT_MAINTENANCE_INTENT.test(text);
}

function timestamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Skill Turn 时间戳无效");
  return parsed.toISOString();
}

function beijingDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  return new Date(parsed.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function safeToken(value, label, { required = false, max = 160 } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label} 不能为空`);
  if (!normalized) return null;
  if (normalized.length > max || /[\r\n]/u.test(normalized)) throw new Error(`${label} 必须是 ${max} 字符内的单行值`);
  return normalized;
}

function hashPrompt(value) {
  return createHash("sha256").update(String(value ?? "").replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

// [gpt] 2026-08-26：Markdown 行尾双空格和 CRLF 只影响渲染，不改变 Gate artifact 的正文。
// 仅归一这两类展示噪声；标点、措辞、标签和普通内部空格仍逐字受 hash 保护。
function normalizeArtifactPresentation(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+(?=\n|$)/gu, "");
}

export function containsHashedArtifact(message, artifactHash, artifactLength) {
  const text = String(message ?? "").replace(/\r\n/gu, "\n");
  const hash = String(artifactHash ?? "");
  const length = Number(artifactLength);
  if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isInteger(length) || length < 1 || text.length < length) return false;
  for (let start = 0; start <= text.length - length; start += 1) {
    if (hashPrompt(text.slice(start, start + length)) === hash) return true;
  }
  const normalizedText = normalizeArtifactPresentation(text);
  if (normalizedText.length < length || normalizedText === text) return false;
  for (let start = 0; start <= normalizedText.length - length; start += 1) {
    if (hashPrompt(normalizedText.slice(start, start + length)) === hash) return true;
  }
  return false;
}

function eventBase({
  event,
  sessionId,
  turnId,
  producerHost = "unknown",
  turnIdSource = "none",
  identityState = sessionId && turnId ? "full" : "host_only",
  now = new Date(),
}) {
  const normalizedIdentityState = safeToken(identityState, "identityState", { required: true, max: 20 });
  const normalizedTurnIdSource = safeToken(turnIdSource, "turnIdSource", { required: true, max: 20 });
  if (!IDENTITY_STATES.includes(normalizedIdentityState) || normalizedIdentityState === "legacy") {
    throw new Error("新 Skill Turn 事件 identityState 只接受 full|host_only");
  }
  if (!TURN_ID_SOURCES.includes(normalizedTurnIdSource) || normalizedTurnIdSource === "legacy") {
    throw new Error("新 Skill Turn 事件 turnIdSource 只接受 turn_id|prompt_id|session_latest|explicit|none");
  }
  return {
    schemaVersion: SKILL_TURN_SCHEMA_VERSION,
    eventId: `ST-${randomUUID()}`,
    event,
    observedAt: timestamp(now),
    beijingDate: beijingDate(now),
    producerHost: normalizeProducerHost(producerHost) ?? "unknown",
    sessionId: safeToken(sessionId, "sessionId", { max: 100 }),
    turnId: safeToken(turnId, "turnId", { max: 100 }),
    turnIdSource: normalizedTurnIdSource,
    identityState: normalizedIdentityState,
  };
}

export function appendSkillTurnEvent(event, file = DEFAULT_SKILL_TURN_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

function readSkillTurnEventFile(file) {
  if (!existsSync(file)) return { events: [], issues: [] };
  const events = [];
  const issues = [];
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/u).entries()) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const event = JSON.parse(raw);
      if (![1, SKILL_TURN_SCHEMA_VERSION].includes(event?.schemaVersion) || !event?.event || !event?.observedAt) {
        throw new Error("缺少可兼容 schemaVersion/event/observedAt");
      }
      events.push(event.schemaVersion === 1 ? { ...event, ...legacyIdentity(event) } : event);
    } catch (error) {
      issues.push({
        code: "skill_turn_telemetry_unreadable",
        severity: "error",
        file,
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { events, issues };
}

export function readSkillTurnEvents(file) {
  const files = file
    ? [file]
    : process.env.FASHUO_SKILL_TURN_FILE
      ? [process.env.FASHUO_SKILL_TURN_FILE]
      : discoverObservabilityFiles("skill-turns.jsonl", { canonicalFile: DEFAULT_SKILL_TURN_FILE });
  const events = [];
  const issues = [];
  const seen = new Set();
  for (const source of files) {
    const parsed = readSkillTurnEventFile(source);
    issues.push(...parsed.issues);
    for (const event of parsed.events) {
      const key = event.eventId ?? `${event.sessionId}:${event.turnId}:${event.event}:${event.observedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  events.sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));
  return { events, issues, files };
}

export function findGuardNotInvokedRuns(runInput = [], turnInput = [], {
  windowStart = null,
  windowEnd = null,
} = {}) {
  const runEvents = Array.isArray(runInput) ? runInput : runInput.events ?? [];
  const turnEvents = Array.isArray(turnInput) ? turnInput : turnInput.events ?? [];
  const observedTurns = new Set(turnEvents.filter((event) => event.event === "prompt_routed")
    .map((event) => `${event.producerHost ?? "unknown"}:${event.sessionId ?? ""}:${event.turnId ?? ""}`));
  return runEvents.filter((event) => (
    event.event === "started"
      && event.schemaVersion === SKILL_TURN_SCHEMA_VERSION
      && event.runPurpose === "learning"
      && ["codex", "claude"].includes(event.producerHost)
      && event.identityState === "full"
      && inWindow(event.observedAt, windowStart, windowEnd)
      && !observedTurns.has(`${event.producerHost}:${event.sessionId ?? ""}:${event.turnId ?? ""}`)
  )).map((event) => ({
    runId: event.runId,
    skill: event.skill,
    producerHost: event.producerHost,
    sessionId: event.sessionId,
    turnId: event.turnId,
    observedAt: event.observedAt,
  }));
}

export function routeSkillPrompt(prompt) {
  const text = String(prompt ?? "").normalize("NFC").trim();
  if (!text) return null;
  if ([...RETIRED_SKILLS].some((skill) => new RegExp(`(?:^|[^a-z])${skill}(?:$|[^a-z])`, "iu").test(text))) {
    return null;
  }
  const retry = text.match(RETRY_PATTERN);
  if (retry && CONTROLLED_SKILLS.has(retry[1])) {
    return { skill: retry[1], source: "guard_retry", guardRetry: true, retryCode: retry[2] };
  }
  // [gpt] 系统诊断即使点名某个 Skill，也不应被误路由成学习答疑；显式“使用/按某 Skill”仍保留。
  const systemDiagnostic = isSystemDiagnosticPrompt(text);
  if (systemDiagnostic && !EXPLICIT_SKILL_USE.test(text)) {
    return null;
  }
  for (const skill of CONTROLLED_SKILLS) {
    if (new RegExp(`(?:^|[^a-z])${skill}(?:$|[^a-z])`, "iu").test(text)) {
      return { skill, source: "explicit_skill", guardRetry: false };
    }
  }
  for (const rule of ROUTE_RULES) {
    if (rule.pattern.test(text)) return { skill: rule.skill, source: "strong_trigger", guardRetry: false };
  }
  if (ANSWER_INTENT.test(text) && LEGAL_DOMAIN.test(text) && !systemDiagnostic) {
    return { skill: "ask-pc", source: "legal_answer", guardRetry: false };
  }
  return null;
}

function latestActiveRun(runs, sessionId) {
  return [...(runs?.values?.() ?? [])]
    .filter((run) => CONTROLLED_SKILLS.has(run.skill) && run.sessionId === sessionId && !run.end)
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
}

function latestClosedRun(runs, sessionId, now, maxAgeMinutes = 30) {
  const nowMs = new Date(now).getTime();
  return [...(runs?.values?.() ?? [])]
    .filter((run) => {
      if (!CONTROLLED_SKILLS.has(run.skill) || run.sessionId !== sessionId || !run.end || run.end.outcome === "aborted") return false;
      const observedMs = new Date(run.lastEventAt).getTime();
      return Number.isFinite(nowMs) && Number.isFinite(observedMs) && nowMs >= observedMs
        && (nowMs - observedMs) / 60000 <= maxAgeMinutes;
    })
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
}

function latestRecentPromptRoute(events, sessionId, now, maxAgeMinutes = 30) {
  const nowMs = new Date(now).getTime();
  return [...(events ?? [])].reverse().find((event) => {
    if (event.event !== "prompt_routed" || event.sessionId !== sessionId) return false;
    const observedMs = new Date(event.observedAt).getTime();
    return Number.isFinite(nowMs) && Number.isFinite(observedMs) && nowMs >= observedMs
      && (nowMs - observedMs) / 60000 <= maxAgeMinutes;
  }) ?? null;
}

export function createPromptRoutedEvent(payload = {}, runs = new Map(), now = new Date(), { previousPromptEvents = [] } = {}) {
  const identity = resolveHookIdentity(payload);
  const { sessionId, turnId } = identity;
  if (!turnId) throw new Error(`${identity.producerHost} UserPromptSubmit 缺少可用 turn_id/prompt_id`);
  const prompt = String(payload.prompt ?? "");
  const route = routeSkillPrompt(prompt);
  const active = sessionId ? latestActiveRun(runs, sessionId) : null;
  // [gpt] 2026-08-12：普通交卷、同 Skill 强触发和法律追问均续用活动 Run；只有明确指向不同 Skill 的强触发才切换。
  const normalizedPrompt = prompt.normalize("NFC").trim();
  const systemDiagnostic = isSystemDiagnosticPrompt(normalizedPrompt) && !EXPLICIT_SKILL_USE.test(normalizedPrompt);
  const activeReply = active && (
    (!route && !systemDiagnostic)
      || route?.source === "legal_answer"
      || route?.skill === active.skill
      || SUBMISSION_CONTINUATION_INTENT.test(` ${normalizedPrompt} `)
  ) ? active : null;
  const shortContinuation = sessionId && !active && CONTINUATION_INTENT.test(normalizedPrompt);
  const recentPrompt = shortContinuation ? latestRecentPromptRoute(previousPromptEvents, sessionId, now) : null;
  // [gpt] 2026-08-26：短“继续”只继承紧邻的最近 prompt；若中间已经进入系统诊断/修复
  // （expectedSkill=null），不能让更早的已收口学习 Run 抢回路由。没有 prompt 遥测时才回退到
  // 30 分钟内的已收口 Run，兼容宿主刚启动或历史数据缺口。
  const closed = shortContinuation && !recentPrompt ? latestClosedRun(runs, sessionId, now) : null;
  const promptContinuationSkill = CONTROLLED_SKILLS.has(recentPrompt?.expectedSkill) ? recentPrompt.expectedSkill : null;
  const closedCandidate = closed?.end?.outcome === "handoff" ? closed.end.handoffSkill : closed?.skill;
  const closedContinuationSkill = CONTROLLED_SKILLS.has(closedCandidate) ? closedCandidate : null;
  const expectedSkill = activeReply?.skill ?? route?.skill ?? promptContinuationSkill ?? closedContinuationSkill ?? null;
  return {
    ...eventBase({ event: "prompt_routed", ...identity, now }),
    expectedSkill,
    expectedRunId: activeReply?.runId ?? null,
    routeSource: activeReply
      ? "active_run"
      : route?.source ?? (promptContinuationSkill ? "continuation_prompt" : closedContinuationSkill ? "continuation" : "none"),
    intentHint: null,
    guardRetry: Boolean(route?.guardRetry),
    retryCode: route?.retryCode ?? null,
    promptHash: hashPrompt(prompt),
    promptLength: prompt.length,
    model: safeToken(payload.model, "model", { max: 80 }),
  };
}

export function currentCodexTurnReference({
  sessionId = runtimeSessionId(),
  file = process.env.FASHUO_SKILL_TURN_FILE ?? DEFAULT_SKILL_TURN_FILE,
} = {}) {
  const runtimeIdentity = resolveRuntimeIdentity({ sessionId });
  const normalizedSession = runtimeIdentity.sessionId;
  if (!normalizedSession) return { ...runtimeIdentity, expectedSkill: null, expectedRunId: null };
  const parsed = readSkillTurnEvents(file);
  if (parsed.issues.length) return { ...runtimeIdentity, expectedSkill: null, expectedRunId: null };
  const prompt = [...parsed.events].reverse().find((event) => (
    event.event === "prompt_routed"
      && event.sessionId === normalizedSession
  ));
  const expectedSkill = CONTROLLED_SKILLS.has(prompt?.expectedSkill) ? prompt.expectedSkill : null;
  // [gpt] 2026-08-13：把宿主已确认的 Run 路由带回执行层；跨 turn 续用必须匹配该 Run，不能只凭同 session 放行。
  return {
    sessionId: normalizedSession,
    turnId: prompt?.turnId ?? null,
    producerHost: prompt?.producerHost ?? runtimeIdentity.producerHost,
    turnIdSource: prompt?.turnIdSource ?? "none",
    identityState: prompt?.identityState ?? runtimeIdentity.identityState,
    expectedSkill,
    expectedRunId: expectedSkill ? prompt?.expectedRunId ?? null : null,
  };
}

export function createSessionSeenEvent(payload = {}, now = new Date()) {
  const identity = resolveHookIdentity(payload, { sessionEvent: true });
  return {
    ...eventBase({ event: "session_seen", ...identity, now }),
    source: safeToken(payload.source, "source", { max: 40 }),
    model: safeToken(payload.model, "model", { max: 80 }),
  };
}

export function latestPromptEvent(events, sessionId, turnId) {
  const candidates = [...(events ?? [])].reverse().filter((event) => (
    event.event === "prompt_routed" && event.sessionId === sessionId
  ));
  if (turnId) return candidates.find((event) => event.turnId === turnId) ?? null;
  // [gpt] 2026-08-25：Claude Stop 缺 prompt_id 时按同 session 最新一轮回落；
  // Codex 缺 turn_id 仍须 fail-open，不得借此把载荷缺字段静默掩盖。
  const latest = candidates[0];
  if (latest?.producerHost !== "claude") return null;
  // 若这一轮已经完成最终 Stop 审计，新一轮 UserPromptSubmit 又没有留下事件，
  // 不得把新的 Stop 错配给旧轮次；第一次 continued=true 后的重试仍可继续匹配。
  const latestCheck = [...(events ?? [])].reverse().find((event) => (
    event.event === "stop_checked"
      && event.sessionId === latest.sessionId
      && event.turnId === latest.turnId
  ));
  return latestCheck && !latestCheck.continued ? null : latest;
}

export function evaluateTurnCompliance(promptEvent, runs = new Map(), { lastAssistantMessage = null } = {}) {
  if (!promptEvent?.expectedSkill) return { applicable: false, compliant: true, failureCode: null, run: null };
  if (!CONTROLLED_SKILLS.has(promptEvent.expectedSkill)) {
    return { applicable: false, compliant: true, failureCode: null, run: null, retiredSkill: promptEvent.expectedSkill };
  }
  const candidates = [...(runs?.values?.() ?? [])].filter((run) => (
    run.skill === promptEvent.expectedSkill
      && run.sessionId === promptEvent.sessionId
      && (!promptEvent.expectedRunId || run.runId === promptEvent.expectedRunId)
  ));
  const run = candidates
    .filter((item) => item.events.some((event) => event.turnId === promptEvent.turnId))
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
  if (!run) return { applicable: true, compliant: false, failureCode: "missing_run", run: null };
  // prompt_routed 只代表真实学习入口；模型不能用 diagnostic/simulation 标签绕过 Stop 守卫，
  // 再让统计层把这次失败从学习分母里排除。系统诊断本来就不会产生 expectedSkill。
  if (RUN_PURPOSES.has(run.runPurpose) && run.runPurpose !== "learning") {
    return { applicable: true, compliant: false, failureCode: "run_purpose_mismatch", run };
  }
  if (run.status === "waiting_user") {
    const checkpoint = [...run.events].reverse().find((event) => (
      event.event === "checkpoint_passed" && String(event.phase).endsWith("question") && event.turnId === promptEvent.turnId
    ));
    const step = checkpoint?.phase === "diagnosis_question" ? "judgment_output_verified" : "question_integrity_pass";
    const artifact = run.steps?.[step];
    if (lastAssistantMessage != null && checkpoint && artifact?.artifactHash
      && !containsHashedArtifact(lastAssistantMessage, artifact.artifactHash, artifact.artifactLength)) {
      return { applicable: true, compliant: false, failureCode: step === "judgment_output_verified" ? "judgment_display_drift" : "display_drift", run };
    }
    return { applicable: true, compliant: true, failureCode: null, run };
  }
  if (["completed", "handoff", "aborted"].includes(run.status)) {
    // [gpt] 2026-08-21 立、[claude] 2026-08-25 删：原本要求 progress 后同 turn 必须出现抽查 Run，
    // 否则报 post_progress_probe_missing。云 2026-08-25 拍板当日抽查改成无 Run 的 stateless probe
    // （不落任何账），这条闸从"催我别漏抽查"变成"每次正确执行都误报"，故整条移除。
    // 抽查该不该做仍是硬规矩，只是它的证据不再是一条空账本 Run——见 beisong-blueprint「二·五」。
    const judgment = run.skill === "cuoti-fupan" && run.end?.outcome === "completed" && run.end?.phase === "result"
      ? run.steps?.judgment_output_verified
      : null;
    if (lastAssistantMessage != null && judgment?.artifactHash
      && !containsHashedArtifact(lastAssistantMessage, judgment.artifactHash, judgment.artifactLength)) {
      return { applicable: true, compliant: false, failureCode: "judgment_display_drift", run };
    }
    return { applicable: true, compliant: true, failureCode: null, run };
  }
  return {
    applicable: true,
    compliant: false,
    failureCode: run.status === "blocked" ? "blocked_run" : "unclosed_run",
    run,
  };
}

export function createStopCheckedEvent(payload = {}, promptEvent, result, {
  continued = false,
  now = new Date(),
  turnCheckVisible = null,
} = {}) {
  const hookIdentity = resolveHookIdentity(payload);
  const fallbackTurnId = hookIdentity.turnIdSource === "session_latest" ? promptEvent?.turnId ?? null : null;
  const identity = fallbackTurnId
    ? {
      ...hookIdentity,
      turnId: fallbackTurnId,
      identityState: hookIdentity.sessionId ? "full" : hookIdentity.identityState,
    }
    : hookIdentity;
  const rawRunPurpose = safeToken(result?.run?.runPurpose, "runPurpose", { max: 20 });
  // 旧 Run 与 missing_run 没有 purpose；为兼容既有学习遥测，均按 learning 计入。
  const runPurpose = RUN_PURPOSES.has(rawRunPurpose) ? rawRunPurpose : "learning";
  const compliancePurpose = result?.failureCode === "run_purpose_mismatch" ? "learning" : runPurpose;
  const turnCheck = result?.turnCheck ? {
    ...result.turnCheck,
    // 默认兼容 Claude observe 已展示语义；enforce wrapper 对被 block 的草稿显式传 false。
    visible: typeof turnCheckVisible === "boolean"
      ? turnCheckVisible
      : identity.producerHost === "claude" || Boolean(result.compliant),
  } : null;
  return {
    ...eventBase({ event: "stop_checked", ...identity, now }),
    expectedSkill: promptEvent?.expectedSkill ?? null,
    runId: result?.run?.runId ?? null,
    runStatus: result?.run?.status ?? null,
    compliant: Boolean(result?.compliant),
    failureCode: result?.failureCode ?? null,
    continued: Boolean(continued),
    stopHookActive: Boolean(payload.stop_hook_active),
    runPurpose,
    compliancePurpose,
    turnCheck,
  };
}

export function createGuardErrorEvent(payload = {}, error, now = new Date()) {
  let identity;
  try {
    identity = resolveHookIdentity(payload, { sessionEvent: payload.hook_event_name === "SessionStart" });
  } catch {
    identity = {
      producerHost: "unknown",
      sessionId: null,
      turnId: null,
      turnIdSource: "none",
      identityState: "host_only",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const payloadInvalid = /(?:payload|session_id|turn_id|prompt_id|JSON|producerHost|身份字段)/iu.test(message);
  return {
    ...eventBase({ event: "guard_error", ...identity, now }),
    hookEventName: safeToken(payload.hook_event_name, "hookEventName", { max: 40 }),
    failureCode: payloadInvalid ? "hook_payload_invalid" : "guard_internal_error",
    errorMessage: safeToken(message, "errorMessage", { max: 300 }) ?? "unknown guard error",
  };
}

function inWindow(value, start, end) {
  const date = beijingDate(value);
  return (!start || date >= start) && (!end || date <= end);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function summarizeSkillTurns(input = {}, {
  nowIso = new Date().toISOString(),
  windowStart = null,
  windowEnd = null,
  uncheckedStaleMinutes = 60,
  runPurpose = "learning",
  runInput = [],
} = {}) {
  if (!RUN_PURPOSES.has(runPurpose)) throw new Error("runPurpose 只接受 learning|diagnostic|simulation");
  const events = Array.isArray(input) ? input : input.events ?? [];
  const issues = Array.isArray(input) ? [] : input.issues ?? [];
  const telemetrySources = Array.isArray(input) ? [] : input.files ?? [];
  const allPrompts = events.filter((event) => event.event === "prompt_routed" && event.expectedSkill && inWindow(event.observedAt, windowStart, windowEnd));
  const sessions = events.filter((event) => event.event === "session_seen" && inWindow(event.observedAt, windowStart, windowEnd));
  const observedEvents = events.filter((event) => inWindow(event.observedAt, windowStart, windowEnd));
  const guardErrors = observedEvents.filter((event) => event.event === "guard_error");
  const runEvents = Array.isArray(runInput) ? runInput : runInput.events ?? [];
  const purposeByRunId = new Map(runEvents
    .filter((event) => event.event === "started" && event.runId)
    .map((event) => [event.runId, RUN_PURPOSES.has(event.runPurpose) ? event.runPurpose : "learning"]));
  const purposeByTurn = new Map();
  const setTurnPurpose = (key, purpose) => {
    if (!key) return;
    if (!purposeByTurn.has(key)) {
      purposeByTurn.set(key, purpose);
      return;
    }
    const previous = purposeByTurn.get(key);
    if (previous !== purpose) purposeByTurn.set(key, null);
  };
  for (const event of runEvents) {
    const purpose = purposeByRunId.get(event.runId);
    if (!purpose || !event.sessionId || !event.turnId) continue;
    setTurnPurpose(`${event.producerHost ?? "unknown"}:${event.sessionId}:${event.turnId}`, purpose);
    setTurnPurpose(`${event.sessionId}:${event.turnId}`, purpose);
  }
  const checksByTurn = new Map();
  for (const event of events.filter((item) => item.event === "stop_checked")) {
    checksByTurn.set(`${event.sessionId}:${event.turnId}`, event);
  }
  const allChecked = allPrompts.map((prompt) => ({ prompt, check: checksByTurn.get(`${prompt.sessionId}:${prompt.turnId}`) ?? null }));
  const pairPurpose = ({ prompt, check }) => {
    if (RUN_PURPOSES.has(check?.compliancePurpose)) return check.compliancePurpose;
    if (RUN_PURPOSES.has(check?.runPurpose)) return check.runPurpose;
    return purposeByTurn.get(`${prompt.producerHost ?? "unknown"}:${prompt.sessionId}:${prompt.turnId}`)
      ?? purposeByTurn.get(`${prompt.sessionId}:${prompt.turnId}`)
      ?? "learning";
  };
  // 旧 stop_checked 与尚未审计的路由没有 purpose，按 learning 兼容；已有明确
  // diagnostic/simulation 回执的轮次从学习合规率、漏审与耗时中排除。历史漏审
  // 没有 stop_checked 时，再按同 host/session/turn 的 Run purpose 归类。
  const checked = allChecked.filter((pair) => pairPurpose(pair) === runPurpose);
  const prompts = checked.map(({ prompt }) => prompt);
  const nowMs = new Date(nowIso).getTime();
  const unchecked = checked.filter(({ prompt, check }) => !check
    && Number.isFinite(nowMs)
    && (nowMs - new Date(prompt.observedAt).getTime()) / 60000 >= uncheckedStaleMinutes);
  const finalFailures = checked.filter(({ check }) => check && !check.compliant && !check.continued);
  const protectedRuns = events.filter((event) => (
    event.event === "stop_checked"
      && event.continued
      && (event.compliancePurpose ?? event.runPurpose ?? "learning") === runPurpose
      && inWindow(event.observedAt, windowStart, windowEnd)
  ));
  const passed = checked.filter(({ check }) => check?.compliant);
  // [gpt] 2026-08-20：宿主可观测耗时定义为 UserPromptSubmit 到最终 Stop；用户等待与 Skill 自动步骤另行统计。
  const turnLatencies = checked.flatMap(({ prompt, check }) => {
    if (!check) return [];
    const durationMs = new Date(check.observedAt).getTime() - new Date(prompt.observedAt).getTime();
    return Number.isFinite(durationMs) && durationMs >= 0 ? [{
      skill: prompt.expectedSkill,
      intent: check.turnCheck?.intent ?? null,
      durationMs,
    }] : [];
  });
  const summarizeLatency = (values) => ({
    samples: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  });
  return {
    telemetrySources,
    purposeScope: {
      selected: runPurpose,
      legacyFallback: "learning",
      stopCheckedByPurpose: Object.fromEntries([...RUN_PURPOSES].map((purpose) => [
        purpose,
        observedEvents.filter((event) => event.event === "stop_checked" && (event.runPurpose ?? "learning") === purpose).length,
      ])),
      complianceCheckedByPurpose: Object.fromEntries([...RUN_PURPOSES].map((purpose) => [
        purpose,
        observedEvents.filter((event) => (
          event.event === "stop_checked"
            && (event.compliancePurpose ?? event.runPurpose ?? "learning") === purpose
        )).length,
      ])),
      routedByPurpose: Object.fromEntries([...RUN_PURPOSES].map((purpose) => [
        purpose,
        allChecked.filter((pair) => pairPurpose(pair) === purpose).length,
      ])),
      excludedRouted: allPrompts.length - prompts.length,
    },
    counts: {
      routed: prompts.length,
      sessions: new Set(sessions.map((event) => event.sessionId)).size,
      checked: checked.filter(({ check }) => check).length,
      passed: passed.length,
      protected: protectedRuns.length,
      failed: finalFailures.length,
      unchecked: unchecked.length,
      guardErrors: guardErrors.length,
    },
    compliance: {
      eligible: passed.length + finalFailures.length,
      rate: passed.length + finalFailures.length
        ? Math.round((passed.length / (passed.length + finalFailures.length)) * 1000) / 10
        : null,
    },
    coverage: {
      state: observedEvents.length ? "observed" : "unobserved",
      lastSessionAt: sessions.at(-1)?.observedAt ?? null,
      lastEventAt: observedEvents.at(-1)?.observedAt ?? null,
    },
    byProducerHost: Object.fromEntries([...new Set(observedEvents.map((event) => event.producerHost ?? "unknown"))]
      .sort()
      .map((host) => [host, observedEvents.filter((event) => (event.producerHost ?? "unknown") === host).length])),
    turnLatencyMs: {
      ...summarizeLatency(turnLatencies.map((item) => item.durationMs)),
      bySkill: Object.fromEntries([...new Set(turnLatencies.map((item) => item.skill))].sort().map((skill) => [
        skill,
        summarizeLatency(turnLatencies.filter((item) => item.skill === skill).map((item) => item.durationMs)),
      ])),
      boundary: "user_prompt_submit_to_final_stop",
    },
    failuresByCode: Object.fromEntries([...new Set(finalFailures.map(({ check }) => check.failureCode))]
      .filter(Boolean)
      .sort()
      .map((code) => [code, finalFailures.filter(({ check }) => check.failureCode === code).length])),
    guardErrors: guardErrors.slice(-10).map((event) => ({
      producerHost: event.producerHost,
      hookEventName: event.hookEventName,
      failureCode: event.failureCode,
      observedAt: event.observedAt,
    })),
    examples: [...finalFailures, ...unchecked].slice(0, 10).map(({ prompt, check }) => ({
      sessionId: prompt.sessionId,
      turnId: prompt.turnId,
      expectedSkill: prompt.expectedSkill,
      failureCode: check?.failureCode ?? "unchecked",
      observedAt: check?.observedAt ?? prompt.observedAt,
    })),
    issues,
  };
}
