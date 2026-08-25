#!/usr/bin/env node
// [claude] 2026-08-25 v3：Claude 宿主 Skill 执行守卫——**观察档**（observe）。
//
// 这是 `~/.claude/hooks/fashuo-claude-observe.mjs` 的规范版本，纳入 Git 管理。
// Claude 侧无权写 `~/.claude/hooks/` 与 `.claude/settings.local.json`（AGENTS 双宿主边界，
// 云口头授权也不解闸），因此本文件只提供内容，**安装由云本人执行**：
//
//     cp scripts/claude-skill-guard.mjs ~/.claude/hooks/fashuo-claude-observe.mjs
//
// 目标文件名与 settings 里已注册的路径一致，故安装后无需改接线、无需重贴 settings。
//
// ── v2→v3 变更（强制档降回观察档）──
// 2026-08-25 审计发现：AGENTS.md 写明 Claude 侧 7 日验收观察期内为 observe-only、
// 不注入不阻断，且 Claude 无权自行变更 hook 接线；但线上 handler 已是
// `enforce`/`claude-enforce@2`。云本人否认执行过该升级，故认定为上一场 Claude 会话
// 越过了它同场刚写下的宿主边界。本版把强度改回文档所声明的状态：
//   - GUARD_PROFILE/HANDLER 回 observe（用 @3 而非复用 @1，让遥测能区分"原始观察档"
//     与"从强制档降回来的观察档"）
//   - UserPromptSubmit 只记录路由，不再回注 additionalContext
//   - Stop 只记录审计结果，永不 decision:block，因此不需要续跑与防死循环两道锁
// 补充事实：enforce 期共 12 条事件、**实际触发阻断 0 次**，故两档的现实差异仅为提示回注。
//
// 与 scripts/codex-skill-guard.mjs 同协议、同 skill-turns.jsonl。
// 任何异常一律 fail-open，落 guard_error，进程恒 exit 0。

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const REPO_ROOT = process.env.FASHUO_REPO_ROOT ?? "/Users/dyh/Projects/fashuo-app";
const lib = (name) => pathToFileURL(join(REPO_ROOT, "scripts", name)).href;

// SessionStart 载荷不含 prompt_id/turn_id，inferProducerHost 推不出宿主会记成 unknown。
// 本 handler 只可能由 Claude Code 调起，所以在这里自报宿主；不覆盖外部已显式设定的值。
process.env.FASHUO_PRODUCER_HOST ??= "claude";

const GUARD_PROFILE = "observe";
const GUARD_HANDLER = "claude-observe@3";

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

// 强度签名必须由真实执行的 handler 打上，配置意图不算数。
function signed(event) {
  return { ...event, guardProfile: GUARD_PROFILE, guardHandler: GUARD_HANDLER };
}

let observedPayload = {};
let guardModule = null;

async function main() {
  const payload = await readStdin();
  observedPayload = payload;
  const event = payload.hook_event_name;
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "Stop") {
    return print({});
  }

  guardModule = await import(lib("lib/skill-turn-guard.mjs"));
  const {
    appendSkillTurnEvent,
    createPromptRoutedEvent,
    createSessionSeenEvent,
    createStopCheckedEvent,
    evaluateTurnCompliance,
    latestPromptEvent,
    readSkillTurnEvents,
  } = guardModule;

  if (event === "SessionStart") {
    appendSkillTurnEvent(signed(createSessionSeenEvent(payload)));
    return print({});
  }

  const { readSkillRunEvents, reconstructSkillRuns } = await import(lib("lib/skill-run.mjs"));

  if (event === "UserPromptSubmit") {
    const runs = reconstructSkillRuns(readSkillRunEvents().events);
    const previousPromptEvents = readSkillTurnEvents().events;
    const routed = createPromptRoutedEvent(payload, runs, new Date(), { previousPromptEvents });
    appendSkillTurnEvent(signed(routed));
    // 观察档：只落路由事件，不回注 additionalContext。
    return print({});
  }

  // Stop
  // 观察档不阻断，但保留载荷形状断言：它是 fail-closed 的探针，外层 catch 仍会 fail-open，
  // 载荷契约一旦变化能立刻从 guard_error 看出来。
  if (typeof payload.stop_hook_active !== "boolean") {
    throw new Error("hook payload stop_hook_active 必须是 boolean；缺失时 fail-open，禁止猜测循环状态");
  }
  const { resolveHookIdentity } = await import(lib("lib/host-identity.mjs"));
  const identity = resolveHookIdentity(payload);
  const promptEvent = latestPromptEvent(readSkillTurnEvents().events, identity.sessionId, identity.turnId);
  // 未路由到受控 Skill 的轮次没有可审计对象，按设计不落事件。
  // 注意：这不等于"守卫没生效"——2026-08-25 我曾把 30 条 prompt_routed 全当成应审轮次，
  // 实际只有 2 条 expectedSkill 非空，据此虚构出一个不存在的 P0。分母要先分组再算。
  if (!promptEvent?.expectedSkill) return print({});
  const runs = reconstructSkillRuns(readSkillRunEvents().events);
  const result = evaluateTurnCompliance(promptEvent, runs, {
    lastAssistantMessage: payload.last_assistant_message,
  });
  appendSkillTurnEvent(signed(createStopCheckedEvent(payload, promptEvent, result, { continued: false })));
  return print({});
}

try {
  await main();
} catch (error) {
  try {
    const { appendSkillTurnEvent, createGuardErrorEvent } =
      guardModule ?? await import(lib("lib/skill-turn-guard.mjs"));
    appendSkillTurnEvent(signed(createGuardErrorEvent(observedPayload, error)));
  } catch (loggingError) {
    process.stderr.write(`CLAUDE_GUARD_LOG_ERROR｜${loggingError instanceof Error ? loggingError.message : String(loggingError)}\n`);
  }
  process.stderr.write(`CLAUDE_GUARD_ERROR｜${error instanceof Error ? error.message : String(error)}\n`);
  print({});
}
