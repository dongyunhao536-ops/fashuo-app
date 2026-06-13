import { vi, describe, it, expect, beforeEach } from "vitest";

// hoisted：vi.mock 工厂在文件顶部提升执行，共享状态必须在 hoisted 块内构造，
// 否则模块级 let 此时尚未初始化。
const h = vi.hoisted(() => {
  const state = {
    selectResult: { data: null as { id: number }[] | null, error: null as { message: string } | null },
    insertResult: { error: null as { message: string } | null },
    updateResult: { error: null as { message: string } | null },
    insertPayloads: [] as Record<string, unknown>[],
    selectFilters: [] as string[], // 记录 SELECT 链上的过滤列，断言防重维度
    updateCalled: false,
  };
  interface Builder {
    _op?: string;
    select: () => Builder;
    insert: (p: unknown) => Builder;
    update: () => Builder;
    eq: (col: unknown) => Builder;
    is: (col: unknown) => Builder;
    limit: () => Builder;
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise<unknown>;
  }
  function from(): Builder {
    const b: Builder = {
      select: () => { b._op = "select"; return b; },
      insert: (p: unknown) => { b._op = "insert"; state.insertPayloads.push(p as Record<string, unknown>); return b; },
      update: () => { b._op = "update"; state.updateCalled = true; return b; },
      eq: (col: unknown) => { if (b._op === "select") state.selectFilters.push(`eq:${col}`); return b; },
      is: (col: unknown) => { if (b._op === "select") state.selectFilters.push(`is:${col}`); return b; },
      limit: () => b,
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const r = b._op === "select" ? state.selectResult : b._op === "insert" ? state.insertResult : state.updateResult;
        return Promise.resolve(r).then(onF, onR);
      },
    };
    return b;
  }
  return { state, from };
});

vi.mock("./supabase", () => ({ supabaseAdmin: { from: h.from } }));

import { emitEvent, consumeReviewRequests } from "./events";

beforeEach(() => {
  h.state.selectResult = { data: null, error: null };
  h.state.insertResult = { error: null };
  h.state.updateResult = { error: null };
  h.state.insertPayloads.length = 0;
  h.state.selectFilters.length = 0;
  h.state.updateCalled = false;
});

const base = { subject: "刑法", kp_id: null, knowledge: "正当防卫限度", anchor: null, source: "答疑" } as const;

describe("emitEvent 投递 + pending 防重", () => {
  it("已有 pending 同条 → 不重复 insert，仍返回 true（等同已投）", async () => {
    h.state.selectResult = { data: [{ id: 7 }], error: null };
    const ok = await emitEvent({ type: "弱项候选", ...base });
    expect(ok).toBe(true);
    expect(h.state.insertPayloads).toHaveLength(0);
  });

  it("无 pending → insert，payload 带 status=pending", async () => {
    h.state.selectResult = { data: [], error: null };
    const ok = await emitEvent({ type: "弱项候选", ...base });
    expect(ok).toBe(true);
    expect(h.state.insertPayloads).toHaveLength(1);
    expect(h.state.insertPayloads[0]).toMatchObject({ type: "弱项候选", status: "pending", knowledge: "正当防卫限度" });
  });

  it("insert 失败 → 返回 false", async () => {
    h.state.selectResult = { data: [], error: null };
    h.state.insertResult = { error: { message: "boom" } };
    const ok = await emitEvent({ type: "弱项候选", ...base });
    expect(ok).toBe(false);
  });

  it("默认按 subject+knowledge 防重（自由短语，同 kp 可挂多条）", async () => {
    h.state.selectResult = { data: [], error: null };
    await emitEvent({ type: "弱项候选", ...base });
    expect(h.state.selectFilters).toContain("eq:subject");
    expect(h.state.selectFilters).toContain("eq:knowledge");
    expect(h.state.selectFilters).not.toContain("eq:kp_id");
  });

  it("dedupBy=kp（考点级）按 kp_id 防重，不看 knowledge", async () => {
    h.state.selectResult = { data: [], error: null };
    await emitEvent({ type: "复验请求", ...base, kp_id: "XF-0042", dedupBy: "kp" });
    expect(h.state.selectFilters).toContain("eq:kp_id");
    expect(h.state.selectFilters).not.toContain("eq:knowledge");
  });

  it("subject 为 null → 用 is(subject) 而非 eq（弱项候选缺科目兜底）", async () => {
    h.state.selectResult = { data: [], error: null };
    await emitEvent({ type: "弱项候选", ...base, subject: null });
    expect(h.state.selectFilters).toContain("is:subject");
  });
});

describe("consumeReviewRequests G2 兑现", () => {
  it("调用 update 消费该 kp 的 pending 复验请求（不抛）", async () => {
    await expect(consumeReviewRequests("XF-0042")).resolves.toBeUndefined();
    expect(h.state.updateCalled).toBe(true);
  });
});
