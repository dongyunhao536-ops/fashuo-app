import { describe, expect, it } from "vitest";
import { canonicalJson, ingestPayloadSha256, withIngestAudit } from "./ingest-ledger.mjs";

function rpcDb(responses) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return responses.shift() ?? { data: {}, error: null };
    },
  };
}

describe("ingest ledger", () => {
  it("对象键顺序不影响 payload 指纹", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(ingestPayloadSha256({ op: "x", a: 1, b: 2 }))
      .toBe(ingestPayloadSha256({ b: 2, a: 1, op: "x" }));
  });

  it("首次处理按 begin → handler → complete 入账", async () => {
    const db = rpcDb([
      { data: { action: "apply", attempt_count: 1 }, error: null },
      { data: { status: "applied" }, error: null },
    ]);
    const operation = { op: "study_log", operation_id: "op-1", subject: "刑法" };
    const result = await withIngestAudit({
      db,
      operation,
      handlerVersion: "test-v1",
      handler: async () => ({ kind: "study_log", affected: 1 }),
    });
    expect(result.affected).toBe(1);
    expect(db.calls.map((call) => call.name)).toEqual(["begin_ingest_operation", "complete_ingest_operation"]);
    expect(db.calls[0].args.p_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("已应用操作直接返回历史结果，不再触发业务写入", async () => {
    const db = rpcDb([{ data: { action: "replay", result: { kind: "study_log", affected: 1 } }, error: null }]);
    let handled = false;
    const result = await withIngestAudit({
      db,
      operation: { op: "study_log", operation_id: "op-1" },
      handlerVersion: "test-v1",
      handler: async () => ((handled = true), {}),
    });
    expect(handled).toBe(false);
    expect(result).toMatchObject({ kind: "study_log", affected: 1 });
    expect(db.calls).toHaveLength(1);
  });

  it("业务失败后持久化失败状态，原异常继续交给 outbox 重试", async () => {
    const db = rpcDb([
      { data: { action: "apply" }, error: null },
      { data: { status: "failed" }, error: null },
    ]);
    await expect(withIngestAudit({
      db,
      operation: { op: "study_log", operation_id: "op-fail" },
      handlerVersion: "test-v1",
      handler: async () => { throw new Error("network down"); },
    })).rejects.toThrow("network down");
    expect(db.calls.map((call) => call.name)).toEqual(["begin_ingest_operation", "fail_ingest_operation"]);
  });
});
