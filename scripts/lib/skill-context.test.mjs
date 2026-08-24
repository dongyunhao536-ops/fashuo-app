// [gpt] 2026-08-11：交互 skill 紧凑快照的分流、压缩与钻取闸门测试。

import { describe, expect, it } from "vitest";
import {
  assessPromptMateriality,
  buildCrossSubjectReviewPool,
  buildCoachContext,
  buildCuotiContext,
  buildDaibeiContext,
  buildAskContext,
  extractWeeklyPriorities,
  formatSkillContext,
  reconcileCoachContextFacts,
  scheduleItems,
  summarizeStudyLogs,
  shouldReplan,
} from "./skill-context.mjs";

describe("交互 skill 学习进度摘要", () => {
  it("严格区分带背与自背，并保留当前科目的完整唯一进度线", () => {
    const summary = summarizeStudyLogs([
      { id: 1, log_date: "2026-08-01", subject: "法理", chapter: "第一章", activity: "背诵" },
      { id: 2, log_date: "2026-08-02", subject: "法理", chapter: "第一章第一节", activity: "带背" },
      { id: 3, log_date: "2026-08-03", subject: "法理", chapter: "第一章第一节", activity: "背诵", raw_input: "[背诵方式=带背] 节末总复述完成" },
      { id: 4, log_date: "2026-08-04", subject: "法理", chapter: "第二章", activity: "背诵", raw_input: "[背诵方式=自背] 用户汇报背完" },
      { id: 5, log_date: "2026-08-05", subject: "民法", chapter: "总则", activity: "看书" },
    ], { subject: "法理" });

    expect(summary.total).toBe(4);
    expect(summary.trail.guided.map((item) => item.chapter)).toEqual(["第一章第一节"]);
    expect(summary.trail.selfRecite.map((item) => item.chapter)).toEqual(["第一章", "第二章"]);
    expect(summary.bySubject["法理"].activities).toEqual({ 背诵: 4 });
    expect(summary.recent[0]).toMatchObject({ activity: "背诵", recitationMode: "自背" });
  });
});

describe("实时事实覆盖历史叙述", () => {
  it("隔离与当前流水冲突的零流水记忆，同时保留非冲突画像", () => {
    const result = reconcileCoachContextFacts({
      studyLogs: [
        { id: 1, log_date: "2026-08-08", subject: "英语", chapter: "2016 Text 1", activity: "做题" },
        { id: 2, log_date: "2026-08-09", subject: "宪法", chapter: "第一章", activity: "看书" },
      ],
      memories: [
        { category: "约定", fact: "云至今英语零流水，一篇没做" },
        { category: "画像", fact: "原则的例外和边界需要多检验" },
        { category: "进度", fact: "宪法尚未开张" },
      ],
    });
    expect(result.memories.map((item) => item.fact)).toEqual(["原则的例外和边界需要多检验"]);
    expect(result.quarantined.map((item) => item.fact)).toEqual(["云至今英语零流水，一篇没做", "宪法尚未开张"]);
    expect(result.currentFacts).toMatchObject({ 英语: { total: 1 }, 宪法: { total: 1 } });
  });

  it("目标分中的下划线历史说明不混入当前目标值", () => {
    const current = { 英语: 75, _英语目标的硬条件: "云至今英语零流水" };
    const assessment = {
      referenceDate: "2026-08-12", dates: {}, rounds: {}, targets: current,
      reviewSchedule: { overdue: [], dueToday: [], upcoming: [], issues: [] },
      errorBook: { eventCounts: { open: 0 }, activeTopics: 0, awaitingColdReviewTopics: 0 },
      askPoints: {}, recite: { counts: { active: 0, actionable: 0 } },
      coachEngine: {
        topicStates: { items: [] }, controller: { mode: "normal", reason: "ok" }, dispatch: { today: [] },
        examRisk: { topRisks: [] }, examForecast: { hotspots: [] }, knowledgeGraph: { activeBlockedTargets: [] }, caveat: null,
      },
    };
    const context = buildCoachContext({
      assessment,
      studyLogs: [{ id: 1, log_date: "2026-08-08", subject: "英语", chapter: "2016 Text 1", activity: "做题" }],
      errorSummary: { events: [] },
    });
    expect(context.targets).toEqual({ 英语: 75 });
    expect(context.factPolicy.targetNotes).toEqual([{ key: "_英语目标的硬条件", text: "云至今英语零流水" }]);
  });
});

describe("周标准与排期分流", () => {
  it("只从下周指导提取 P0/P1/P2，并携带验收细节", () => {
    const priorities = extractWeeklyPriorities(`## 📋 本周复盘
**第 1 件【P0】旧块不应读取**

## 🎯 下周指导
**第 1 件【P0】宪法开张**
- **时段：**周六上午
- **验收：**第一条流水

**第 2 件【P1】民法一章**`);
    expect(priorities).toEqual([
      { priority: "P0", title: "宪法开张", details: ["时段：**周六上午", "验收：**第一条流水"] },
      { priority: "P1", title: "民法一章", details: [] },
    ]);
  });

  it("旧排期缺 subject 时用正文科目消歧，不把民法任务塞进英语", () => {
    const schedule = {
      overdue: [
        { id: "R1", title: "民法第六章分章真题" },
        { id: "R2", title: "英语阅读精刷" },
        { id: "R3", title: "跨科总盘复盘" },
      ],
      dueToday: [],
      upcoming: [],
      issues: [],
    };
    expect(scheduleItems(schedule, { subject: "英语" }).overdue.map((item) => item.id)).toEqual(["R2", "R3"]);
  });

  it("从带背稳定 ID 恢复科目，并可在指定科目时严格排除无归属任务", () => {
    const schedule = {
      overdue: [
        { id: "R-L30", ref: "coach-engine:recite:L30:2026-08-12", route: "daibei-pc", dimension: "recall", title: "执法特点两组" },
        { id: "R-X15", ref: "coach-engine:recite:X15:2026-08-11", route: "daibei-pc", dimension: "recall", title: "未成年人处罚" },
        { id: "R-GLOBAL", route: "daibei-pc", dimension: "recall", title: "跨科滚动" },
      ],
      dueToday: [],
      upcoming: [],
      issues: [],
    };
    expect(scheduleItems(schedule, { subject: "法理", strictSubject: true }).overdue.map((item) => item.id)).toEqual(["R-L30"]);
    expect(scheduleItems(schedule, { subject: "刑法", strictSubject: true }).overdue.map((item) => item.id)).toEqual(["R-X15"]);
  });

  it("按 Skill route 隔离同一总排期中的任务", () => {
    const schedule = {
      overdue: [
        { id: "EN", route: "yingyu-pc", title: "英语阅读精刷" },
        { id: "RECITE", route: "daibei-pc", title: "带背冷检" },
        { id: "ERROR", route: "cuoti-fupan", title: "错题冷检" },
      ],
      dueToday: [],
      upcoming: [],
      issues: [],
    };
    expect(scheduleItems(schedule, { route: "yingyu-pc", subject: "英语" }).overdue.map((item) => item.id)).toEqual(["EN"]);
  });
});

describe("错题合并快照", () => {
  it("在一份上下文里同时给主题、原始事件、proof 与分科校准", () => {
    const assessment = {
      referenceDate: "2026-08-11",
      dates: { daysToExam: 130 },
      rounds: { 第1轮: { 窗口: "2026-07~08", 范围: "基础" } },
      reviewSchedule: { overdue: [], dueToday: [], upcoming: [], issues: [] },
      coachEngine: {
        topicStates: {
          counts: { reinforcing: 1 },
          due: [{ id: 9, subject: "刑法" }],
          items: [{
            id: 9, subject: "刑法", title: "中止边界", state: "reinforcing", masteryStatus: "open",
            active: true, recurrent: true, eventCounts: { open: 1 }, confirmedFailurePatterns: ["scope_expansion"],
            reviewProof: { blockers: ["需冷检"] }, nextProbe: { earliestDate: "2026-08-11", variantKind: "counterfactual", probeAxis: "rule_boundary" },
          }],
        },
        failurePortrait: { counts: {}, bySubject: [{ subject: "刑法" }], byKnowledgePoint: [], unmatched: [] },
      },
    };
    const context = buildCuotiContext({
      assessment,
      subject: "刑法",
      errorSummary: { events: [{ id: 3, subject: "刑法", status: "open", logDate: "2026-08-10", knowledge: "原始误答", topicIds: [9] }] },
      calibration: { stumblePredictionBySubject: { 刑法: { countable: 6, hitRate: 67, advice: "降低置信度" } } },
      weeklyMarkdown: "",
    });

    expect(context.dueTopicIds).toEqual([9]);
    expect(context.topics[0].nextProbe.probeAxis).toBe("rule_boundary");
    expect(context.openEvents[0]).toMatchObject({ id: 3, topicIds: [9], knowledge: "原始误答" });
    expect(context.calibration).toMatchObject({ countable: 6, hitRate: 67 });
    expect(context.questionIntegrity).toMatchObject({
      requiredBeforeDisplay: true,
      passToken: "QUESTION_INTEGRITY_PASS",
      lateDetection: { responsibility: "teacher", closeSchedule: false },
    });
    expect(context.judgmentResult).toMatchObject({
      passToken: "JUDGMENT_RESULT_PASS",
      command: expect.stringContaining("judgment-result.mjs check"),
    });
  });
});

// [gpt] 2026-08-12：回放“文字洁癖、P0 锁科、加量不重排、当天新错连考”等失灵场景。
describe("执行裁量与跨科重规划回放", () => {
  const referenceDate = "2026-08-12";
  const topics = [
    {
      id: 1, subject: "法理", title: "法律解释主体", riskScore: 90, recurrent: true,
      nextProbe: { earliestDate: referenceDate, probeAxis: "subject_identity", transferLevel: 3, coldRequired: true },
    },
    {
      id: 2, subject: "民法", title: "监护人顺位", riskScore: 55, recurrent: false,
      nextProbe: { earliestDate: referenceDate, probeAxis: "rule_boundary", transferLevel: 3, coldRequired: true },
    },
  ];
  const events = [
    { id: 81, subject: "法理", status: "open", logDate: "2026-08-08", knowledge: "混淆解释主体", topicIds: [1] },
    { id: 82, subject: "民法", status: "open", logDate: "2026-08-08", knowledge: "监护顺位误判", topicIds: [2] },
  ];
  const eventProofs = new Map([
    [81, { primaryTopicId: 1, eligible: false, passCount: 0, coldPassCount: 0, axes: [], blockers: ["还需两条证据"] }],
    [82, { primaryTopicId: 2, eligible: false, passCount: 1, coldPassCount: 1, axes: ["fact_signal"], blockers: ["还需第二验证轴"] }],
  ]);

  it("小文字误差不改变答案、争点或关键推理时，不判错也不强制重做", () => {
    expect(assessPromptMateriality()).toEqual(expect.objectContaining({
      level: "immaterial",
      invalidate: false,
      deduct: false,
      repeatRequired: false,
    }));
    expect(assessPromptMateriality({ changesAnswer: true })).toEqual(expect.objectContaining({
      level: "material",
      invalidate: true,
    }));
  });

  it("完成法理最小动作且同科连续多题后，即使法理是 P0，也把一次通过可销账的民法排到前面", () => {
    const pool = buildCrossSubjectReviewPool({
      topics,
      events,
      eventProofs,
      schedule: { overdue: [], dueToday: [], upcoming: [] },
      weeklyPriorities: [{ priority: "P0", title: "法理错题闭环", details: [] }],
      referenceDate,
      routing: { currentSubject: "法理", focusSubject: "法理", subjectStreak: 3, focusMinimumMet: true, signal: "too-little" },
    });

    expect(pool.replanned).toBe(true);
    expect(pool.candidates[0]).toMatchObject({ eventId: 82, subject: "民法", state: "one-pass-to-absorb", canAbsorbAfterPass: true });
  });

  it("未指定科目时，cuoti 快照保留跨科候选而不是退回单科清单", () => {
    const assessment = {
      referenceDate,
      dates: {},
      rounds: {},
      reviewSchedule: { overdue: [], dueToday: [], upcoming: [], issues: [] },
      coachEngine: {
        topicStates: { counts: {}, due: topics, items: topics },
        failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] },
      },
    };
    const context = buildCuotiContext({
      assessment,
      errorSummary: { events },
      eventProofs,
      routing: { signal: "continue" },
    });
    expect(context.subject).toBeNull();
    expect(new Set(context.crossSubjectReview.candidates.map((item) => item.subject))).toEqual(new Set(["法理", "民法"]));
    expect(new Set(context.topics.map((item) => item.subject))).toEqual(new Set(["法理", "民法"]));
  });

  it("排期只按事件、主题或标题精确关联，不把同科的任意任务都算成当前事件到期", () => {
    const pool = buildCrossSubjectReviewPool({
      topics: [topics[1]],
      events: [events[1]],
      eventProofs,
      schedule: { overdue: [], dueToday: [{ id: "OTHER", subject: "民法", title: "所有权新章" }], upcoming: [] },
      referenceDate,
    });
    expect(pool.candidates[0].scheduleStatus).toBe("unscheduled");
  });

  it("T#10 不会被未来 T#108 排期误命中", () => {
    // [gpt] 2026-08-12：回归真实账本中 includes('T#10') 命中 'T#108' 的前缀碰撞。
    const topic10 = { ...topics[0], id: 10, title: "法条竞合" };
    const event10 = { ...events[0], id: 64, topicIds: [10], knowledge: "法条竞合默认规则" };
    const pool = buildCrossSubjectReviewPool({
      topics: [topic10],
      events: [event10],
      eventProofs: new Map([[64, { ...eventProofs.get(81), primaryTopicId: 10 }]]),
      schedule: {
        overdue: [], dueToday: [],
        upcoming: [{ id: "FUTURE-108", date: "2026-08-14", priority: "P1", route: "cuoti-fupan", dimension: "application", ref: "T#108", title: "T#108 销售劣药罪" }],
      },
      referenceDate,
    });
    expect(pool.candidates[0]).toMatchObject({ topicId: 10, scheduleStatus: "unscheduled", scheduleIds: [] });
  });

  it("今日指定 P0 是硬闸，即使自由题更接近销账也必须排在其后", () => {
    const pool = buildCrossSubjectReviewPool({
      topics,
      events,
      eventProofs,
      schedule: {
        overdue: [],
        dueToday: [{ id: "TODAY-P0-T1", date: referenceDate, priority: "P0", route: "cuoti-fupan", dimension: "application", ref: "T#1", title: "T#1 法律解释主体" }],
        upcoming: [],
      },
      referenceDate,
      routing: { currentSubject: "法理", subjectStreak: 3, focusMinimumMet: true, signal: "too-little" },
    });
    expect(pool.hardGateActive).toBe(true);
    expect(pool.hardGateBlocked).toBe(false);
    expect(pool.requiredP0[0]).toMatchObject({ id: "TODAY-P0-T1", topicIds: [1], candidateKeys: ["#81/T#1"], blockedReason: null });
    expect(pool.candidates[0]).toMatchObject({ eventId: 81, mandatory: true, mandatoryScheduleIds: ["TODAY-P0-T1"] });
    expect(pool.candidates[1]).toMatchObject({ eventId: 82, mandatory: false, canAbsorbAfterPass: true });
  });

  it("未来 P0 只标 upcoming，不会提前冻结当天候选", () => {
    const pool = buildCrossSubjectReviewPool({
      topics,
      events,
      eventProofs,
      schedule: {
        overdue: [], dueToday: [],
        upcoming: [{ id: "FUTURE-P0-T1", date: "2026-08-14", priority: "P0", route: "cuoti-fupan", dimension: "application", ref: "T#1", title: "T#1 法律解释主体" }],
      },
      referenceDate,
    });
    expect(pool.hardGateActive).toBe(false);
    expect(pool.requiredP0).toEqual([]);
    expect(pool.candidates.find((item) => item.eventId === 81)).toMatchObject({ scheduleStatus: "upcoming", mandatory: false });
  });

  it("指定 P0 仍在真实冷却期时显式阻断，不为赶日报伪造冷检", () => {
    const coolingTopic = { ...topics[0], nextProbe: { ...topics[0].nextProbe, earliestDate: "2026-08-19" } };
    const pool = buildCrossSubjectReviewPool({
      topics: [coolingTopic],
      events: [events[0]],
      eventProofs: new Map([[81, { ...eventProofs.get(81), coldPassCount: 0 }]]),
      schedule: {
        overdue: [],
        dueToday: [{ id: "BAD-DATE-P0", date: referenceDate, priority: "P0", route: "cuoti-fupan", dimension: "application", ref: "T#1", title: "T#1 法律解释主体" }],
        upcoming: [],
      },
      referenceDate,
    });
    expect(pool.hardGateBlocked).toBe(true);
    expect(pool.requiredP0[0].blockedReason).toMatch(/仍在冷却/);
    expect(pool.candidates).toEqual([]);
    expect(pool.requiredP0[0]).toMatchObject({ candidateKeys: [], deferredCandidateKeys: ["#81/T#1"] });
    expect(pool.deferredCandidates[0]).toMatchObject({ mandatory: true, state: "cooling", action: "wait" });
    const rendered = formatSkillContext({
      schemaVersion: 2, skill: "cuoti-fupan", referenceDate, subject: null,
      crossSubjectReview: pool,
      questionIntegrity: { rule: "gate", command: "gate-command" },
      topics: [], dueTopicIds: [], openEvents: [], schedule: { overdue: [], dueToday: [], upcoming: [] },
    });
    expect(rendered).toContain("无通过冷却资格的可执行事件");
    expect(rendered).toContain("不参与本轮排序");
  });

  it("指定 P0 缺稳定目标时显式 BLOCK，不准用同科标题猜测冲抵", () => {
    const pool = buildCrossSubjectReviewPool({
      topics,
      events,
      eventProofs,
      schedule: {
        overdue: [{ id: "FUZZY-P0", date: "2026-08-11", priority: "P0", route: "cuoti-fupan", dimension: "application", title: "法理错题复检" }],
        dueToday: [], upcoming: [],
      },
      referenceDate,
    });
    expect(pool.hardGateBlocked).toBe(true);
    expect(pool.requiredP0[0]).toMatchObject({ id: "FUZZY-P0", candidateKeys: [] });
    expect(pool.requiredP0[0].blockedReason).toMatch(/缺少稳定/);
    const context = {
      schemaVersion: 2, skill: "cuoti-fupan", referenceDate, subject: null,
      crossSubjectReview: pool,
      questionIntegrity: { rule: "gate", command: "gate-command" },
      topics: [], dueTopicIds: [], openEvents: [], schedule: { overdue: [], dueToday: [], upcoming: [] },
    };
    expect(formatSkillContext(context)).toContain("【指定 P0 硬闸】");
    expect(formatSkillContext(context)).toContain("BLOCK：排期缺少稳定 T#/事件号/KP-ID");
  });

  it("当天新错始终标成 cooling，不因用户加量就当天连考销账", () => {
    const pool = buildCrossSubjectReviewPool({
      topics: [topics[1]],
      events: [{ ...events[1], logDate: referenceDate }],
      eventProofs: new Map([[82, eventProofs.get(82)]]),
      schedule: { overdue: [], dueToday: [], upcoming: [] },
      referenceDate,
      routing: { signal: "continue" },
    });
    expect(pool.candidates).toEqual([]);
    expect(pool.deferredCandidates[0]).toMatchObject({ state: "cooling", action: "wait", canAbsorbAfterPass: false });
  });

  it("冷却项不占候选上限或跨科分散名额", () => {
    const coolingTopic = { ...topics[0], nextProbe: { ...topics[0].nextProbe, earliestDate: "2026-08-19" } };
    const pool = buildCrossSubjectReviewPool({
      topics: [coolingTopic, topics[1]],
      events,
      eventProofs,
      schedule: { overdue: [], dueToday: [], upcoming: [] },
      referenceDate,
      limit: 1,
    });
    expect(pool.candidates).toHaveLength(1);
    expect(pool.candidates[0]).toMatchObject({ eventId: 82, action: "review" });
    expect(pool.deferredCandidates).toHaveLength(1);
    expect(pool.deferredCandidates[0]).toMatchObject({ eventId: 81, action: "wait" });
  });

  it("事件已有跨会话冷检时，允许同场换第二轴销账，但不把它冒充主题跨日 stable", () => {
    const laterTopic = {
      ...topics[1],
      nextProbe: { ...topics[1].nextProbe, earliestDate: "2026-08-19" },
    };
    const pool = buildCrossSubjectReviewPool({
      topics: [laterTopic],
      events: [events[1]],
      eventProofs,
      schedule: { overdue: [], dueToday: [], upcoming: [] },
      referenceDate,
    });
    expect(pool.candidates[0]).toMatchObject({
      state: "one-pass-to-absorb",
      canAbsorbAfterPass: true,
      closureScope: "event-only",
      eventReviewAllowed: true,
      topicCooling: true,
      topicProgressAllowed: false,
      topicEarliestDate: "2026-08-19",
    });
    const context = {
      schemaVersion: 2, skill: "cuoti-fupan", referenceDate, subject: null,
      crossSubjectReview: pool,
      questionIntegrity: { rule: "gate", command: "gate-command" },
      topics: [], dueTopicIds: [], openEvents: [], schedule: { overdue: [], dueToday: [], upcoming: [] },
    };
    expect(formatSkillContext(context)).toContain("事件本题通过可销账；主题冷却至 2026-08-19，本轮不推进 stable");
  });

  it("答题结果、销账、新错和用户加量都会触发重规划，纯开场不会", () => {
    expect(shouldReplan("startup")).toBe(false);
    for (const signal of ["continue", "too-little", "switch", "pass", "partial", "fail", "absorbed", "new-error"]) {
      expect(shouldReplan(signal)).toBe(true);
    }
  });
});

describe("带背分科风险", () => {
  it("先按科目筛选再排掉落风险，不受全局前列的其他科目挤占", () => {
    const assessment = {
      referenceDate: "2026-08-11",
      dates: {},
      rounds: {},
      reviewSchedule: { overdue: [], dueToday: [], upcoming: [], issues: [] },
      recite: { counts: { active: 2 }, oldestActive: [], withdrawnReviewCandidates: [] },
      coachEngine: {
        reciteMemory: {
          counts: { items: 2 },
          topDropRisk: [{ id: "X1", subject: "刑法", dropRisk: 100 }],
          items: [
            { id: "X1", subject: "刑法", title: "刑法点", dropRisk: 100, dueDate: "2026-08-01" },
            { id: "L1", subject: "法理", title: "法理点", dropRisk: 80, dueDate: "2026-08-02" },
          ],
        },
        failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] },
        controller: { mode: "normal" },
      },
    };
    const context = buildDaibeiContext({ assessment, studyLogs: [], subject: "法理" });
    expect(context.recite.topDropRisk.map((item) => item.id)).toEqual(["L1"]);
    expect(context.recite.counts).toMatchObject({ active: 2, items: 2 });
    expect(context.recite.selectedCounts).toMatchObject({ items: 1, active: 0, due: 1, highRisk: 1 });
    expect(context.questionIntegrity.passToken).toBe("QUESTION_INTEGRITY_PASS");
  });

  it("带背快照显式标出逾期 P0，避免被同科风险池自由抽题冲抵", () => {
    const assessment = {
      referenceDate: "2026-08-12",
      dates: {},
      rounds: {},
      reviewSchedule: {
        overdue: [{
          id: "AUTO-20260811-RX15", date: "2026-08-11", priority: "P0", subject: "刑法",
          route: "daibei-pc", dimension: "recall", title: "X15：不满18周岁量刑措辞冷检",
        }],
        dueToday: [], upcoming: [], issues: [],
      },
      recite: { counts: { active: 1 }, oldestActive: [], withdrawnReviewCandidates: [] },
      coachEngine: {
        reciteMemory: {
          counts: { items: 1 },
          topDropRisk: [{ id: "X17", subject: "刑法", dropRisk: 100 }],
          items: [{ id: "X17", subject: "刑法", title: "另一刑法点", dropRisk: 100, dueDate: "2026-08-01" }],
        },
        failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] },
      },
    };
    const context = buildDaibeiContext({ assessment, studyLogs: [], subject: "刑法" });
    const rendered = formatSkillContext(context);
    expect(context.selection).toMatchObject({ source: "due_schedule", scheduleId: "AUTO-20260811-RX15", reciteId: "X15", blocked: false });
    expect(rendered).toContain("[逾期][P0] AUTO-20260811-RX15");
    expect(rendered).toContain("X15：不满18周岁量刑措辞冷检");
  });

  // [gpt] 2026-08-14：调度裁决必须可结构化断言，不能只测最终文案。
  it("waiting Run 优先于逾期排期，并把恢复对象直接展示给执行层", () => {
    const assessment = {
      referenceDate: "2026-08-14",
      dates: {},
      rounds: {},
      reviewSchedule: {
        overdue: [{
          id: "R20260812-RECITE-L30", date: "2026-08-12", priority: "P1", subject: "法理",
          route: "daibei-pc", dimension: "recall", ref: "coach-engine:recite:L30:2026-08-12", title: "L30 冷检",
        }],
        dueToday: [], upcoming: [], issues: [],
      },
      recite: { counts: {}, oldestActive: [], withdrawnReviewCandidates: [] },
      coachEngine: {
        reciteMemory: { counts: {}, items: [] },
        failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] },
      },
    };
    const recovery = {
      preferred: { runId: "SR-WAIT-L31", targetRef: "R20260812-RECITE-L31", reciteId: "L31", status: "waiting_user", stable: true },
      openRuns: [{ runId: "SR-WAIT-L31" }],
      ignored: [],
    };
    const context = buildDaibeiContext({ assessment, studyLogs: [], subject: "法理", recovery });
    expect(context.selection).toMatchObject({ source: "waiting_run", runId: "SR-WAIT-L31", reciteId: "L31" });
    expect(formatSkillContext(context)).toContain("恢复 SR-WAIT-L31");
  });

  it("旧 Run 串入上一题结果时隔离 Run，只继承 waiting 目标", () => {
    const assessment = {
      referenceDate: "2026-08-14", dates: {}, rounds: {},
      reviewSchedule: { overdue: [], dueToday: [], upcoming: [], issues: [] },
      recite: { counts: {}, oldestActive: [], withdrawnReviewCandidates: [] },
      coachEngine: { reciteMemory: { counts: {}, items: [] }, failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] } },
    };
    const recovery = {
      preferred: null,
      targetFallback: { runId: "SR-MIXED", targetRef: "R20260812-RECITE-L31", reciteId: "L31", resultState: "mismatch" },
      openRuns: [{ runId: "SR-MIXED" }],
      ignored: [],
    };
    const context = buildDaibeiContext({ assessment, studyLogs: [], subject: "法理", recovery });
    expect(context.selection).toMatchObject({ source: "waiting_target_recovered", priorRunId: "SR-MIXED", reciteId: "L31", runId: null });
    expect(formatSkillContext(context)).toContain("隔离旧 Run SR-MIXED");
  });

  it("到期排期没有唯一条目 ID 时阻断，不用同科自由题冲抵", () => {
    const assessment = {
      referenceDate: "2026-08-14", dates: {}, rounds: {},
      reviewSchedule: {
        overdue: [{ id: "R-FUZZY", date: "2026-08-13", priority: "P0", subject: "法理", route: "daibei-pc", dimension: "recall", title: "法理冷检" }],
        dueToday: [], upcoming: [], issues: [],
      },
      recite: { counts: {}, oldestActive: [], withdrawnReviewCandidates: [] },
      coachEngine: { reciteMemory: { counts: {}, items: [] }, failurePortrait: { counts: {}, bySubject: [], byKnowledgePoint: [], unmatched: [] } },
    };
    const context = buildDaibeiContext({ assessment, studyLogs: [], subject: "法理" });
    expect(context.selection).toMatchObject({ source: "due_schedule", scheduleId: "R-FUZZY", blocked: true, reciteId: null });
    expect(formatSkillContext(context)).toContain("BLOCK｜到期排期 R-FUZZY 未绑定唯一带背条目 ID");
  });
});

describe("其他复检路由共用 Gate", () => {
  it("ask 快照也携带同一命题完整性命令，避免临时理解检验绕行", () => {
    const context = buildAskContext({ referenceDate: "2026-08-12" });
    expect(context.questionIntegrity).toMatchObject({ requiredBeforeDisplay: true, passToken: "QUESTION_INTEGRITY_PASS" });
  });
});
