#!/usr/bin/env node
// [gpt] 2026-08-12：Codex UserPromptSubmit/Stop hook；命中 Skill 却无合规 Run 时只自动续跑一次。

import {
  appendSkillTurnEvent,
  createPromptRoutedEvent,
  createSessionSeenEvent,
  createStopCheckedEvent,
  evaluateTurnCompliance,
  latestPromptEvent,
  readSkillTurnEvents,
} from "./lib/skill-turn-guard.mjs";
import { readSkillRunEvents, reconstructSkillRuns } from "./lib/skill-run.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function promptContext(event) {
  return `SKILL_EXECUTION_GUARD｜expected=${event.expectedSkill}｜turn=${event.turnId}。完整读取对应 SKILL.md；按其唯一入口建立或续用 Skill Run；自动步骤只认脚本回执；最终答复前必须 checkpoint/end，BLOCK 不得口头越过。`;
}

function retryReason(event, result) {
  return `SKILL_EXECUTION_GUARD_RETRY|skill=${event.expectedSkill}|code=${result.failureCode}|turn=${event.turnId}｜宿主未观察到对应且已收口的 Skill Run。立即完整读取该 SKILL.md，执行缺失入口/步骤和硬闸后再答；不要解释或绕过。`;
}

export async function main() {
  const payload = await readStdin();
  const runs = reconstructSkillRuns(readSkillRunEvents().events);
  if (payload.hook_event_name === "SessionStart") {
    appendSkillTurnEvent(createSessionSeenEvent(payload));
    return print({});
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    // [gpt] 2026-08-21：让被中断后的极短“继续”可继承最近一次已路由 Skill，即使旧 turn 尚未建 Run。
    const previousPromptEvents = readSkillTurnEvents().events;
    const event = createPromptRoutedEvent(payload, runs, new Date(), { previousPromptEvents });
    appendSkillTurnEvent(event);
    if (!event.expectedSkill) return print({});
    return print({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: promptContext(event),
      },
    });
  }
  if (payload.hook_event_name === "Stop") {
    const parsed = readSkillTurnEvents();
    const promptEvent = latestPromptEvent(parsed.events, payload.session_id, payload.turn_id);
    if (!promptEvent?.expectedSkill) return print({});
    const result = evaluateTurnCompliance(promptEvent, runs, { lastAssistantMessage: payload.last_assistant_message });
    if (result.compliant) {
      appendSkillTurnEvent(createStopCheckedEvent(payload, promptEvent, result));
      return print({});
    }
    const mayContinue = !payload.stop_hook_active && !promptEvent.guardRetry;
    appendSkillTurnEvent(createStopCheckedEvent(payload, promptEvent, result, { continued: mayContinue }));
    if (mayContinue) return print({ decision: "block", reason: retryReason(promptEvent, result) });
    return print({
      systemMessage: `Skill 守卫最终未通过：${promptEvent.expectedSkill}/${result.failureCode}；已记录监控，未再次续跑以避免死循环。`,
    });
  }
  return print({});
}

try {
  await main();
} catch (error) {
  // Stop hook 退出 0 时必须输出 JSON；守卫自身异常采用 fail-open，但不会伪报 PASS。
  process.stderr.write(`SKILL_GUARD_ERROR｜${error instanceof Error ? error.message : String(error)}\n`);
  print({});
}
