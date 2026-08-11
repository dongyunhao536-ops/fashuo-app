import { describe, expect, it } from "vitest";
import { parseReviewSchedule } from "./assessment-ledgers.mjs";
import {
  appendScheduleItem,
  assertScheduleLink,
  auditScheduleLinks,
  closeScheduleItem,
  setScheduleDispatch,
} from "./schedule-store.mjs";

const TODAY = "2026-08-05";

// [gpt] 2026-08-10：补齐结案前后结构复验的回归覆盖。
describe("schedule store", () => {
  it("追加后用同一个解析器复验结构", () => {
    const result = appendScheduleItem("# 复盘排期\n", {
      id: "AUTO-1",
      date: TODAY,
      priority: "P0",
      type: "错题冷复检",
      task: "T#1：换角度复检",
      ref: "coach-engine:topic:T1:2026-08-05",
      route: "cuoti-fupan",
      dimension: "application",
    }, { referenceDate: TODAY });
    expect(result.added).toBe(true);
    expect(parseReviewSchedule(result.markdown, { referenceDate: TODAY })).toMatchObject({
      counts: { errors: 0, canonical: 1 },
      items: [{ route: "cuoti-fupan", dimension: "application" }],
    });
  });

  it("周计划验收单元完整往返并拒绝跨周到期", () => {
    // [gpt] 2026-08-10：P0 完成率只认带稳定计划身份的验收单元。
    const result = appendScheduleItem("# 复盘排期\n", {
      id: "PLAN-U1",
      date: TODAY,
      priority: "P0",
      type: "周计划验收",
      task: "民法第一章听完并完成分章真题",
      planId: "W20260803-P0-1",
      planWeek: "2026-08-03",
      planSource: "weekly",
      acceptanceWeight: 2,
      goalId: "G-MINFA",
    }, { referenceDate: TODAY });
    expect(parseReviewSchedule(result.markdown, { referenceDate: TODAY }).items[0]).toMatchObject({
      planId: "W20260803-P0-1",
      planWeek: "2026-08-03",
      planSource: "weekly",
      acceptanceWeight: 2,
      goalId: "G-MINFA",
    });
    expect(() => appendScheduleItem("# 复盘排期\n", {
      id: "BAD-WEEK", date: "2026-08-10", priority: "P0", type: "周计划验收", task: "跨周", planId: "WEEK-1", planWeek: "2026-08-03", planSource: "weekly",
    }, { referenceDate: TODAY })).toThrow(/所属周内/);
  });

  it("带病根派单与结构化结案可完整回读", () => {
    // [gpt] 2026-08-10：覆盖“事前基线 → 事后响应”的同条排期往返。
    const added = appendScheduleItem("# 复盘排期\n", {
      id: "AUTO-PATTERN",
      date: TODAY,
      priority: "P0",
      type: "知识点精准复检",
      task: "XF-0054：换事实做应用",
      ref: "coach-engine:knowledge:XF-0054:2026-08-05",
      route: "cuoti-fupan",
      dimension: "application",
      subject: "刑法",
      kpId: "XF-0054",
      failurePatternCode: "scope_expansion",
      failurePatternScope: "subject",
      interventionCode: "scope_expansion@cuoti-fupan:application",
      interventionEpisodeId: "EP-AUTO-PATTERN",
      protocolCode: "contrast_case",
      protocolVersion: 1,
      observationWindow: "immediate",
      baselineRisk: 82,
      expectedOutcome: "clean-pass",
    }, { referenceDate: TODAY });
    const closed = closeScheduleItem(added.markdown, "AUTO-PATTERN", {
      date: TODAY,
      result: "陌生变式通过",
      outcome: "pass",
      cold: true,
      promptIntegrity: "clean",
    });
    const parsed = parseReviewSchedule(closed, { referenceDate: TODAY });
    expect(parsed.counts.errors).toBe(0);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      subject: "刑法",
      kpId: "XF-0054",
      failurePatternCode: "scope_expansion",
      failurePatternScope: "subject",
      baselineRisk: 82,
      expectedOutcome: "clean-pass",
      outcome: "pass",
      cold: true,
      promptIntegrity: "clean",
      interventionEpisodeId: "EP-AUTO-PATTERN",
      protocolCode: "contrast_case",
      protocolVersion: 1,
      observationWindow: "immediate",
      episodeStartedOn: TODAY,
    });
    expect(parsed.items[1]).toMatchObject({
      id: "EP-AUTO-PATTERN-D3",
      dueDate: "2026-08-08",
      status: "pending",
      observationWindow: "d3",
      episodeStartedOn: TODAY,
    });
  });

  it("干净通过才按 episode 串行生成 D3、D14、D30，延迟失败立即停止", () => {
    // [gpt] 2026-08-10：窗口串行生成，避免提前铺满排期，也避免失败后继续机械重复旧协议。
    const root = appendScheduleItem("# 复盘排期\n", {
      id: "ROOT",
      date: TODAY,
      priority: "P0",
      type: "知识点精准复检",
      task: "XF-0054：边界辨析",
      ref: "coach-engine:knowledge:XF-0054:2026-08-05",
      route: "cuoti-fupan",
      dimension: "application",
      subject: "刑法",
      kpId: "XF-0054",
      failurePatternCode: "scope_expansion",
      failurePatternScope: "point",
      interventionCode: "scope_expansion@cuoti-fupan:application",
      interventionEpisodeId: "EP-ROOT",
      protocolCode: "contrast_case",
      protocolVersion: 1,
      observationWindow: "immediate",
      baselineRisk: 80,
      expectedOutcome: "clean-pass",
    }, { referenceDate: TODAY }).markdown;
    const immediate = closeScheduleItem(root, "ROOT", {
      date: TODAY, result: "即时通过", outcome: "pass", cold: false, promptIntegrity: "clean",
    });
    expect(() => closeScheduleItem(immediate, "EP-ROOT-D3", {
      date: "2026-08-07", result: "提前测", outcome: "pass", cold: true, promptIntegrity: "clean",
    })).toThrow(/最早 2026-08-08/);
    expect(() => closeScheduleItem(immediate, "EP-ROOT-D3", {
      date: "2026-08-08", result: "带提示", outcome: "pass", cold: false, promptIntegrity: "clean",
    })).toThrow(/D3\/D14\/D30/);

    const d3 = closeScheduleItem(immediate, "EP-ROOT-D3", {
      date: "2026-08-08", result: "D3冷检通过", outcome: "pass", cold: true, promptIntegrity: "clean",
    });
    let parsed = parseReviewSchedule(d3, { referenceDate: "2026-08-08" });
    expect(parsed.items.find((item) => item.id === "EP-ROOT-D14")).toMatchObject({ dueDate: "2026-08-19", observationWindow: "d14" });

    const d14 = closeScheduleItem(d3, "EP-ROOT-D14", {
      date: "2026-08-19", result: "D14冷检通过", outcome: "pass", cold: true, promptIntegrity: "clean",
    });
    parsed = parseReviewSchedule(d14, { referenceDate: "2026-08-19" });
    expect(parsed.items.find((item) => item.id === "EP-ROOT-D30")).toMatchObject({ dueDate: "2026-09-04", observationWindow: "d30" });

    const failedRoot = root.replaceAll("ROOT", "FAIL");
    const failedImmediate = closeScheduleItem(failedRoot, "FAIL", {
      date: TODAY, result: "即时通过", outcome: "pass", cold: false, promptIntegrity: "clean",
    });
    const failedD3 = closeScheduleItem(failedImmediate, "EP-FAIL-D3", {
      date: "2026-08-08", result: "D3再次错", outcome: "fail", cold: true, promptIntegrity: "clean",
    });
    const failedParsed = parseReviewSchedule(failedD3, { referenceDate: "2026-08-08" });
    expect(failedParsed.items.some((item) => item.id === "EP-FAIL-D14")).toBe(false);
  });

  it("结构化结案拒绝缺字段或污染冷检", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=知识点精准复检 | task=XF-0054\n";
    expect(() => closeScheduleItem(markdown, "R1", { date: TODAY, result: "通过", outcome: "pass" })).toThrow(/同时提供/);
    expect(() => closeScheduleItem(markdown, "R1", {
      date: TODAY, result: "提示后通过", outcome: "pass", cold: true, promptIntegrity: "cued",
    })).toThrow(/冷检.*clean/);
  });

  it("同一对象已有未完成排期时幂等跳过", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-04 | P1 | id=OLD | type=错题冷复检 | task=T#1 | ref=coach-engine:topic:T1:2026-08-04\n";
    const result = appendScheduleItem(markdown, {
      id: "AUTO-2",
      date: TODAY,
      priority: "P1",
      type: "错题冷复检",
      task: "T#1：再复检",
      ref: "coach-engine:topic:T1:2026-08-05",
    }, { referenceDate: TODAY, dedupeRefPrefix: "coach-engine:topic:T1:" });
    expect(result).toMatchObject({ added: false, reason: "open-ref" });
    expect(result.markdown).toBe(markdown);
  });

  it("结案把未完成条目打勾并追加 completed/result，重复结案拒绝", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=错题冷复检 | task=T#1 | ref=coach-engine:topic:T1:2026-08-05\n";
    const closed = closeScheduleItem(markdown, "R1", { date: TODAY, result: "通过｜变式案例" });
    const parsed = parseReviewSchedule(closed, { referenceDate: TODAY });
    expect(parsed.counts).toMatchObject({ canonical: 1, completed: 1, dueToday: 0, errors: 0 });
    expect(parsed.items[0]).toMatchObject({ id: "R1", status: "completed", completedOn: TODAY, result: "通过｜变式案例" });
    expect(() => closeScheduleItem(closed, "R1", { date: TODAY, result: "再写" })).toThrow(/排期已完成/);
  });

  it("找不到或重复的排期 ID 明确报错", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=错题冷复检 | task=T#1\n- [ ] 2026-08-05 | P1 | id=R2 | type=错题冷复检 | task=T#2\n";
    expect(() => closeScheduleItem(markdown, "NOPE", { date: TODAY, result: "x" })).toThrow(/未找到排期 ID/);
    expect(() => closeScheduleItem(`${markdown}- [ ] 2026-08-06 | P1 | id=R1 | type=错题冷复检 | task=T#3\n`, "R1", { date: TODAY, result: "x" })).toThrow(/排期 ID 重复/);
  });

  it("结案前拒绝已有结构错误，且拒绝空结果", () => {
    const bad = "# 复盘排期\n- [ ] 2026-02-30 | P1 | id=R1 | type=错题冷复检 | task=T#1\n";
    expect(() => closeScheduleItem(bad, "R1", { date: TODAY, result: "通过" })).toThrow(/结构错误/);
    const good = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=错题冷复检 | task=T#1\n";
    expect(() => closeScheduleItem(good, "R1", { date: TODAY, result: "" })).toThrow(/结果不能为空/);
  });

  it("route 与 dimension 必须成对且使用稳定枚举", () => {
    const base = { id: "R1", date: TODAY, priority: "P1", type: "知识点理解", task: "XF-0054：解释边界" };
    expect(() => appendScheduleItem("# 复盘排期\n", { ...base, route: "ask-pc" }, { referenceDate: TODAY })).toThrow(/成对提供/);
    expect(() => appendScheduleItem("# 复盘排期\n", { ...base, route: "unknown", dimension: "understanding" }, { referenceDate: TODAY })).toThrow(/route 不合法/);
    const parsed = parseReviewSchedule(
      "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=知识点理解 | task=XF-0054 | route=ask-pc | dimension=wrong\n",
      { referenceDate: TODAY },
    );
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_dimension" })]));
  });

  it("可为既有排期补齐或纠正路由，且保留结案证据", () => {
    const markdown = [
      "# 复盘排期",
      "- [ ] 2026-08-05 | P1 | id=OPEN | type=知识点理解 | task=XF-0054 | ref=本周P0",
      "- [x] 2026-08-05 | P1 | id=DONE | type=带背复检 | task=L9 | route=coach-pc | dimension=exposure | ref=本周P1 | completed=2026-08-06 | result=冷检通过",
      "",
    ].join("\n");
    const withOpenRoute = setScheduleDispatch(markdown, "OPEN", {
      route: "ask-pc", dimension: "understanding", referenceDate: TODAY,
    });
    const updated = setScheduleDispatch(withOpenRoute, "DONE", {
      route: "daibei-pc", dimension: "recall", referenceDate: TODAY,
    });
    const parsed = parseReviewSchedule(updated, { referenceDate: TODAY });
    expect(parsed.counts.errors).toBe(0);
    expect(parsed.items.find((item) => item.id === "OPEN")).toMatchObject({ route: "ask-pc", dimension: "understanding" });
    expect(parsed.items.find((item) => item.id === "DONE")).toMatchObject({
      route: "daibei-pc", dimension: "recall", status: "completed", completedOn: "2026-08-06", result: "冷检通过",
    });
  });

  it("修改路由时拒绝非法枚举且不触碰输入", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=R1 | type=知识点理解 | task=XF-0054\n";
    expect(() => setScheduleDispatch(markdown, "R1", {
      route: "unknown", dimension: "understanding", referenceDate: TODAY,
    })).toThrow(/route 不合法/);
    expect(markdown).not.toContain("route=");
  });

  it("联动结案要求排期类型与知识对象一一对应", () => {
    const markdown = [
      "# 复盘排期",
      "- [ ] 2026-08-05 | P1 | id=RL9 | type=带背复检 | task=L9：冷检 | ref=coach-engine:recite:L9:2026-08-05",
      "- [ ] 2026-08-05 | P1 | id=T62 | type=错题冷复检 | task=T#62：变式 | ref=coach-engine:topic:T62:2026-08-05",
      "- [ ] 2026-08-05 | P1 | id=K1 | type=知识点精准复检 | task=XF-0054：应用检验 | ref=coach-engine:knowledge:XF-0054:2026-08-05",
      "- [ ] 2026-08-05 | P1 | id=KASK | type=知识点理解 | task=XF-0054：解释边界 | route=ask-pc | dimension=understanding | ref=coach-engine:knowledge:XF-0054:2026-08-05",
      "- [ ] 2026-08-05 | P1 | id=MULTI | type=带背复检 | task=L30 与 L31 各打一发 | ref=本周周报",
      "",
    ].join("\n");

    expect(assertScheduleLink(markdown, "RL9", { kind: "recite", targetId: "L9", referenceDate: TODAY })).toMatchObject({ id: "RL9" });
    expect(assertScheduleLink(markdown, "T62", { kind: "topic", targetId: 62, referenceDate: TODAY })).toMatchObject({ id: "T62" });
    expect(assertScheduleLink(markdown, "K1", { kind: "knowledge", targetId: "XF-0054", referenceDate: TODAY })).toMatchObject({ id: "K1" });
    expect(assertScheduleLink(markdown, "KASK", { kind: "knowledge", targetId: "XF-0054", referenceDate: TODAY, route: "ask-pc", dimension: "understanding" })).toMatchObject({ id: "KASK" });
    expect(() => assertScheduleLink(markdown, "KASK", { kind: "knowledge", targetId: "XF-0054", referenceDate: TODAY, route: "cuoti-fupan", dimension: "application" })).toThrow(/route=ask-pc|dimension=understanding/);
    expect(() => assertScheduleLink(markdown, "RL9", { kind: "recite", targetId: "L10", referenceDate: TODAY })).toThrow(/不是 L10|不包含目标 L10/);
    expect(() => assertScheduleLink(markdown, "T62", { kind: "recite", targetId: "L9", referenceDate: TODAY })).toThrow(/类型/);
    expect(() => assertScheduleLink(markdown, "MULTI", { kind: "recite", targetId: "L30", referenceDate: TODAY })).toThrow(/同时包含 L30、L31/);
  });

  it("关联审计能发现排期仍开但带背条目已经撤池", () => {
    const markdown = "# 复盘排期\n- [ ] 2026-08-05 | P1 | id=RL9 | type=带背复检 | task=L9：冷检 | ref=coach-engine:recite:L9:2026-08-05\n";
    const audit = auditScheduleLinks(markdown, {
      referenceDate: TODAY,
      reciteParsed: { records: [{ id: "L9", status: "withdrawn" }], issues: [] },
    });
    expect(audit.counts.errors).toBe(1);
    expect(audit.issues[0]).toMatchObject({ code: "stale-open-recite-link" });
  });
});
