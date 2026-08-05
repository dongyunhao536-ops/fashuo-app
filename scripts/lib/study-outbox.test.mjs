import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendOutbox,
  processOutbox,
  readOutbox,
  syncStudyOutbox,
  writeOutbox,
} from "./study-outbox.mjs";

const dirs = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "fashuo-outbox-"));
  dirs.push(dir);
  return join(dir, "pending.jsonl");
}

function scriptedDb(responses) {
  const calls = [];
  let cursor = 0;

  function from(table) {
    const call = { table, steps: [] };
    let completed;
    const finish = () => {
      if (!completed) {
        calls.push(call);
        completed = Promise.resolve(responses[cursor++] ?? { data: null, error: null });
      }
      return completed;
    };
    const builder = {};
    for (const method of ["select", "upsert", "update", "eq", "neq", "in", "order", "limit"]) {
      builder[method] = (...args) => {
        call.steps.push({ method, args });
        return builder;
      };
    }
    builder.single = () => finish();
    builder.maybeSingle = () => finish();
    builder.then = (onFulfilled, onRejected) => finish().then(onFulfilled, onRejected);
    return builder;
  }

  return {
    db: { from },
    calls,
    remaining: () => responses.length - cursor,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("study outbox", () => {
  it("为新操作生成稳定 operation_id 并能原样读回", () => {
    const path = tempPath();
    const added = appendOutbox(path, { op: "study_log", subject: "宪法" }, {
      operationId: "op-1",
      timestamp: "2026-08-04T00:00:00.000Z",
    });

    expect(added.operation_id).toBe("op-1");
    expect(readOutbox(path)).toEqual([added]);
  });

  it("为旧格式缓冲生成确定性 ID，重复读取不会变化", () => {
    const path = tempPath();
    writeOutbox(path, [{ op: "new_error", subject: "刑法", knowledge: "测试" }]);

    const first = readOutbox(path)[0].operation_id;
    const second = readOutbox(path)[0].operation_id;
    expect(first).toMatch(/^legacy-[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("部分失败时只移除成功项，失败项保留供重试", async () => {
    const operations = [
      { op: "study_log", operation_id: "ok" },
      { op: "new_error", operation_id: "retry" },
    ];
    const result = await processOutbox(operations, async (op) => {
      if (op.operation_id === "retry") throw new Error("network down");
      return { affected: 1 };
    });

    expect(result.succeeded.map(({ op }) => op.operation_id)).toEqual(["ok"]);
    expect(result.failed).toEqual([{ op: operations[1], error: "network down" }]);

    const path = tempPath();
    writeOutbox(path, result.failed.map(({ op }) => op));
    expect(readOutbox(path)).toEqual([operations[1]]);
  });

  it("可以在 Windows 上原子替换已经存在的 outbox", () => {
    const path = tempPath();
    appendOutbox(path, { op: "study_log" }, { operationId: "old" });
    const retained = { op: "new_error", operation_id: "retry" };
    writeOutbox(path, [retained]);
    expect(readOutbox(path)).toEqual([retained]);
  });

  it("损坏行不会被静默吞掉", () => {
    const path = tempPath();
    writeFileSync(path, '{"op":"study_log"}\n这不是 JSON\n');
    expect(() => readOutbox(path)).toThrow("第 2 行不是合法 JSON");
    expect(readFileSync(path, "utf8")).toContain("这不是 JSON");
  });

  it("主题和关联都用稳定唯一键 upsert，同一错题可以保留主主题和关联主题", async () => {
    const path = tempPath();
    writeOutbox(path, [
      {
        op: "classify_error",
        operation_id: "classify-primary",
        studyErrorId: 7,
        topic: { title: "主观方面必备要件口径", role: "primary" },
      },
      {
        op: "classify_error",
        operation_id: "classify-related",
        studyErrorId: 7,
        topic: { title: "审题层级区分", role: "related" },
      },
    ]);
    const scripted = scriptedDb([
      { data: { id: 7, subject: "刑法", kp_id: null }, error: null },
      { data: { id: 10, topic_key: "刑法:a", title: "主观方面必备要件口径", classification_status: "confirmed" }, error: null },
      { data: [], error: null },
      { data: null, error: null },
      { data: { id: 7, subject: "刑法", kp_id: null }, error: null },
      { data: { id: 11, topic_key: "刑法:b", title: "审题层级区分", classification_status: "confirmed" }, error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-05",
      now: new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(2);
    expect(readOutbox(path)).toEqual([]);
    expect(scripted.remaining()).toBe(0);

    const topicUpserts = scripted.calls
      .filter((call) => call.table === "error_topic")
      .map((call) => call.steps.find((step) => step.method === "upsert"));
    expect(topicUpserts).toHaveLength(2);
    expect(topicUpserts.every((step) => step.args[1].onConflict === "topic_key")).toBe(true);

    const linkUpserts = scripted.calls
      .filter((call) => call.table === "study_error_topic")
      .map((call) => call.steps.find((step) => step.method === "upsert"))
      .filter(Boolean);
    expect(linkUpserts.map((step) => step.args[0].role)).toEqual(["primary", "related"]);
    expect(linkUpserts.every((step) => step.args[1].onConflict === "study_error_id,topic_id")).toBe(true);
  });

  it("冷复检按证据自动进入 stable，后续失败会立即回到 open", async () => {
    const path = tempPath();
    writeOutbox(path, [
      { op: "error_review", operation_id: "review-pass", topicId: 10, result: "pass" },
      { op: "error_review", operation_id: "review-fail", topicId: 10, result: "fail" },
    ]);
    const scripted = scriptedDb([
      { data: null, error: null },
      { data: [
        { id: 2, review_date: "2026-08-05", result: "pass" },
        { id: 1, review_date: "2026-08-03", result: "pass" },
      ], error: null },
      { data: [{ id: 10 }], error: null },
      { data: null, error: null },
      { data: [
        { id: 3, review_date: "2026-08-06", result: "fail" },
        { id: 2, review_date: "2026-08-05", result: "pass" },
        { id: 1, review_date: "2026-08-03", result: "pass" },
      ], error: null },
      { data: [{ id: 10 }], error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-06",
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(result.succeeded.map(({ result: item }) => item.masteryStatus)).toEqual(["stable", "open"]);
    expect(result.failed).toEqual([]);
    const masteryUpdates = scripted.calls
      .filter((call) => call.table === "error_topic")
      .map((call) => call.steps.find((step) => step.method === "update")?.args[0].mastery_status);
    expect(masteryUpdates).toEqual(["stable", "open"]);
  });

  it("PC 答疑卡点新增与收口都走幂等 outbox", async () => {
    const path = tempPath();
    writeOutbox(path, [
      { op: "ask_point", operation_id: "ask-add", subject: "刑法", confusion: "不能犯未遂边界", date: "2026-08-05" },
      { op: "resolve_ask_point", operation_id: "ask-resolve", pointId: 55, action: "clarified", note: "新情境已能解释" },
    ]);
    const scripted = scriptedDb([
      { data: [{ id: 55 }], error: null },
      { data: null, error: null },
      { data: [{ id: 55, status: "clarified" }], error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-05",
      now: new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded.map(({ result: item }) => item.kind)).toEqual(["ask_point", "resolve_ask_point"]);
    expect(readOutbox(path)).toEqual([]);
    const insert = scripted.calls[0].steps.find((step) => step.method === "upsert");
    expect(insert.args[0]).toMatchObject({ operation_id: "ask-add", source: "pc", ttl_until: "2026-11-03" });
    const update = scripted.calls[2].steps.find((step) => step.method === "update");
    expect(update.args[0]).toMatchObject({ status: "clarified", resolve_operation_id: "ask-resolve" });
  });
});
