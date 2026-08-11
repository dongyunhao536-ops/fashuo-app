import { describe, expect, it } from "vitest";
import {
  appendJudgment,
  beijingDate,
  parseJudgmentLedger,
  resolveJudgment,
  summarizeJudgmentLedger,
} from "./judgment-ledger.mjs";

const TODAY = "2026-08-07";
const HEAD = `# 判断台账

## 结构化台账（机器读取）

| id | date | type | subject | ref | prediction | basis | verify_date | result | resolved_date | seed | note |
<!-- 列：落账日 ｜ 类型 ｜ 科目 ｜ 关联 ｜ 预测内容 ｜ 依据 ｜ 验证时点 ｜ 结果 ｜ 对账日 ｜ 种子 ｜ 备注 -->
`;

// [gpt] 2026-08-10：固定种子不接收无效覆盖参数。
function seedRow() {
  return `| J0001 | 2026-08-01 | 事实 | — | — | 官方答案不存在 | Get-ChildItem 不加 -Force | 2026-08-01 | miss | 2026-08-01 | 1 | 真题_文本 Hidden，答案存在 |`;
}

describe("judgment ledger", () => {
  it("追加一条预测并复验结构", () => {
    const result = appendJudgment(HEAD, {
      type: "栽点",
      prediction: "会栽在职务代理与无权处分边界",
      subject: "民法",
      ref: "T#98",
      verifyDate: "2026-08-08",
    }, { referenceDate: TODAY });
    expect(result.added).toBe(true);
    expect(result.id).toBe("J0001");
    const parsed = parseJudgmentLedger(result.markdown, { referenceDate: TODAY });
    expect(parsed.counts.errors).toBe(0);
    expect(parsed.items[0]).toMatchObject({ id: "J0001", type: "栽点", result: "pending", seed: 0 });
  });

  it("空文件可自动初始化机器表并写入第一条预测", () => {
    const result = appendJudgment("", {
      type: "事实",
      prediction: "今晚会完成核验",
      verifyDate: TODAY,
    }, { referenceDate: TODAY });
    expect(result.markdown).toContain("# 判断台账");
    expect(result.markdown).toContain("| id | date | type |");
    expect(parseJudgmentLedger(result.markdown).counts.errors).toBe(0);
  });

  it("对账后到期未对账清零，重复对账幂等", () => {
    const added = appendJudgment(HEAD, {
      type: "掌握度",
      prediction: "这条能过",
      ref: "L9",
      verifyDate: "2026-08-08",
    }, { referenceDate: TODAY });
    const resolved = resolveJudgment(added.markdown, "J0001", "hit", { date: "2026-08-08", note: "四块全过" });
    const parsed = parseJudgmentLedger(resolved.markdown, { referenceDate: "2026-08-08" });
    expect(parsed.items[0]).toMatchObject({ result: "hit", resolvedDate: "2026-08-08", note: "四块全过" });
    const summary = summarizeJudgmentLedger(parsed, { referenceDate: "2026-08-08" });
    expect(summary.counts.dueUnresolved).toBe(0);
    expect(summary.hitRate).toBe(100);
    const again = resolveJudgment(resolved.markdown, "J0001", "miss", { date: "2026-08-09" });
    expect(again.changed).toBe(false);
  });

  it("种子不计入兑现率分母，只出错误分布", () => {
    const withSeed = appendJudgment(`${HEAD}${seedRow()}\n`, {
      type: "栽点",
      prediction: "会错在边界",
      verifyDate: "2026-08-02",
    }, { referenceDate: "2026-08-01" });
    const resolved = resolveJudgment(withSeed.markdown, "J0002", "miss", { date: "2026-08-02" });
    const parsed = parseJudgmentLedger(resolved.markdown, { referenceDate: "2026-08-02" });
    const summary = summarizeJudgmentLedger(parsed, { referenceDate: "2026-08-02" });
    expect(summary.counts.seed).toBe(1);
    expect(summary.counts.countable).toBe(1);
    expect(summary.hitRate).toBe(0);
    expect(summary.seedDistribution).toMatchObject({ 事实: { miss: 1 } });
    expect(summary.counts.void).toBe(0);
  });

  it("到期未对账的预测会被 due 统计捕获", () => {
    const added = appendJudgment(HEAD, {
      type: "排期",
      prediction: "今晚三件能完成",
      verifyDate: "2026-08-06",
    }, { referenceDate: "2026-08-05" });
    const summary = summarizeJudgmentLedger(parseJudgmentLedger(added.markdown, { referenceDate: "2026-08-07" }), { referenceDate: "2026-08-07" });
    expect(summary.counts.dueUnresolved).toBe(1);
    expect(summary.due[0]).toMatchObject({ id: "J0001", type: "排期" });
  });

  it("坏结构会被 check 捕获并拒绝继续", () => {
    const bad = `${HEAD}| J0001 | 2026-08-07 | 坏类型 | — | — | 预测 | — | — | pending | — | 0 | — |\n`;
    const parsed = parseJudgmentLedger(bad, { referenceDate: TODAY });
    expect(parsed.counts.errors).toBeGreaterThan(0);
    expect(() => appendJudgment(bad, { type: "栽点", prediction: "x" }, { referenceDate: TODAY })).toThrow(/结构错误/);
    expect(() => summarizeJudgmentLedger(parsed, { referenceDate: TODAY })).toThrow(/拒绝汇总/);
  });

  it("结果与对账日不一致会被判为坏账", () => {
    const resolvedWithoutDate = `${HEAD}| J0001 | 2026-08-07 | 事实 | — | — | 预测 | — | — | hit | — | 0 | — |\n`;
    const pendingWithDate = `${HEAD}| J0001 | 2026-08-07 | 事实 | — | — | 预测 | — | — | pending | 2026-08-07 | 0 | — |\n`;
    expect(parseJudgmentLedger(resolvedWithoutDate).issues.some((issue) => issue.code === "resolved-missing-date")).toBe(true);
    expect(parseJudgmentLedger(pendingWithDate).issues.some((issue) => issue.code === "pending-has-resolved-date")).toBe(true);
  });

  it("北京日口径与其他台账一致", () => {
    expect(beijingDate(new Date("2026-08-07T16:30:00Z"))).toBe("2026-08-08");
  });
});
