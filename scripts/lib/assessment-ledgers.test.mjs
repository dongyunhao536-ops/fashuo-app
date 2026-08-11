import { describe, expect, it } from "vitest";
import { parseDailyLedger, parseReviewSchedule, parseSubjectiveLedger, summarizeScheduleExecution } from "./assessment-ledgers.mjs";

describe("assessment ledgers", () => {
  it("从日报台账提取严格执行率、派单量和断链", () => {
    const parsed = parseDailyLedger(`# 日报台账
## 2026-08-01（周六）
- **派单**：[P0] A ｜ [P1] B
- **昨日结算**：2 件 ✅❌
- **今日流水**：有
- **断档**：无

## 2026-08-03（周一）
- **派单**：[P0] C
- **昨日结算**：1 件 ⚠️
- **今日流水**：有
- **断档**：日报断链
`, { referenceDate: "2026-08-05" });

    expect(parsed.counts).toMatchObject({ days: 2, dispatched: 3, total: 3, completed: 1, partial: 1, missed: 1 });
    expect(parsed.strictExecutionRate).toBe(0.333);
    expect(parsed.gaps).toEqual([{ after: "2026-08-01", before: "2026-08-03", missingDays: 1 }]);
  });

  it("优先解析结构化排期，并兼容旧验收行", () => {
    const parsed = parseReviewSchedule(`# 排期
## 结构化排期
- [ ] 2026-08-05 | P0 | id=R1 | type=错题复检 | task=打 T#1 | ref=T#1
- [x] 2026-08-04 | P1 | id=R2 | type=带背 | task=复检 X1 | completed=2026-08-04 | result=通过

- **【P0-2】旧处方**
  - 验收② **8-03 前**：旧任务 ❌ 实际未执行，滚至 8-05。
  - 验收③ **8-21 前**：未来任务。
`, { referenceDate: "2026-08-05" });

    expect(parsed.counts).toMatchObject({ canonical: 2, legacy: 2, completed: 1, overdue: 0, dueToday: 1, upcoming: 0, legacyOpenCandidates: 2 });
    expect(parsed.dueToday[0]).toMatchObject({ id: "R1", priority: "P0" });
    expect(parsed.legacyOpenCandidates[0]).toMatchObject({ status: "missed", dueDate: "2026-08-03" });
  });

  it("按计划窗口、实际结案窗口与 route/dimension 汇总履约，不把结案冒充掌握", () => {
    const parsed = parseReviewSchedule(`# 排期
- [x] 2026-08-04 | P0 | id=R1 | type=答疑复检 | task=解释概念 | route=ask-pc | dimension=understanding | completed=2026-08-05 | result=讲清
- [ ] 2026-08-05 | P0 | id=R2 | type=错题复检 | task=做变式 | route=cuoti-fupan | dimension=application
- [x] 2026-07-30 | P1 | id=R3 | type=带背复检 | task=冷检 | route=daibei-pc | dimension=recall | completed=2026-08-04 | result=通过
- [ ] 2026-07-29 | P1 | id=R4 | type=带背复检 | task=冷检旧账 | route=daibei-pc | dimension=recall
- [x] 2026-08-05 | P2 | id=R5 | type=旧式任务 | task=没有路由 | completed=2026-08-06 | result=迟到
`, { referenceDate: "2026-08-06" });
    const summary = summarizeScheduleExecution(parsed, { start: "2026-08-04", end: "2026-08-05" });

    expect(summary.counts).toEqual({ planned: 3, completedByEnd: 1, notCompletedByEnd: 2, completedDuring: 2, backlogOpenAtEnd: 1 });
    expect(summary.completedDuringItems.map((item) => item.id)).toEqual(["R1", "R3"]);
    expect(summary.notCompletedByEndItems.map((item) => item.id)).toEqual(["R2", "R5"]);
    expect(summary.backlogOpenAtEndItems.map((item) => item.id)).toEqual(["R4"]);
    expect(summary.byRouteDimension).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "ask-pc", dimension: "understanding", planned: 1, completedByEnd: 1, completedDuring: 1 }),
      expect.objectContaining({ route: "cuoti-fupan", dimension: "application", planned: 1, notCompletedByEnd: 1 }),
      expect.objectContaining({ route: "daibei-pc", dimension: "recall", completedDuring: 1, backlogOpenAtEnd: 1 }),
      expect.objectContaining({ route: "unrouted", dimension: "unrouted", planned: 1, notCompletedByEnd: 1 }),
    ]));
  });

  it("提取主观题病灶、首稿重写和最近练笔", () => {
    const parsed = parseSubjectiveLedger(`# 主观题台账
## 挂着的病灶
### A1｜涵摄缺失｜案例
- 首现 2026-08-01｜最后碰 2026-08-02｜状态：挂
## 练笔记录
### 2026-08-01｜案例 刑-01｜题目
- **首稿 4.0 / 15**｜用时 8 分钟
- **重写稿 9.5 / 15**｜提升 +5.5
## 已改掉
### B1｜结合句｜论述
- 首现 2026-07-01｜最后碰 2026-07-20｜状态：已改
`, { referenceDate: "2026-08-05" });

    expect(parsed.counts).toMatchObject({ activeDefects: 1, resolvedDefects: 1, practices: 1, cases: 1, rewrites: 1 });
    expect(parsed.scores).toMatchObject({ averageDraft: 4, averageLatest: 9.5, averageImprovement: 5.5 });
    expect(parsed.daysSinceLatestPractice).toBe(4);
    expect(parsed.capabilityProfile.tracks.case.draft.dimensions.classification).toMatchObject({ samples: 0, observedPercent: null, qualifiedPercent: null, confidence: "none" });
    expect(parsed.propagation.counts).toMatchObject({ roots: 0, active: 0, crossSubject: 0, crossTask: 0 });
  });

  // [gpt] 2026-08-10：钉死内参样本闸、首稿/重写隔离、跨科传播与跨场景销账。
  it("聚合首稿与重写能力画像，并在样本闸前拒绝给正式百分比", () => {
    const parsed = parseSubjectiveLedger(`# 主观题台账
## 挂着的病灶
### B1｜缺结合句｜论述拼接
- **底层能力**：C1
- 首现 2026-08-01｜最后碰 2026-08-02｜状态：挂
### A1｜缺涵摄链｜案例只写结论
- **底层能力**：C1
- 首现 2026-08-03｜最后碰 2026-08-05｜状态：挂

## 练笔记录
### 2026-08-01｜论述 58型｜法治与宪法监督
- **首稿 8 / 15**
- **重写稿 12 / 15**
- **画像标签**：主科=法理｜辅科=宪法｜专题=法治,监督
- **诊断依据**：官方答案
- **能力观测·首稿**：概念=4/4｜结构=3/4｜理论=2/4｜结合=1/4
- **能力观测·重写**：概念=4/4｜结构=4/4｜理论=3/4｜结合=3/4
- **门槛观测·首稿**：设问层=pass｜时限回扫=partial
- **病灶观测·首稿**：B1=fail

### 2026-08-02｜论述 58型｜法理与法制史
- **首稿 9 / 15**
- **画像标签**：主科=法理｜辅科=法制史｜专题=法治,传统
- **诊断依据**：官方答案
- **能力观测·首稿**：概念=3/4｜结构=3/4｜理论=3/4｜结合=2/4
- **病灶观测·首稿**：B1=partial

### 2026-08-03｜论述 57型｜法律价值
- **首稿 10 / 15**
- **画像标签**：主科=法理｜辅科=无｜专题=法律价值
- **诊断依据**：用户标准
- **能力观测·首稿**：概念=2/4｜结构=4/4｜理论=3/4｜结合=3/4

### 2026-08-04｜案例 刑-01｜共同犯罪
- **首稿 9 / 15**
- **画像标签**：主科=刑法｜辅科=无｜专题=共犯
- **诊断依据**：官方答案
- **能力观测·首稿**：定性=3/4｜规则=2/4｜涵摄=1/4｜收口=2/4
- **病灶观测·首稿**：A1=fail

### 2026-08-05｜案例 民-01｜合同责任
- **首稿 10 / 15**
- **画像标签**：主科=民法｜辅科=无｜专题=合同
- **诊断依据**：估分
- **能力观测·首稿**：定性=3/4｜规则=3/4｜涵摄=2/4｜收口=3/4
- **病灶观测·首稿**：A1=partial

## 已改掉
`, { referenceDate: "2026-08-10" });

    const essay = parsed.capabilityProfile.tracks.essay;
    expect(essay.draft.dimensions.concept).toMatchObject({ samples: 3, observedPercent: 75, qualifiedPercent: 75, confidence: "provisional" });
    expect(essay.draft.dimensions.integration).toMatchObject({ samples: 3, observedPercent: 50, qualifiedPercent: 50 });
    expect(essay.rewrite.dimensions.concept).toMatchObject({ samples: 1, observedPercent: 100, qualifiedPercent: null, confidence: "insufficient" });
    expect(parsed.capabilityProfile.tracks.case.draft.dimensions.subsumption).toMatchObject({ samples: 2, observedPercent: 38, qualifiedPercent: null, confidence: "insufficient" });
    expect(essay.draft.gates.taskLevel).toMatchObject({ samples: 1, observedPercent: 100, qualifiedPercent: null });

    const bridge = parsed.propagation.roots.find((root) => root.rootCode === "C1");
    expect(bridge).toMatchObject({ status: "active", spreadLevel: "cross_task", confidence: "high", issueEpisodes: 4, nextProbe: "跨题型无提示首稿复检" });
    expect(bridge.subjects).toEqual(["刑法", "宪法", "民法", "法制史", "法理"]);
    expect(parsed.counts.warnings).toBe(0);
  });

  it("底层病灶必须经两个不同首稿场景干净通过才算解决", () => {
    const parsed = parseSubjectiveLedger(`# 主观题台账
## 挂着的病灶
### B1｜缺结合句｜论述
- **底层能力**：C1
- 首现 2026-08-01｜最后碰 2026-08-01｜状态：挂
### A1｜缺涵摄链｜案例
- **底层能力**：C1
- 首现 2026-08-01｜最后碰 2026-08-01｜状态：挂
## 练笔记录
### 2026-08-01｜论述 58型｜第一次
- **首稿 8 / 15**
- **画像标签**：主科=法理｜辅科=宪法｜专题=法治
- **诊断依据**：官方答案
- **病灶观测·首稿**：B1=fail
### 2026-08-03｜论述 58型｜第二次
- **首稿 11 / 15**
- **画像标签**：主科=法理｜辅科=法制史｜专题=传统
- **诊断依据**：官方答案
- **病灶观测·首稿**：B1=pass
### 2026-08-05｜案例 刑-01｜第三次
- **首稿 12 / 15**
- **画像标签**：主科=刑法｜辅科=无｜专题=共犯
- **诊断依据**：官方答案
- **病灶观测·首稿**：A1=pass
## 已改掉
`, { referenceDate: "2026-08-10" });

    expect(parsed.propagation.roots[0]).toMatchObject({
      rootCode: "C1",
      status: "resolved",
      resolution: { cleanPassesAfterLastIssue: 2, distinctContexts: 2, scopeQualified: true },
      nextProbe: null,
    });
  });
});
