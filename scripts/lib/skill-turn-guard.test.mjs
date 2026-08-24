// [gpt] 2026-08-12：宿主守卫回归，覆盖路由、隐私、Run 关联、续跑后失败和正常等用户。

import { describe, expect, it } from "vitest";
import {
  containsHashedArtifact,
  createSessionSeenEvent,
  createPromptRoutedEvent,
  createStopCheckedEvent,
  evaluateTurnCompliance,
  routeSkillPrompt,
  summarizeSkillTurns,
} from "./skill-turn-guard.mjs";
import { hashSkillArtifact } from "./skill-run.mjs";

function run(overrides = {}) {
  return {
    runId: "SR-1",
    skill: "cuoti-fupan",
    sessionId: "session-1",
    status: "waiting_user",
    lastEventAt: "2026-08-12T01:00:01.000Z",
    events: [{ turnId: "turn-1" }],
    ...overrides,
  };
}

describe("Skill 宿主路由", () => {
  it("只路由明确强触发，不把系统诊断误判成法硕答疑", () => {
    expect(routeSkillPrompt("复盘错题，考我昨天那道题")?.skill).toBe("cuoti-fupan");
    expect(routeSkillPrompt("记录错题，我上传了两张截图")?.skill).toBe("cuoti-fupan");
    expect(routeSkillPrompt("带我背法理学基本原则")?.skill).toBe("daibei-pc");
    expect(routeSkillPrompt("这道刑法题为什么选 B")?.skill).toBe("ask-pc");
    expect(routeSkillPrompt("解释一下犯罪中止")?.skill).toBe("ask-pc");
    expect(routeSkillPrompt("诊断一下 ask-pc skill 为什么执行慢")).toBeNull();
    expect(routeSkillPrompt("使用 ask-pc 讲讲犯罪中止")?.skill).toBe("ask-pc");
    expect(routeSkillPrompt("这两天系统升级后 skill 执行慢吗")).toBeNull();
  });

  it("覆盖真实口语变体，不要求用户背固定触发词", () => {
    const cases = [
      ["居住权和租赁权有什么区别", "ask-pc"],
      ["我有点焦虑，照这个节奏怎么办", "coach-pc"],
      ["继续清几道老题", "cuoti-fupan"],
      ["今天法制史该背什么", "daibei-pc"],
      ["记录进度，法制史第三章秦汉三国魏晋南北朝背诵完毕", "daibei-pc"],
      ["练一道论述题", "lunshu-pc"],
      ["给我对一下这篇英语阅读的答案", "yingyu-pc"],
    ];
    for (const [prompt, skill] of cases) expect(routeSkillPrompt(prompt)?.skill).toBe(skill);
  });

  it("工程诊断不误触发，但明确要求使用 Skill 时服从显式路由", () => {
    expect(routeSkillPrompt("ask-pc 为什么最近执行不严格")).toBeNull();
    expect(routeSkillPrompt("使用 ask-pc 讲讲居住权")).toMatchObject({ skill: "ask-pc", source: "explicit_skill" });
  });

  it("路由遥测仅保存 hash 和长度，不保存 prompt 原文", () => {
    const event = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "复盘错题：我的原答案是秘密内容",
      model: "gpt-5.6-sol",
    }, new Map(), "2026-08-12T01:00:00Z");
    expect(event).toMatchObject({ expectedSkill: "cuoti-fupan", routeSource: "strong_trigger" });
    expect(event.promptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(event)).not.toContain("我的原答案是秘密内容");
  });

  it("用户对正在运行的 Skill 作普通回复时续用原 Run", () => {
    const event = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-2",
      prompt: "B",
    }, new Map([["SR-1", run()]]), "2026-08-12T01:05:00Z");
    expect(event).toMatchObject({ expectedSkill: "cuoti-fupan", expectedRunId: "SR-1", routeSource: "active_run" });
  });

  it("活动复盘题中的法律追问仍续用原 Run，明确跨域请求才切换", () => {
    const runs = new Map([["SR-1", run()]]);
    const followup = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-2",
      prompt: "为什么这里不构成犯罪中止？",
    }, runs, "2026-08-12T01:05:00Z");
    expect(followup).toMatchObject({ expectedSkill: "cuoti-fupan", expectedRunId: "SR-1", routeSource: "active_run" });
    const switchSkill = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-3",
      prompt: "先停一下，帮我规划今晚",
    }, runs, "2026-08-12T01:06:00Z");
    expect(switchSkill).toMatchObject({ expectedSkill: "coach-pc", expectedRunId: null, routeSource: "strong_trigger" });
  });

  it("同 Skill 强触发和模糊交卷续用活动 Run，英语作文不会误切主观题", () => {
    const cuotiRuns = new Map([["SR-1", run()]]);
    const sameSkill = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-2", prompt: "继续清几道老题" }, cuotiRuns, "2026-08-12T01:05:00Z");
    expect(sameSkill).toMatchObject({ expectedSkill: "cuoti-fupan", expectedRunId: "SR-1", routeSource: "active_run" });
    const submitted = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-3", prompt: "我写好了，你看看" }, cuotiRuns, "2026-08-12T01:06:00Z");
    expect(submitted).toMatchObject({ expectedSkill: "cuoti-fupan", expectedRunId: "SR-1", routeSource: "active_run" });

    expect(routeSkillPrompt("英语作文写好了，帮我批改")?.skill).toBe("yingyu-pc");
    expect(routeSkillPrompt("案例题写好了，帮我批改")?.skill).toBe("lunshu-pc");
  });

  it("上一场已收口后，极短的继续仍能回到原 Skill", () => {
    const closed = run({ status: "completed", end: { outcome: "completed" }, lastEventAt: "2026-08-12T01:00:02.000Z" });
    const event = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-4", prompt: "继续" }, new Map([["SR-1", closed]]), "2026-08-12T01:07:00Z");
    expect(event).toMatchObject({ expectedSkill: "cuoti-fupan", expectedRunId: null, routeSource: "continuation" });
  });

  it("上一轮被中断且尚未建 Run 时，短继续继承最近路由", () => {
    const previous = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "记录进度，法制史第三章背诵完毕",
    }, new Map(), "2026-08-12T01:00:00Z");
    const event = createPromptRoutedEvent(
      { session_id: "session-1", turn_id: "turn-2", prompt: "继续" },
      new Map(),
      "2026-08-12T01:01:00Z",
      { previousPromptEvents: [previous] },
    );
    expect(event).toMatchObject({ expectedSkill: "daibei-pc", expectedRunId: null, routeSource: "continuation_prompt" });
  });
});

describe("Skill Stop 审计", () => {
  it("普通自背进度落账后没有更晚的抽查 Run 时阻断 Stop", () => {
    const prompt = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "记录进度，法制史第三章背诵完毕",
    }, new Map(), "2026-08-12T01:00:00Z");
    const progress = run({
      skill: "daibei-pc",
      kind: "progress",
      status: "completed",
      end: { outcome: "completed", phase: "progress" },
      events: [{ turnId: "turn-1", event: "ended" }],
    });
    expect(evaluateTurnCompliance(prompt, new Map([[progress.runId, progress]]))).toMatchObject({
      compliant: false,
      failureCode: "post_progress_probe_missing",
    });
  });

  it("显式 progress-only 可只记录不抽查", () => {
    const prompt = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "只记录进度，不抽查：法制史第三章背诵完毕",
    }, new Map(), "2026-08-12T01:00:00Z");
    const progress = run({
      skill: "daibei-pc",
      kind: "progress-only",
      status: "completed",
      end: { outcome: "completed", phase: "progress" },
      events: [{ turnId: "turn-1", event: "ended" }],
    });
    expect(evaluateTurnCompliance(prompt, new Map([[progress.runId, progress]])).compliant).toBe(true);
  });

  it("同 turn 的 waiting_user 是合法状态，缺 Run 则不合规", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", run()]])).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map())).toMatchObject({ compliant: false, failureCode: "missing_run" });
  });

  it("本轮刚放行的题面必须原样出现在最终消息，改一个字也阻断", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const draft = "【单选题】甲的行为应如何认定？\nA. 既遂\nB. 未遂";
    const artifactHash = hashSkillArtifact(draft);
    const guardedRun = run({
      steps: { question_integrity_pass: { status: "pass", artifactHash, artifactLength: draft.length } },
      events: [
        { turnId: "turn-1", event: "step" },
        { turnId: "turn-1", event: "checkpoint_passed", phase: "question" },
      ],
    });
    expect(containsHashedArtifact(`请作答：\n${draft}`, artifactHash, draft.length)).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: `请作答：\n${draft}` }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: `请作答：\n${draft.replace("未遂", "中止")}` })).toMatchObject({
      compliant: false,
      failureCode: "display_drift",
    });
  });

  it("英语作文 writing_question 也受最终题面漂移保护", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "练一篇英语作文" }, new Map(), "2026-08-12T01:00:00Z");
    const draft = "Write a reply to Paul and answer both questions.";
    const artifactHash = hashSkillArtifact(draft);
    const guardedRun = run({
      skill: "yingyu-pc",
      steps: { question_integrity_pass: { status: "pass", artifactHash, artifactLength: draft.length } },
      events: [
        { turnId: "turn-1", event: "step" },
        { turnId: "turn-1", event: "checkpoint_passed", phase: "writing_question" },
      ],
    });
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: draft }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: draft.replace("both", "the") })).toMatchObject({
      compliant: false,
      failureCode: "display_drift",
    });
  });

  it("错题 result 即使已经 completed，最终回复缺少或改写证据卡仍阻断", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const card = "【判题】partial｜结论正确但理由错误\n【证据卡】\n1. 法制史讲义｜第245页·行10793｜清律无文字犯罪专条";
    const artifactHash = hashSkillArtifact(card);
    const completed = run({
      status: "completed",
      end: { outcome: "completed", phase: "result" },
      steps: { judgment_output_verified: { status: "pass", artifactHash, artifactLength: card.length } },
    });
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), { lastAssistantMessage: card }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), { lastAssistantMessage: "判定为 partial，依据见系统。" })).toMatchObject({
      compliant: false,
      failureCode: "judgment_display_drift",
    });
  });

  it("等待病根认领时也必须原样展示 pending 证据卡", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const card = "【判题】fail｜结论错误\n【证据卡】\n1. 刑法考试分析｜第88页·行3021｜规则摘要\n【病根·待认领】以下仅为候选：1) 规则不会；2) 题干误读";
    const artifactHash = hashSkillArtifact(card);
    const guardedRun = run({
      steps: { judgment_output_verified: { status: "pass", artifactHash, artifactLength: card.length } },
      events: [
        { turnId: "turn-1", event: "step" },
        { turnId: "turn-1", event: "checkpoint_passed", phase: "diagnosis_question" },
      ],
    });
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: card }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", guardedRun]]), { lastAssistantMessage: card.replace("题干误读", "步骤错位") })).toMatchObject({
      compliant: false,
      failureCode: "judgment_display_drift",
    });
  });

  it("汇总把第一次续跑算保护，不冒充最终失败", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const protectedCheck = createStopCheckedEvent(
      { session_id: "session-1", turn_id: "turn-1", stop_hook_active: false },
      prompt,
      { compliant: false, failureCode: "missing_run", run: null },
      { continued: true, now: "2026-08-12T01:00:01Z" },
    );
    const session = createSessionSeenEvent({ session_id: "session-1", source: "startup" }, "2026-08-12T00:59:59Z");
    const summary = summarizeSkillTurns([session, prompt, protectedCheck], {
      nowIso: "2026-08-12T02:00:00Z",
      windowStart: "2026-08-12",
      windowEnd: "2026-08-12",
      uncheckedStaleMinutes: 10,
    });
    expect(summary.counts).toMatchObject({ sessions: 1, routed: 1, checked: 1, protected: 1, failed: 0, unchecked: 0 });
    expect(summary.coverage.state).toBe("observed");
  });

  it("汇总 UserPromptSubmit 到最终 Stop 的宿主耗时", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00.000Z");
    const check = createStopCheckedEvent(
      { session_id: "session-1", turn_id: "turn-1" },
      prompt,
      { compliant: true, run: run() },
      { now: "2026-08-12T01:00:02.500Z" },
    );
    const summary = summarizeSkillTurns([prompt, check], { windowStart: "2026-08-12", windowEnd: "2026-08-12" });
    expect(summary.turnLatencyMs).toMatchObject({ samples: 1, p50: 2500, p95: 2500, max: 2500, boundary: "user_prompt_submit_to_final_stop" });
    expect(summary.turnLatencyMs.bySkill["cuoti-fupan"]).toMatchObject({ samples: 1, p50: 2500 });
  });
});
