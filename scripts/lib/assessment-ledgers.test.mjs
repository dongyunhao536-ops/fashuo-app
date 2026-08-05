import { describe, expect, it } from "vitest";
import { parseDailyLedger, parseReviewSchedule, parseSubjectiveLedger } from "./assessment-ledgers.mjs";

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
  });
});
