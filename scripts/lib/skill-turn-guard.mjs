// [gpt] 2026-08-12：Codex 宿主级 Skill 路由与 Stop 审计；只保存 prompt hash，不保存用户原文。

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalObservabilityFile, discoverObservabilityFiles } from "./observability-paths.mjs";

export const SKILL_TURN_SCHEMA_VERSION = 1;
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

const RETRY_PATTERN = /^SKILL_EXECUTION_GUARD_RETRY\|skill=([a-z-]+)\|code=([a-z_]+)/u;
const SYSTEM_DIAGNOSTIC_INTENT = /(?:诊断|监控|迁移|升级|代码|脚本|配置|故障|速度慢|日志|遥测|机制|执行.{0,8}(?:慢|异常|问题|不严格|不完整)|为什么.{0,8}(?:不执行|没执行|失效))/u;
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

const ANSWER_INTENT = /(?:讲讲|解释|什么是|是什么意思|如何理解|怎么理解|为什么|区别|辨析|比较|这题选什么|选什么|怎么定性|如何认定|是否构成|法条什么意思|这个概念|这道题|如何评价|怎么判断)/u;
const CONTINUATION_INTENT = /^(?:继续|接着|再来|下一题|下一个|再来一(?:道|个|篇)|继续刚才的|往下)(?:吧|一下|一个|一题|一道|一篇)?[。！!？?]*$/u;
const SUBMISSION_CONTINUATION_INTENT = /(?:^|[，,。！!？?\s])(?:我)?(?:写好了|写完了|答完了|做完了|交卷|我的答案(?:是|：|:)?)(?:$|[，,。！!？?\s])/u;

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

export function containsHashedArtifact(message, artifactHash, artifactLength) {
  const text = String(message ?? "").replace(/\r\n/gu, "\n");
  const hash = String(artifactHash ?? "");
  const length = Number(artifactLength);
  if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isInteger(length) || length < 1 || text.length < length) return false;
  for (let start = 0; start <= text.length - length; start += 1) {
    if (hashPrompt(text.slice(start, start + length)) === hash) return true;
  }
  return false;
}

function eventBase({ event, sessionId, turnId, now = new Date() }) {
  return {
    schemaVersion: SKILL_TURN_SCHEMA_VERSION,
    eventId: `ST-${randomUUID()}`,
    event,
    observedAt: timestamp(now),
    beijingDate: beijingDate(now),
    sessionId: safeToken(sessionId, "sessionId", { required: true, max: 100 }),
    turnId: safeToken(turnId, "turnId", { required: true, max: 100 }),
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
      if (event?.schemaVersion !== SKILL_TURN_SCHEMA_VERSION || !event?.event || !event?.sessionId || !event?.turnId || !event?.observedAt) {
        throw new Error("缺少 schemaVersion/event/sessionId/turnId/observedAt");
      }
      events.push(event);
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

export function routeSkillPrompt(prompt) {
  const text = String(prompt ?? "").normalize("NFC").trim();
  if (!text) return null;
  const retry = text.match(RETRY_PATTERN);
  if (retry && CONTROLLED_SKILLS.has(retry[1])) {
    return { skill: retry[1], source: "guard_retry", guardRetry: true, retryCode: retry[2] };
  }
  // [gpt] 系统诊断即使点名某个 Skill，也不应被误路由成学习答疑；显式“使用/按某 Skill”仍保留。
  if (SYSTEM_DIAGNOSTIC_INTENT.test(text) && !EXPLICIT_SKILL_USE.test(text)) {
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
  if (ANSWER_INTENT.test(text) && LEGAL_DOMAIN.test(text) && !SYSTEM_DIAGNOSTIC_INTENT.test(text)) {
    return { skill: "ask-pc", source: "legal_answer", guardRetry: false };
  }
  return null;
}

function latestActiveRun(runs, sessionId) {
  return [...(runs?.values?.() ?? [])]
    .filter((run) => run.sessionId === sessionId && !run.end)
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
}

function latestClosedRun(runs, sessionId) {
  return [...(runs?.values?.() ?? [])]
    .filter((run) => run.sessionId === sessionId && run.end && run.end.outcome !== "aborted")
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
}

function recentPromptSkill(events, sessionId, now, maxAgeMinutes = 30) {
  const nowMs = new Date(now).getTime();
  return [...(events ?? [])].reverse().find((event) => {
    if (event.event !== "prompt_routed" || event.sessionId !== sessionId || !event.expectedSkill) return false;
    const observedMs = new Date(event.observedAt).getTime();
    return Number.isFinite(nowMs) && Number.isFinite(observedMs) && nowMs >= observedMs
      && (nowMs - observedMs) / 60000 <= maxAgeMinutes;
  })?.expectedSkill ?? null;
}

export function createPromptRoutedEvent(payload = {}, runs = new Map(), now = new Date(), { previousPromptEvents = [] } = {}) {
  const sessionId = safeToken(payload.session_id, "session_id", { required: true, max: 100 });
  const turnId = safeToken(payload.turn_id, "turn_id", { required: true, max: 100 });
  const prompt = String(payload.prompt ?? "");
  const route = routeSkillPrompt(prompt);
  const active = latestActiveRun(runs, sessionId);
  // [gpt] 2026-08-12：普通交卷、同 Skill 强触发和法律追问均续用活动 Run；只有明确指向不同 Skill 的强触发才切换。
  const normalizedPrompt = prompt.normalize("NFC").trim();
  const activeReply = active && (
    !route
      || route.source === "legal_answer"
      || route.skill === active.skill
      || SUBMISSION_CONTINUATION_INTENT.test(` ${normalizedPrompt} `)
  ) ? active : null;
  const closed = !active && CONTINUATION_INTENT.test(normalizedPrompt) ? latestClosedRun(runs, sessionId) : null;
  const continuationSkill = closed?.end?.outcome === "handoff" ? closed.end.handoffSkill : closed?.skill;
  // [gpt] 2026-08-21：前一轮被用户中断且尚未来得及建 Run 时，短“继续”仍继承最近一次已路由 Skill。
  const promptContinuationSkill = !active && !closed && CONTINUATION_INTENT.test(normalizedPrompt)
    ? recentPromptSkill(previousPromptEvents, sessionId, now)
    : null;
  const expectedSkill = activeReply?.skill ?? route?.skill ?? continuationSkill ?? promptContinuationSkill ?? null;
  return {
    ...eventBase({ event: "prompt_routed", sessionId, turnId, now }),
    expectedSkill,
    expectedRunId: activeReply?.runId ?? null,
    routeSource: activeReply
      ? "active_run"
      : route?.source ?? (continuationSkill ? "continuation" : promptContinuationSkill ? "continuation_prompt" : "none"),
    guardRetry: Boolean(route?.guardRetry),
    retryCode: route?.retryCode ?? null,
    promptHash: hashPrompt(prompt),
    promptLength: prompt.length,
    model: safeToken(payload.model, "model", { max: 80 }),
  };
}

export function currentCodexTurnReference({
  sessionId = process.env.CODEX_THREAD_ID,
  file = process.env.FASHUO_SKILL_TURN_FILE ?? DEFAULT_SKILL_TURN_FILE,
} = {}) {
  const normalizedSession = safeToken(sessionId, "sessionId", { max: 100 });
  if (!normalizedSession) return { sessionId: null, turnId: null, expectedSkill: null, expectedRunId: null };
  const parsed = readSkillTurnEvents(file);
  if (parsed.issues.length) return { sessionId: normalizedSession, turnId: null, expectedSkill: null, expectedRunId: null };
  const prompt = [...parsed.events].reverse().find((event) => (
    event.event === "prompt_routed"
      && event.sessionId === normalizedSession
  ));
  // [gpt] 2026-08-13：把宿主已确认的 Run 路由带回执行层；跨 turn 续用必须匹配该 Run，不能只凭同 session 放行。
  return {
    sessionId: normalizedSession,
    turnId: prompt?.turnId ?? null,
    expectedSkill: prompt?.expectedSkill ?? null,
    expectedRunId: prompt?.expectedRunId ?? null,
  };
}

export function createSessionSeenEvent(payload = {}, now = new Date()) {
  return {
    ...eventBase({ event: "session_seen", sessionId: payload.session_id, turnId: "__session__", now }),
    source: safeToken(payload.source, "source", { max: 40 }),
    model: safeToken(payload.model, "model", { max: 80 }),
  };
}

export function latestPromptEvent(events, sessionId, turnId) {
  return [...(events ?? [])].reverse().find((event) => (
    event.event === "prompt_routed" && event.sessionId === sessionId && event.turnId === turnId
  )) ?? null;
}

export function evaluateTurnCompliance(promptEvent, runs = new Map(), { lastAssistantMessage = null } = {}) {
  if (!promptEvent?.expectedSkill) return { applicable: false, compliant: true, failureCode: null, run: null };
  const candidates = [...(runs?.values?.() ?? [])].filter((run) => (
    run.skill === promptEvent.expectedSkill
      && run.sessionId === promptEvent.sessionId
      && (!promptEvent.expectedRunId || run.runId === promptEvent.expectedRunId)
  ));
  const run = candidates
    .filter((item) => item.events.some((event) => event.turnId === promptEvent.turnId))
    .sort((left, right) => String(right.lastEventAt).localeCompare(String(left.lastEventAt)))[0] ?? null;
  if (!run) return { applicable: true, compliant: false, failureCode: "missing_run", run: null };
  if (run.status === "waiting_user") {
    const checkpoint = [...run.events].reverse().find((event) => (
      event.event === "checkpoint_passed" && String(event.phase).endsWith("question") && event.turnId === promptEvent.turnId
    ));
    const step = checkpoint?.phase === "diagnosis_question" ? "judgment_output_verified" : "question_integrity_pass";
    const artifact = run.steps?.[step];
    if (checkpoint && artifact?.artifactHash
      && !containsHashedArtifact(lastAssistantMessage, artifact.artifactHash, artifact.artifactLength)) {
      return { applicable: true, compliant: false, failureCode: step === "judgment_output_verified" ? "judgment_display_drift" : "display_drift", run };
    }
    return { applicable: true, compliant: true, failureCode: null, run };
  }
  if (["completed", "handoff", "aborted"].includes(run.status)) {
    // [gpt] 2026-08-21：普通自背进度不是会话终点；同 turn 没有更晚的抽查 Run 时阻止最终回复漏掉首题。
    if (run.skill === "daibei-pc"
      && run.kind === "progress"
      && run.end?.outcome === "completed"
      && run.end?.phase === "progress") {
      return { applicable: true, compliant: false, failureCode: "post_progress_probe_missing", run };
    }
    const judgment = run.skill === "cuoti-fupan" && run.end?.outcome === "completed" && run.end?.phase === "result"
      ? run.steps?.judgment_output_verified
      : null;
    if (judgment?.artifactHash
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

export function createStopCheckedEvent(payload = {}, promptEvent, result, { continued = false, now = new Date() } = {}) {
  return {
    ...eventBase({ event: "stop_checked", sessionId: payload.session_id, turnId: payload.turn_id, now }),
    expectedSkill: promptEvent?.expectedSkill ?? null,
    runId: result?.run?.runId ?? null,
    runStatus: result?.run?.status ?? null,
    compliant: Boolean(result?.compliant),
    failureCode: result?.failureCode ?? null,
    continued: Boolean(continued),
    stopHookActive: Boolean(payload.stop_hook_active),
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
} = {}) {
  const events = Array.isArray(input) ? input : input.events ?? [];
  const issues = Array.isArray(input) ? [] : input.issues ?? [];
  const telemetrySources = Array.isArray(input) ? [] : input.files ?? [];
  const prompts = events.filter((event) => event.event === "prompt_routed" && event.expectedSkill && inWindow(event.observedAt, windowStart, windowEnd));
  const sessions = events.filter((event) => event.event === "session_seen" && inWindow(event.observedAt, windowStart, windowEnd));
  const checksByTurn = new Map();
  for (const event of events.filter((item) => item.event === "stop_checked")) {
    checksByTurn.set(`${event.sessionId}:${event.turnId}`, event);
  }
  const checked = prompts.map((prompt) => ({ prompt, check: checksByTurn.get(`${prompt.sessionId}:${prompt.turnId}`) ?? null }));
  const nowMs = new Date(nowIso).getTime();
  const unchecked = checked.filter(({ prompt, check }) => !check
    && Number.isFinite(nowMs)
    && (nowMs - new Date(prompt.observedAt).getTime()) / 60000 >= uncheckedStaleMinutes);
  const finalFailures = checked.filter(({ check }) => check && !check.compliant && !check.continued);
  const protectedRuns = events.filter((event) => event.event === "stop_checked" && event.continued && inWindow(event.observedAt, windowStart, windowEnd));
  const passed = checked.filter(({ check }) => check?.compliant);
  // [gpt] 2026-08-20：宿主可观测耗时定义为 UserPromptSubmit 到最终 Stop；用户等待与 Skill 自动步骤另行统计。
  const turnLatencies = checked.flatMap(({ prompt, check }) => {
    if (!check) return [];
    const durationMs = new Date(check.observedAt).getTime() - new Date(prompt.observedAt).getTime();
    return Number.isFinite(durationMs) && durationMs >= 0 ? [{ skill: prompt.expectedSkill, durationMs }] : [];
  });
  const summarizeLatency = (values) => ({
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  });
  return {
    telemetrySources,
    counts: {
      routed: prompts.length,
      sessions: new Set(sessions.map((event) => event.sessionId)).size,
      checked: checked.filter(({ check }) => check).length,
      passed: passed.length,
      protected: protectedRuns.length,
      failed: finalFailures.length,
      unchecked: unchecked.length,
    },
    compliance: {
      eligible: passed.length + finalFailures.length,
      rate: passed.length + finalFailures.length
        ? Math.round((passed.length / (passed.length + finalFailures.length)) * 1000) / 10
        : null,
    },
    coverage: {
      state: sessions.length ? "observed" : "unobserved",
      lastSessionAt: sessions.at(-1)?.observedAt ?? null,
    },
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
