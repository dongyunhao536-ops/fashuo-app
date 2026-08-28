#!/usr/bin/env node
// [gpt] 2026-08-26 v4：云明确要求 Claude 宿主 Skill 执行守卫升为**强制档**（enforce）。
//
// 这是 `~/.claude/hooks/fashuo-claude-observe.mjs` 的规范版本，纳入 Git 管理。
// Claude 侧无权写 `~/.claude/hooks/` 与 `.claude/settings.local.json`（AGENTS 双宿主边界，
// 云口头授权也不解闸），因此本文件只提供内容，**安装由云本人执行**：
//
//     cp scripts/claude-skill-guard.mjs ~/.claude/hooks/fashuo-claude-observe.mjs
//
// 目标文件名与 settings 里已注册的路径一致，故安装后无需改接线、无需重贴 settings。
//
// ── v3→v4 变更（观察档升强制档）──
//   - UserPromptSubmit 命中受控 Skill 时回注执行契约；
//   - Stop 不合规时最多 decision:block 一次，要求补齐后重新输出；
//   - stop_hook_active 是宿主主锁，guardRetry 是提示重入副锁，第二次失败只告警不再阻断；
//   - 守卫异常仍 fail-open 并落 guard_error，不能因守卫故障卡死普通对话。
//
// ── v4→v5 变更（[claude] 2026-08-26：waiting_user 心跳）──
//   - UserPromptSubmit 时给同 session 的 waiting_user Run 续命，让 30 分钟空闲回收
//     真的按"用户有没有动"计算，而不是按"模型有没有跑脚本"；
//   - 心跳只写 user_active 事件，不签任何 step、不改 status，不构成合规证据；
//   - 保留绝对上限（默认 6 小时），Run 永久悬空这条原始保证不被削弱；
//   - 心跳失败绝不影响回注与放行，单独 try 包住。
//
// ── v5→v6 变更（[gpt] 2026-08-26：授课 meta 通道）──
//   - 课堂内的重复送达/记录问题注入 intent=meta，不再强迫 Claude 重放冻结正文；
//   - 实际判定仍复用 Git 跟踪的共享 skill-turn-guard，Codex/Claude 不分叉契约。
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

const GUARD_PROFILE = "enforce";
const GUARD_HANDLER = "claude-enforce@6";

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

function promptContext(event) {
  const intent = event.intentHint ? `｜intent=${event.intentHint}` : "";
  return `SKILL_EXECUTION_GUARD｜expected=${event.expectedSkill}｜turn=${event.turnId}${intent}。完整读取对应 SKILL.md；按其唯一入口建立或续用 Skill Run；自动步骤只认脚本回执；最终答复前必须 checkpoint/end，BLOCK 不得口头越过。`;
}

function retryReason(event, result) {
  if (result.failureCode === "shouke_delivery_failed") {
    const missing = (result.turnCheck?.failures ?? []).slice(0, 8)
      .map((item) => `${item.displayLabel ?? "单元"}:${item.code}`)
      .join("、");
    return `SHOUKE_DELIVERY_RETRY|skill=shouke-pc|turn=${event.turnId}｜实际授课正文未通过：${missing || "内容不完整"}。请按本轮已冻结单元包重发完整修正版正文；不要只发补丁，因为被拦草稿不算用户已收到。`;
  }
  return `SKILL_EXECUTION_GUARD_RETRY|skill=${event.expectedSkill}|code=${result.failureCode}|turn=${event.turnId}｜宿主未观察到对应且已收口的 Skill Run。立即完整读取该 SKILL.md，执行缺失入口/步骤和硬闸后再答；不要解释或绕过。`;
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

  const skillRunModule = await import(lib("lib/skill-run.mjs"));
  const { readSkillRunEvents, reconstructSkillRuns } = skillRunModule;

  if (event === "UserPromptSubmit") {
    // 云一发话就给同 session 的 waiting_user Run 续命；失败绝不影响回注与放行。
    try {
      const { resolveHookIdentity } = await import(lib("lib/host-identity.mjs"));
      skillRunModule.touchWaitingRunsForUserActivity({ sessionId: resolveHookIdentity(payload).sessionId });
    } catch (heartbeatError) {
      process.stderr.write(`CLAUDE_GUARD_HEARTBEAT_SKIPPED｜${heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)}\n`);
    }
    const runs = reconstructSkillRuns(readSkillRunEvents().events);
    const previousPromptEvents = readSkillTurnEvents().events;
    const routed = createPromptRoutedEvent(payload, runs, new Date(), { previousPromptEvents });
    appendSkillTurnEvent(signed(routed));
    if (!routed.expectedSkill) return print({});
    return print({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: promptContext(routed),
      },
    });
  }

  // Stop
  // 强制档仍保留载荷形状断言；载荷契约变化时外层 fail-open 并落 guard_error。
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
  if (result.compliant) {
    appendSkillTurnEvent(signed(createStopCheckedEvent(payload, promptEvent, result)));
    return print({});
  }
  const mayContinue = payload.stop_hook_active === false && !promptEvent.guardRetry;
  appendSkillTurnEvent(signed(createStopCheckedEvent(payload, promptEvent, result, {
    continued: mayContinue,
    // Claude enforce 被 block 的草稿没有真正送达；第二次不再阻断时才按已展示计。
    turnCheckVisible: mayContinue ? false : null,
  })));
  if (mayContinue) return print({ decision: "block", reason: retryReason(promptEvent, result) });
  return print({
    systemMessage: `Skill 守卫最终未通过：${promptEvent.expectedSkill}/${result.failureCode}；已记录监控，未再次续跑以避免死循环。`,
  });
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
