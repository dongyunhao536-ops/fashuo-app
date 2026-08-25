import { describe, expect, it } from "vitest";
import { applyEvidenceEvent, applyTransition, formatReciteLedgerSummary, parseReciteLedger, summarizeReciteLedger, summarizeReciteTransitions } from "./recite-ledger.mjs";

const header = `# 带背挂账\n\n## 挂账中（法理 1 · 刑法 1）`;

describe("recite ledger", () => {
  it("区分带背挂账、挑错轻滚轨、撤账池和移交条目", () => {
    const parsed = parseReciteLedger(`${header}
### L1｜法理｜普通挂账
- 挂 07-01 ｜ 最后碰 **07-20** ｜ 状态：挂

### L2｜法理｜专名辨析｜转挑错式再认轨
- 挂 07-02 ｜ 最后碰 07-21 ｜ 状态：挂（转挑错式再认轨·周中轻滚）

### X1｜刑法｜幅度词｜撤 07-22
- 挂 07-03 ｜ 最后碰 07-22 ｜ 状态：撤 07-22

### L3｜法理｜名单｜带背侧结案
- 挂 07-04 ｜ 最后碰 07-23 ｜ 状态：带背侧结案·移交宪法轨
`, { referenceDate: "2026-08-05" });
    const summary = summarizeReciteLedger(parsed);

    expect(summary.counts).toMatchObject({ records: 4, active: 2, actionable: 1, recognition: 1, legacyRoutes: 0, withdrawn: 1, transferred: 1 });
    expect(summary.oldestActive.map((entry) => entry.id)).toEqual(["L1"]);
    expect(summary.withdrawnReviewCandidates.map((entry) => entry.id)).toEqual(["X1"]);
  });

  it("旧 Anki 标记只读兼容，并能以新事件留痕迁到挑错轻滚轨", () => {
    const original = `${header}
### L2｜法理｜旧卡｜转 Anki 轨
- 挂 07-02 ｜ 最后碰 07-21 ｜ 状态：挂（主轨移交 Anki）
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-24" });
    expect(parsed.records[0].route).toBe("legacy_anki");
    expect(summarizeReciteLedger(parsed).counts).toMatchObject({ recognition: 0, legacyRoutes: 1 });

    const migrated = applyTransition(original, parsed, {
      id: "L2",
      event: "route-recognition",
      date: "2026-08-24",
      evidence: "2026-08-24 云停用 Anki",
      note: "挑错式再认·周中轻滚",
    });
    const checked = parseReciteLedger(migrated.markdown, { referenceDate: "2026-08-24" });
    expect(checked.records[0].route).toBe("recognition_light_roll");
    expect(checked.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(migrated.transition).toMatchObject({ fromRoute: "legacy_anki", toRoute: "recognition_light_roll" });
  });

  it("拒绝继续生产 route-anki", () => {
    const original = `${header}
### L1｜法理｜普通挂账
- 挂 07-01 ｜ 最后碰 07-20 ｜ 状态：挂
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-24" });
    expect(() => applyTransition(original, parsed, {
      id: "L1",
      event: "route-anki",
      date: "2026-08-24",
      evidence: "旧调用",
      note: "",
    })).toThrow(/route-anki 已于 2026-08-24 停用/);
  });

  it("标题迁移标记优先于未同步字段，并报告冲突", () => {
    const parsed = parseReciteLedger(`${header}
### X23｜刑法｜正当防卫｜撤 07-27
- 挂 07-10 ｜ 最后碰 07-22 ｜ 状态：挂
- 复检（07-27）：✓ → 撤账
`, { referenceDate: "2026-08-05" });

    expect(parsed.records[0]).toMatchObject({ status: "withdrawn", statusSource: "title" });
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "status_conflict", id: "X23" })]));
  });

  it("重挂晚于撤账时保持 active，并按最后碰排序", () => {
    const parsed = parseReciteLedger(`${header}
### X13｜刑法｜教唆犯｜撤 07-10 → 07-20 重挂
- 挂 07-09 ｜ 撤 07-10 ｜ 重挂 07-20 ｜ 最后碰 07-20 ｜ 状态：挂

### L1｜法理｜溯及力
- 挂 07-08 ｜ 最后碰 07-29 ｜ 状态：挂
`, { referenceDate: "2026-08-05" });
    const summary = summarizeReciteLedger(parsed);

    expect(parsed.records[0].status).toBe("active");
    expect(summary.oldestActive.map((entry) => entry.id)).toEqual(["X13", "L1"]);
    expect(summary.oldestActive[0].ageDays).toBe(16);
  });

  it("重复 ID 不会静默双计，且 check 能拿到错误", () => {
    const parsed = parseReciteLedger(`${header}
### L1｜法理｜第一份
- 挂 07-01 ｜ 最后碰 07-02 ｜ 状态：挂

### L1｜法理｜第二份
- 挂 07-03 ｜ 最后碰 07-04 ｜ 状态：挂
`, { referenceDate: "2026-08-05" });
    const summary = summarizeReciteLedger(parsed);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code: "duplicate_id" })]));
    expect(summary.counts.active).toBe(1);
  });

  it("无显式最后碰时用块内最新日期推断，并可输出紧凑摘要", () => {
    const parsed = parseReciteLedger(`${header}
### X1｜刑法｜旧撤账｜撤 07-14
- 点：旧记录
- 复检（07-19）：✓ 保持
`, { referenceDate: "2026-08-05" });
    const summary = summarizeReciteLedger(parsed);

    expect(parsed.records[0]).toMatchObject({ lastTouchedOn: "2026-07-19", lastTouchedSource: "inferred" });
    expect(formatReciteLedgerSummary(summary)).toContain("已撤池轮抽候选：X1 刑法(2026-07-19)");
  });

  it("读取同一 Markdown 内的 append-only 迁移流水并按周汇总", () => {
    const parsed = parseReciteLedger(`${header}
### L1｜法理｜普通挂账 → 撤 08-05
- 挂 07-01 ｜ 最后碰 **08-05** ｜ 状态：撤 08-05

## 迁移流水（机器读取·append-only）
<!-- recite-transition-v1 {"operationId":"op-1","date":"2026-08-04","event":"new","entryId":"L1","fromStatus":null,"toStatus":"active","fromRoute":null,"toRoute":"daibei","evidence":"新栽点"} -->
<!-- recite-transition-v1 {"operationId":"op-2","date":"2026-08-05","event":"withdraw","entryId":"L1","fromStatus":"active","toStatus":"withdrawn","fromRoute":"daibei","toRoute":"daibei","evidence":"跨日冷检通过"} -->
`, { referenceDate: "2026-08-05" });
    const flow = summarizeReciteTransitions(parsed, { start: "2026-08-05", end: "2026-08-11" });

    expect(parsed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(flow).toMatchObject({ total: 1, byEvent: { withdraw: 1, new: 0 } });
    expect(flow.transitions[0]).toMatchObject({ entryId: "L1", evidence: "跨日冷检通过" });
  });

  it("迁移流水与当前状态漂移时直接报结构错误", () => {
    const parsed = parseReciteLedger(`${header}
### L1｜法理｜仍挂着
- 挂 07-01 ｜ 最后碰 **08-05** ｜ 状态：挂
<!-- recite-transition-v1 {"operationId":"op-1","date":"2026-08-05","event":"withdraw","entryId":"L1","fromStatus":"active","toStatus":"withdrawn","fromRoute":"daibei","toRoute":"daibei","evidence":"通过"} -->
`, { referenceDate: "2026-08-05" });

    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code: "transition_status_drift", id: "L1" })]));
  });

  it("把带背结果、检验条件与候选栽点留成同账本 append-only 证据", () => {
    const original = `${header}
### X1｜刑法｜程度词
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-05" });
    const applied = applyEvidenceEvent(original, parsed, {
      id: "X1",
      date: "2026-08-05",
      dimension: "recall",
      result: "fail",
      cold: true,
      promptIntegrity: "clean",
      failurePatternCode: "degree_strength",
      diagnosisStatus: "pending",
      evidenceAnchor: "背诵一本通#刑法-程度词",
      note: "把可以说成应当",
    });
    const checked = parseReciteLedger(applied.markdown, { referenceDate: "2026-08-05" });

    expect(checked.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(checked.records[0]).toMatchObject({ lastTouchedOn: "2026-08-05" });
    expect(checked.records[0].explicitEvidence).toEqual([
      expect.objectContaining({ entryId: "X1", result: "fail", cold: true, failurePatternCode: "degree_strength", diagnosisStatus: "pending" }),
    ]);
    expect(applied.markdown).toContain("**冷复检（08-05）**：✗；栽点：程度词/效力词漂移（pending）");
    expect(applied.markdown).toContain("<!-- recite-evidence-v2");
  });

  it("失败证据没有栽点类型时拒绝写入", () => {
    const original = `${header}
### X1｜刑法｜程度词
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-05" });
    expect(() => applyEvidenceEvent(original, parsed, {
      id: "X1",
      date: "2026-08-05",
      result: "fail",
      evidenceAnchor: "背诵一本通#刑法-程度词",
    })).toThrow("必须记录栽点类型");
  });

  it("污染题 void 只留教练事故审计，不刷新最后碰或用户栽点", () => {
    const original = `${header}
### X1｜刑法｜程度词
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-05" });
    const applied = applyEvidenceEvent(original, parsed, {
      id: "X1",
      date: "2026-08-05",
      dimension: "recall",
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      failurePatternCode: "degree_strength",
      evidenceAnchor: "污染题#1",
      note: "点名错误项",
    });
    const checked = parseReciteLedger(applied.markdown, { referenceDate: "2026-08-05" });

    expect(checked.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(checked.records[0].lastTouchedOn).toBe("2026-08-01");
    expect(applied.event).toMatchObject({ result: "void", failurePatternCode: null, diagnosisStatus: null });
    expect(applied.event.note).toContain("responsibility=teacher");
    expect(applied.markdown).not.toContain("栽点：程度词");
  });

  it("同一内存事务可先写冷检证据再撤池，重解析后两类事实一致", () => {
    const original = `${header}
### L1｜法理｜普通挂账
- 挂 08-01 ｜ 最后碰 **08-01** ｜ 状态：挂
`;
    const parsed = parseReciteLedger(original, { referenceDate: "2026-08-10" });
    const evidenced = applyEvidenceEvent(original, parsed, {
      id: "L1",
      date: "2026-08-10",
      dimension: "recall",
      result: "pass",
      cold: true,
      promptIntegrity: "clean",
      evidenceAnchor: "教材#L1",
    });
    const afterEvidence = parseReciteLedger(evidenced.markdown, { referenceDate: "2026-08-10" });
    const transitioned = applyTransition(evidenced.markdown, afterEvidence, {
      id: "L1",
      event: "withdraw",
      date: "2026-08-10",
      evidence: "教材#L1",
      note: "冷检通过",
    });
    const final = parseReciteLedger(transitioned.markdown, { referenceDate: "2026-08-10" });
    expect(final.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(final.records[0]).toMatchObject({ status: "withdrawn", lastTouchedOn: "2026-08-10" });
    expect(final.evidenceEvents).toHaveLength(1);
    expect(final.transitions).toHaveLength(1);
  });
});
