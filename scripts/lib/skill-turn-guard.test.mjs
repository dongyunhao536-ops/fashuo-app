// [gpt] 2026-08-12：宿主守卫回归，覆盖路由、隐私、Run 关联、续跑后失败和正常等用户。

import { describe, expect, it } from "vitest";
import {
  containsHashedArtifact,
  createSessionSeenEvent,
  createPromptRoutedEvent,
  createStopCheckedEvent,
  evaluateTurnCompliance,
  latestPromptEvent,
  routeSkillPrompt,
  summarizeSkillTurns,
} from "./skill-turn-guard.mjs";
import { hashSkillArtifact } from "./skill-run.mjs";

function run(overrides = {}) {
  return {
    runId: "SR-1",
    skill: "cuoti-fupan",
    sessionId: "session-1",
    runPurpose: "learning",
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
    expect(routeSkillPrompt("从民法离婚开始给我上课")).toBeNull();
    expect(routeSkillPrompt("用基础精讲讲义从民法离婚开始讲")).toBeNull();
    expect(routeSkillPrompt("按精讲一本通继续授课")).toBeNull();
    expect(routeSkillPrompt("继续刚才的课")).toBeNull();
    expect(routeSkillPrompt("系统讲完法理第八章")).toBeNull();
    expect(routeSkillPrompt("下一节")).toBeNull();
    expect(routeSkillPrompt("诊断一下 ask-pc skill 为什么执行慢")).toBeNull();
    expect(routeSkillPrompt("所以 Claude 那边也可以正常授课了是吗")).toBeNull();
    expect(routeSkillPrompt("这个授课入口现在能正常运行吗")).toBeNull();
    expect(routeSkillPrompt("读取一下刚才的授课记录，似乎有问题")).toBeNull();
    expect(routeSkillPrompt("所以意思是下次授课前还是要提前让你准备是吗？那和之前有什么区别，准备的时间变少了？")).toBeNull();
    expect(routeSkillPrompt("提醒一句：docs/shouke-pc授课Skill方案.md 里的 claude-enforce@4 还没更新成 5")).toBeNull();
    expect(routeSkillPrompt("现在从民法离婚开始给我正常授课")).toBeNull();
    expect(routeSkillPrompt("按更新后的授课方案从民法离婚开始上课")).toBeNull();
    expect(routeSkillPrompt("继续民法课堂教学")).toBeNull();
    expect(routeSkillPrompt("使用 shouke-pc 讲讲犯罪中止")).toBeNull();
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

  it("已撤下 Skill 的旧活动 Run 只作历史记录，不再接管新 prompt 或 Stop", () => {
    const retired = run({ skill: "shouke-pc", status: "waiting_delivery" });
    const routed = createPromptRoutedEvent({
      session_id: "session-1", turn_id: "turn-2", prompt: "继续",
    }, new Map([[retired.runId, retired]]), "2026-08-12T01:05:00Z");
    expect(routed).toMatchObject({ expectedSkill: null, expectedRunId: null, routeSource: "none" });
    expect(evaluateTurnCompliance({
      expectedSkill: "shouke-pc", expectedRunId: retired.runId, sessionId: "session-1", turnId: "turn-2",
    }, new Map([[retired.runId, retired]]))).toMatchObject({
      applicable: false, compliant: true, retiredSkill: "shouke-pc",
    });
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

  // [gpt] 2026-08-26：实跑中“修复 → 继续”被数小时前的错题 Run 抢走，误触学习硬闸。
  it("系统对话已插入时，短继续不回跳到更早的已收口 Skill", () => {
    const closed = run({ status: "completed", end: { outcome: "completed" }, lastEventAt: "2026-08-12T01:00:02.000Z" });
    const engineeringPrompt = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-engineering",
      prompt: "修复这个 Skill 的执行速度，顺便核对 Claude",
    }, new Map([["SR-1", closed]]), "2026-08-12T01:06:00Z");
    expect(engineeringPrompt.expectedSkill).toBeNull();
    const continuation = createPromptRoutedEvent(
      { session_id: "session-1", turn_id: "turn-continue", prompt: "继续" },
      new Map([["SR-1", closed]]),
      "2026-08-12T01:07:00Z",
      { previousPromptEvents: [engineeringPrompt] },
    );
    expect(continuation).toMatchObject({ expectedSkill: null, expectedRunId: null, routeSource: "none" });
  });

  it("已收口 Run 超过 30 分钟时，裸继续不再自动恢复", () => {
    const closed = run({ status: "completed", end: { outcome: "completed" }, lastEventAt: "2026-08-12T01:00:02.000Z" });
    const event = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-4", prompt: "继续" }, new Map([["SR-1", closed]]), "2026-08-12T01:31:00Z");
    expect(event).toMatchObject({ expectedSkill: null, expectedRunId: null, routeSource: "none" });
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
  it("Claude Stop 无 prompt_id 时只回落到同 session 最新 Claude prompt", () => {
    const older = createPromptRoutedEvent({
      producer_host: "claude",
      session_id: "claude-session",
      prompt_id: "prompt-old",
      prompt: "复盘错题",
    }, new Map(), "2026-08-12T01:00:00Z");
    const latest = createPromptRoutedEvent({
      producer_host: "claude",
      session_id: "claude-session",
      prompt_id: "prompt-new",
      prompt: "带我背法理",
    }, new Map(), "2026-08-12T01:01:00Z");
    const codex = createPromptRoutedEvent({
      producer_host: "codex",
      session_id: "codex-session",
      turn_id: "turn-codex",
      prompt: "复盘错题",
    }, new Map(), "2026-08-12T01:02:00Z");

    expect(latestPromptEvent([older, latest], "claude-session", null)?.turnId).toBe("prompt-new");
    expect(latestPromptEvent([codex], "codex-session", null)).toBeNull();
    expect(latestPromptEvent([older, { ...codex, sessionId: "claude-session" }], "claude-session", null)).toBeNull();
    expect(latestPromptEvent([
      older,
      latest,
      { event: "stop_checked", sessionId: "claude-session", turnId: "prompt-new", continued: true },
    ], "claude-session", null)?.turnId).toBe("prompt-new");
    expect(latestPromptEvent([
      older,
      latest,
      { event: "stop_checked", sessionId: "claude-session", turnId: "prompt-new", continued: false },
    ], "claude-session", null)).toBeNull();
  });

  it("Claude Stop 回落后用真实 prompt_id 落 stop_checked，并保留 purpose", () => {
    const prompt = createPromptRoutedEvent({
      producer_host: "claude",
      session_id: "claude-session",
      prompt_id: "claude-prompt",
      prompt: "复盘错题",
    }, new Map(), "2026-08-12T01:00:00Z");
    const check = createStopCheckedEvent(
      {
        producer_host: "claude",
        hook_event_name: "Stop",
        session_id: "claude-session",
        stop_hook_active: false,
      },
      prompt,
      { compliant: true, run: run({ runPurpose: "diagnostic" }) },
      { now: "2026-08-12T01:00:01Z" },
    );
    expect(check).toMatchObject({
      producerHost: "claude",
      sessionId: "claude-session",
      turnId: "claude-prompt",
      turnIdSource: "session_latest",
      identityState: "full",
      runPurpose: "diagnostic",
    });
  });

  // [claude] 2026-08-25：反转断言。云拍板当日抽查改成无 Run 的 stateless probe（不落任何账），
  // 原来的 post_progress_probe_missing 会把每次正确执行都误报成断链，故整条闸移除。
  it("普通自背进度落账后不再因缺抽查 Run 而阻断 Stop（当日抽查已无 Run）", () => {
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
      compliant: true,
      failureCode: null,
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

  it("已路由学习入口不能用 diagnostic Run 绕过守卫和学习合规分母", () => {
    const prompt = createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "复盘错题",
    }, new Map(), "2026-08-12T01:00:00Z");
    const diagnosticRun = run({ runPurpose: "diagnostic" });
    const result = evaluateTurnCompliance(prompt, new Map([[diagnosticRun.runId, diagnosticRun]]));
    expect(result).toMatchObject({ compliant: false, failureCode: "run_purpose_mismatch" });
    const check = createStopCheckedEvent(
      { session_id: "session-1", turn_id: "turn-1", stop_hook_active: false },
      prompt,
      result,
      { now: "2026-08-12T01:00:01Z" },
    );
    expect(check).toMatchObject({ runPurpose: "diagnostic", compliancePurpose: "learning" });
    const summary = summarizeSkillTurns([prompt, check], {
      windowStart: "2026-08-12",
      windowEnd: "2026-08-12",
    });
    expect(summary.counts).toMatchObject({ routed: 1, checked: 1, failed: 1 });
    expect(summary.compliance).toMatchObject({ eligible: 1, rate: 0 });
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

  // [gpt] 2026-08-26：真实事故是模型给每行加 Markdown 硬换行双空格，正文未改却触发整轮重试。
  it("判题卡容忍 CRLF 与行尾 Markdown 空格，但正文改字仍阻断", () => {
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const card = "【判题】pass｜结论与理由正确\n【规则】中央与地方机关须按题干层级识别\n【病根·不新增】本题通过，本轮没有新的错误可供认领。";
    const completed = run({
      status: "completed",
      end: { outcome: "completed", phase: "result" },
      steps: { judgment_output_verified: { status: "pass", artifactHash: hashSkillArtifact(card), artifactLength: card.length } },
    });
    const markdownHardBreaks = `结论如下：\r\n\r\n${card.replaceAll("\n", "  \r\n")}  \r\n\r\n下一步稍后再说。`;
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), { lastAssistantMessage: markdownHardBreaks }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), {
      lastAssistantMessage: markdownHardBreaks.replace("中央与地方机关", "中央与基层机关"),
    })).toMatchObject({ compliant: false, failureCode: "judgment_display_drift" });
  });

  it("F4 裸序号误读事故：把证据卡中的‘上一问’改成‘上一窝’必须阻断", () => {
    // [gpt] 2026-08-25：点名 2026-08-02 事故，避免通用 hash 测试重构后失去守护意图。
    const prompt = createPromptRoutedEvent({ session_id: "session-1", turn_id: "turn-1", prompt: "复盘错题" }, new Map(), "2026-08-12T01:00:00Z");
    const card = "【判题】void｜裸序号指向不明\n【原答】上一问\n【证据卡】\n1. 用户原话｜当前回合｜指的是上一问";
    const artifactHash = hashSkillArtifact(card);
    const completed = run({
      status: "completed",
      end: { outcome: "completed", phase: "result" },
      steps: { judgment_output_verified: { status: "pass", artifactHash, artifactLength: card.length } },
    });
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), { lastAssistantMessage: card }).compliant).toBe(true);
    expect(evaluateTurnCompliance(prompt, new Map([["SR-1", completed]]), { lastAssistantMessage: card.replaceAll("上一问", "上一窝") })).toMatchObject({
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

  it("学习宿主合规率排除 diagnostic/simulation，但旧回执仍按 learning 兼容", () => {
    const prompt = (turnId, observedAt) => createPromptRoutedEvent({
      session_id: "session-1",
      turn_id: turnId,
      prompt: "复盘错题",
    }, new Map(), observedAt);
    const learningPrompt = prompt("turn-learning", "2026-08-12T01:00:00.000Z");
    const diagnosticPrompt = prompt("turn-diagnostic", "2026-08-12T01:01:00.000Z");
    const simulationPrompt = prompt("turn-simulation", "2026-08-12T01:02:00.000Z");
    const legacyPrompt = prompt("turn-legacy", "2026-08-12T01:03:00.000Z");
    const diagnosticUncheckedPrompt = prompt("turn-diagnostic-unchecked", "2026-08-12T01:04:00.000Z");
    const runInput = [{
      schemaVersion: 2,
      event: "started",
      runId: "SR-DIAGNOSTIC-UNCHECKED",
      runPurpose: "diagnostic",
      producerHost: "codex",
      sessionId: "session-1",
      turnId: "turn-diagnostic-unchecked",
      observedAt: "2026-08-12T01:04:00.500Z",
    }];
    const checks = [
      createStopCheckedEvent(
        { session_id: "session-1", turn_id: "turn-learning" },
        learningPrompt,
        { compliant: true, run: run({ runPurpose: "learning" }) },
        { now: "2026-08-12T01:00:01.000Z" },
      ),
      createStopCheckedEvent(
        { session_id: "session-1", turn_id: "turn-diagnostic" },
        diagnosticPrompt,
        { compliant: false, failureCode: "blocked_run", run: run({ runPurpose: "diagnostic" }) },
        { continued: true, now: "2026-08-12T01:01:02.000Z" },
      ),
      createStopCheckedEvent(
        { session_id: "session-1", turn_id: "turn-simulation" },
        simulationPrompt,
        { compliant: true, run: run({ runPurpose: "simulation" }) },
        { now: "2026-08-12T01:02:03.000Z" },
      ),
      {
        ...createStopCheckedEvent(
          { session_id: "session-1", turn_id: "turn-legacy" },
          legacyPrompt,
          { compliant: true, run: run({ runPurpose: "learning" }) },
          { now: "2026-08-12T01:03:04.000Z" },
        ),
        runPurpose: undefined,
      },
    ];
    const summary = summarizeSkillTurns([
      learningPrompt,
      diagnosticPrompt,
      simulationPrompt,
      legacyPrompt,
      diagnosticUncheckedPrompt,
      ...checks,
    ], {
      nowIso: "2026-08-12T03:00:00Z",
      windowStart: "2026-08-12",
      windowEnd: "2026-08-12",
      runInput,
    });

    expect(summary.counts).toMatchObject({ routed: 2, checked: 2, passed: 2, protected: 0, failed: 0 });
    expect(summary.compliance).toMatchObject({ eligible: 2, rate: 100 });
    expect(summary.turnLatencyMs).toMatchObject({ samples: 2, p50: 1000, p95: 4000 });
    expect(summary.purposeScope).toMatchObject({
      selected: "learning",
      legacyFallback: "learning",
      stopCheckedByPurpose: { learning: 2, diagnostic: 1, simulation: 1 },
      routedByPurpose: { learning: 2, diagnostic: 2, simulation: 1 },
      excludedRouted: 3,
    });
    const diagnostic = summarizeSkillTurns([
      learningPrompt,
      diagnosticPrompt,
      simulationPrompt,
      legacyPrompt,
      diagnosticUncheckedPrompt,
      ...checks,
    ], {
      nowIso: "2026-08-12T03:00:00Z",
      windowStart: "2026-08-12",
      windowEnd: "2026-08-12",
      runPurpose: "diagnostic",
      runInput,
    });
    expect(diagnostic.counts).toMatchObject({ routed: 2, checked: 1, protected: 1, failed: 0, unchecked: 1 });
    expect(diagnostic.purposeScope).toMatchObject({ selected: "diagnostic", excludedRouted: 3 });
    expect(() => summarizeSkillTurns([], { runPurpose: "other" })).toThrow(/runPurpose/);
  });
});
