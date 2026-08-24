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
  it("销账落库前重验事件证据，一次通过会保留在 outbox", async () => {
    // [gpt] 2026-08-10：即使手改 outbox，也不能绕过两轴销账门槛。
    const path = tempPath();
    const operation = { op: "absorb", operation_id: "absorb-too-early", ids: [102] };
    writeOutbox(path, [operation]);
    const scripted = scriptedDb([
      { data: [{ id: 102, status: "open", log_date: "2026-08-09" }], error: null },
      { data: [{ study_error_id: 102, topic_id: 90, role: "primary" }], error: null },
      { data: [{ id: 21, topic_id: 90, study_error_id: 102, review_date: "2026-08-10", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3, probe_axis: "fact_signal", angle: "跨朝代切换", evidence_anchor: "教材P213", note: "结论和依据正确" }], error: null },
    ]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.succeeded).toEqual([]);
    expect(result.failed[0].error).toContain("仅有 1/2 条");
    expect(scripted.calls.map((call) => call.table)).toEqual(["study_error", "study_error_topic", "error_review"]);
    expect(readOutbox(path)).toEqual([operation]);
  });

  it("两轴且至少一次冷检通过后才真正销账", async () => {
    const path = tempPath();
    writeOutbox(path, [{ op: "absorb", operation_id: "absorb-ready", ids: [102] }]);
    const base = { topic_id: 90, study_error_id: 102, review_date: "2026-08-10", result: "pass", dimension: "application", prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3 };
    const scripted = scriptedDb([
      { data: [{ id: 102, status: "open", log_date: "2026-08-09" }], error: null },
      { data: [{ study_error_id: 102, topic_id: 90, role: "primary" }], error: null },
      { data: [
        { ...base, id: 21, cold: true, probe_axis: "fact_signal", angle: "跨朝代切换", evidence_anchor: "教材P213", note: "能按朝代说明" },
        { ...base, id: 22, cold: false, probe_axis: "rule_boundary", angle: "行政机关边界", evidence_anchor: "真题2017-40", note: "能解释边界" },
      ], error: null },
      { data: [{ id: 102, kp_id: null }], error: null },
    ]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ kind: "absorb", affected: 1 });
    expect(readOutbox(path)).toEqual([]);
    const update = scripted.calls.at(-1).steps.find((step) => step.method === "update");
    expect(update.args[0]).toMatchObject({ status: "absorbed", absorbed_via: "pc复盘" });
  });

  it("误销账恢复只改事件状态并留下审计原因", async () => {
    const path = tempPath();
    writeOutbox(path, [{ op: "reopen_error", operation_id: "reopen-102", ids: [102], reason: "教练误把一次通过当作销账门槛" }]);
    const scripted = scriptedDb([{ data: [{ id: 102, kp_id: null }], error: null }]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ kind: "reopen_error", affected: 1 });
    const update = scripted.calls[0].steps.find((step) => step.method === "update");
    expect(update.args[0]).toMatchObject({
      status: "open",
      absorbed_at: null,
      absorbed_via: null,
      reopened_via: "pc纠错",
      reopen_reason: "教练误把一次通过当作销账门槛",
    });
  });

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

  it("同步前预检整批错题，后段坏条目不会造成任何远端写入", async () => {
    const path = tempPath();
    const operations = [
      { op: "study_log", operation_id: "would-write", subject: "民法", activity: "做题" },
      { op: "new_error", operation_id: "bad-error", subject: "民法", knowledge: "所有权误判", entrySource: "batch" },
    ];
    writeOutbox(path, operations);
    const scripted = scriptedDb([]);

    await expect(syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-13",
      now: new Date("2026-08-13T12:00:00.000Z"),
    })).rejects.toThrow(/chapter_missing/);

    expect(scripted.calls).toEqual([]);
    expect(readOutbox(path)).toEqual(operations);
  });

  it("旧错题缓冲失败重试时保留原 payload，不把兼容字段写回导致 ingest 指纹漂移", async () => {
    const path = tempPath();
    const legacy = { op: "new_error", operation_id: "legacy-retry", subject: "刑法", knowledge: "旧缓冲" };
    writeOutbox(path, [legacy]);
    const scripted = scriptedDb([{ data: null, error: { message: "network down" } }]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-13",
      now: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(result.failed[0].error).toContain("network down");
    expect(readOutbox(path)).toEqual([legacy]);
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

  it("结构化迁移证据达到跨时门槛才 stable，后续失败立即回 open", async () => {
    const path = tempPath();
    writeOutbox(path, [
      {
        op: "error_review", operation_id: "review-pass", topicId: 10, result: "pass", date: "2026-08-10",
        variantKind: "novel_case", dimension: "application", cold: true, promptIntegrity: "clean",
        probeAxis: "time_condition",
        angle: "改变时间条件", evidenceAnchor: "变式卷#2",
      },
      {
        op: "error_review", operation_id: "review-fail", topicId: 10, result: "fail", date: "2026-08-11",
        variantKind: "novel_case", dimension: "application", cold: true, promptIntegrity: "clean",
        probeAxis: "fact_signal",
        angle: "再换案情", evidenceAnchor: "变式卷#3",
      },
    ]);
    const scripted = scriptedDb([
      { data: null, error: null },
      { data: [
        { id: 2, review_date: "2026-08-10", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4, probe_axis: "time_condition", angle: "改变时间条件", evidence_anchor: "变式卷#2" },
        { id: 1, review_date: "2026-08-03", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3, probe_axis: "subject_condition", angle: "改变主体条件", evidence_anchor: "变式卷#1" },
      ], error: null },
      { data: [{ id: 10 }], error: null },
      { data: null, error: null },
      { data: [
        { id: 3, review_date: "2026-08-11", result: "fail", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4, probe_axis: "fact_signal", angle: "再换案情", evidence_anchor: "变式卷#3" },
        { id: 2, review_date: "2026-08-10", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "novel_case", transfer_level: 4, probe_axis: "time_condition", angle: "改变时间条件", evidence_anchor: "变式卷#2" },
        { id: 1, review_date: "2026-08-03", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3, probe_axis: "subject_condition", angle: "改变主体条件", evidence_anchor: "变式卷#1" },
      ], error: null },
      { data: [{ id: 10 }], error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-11",
      now: new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(result.succeeded.map(({ result: item }) => item.masteryStatus)).toEqual(["stable", "open"]);
    expect(result.failed).toEqual([]);
    const masteryUpdates = scripted.calls
      .filter((call) => call.table === "error_topic")
      .map((call) => call.steps.find((step) => step.method === "update")?.args[0].mastery_status);
    expect(masteryUpdates).toEqual(["stable", "open"]);
  });

  it("错题复检读取主题 kp_id 并把应用证据写入统一知识证据表", async () => {
    const path = tempPath();
    writeOutbox(path, [
      {
        op: "error_review", operation_id: "review-with-kp", topicId: 10, result: "pass", date: "2026-08-06",
        variantKind: "counterfactual", dimension: "application", cold: true, promptIntegrity: "clean",
        probeAxis: "subject_condition",
        angle: "改变主体条件", evidenceAnchor: "变式题#1",
      },
    ]);
    const scripted = scriptedDb([
      { data: null, error: null },
      { data: [{ id: 1, review_date: "2026-08-06", result: "pass", dimension: "application", cold: true, prompt_integrity: "clean", variant_kind: "counterfactual", transfer_level: 3, probe_axis: "subject_condition", angle: "改变主体条件", evidence_anchor: "变式题#1" }], error: null },
      { data: [{ id: 10, kp_id: "XF-0054" }], error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-06",
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "error_review",
      knowledgeEvidence: { kind: "knowledge_evidence", kpId: "XF-0054", dimension: "application", result: "pass" },
    });
    const topicSelect = scripted.calls.find((call) => call.table === "error_topic").steps.find((step) => step.method === "select");
    expect(topicSelect.args[0]).toBe("id, kp_id");
    const evidenceUpsert = scripted.calls.find((call) => call.table === "knowledge_evidence").steps.find((step) => step.method === "upsert");
    expect(evidenceUpsert.args[0]).toMatchObject({
      operation_id: "review-with-kp:knowledge-application",
      kp_id: "XF-0054",
      dimension: "application",
      result: "pass",
      source_kind: "error_review",
    });
    const reviewUpsert = scripted.calls.find((call) => call.table === "error_review").steps.find((step) => step.method === "upsert");
    expect(reviewUpsert.args[0]).toMatchObject({
      dimension: "application",
      cold: true,
      prompt_integrity: "clean",
      variant_kind: "counterfactual",
      transfer_level: 3,
      probe_axis: "subject_condition",
    });
  });

  it("作废题在任何远端调用前完成一致性校验", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "error_review",
      operation_id: "invalid-half-write",
      topicId: 10,
      result: "pass",
      variantKind: "invalid",
      dimension: "application",
      cold: false,
      promptIntegrity: "invalid",
    }]);
    const scripted = scriptedDb([]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-11",
      now: new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed[0].error).toContain("作废复检必须同时使用");
    expect(scripted.calls).toEqual([]);
    expect(readOutbox(path)).toHaveLength(1);
  });

  it("教练污染题可作为 void 留审计，但不改变主题状态", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "error_review",
      operation_id: "teacher-invalid-audit",
      topicId: 10,
      result: "void",
      date: "2026-08-12",
      variantKind: "invalid",
      dimension: "application",
      cold: false,
      promptIntegrity: "invalid",
      probeAxis: "invalid",
      note: "responsibility=teacher；题面点名错误项",
    }]);
    const scripted = scriptedDb([
      { data: null, error: null },
      { data: [{ id: 8, review_date: "2026-08-05", result: "pass" }], error: null },
      { data: [{ id: 10, kp_id: null }], error: null },
    ]);
    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-12",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "error_review",
      masteryStatus: "monitoring",
      disposition: {
        responsibility: "teacher",
        countAsValidAttempt: false,
        countAsUserError: false,
        advanceCooldown: false,
        closeSchedule: false,
      },
    });
    const review = scripted.calls.find((call) => call.table === "error_review").steps.find((step) => step.method === "upsert").args[0];
    expect(review).toMatchObject({ result: "void", prompt_integrity: "invalid", cold: false, variant_kind: "invalid", probe_axis: "invalid" });
    expect(review.note).toContain("responsibility=teacher");
    expect(review.note).toContain("user_error=false");
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

  it("带 KP 的答疑卡点创建时同步生成确认映射与 understanding 缺口证据", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "ask_point",
      operation_id: "ask-with-kp",
      subject: "刑法",
      confusion: "不能犯未遂的判断边界仍混淆",
      kpId: "XF-0054",
      initialUnderstanding: "partial",
      evidenceAnchor: "考试分析·未遂章节",
      date: "2026-08-05",
    }]);
    const scripted = scriptedDb([
      { data: [{ id: 55 }], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-05",
      now: new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "ask_point",
      pointId: 55,
      knowledgeLink: { kind: "knowledge_link", sourceKind: "ask_point", sourceId: "55", kpId: "XF-0054", linkStatus: "confirmed" },
      knowledgeEvidence: { kind: "knowledge_evidence", kpId: "XF-0054", dimension: "understanding", result: "partial" },
    });
    expect(scripted.calls.map((call) => call.table)).toEqual(["ask_summary", "knowledge_object_link", "knowledge_evidence"]);
    const evidence = scripted.calls[2].steps.find((step) => step.method === "upsert").args[0];
    expect(evidence).toMatchObject({ source_kind: "ask_point", source_id: "55", prompt_integrity: "clean" });
  });

  it("答疑验证严格按映射、证据、clarified 顺序执行", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "ask_verification",
      operation_id: "ask-verify-pass",
      pointId: 55,
      kpId: "XF-0054",
      result: "pass",
      promptIntegrity: "clean",
      evidenceAnchor: "新情境变式#2",
      note: "无提示说清规则、例外与涵摄",
      date: "2026-08-06",
    }]);
    const scripted = scriptedDb([
      { data: { id: 55, status: "open", kp_id: "XF-0054" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: [{ id: 55, status: "clarified" }], error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-06",
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "ask_verification",
      pointId: 55,
      kpId: "XF-0054",
      result: "pass",
      promptIntegrity: "clean",
      clarified: true,
    });
    expect(scripted.calls.map((call) => call.table)).toEqual([
      "ask_summary",
      "knowledge_object_link",
      "knowledge_evidence",
      "ask_summary",
      "ask_summary",
    ]);
    const evidenceCall = scripted.calls[2].steps.find((step) => step.method === "upsert");
    expect(evidenceCall.args[0]).toMatchObject({
      operation_id: "ask-verify-pass:knowledge-understanding",
      dimension: "understanding",
      result: "pass",
      source_kind: "ask_point",
      source_id: "55",
    });
    const resolutionCall = scripted.calls[4].steps.find((step) => step.method === "update");
    expect(resolutionCall.args[0]).toMatchObject({ status: "clarified", resolve_operation_id: "ask-verify-pass" });
  });

  it("答疑污染题 void 保持卡点 open，并只返回教练责任审计", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "ask_verification",
      operation_id: "ask-verify-void",
      pointId: 55,
      kpId: "XF-0054",
      result: "void",
      cold: false,
      promptIntegrity: "invalid",
      evidenceAnchor: "污染题#1",
      note: "追问点名错误项",
      date: "2026-08-12",
    }]);
    const scripted = scriptedDb([
      { data: { id: 55, status: "open", kp_id: "XF-0054" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-12",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "ask_verification",
      result: "void",
      clarified: false,
      disposition: {
        responsibility: "teacher",
        countAsValidAttempt: false,
        countAsUserError: false,
        advanceCooldown: false,
        closeSchedule: false,
      },
    });
    expect(scripted.calls.map((call) => call.table)).toEqual(["ask_summary", "knowledge_object_link", "knowledge_evidence"]);
    const evidence = scripted.calls[2].steps.find((step) => step.method === "upsert").args[0];
    expect(evidence.note).toContain("responsibility=teacher");
  });

  it("答疑验证的证据写入失败时绝不提前销疑，并保留原操作重试", async () => {
    const path = tempPath();
    const operation = {
      op: "ask_verification",
      operation_id: "ask-verify-retry",
      pointId: 55,
      kpId: "XF-0054",
      result: "pass",
      promptIntegrity: "clean",
      evidenceAnchor: "变式题#3",
      note: "待重试",
    };
    writeOutbox(path, [operation]);
    const scripted = scriptedDb([
      { data: { id: 55, status: "open", kp_id: "XF-0054" }, error: null },
      { data: null, error: null },
      { data: null, error: { message: "temporary database error" } },
    ]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-06",
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed[0].error).toMatch(/知识点证据写入失败/);
    expect(scripted.calls.map((call) => call.table)).toEqual(["ask_summary", "knowledge_object_link", "knowledge_evidence"]);
    expect(scripted.calls.filter((call) => call.table === "ask_summary")).toHaveLength(1);
    expect(readOutbox(path)).toEqual([operation]);
  });

  it("知识映射和多维证据走同一可靠 outbox，确认主映射同步兼容旧 kp_id", async () => {
    const path = tempPath();
    writeOutbox(path, [
      { op: "knowledge_link", operation_id: "link-topic", sourceKind: "error_topic", sourceId: "25", kpId: "XF-0100", role: "primary", matchMethod: "manual", linkStatus: "confirmed", confidence: 100 },
      { op: "knowledge_evidence", operation_id: "evidence-1", kpId: "XF-0100", dimension: "application", result: "fail", sourceKind: "manual", promptIntegrity: "clean", cold: false },
    ]);
    const scripted = scriptedDb([
      { data: null, error: null },
      { data: [{ id: 25 }], error: null },
      { data: null, error: null },
    ]);
    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });
    expect(result.failed).toEqual([]);
    expect(result.succeeded.map(({ result: item }) => item.kind)).toEqual(["knowledge_link", "knowledge_evidence"]);
    const legacyUpdate = scripted.calls.find((call) => call.table === "error_topic")?.steps.find((step) => step.method === "update");
    expect(legacyUpdate?.args[0]).toEqual({ kp_id: "XF-0100" });
  });

  it("知识证据在写库前拒绝作废题/冷检条件自相矛盾", async () => {
    const path = tempPath();
    const operations = [
      { op: "knowledge_evidence", operation_id: "bad-void", kpId: "XF-0100", dimension: "recall", result: "void", promptIntegrity: "clean", cold: false },
      { op: "knowledge_evidence", operation_id: "bad-invalid", kpId: "XF-0100", dimension: "recall", result: "fail", promptIntegrity: "invalid", cold: false },
      { op: "knowledge_evidence", operation_id: "bad-cold", kpId: "XF-0100", dimension: "recall", result: "pass", promptIntegrity: "cued", cold: true },
    ];
    writeOutbox(path, operations);
    const scripted = scriptedDb([]);
    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.succeeded).toEqual([]);
    expect(result.failed.map((item) => item.error)).toEqual([
      expect.stringContaining("void 必须对应 invalid"),
      expect.stringContaining("invalid 题干也必须记 void"),
      expect.stringContaining("冷检必须使用 clean"),
    ]);
    expect(scripted.calls).toEqual([]);
    expect(readOutbox(path)).toEqual(operations);
  });

  it("通用知识证据 void 强制清除用户栽点并写教练责任", async () => {
    const path = tempPath();
    writeOutbox(path, [{
      op: "knowledge_evidence",
      operation_id: "teacher-void-evidence",
      kpId: "XF-0100",
      dimension: "recall",
      result: "void",
      promptIntegrity: "invalid",
      cold: false,
      failurePatternCode: "degree_strength",
      diagnosisStatus: "confirmed",
      note: "题面点名错误项",
    }]);
    const scripted = scriptedDb([{ data: null, error: null }]);

    const result = await syncStudyOutbox({
      db: scripted.db,
      path,
      today: "2026-08-12",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.failed).toEqual([]);
    const row = scripted.calls[0].steps.find((step) => step.method === "upsert").args[0];
    expect(row).toMatchObject({
      result: "void",
      prompt_integrity: "invalid",
      cold: false,
      failure_pattern_code: null,
      diagnosis_status: "pending",
    });
    expect(row.note).toContain("responsibility=teacher");
    expect(row.note).toContain("user_error=false");
  });

  it("知识前置关系走可靠 outbox，并拒绝无锚点确认", async () => {
    const path = tempPath();
    const valid = {
      op: "knowledge_relation",
      operation_id: "relation-1",
      prerequisiteKpId: "XF-0039",
      dependentKpId: "XF-0041",
      relationType: "prerequisite",
      requiredStage: "recall",
      relationStatus: "confirmed",
      sourceKind: "manual",
      evidenceAnchor: "人工核验：正当防卫成立条件→防卫过当",
      strength: 5,
      confidence: 100,
    };
    writeOutbox(path, [valid]);
    const scripted = scriptedDb([{ data: null, error: null }]);
    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });
    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ kind: "knowledge_relation", prerequisiteKpId: "XF-0039", dependentKpId: "XF-0041" });
    expect(scripted.calls[0].table).toBe("knowledge_relation");

    writeOutbox(path, [{ ...valid, operation_id: "relation-bad", evidenceAnchor: null }]);
    const rejected = await syncStudyOutbox({ db: scriptedDb([]).db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });
    expect(rejected.failed[0].error).toContain("必须带证据锚点");
  });

  it("统一学习尝试先入 ingest 审计，再由单个 RPC 原子写 attempt 与知识证据", async () => {
    // [gpt] 2026-08-10：成功样本也必须留下原始操作和分母，不能只在错题表中看见失败。
    const path = tempPath();
    writeOutbox(path, [{
      op: "learning_attempt",
      operation_id: "attempt-objective-1",
      subject: "刑法",
      kpId: "XF-0054",
      questionRef: "2019-base-12",
      sourceKind: "objective_question",
      sourceId: "2019-base-12",
      dimension: "application",
      result: "pass",
      score: 1,
      maxScore: 1,
      cold: true,
      promptIntegrity: "clean",
      evidenceAnchor: "2019基础卷#12",
    }]);
    const calls = [];
    const responses = [
      { data: { action: "apply", attempt_count: 1 }, error: null },
      { data: { kind: "learning_attempt", attempt_id: 8, knowledge_evidence_id: 9, projected: true }, error: null },
      { data: { status: "applied" }, error: null },
    ];
    const db = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        return responses.shift();
      },
    };

    const result = await syncStudyOutbox({ db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ kind: "learning_attempt", attempt_id: 8, projected: true });
    expect(calls.map((call) => call.name)).toEqual([
      "begin_ingest_operation",
      "record_learning_attempt",
      "complete_ingest_operation",
    ]);
    expect(calls[1].args.p_payload).toMatchObject({
      operation_id: "attempt-objective-1",
      ingest_operation_id: "attempt-objective-1",
      kp_id: "XF-0054",
      question_ref: "2019-base-12",
      score: 1,
      max_score: 1,
    });
    expect(readOutbox(path)).toEqual([]);
  });

  it("显式评分的学习流水会用数据库日志 id 生成同源尝试分母", async () => {
    // [gpt] 2026-08-10：accuracy 仍只是展示字段；只有 attempt 子对象触发统一尝试写入。
    const path = tempPath();
    writeOutbox(path, [{
      op: "study_log",
      operation_id: "english-reading-2016-t1",
      date: "2026-08-10",
      subject: "英语",
      chapter: "2016 Text 1",
      activity: "做题",
      accuracy: 80,
      attempt: {
        sourceKind: "objective_question",
        questionRef: "2016 Text 1",
        sessionKey: "EN-20260810-2016-T1",
        attemptRole: "primary",
        dimension: "application",
        result: "partial",
        score: 4,
        maxScore: 5,
        assessmentContext: "timed",
        durationSeconds: 1080,
      },
    }]);

    const scripted = scriptedDb([{ data: [{ id: 44 }], error: null }]);
    const rpcCalls = [];
    const rpcResponses = [
      { data: { action: "apply", attempt_count: 1 }, error: null },
      { data: { kind: "learning_attempt", attempt_id: 12, projected: false }, error: null },
      { data: { status: "applied" }, error: null },
    ];
    scripted.db.rpc = async (name, args) => {
      rpcCalls.push({ name, args });
      return rpcResponses.shift();
    };

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ kind: "study_log", studyLogId: 44 });
    const upsert = scripted.calls[0].steps.find((step) => step.method === "upsert");
    expect(upsert.args[0]).toMatchObject({ operation_id: "english-reading-2016-t1", attempt_expected: true });
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "begin_ingest_operation",
      "record_learning_attempt",
      "complete_ingest_operation",
    ]);
    expect(rpcCalls[1].args.p_payload).toMatchObject({
      operation_id: "english-reading-2016-t1:attempt",
      ingest_operation_id: "english-reading-2016-t1",
      source_kind: "objective_question",
      source_id: "44",
      question_ref: "2016 Text 1",
      attempt_role: "primary",
      score: 4,
      max_score: 5,
    });
    expect(readOutbox(path)).toEqual([]);
  });

  it("自背和带背都写成背诵，并在原始信息中保留方式", async () => {
    const path = tempPath();
    writeOutbox(path, [
      { op: "study_log", operation_id: "recite-self", subject: "法制史", chapter: "第六章 清末民初", activity: "自背", raw: "用户汇报背完" },
      { op: "study_log", operation_id: "recite-guided", subject: "法理", chapter: "守法", activity: "带背", raw: "节末总复述完成" },
    ]);
    const scripted = scriptedDb([
      { data: [], error: null },
      { data: null, error: null },
      { data: [], error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-16", now: new Date("2026-08-16T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    const payloads = scripted.calls
      .map((call) => call.steps.find((step) => step.method === "upsert")?.args[0])
      .filter(Boolean);
    expect(payloads).toEqual([
      expect.objectContaining({ activity: "背诵", raw_input: "[背诵方式=自背] 用户汇报背完" }),
      expect.objectContaining({ activity: "背诵", raw_input: "[背诵方式=带背] 节末总复述完成" }),
    ]);
    expect(readOutbox(path)).toEqual([]);
  });

  it("同日同科同章的背诵进度复写原行，不因新 operation_id 重复插入", async () => {
    // [gpt] 2026-08-21：业务幂等键独立于传输幂等键；重放进度只更新最近一条规范流水。
    const path = tempPath();
    writeOutbox(path, [{
      op: "study_log",
      operation_id: "recite-rewrite-2",
      date: "2026-08-21",
      subject: "法制史",
      chapter: "第三章 秦汉三国两晋南北朝",
      activity: "自背",
      feeling: "用户汇报已背完本章",
      raw: "用户原话：法制史第三章背诵完毕",
    }]);
    const scripted = scriptedDb([
      { data: [{ id: 220, operation_id: "recite-original" }], error: null },
      { data: null, error: null },
    ]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-21", now: new Date("2026-08-21T04:30:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "study_log",
      affected: 1,
      action: "updated",
      studyLogId: 220,
      operationId: "recite-original",
    });
    expect(scripted.calls).toHaveLength(2);
    expect(scripted.calls[0].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "eq", args: ["log_date", "2026-08-21"] }),
      expect.objectContaining({ method: "eq", args: ["activity", "背诵"] }),
    ]));
    const update = scripted.calls[1].steps.find((step) => step.method === "update");
    expect(update.args[0]).toMatchObject({
      subject: "法制史",
      chapter: "第三章 秦汉三国两晋南北朝",
      activity: "背诵",
      raw_input: "[背诵方式=自背] 用户原话：法制史第三章背诵完毕",
    });
    expect(update.args[0]).not.toHaveProperty("operation_id");
    expect(readOutbox(path)).toEqual([]);
  });

  it("学习流水更正只在完整旧业务键唯一命中时原地更新", async () => {
    // [gpt] 2026-08-23：整场复盘误记为单科时，应改原行而不是再插一条。
    const path = tempPath();
    writeOutbox(path, [{
      op: "study_log_correction",
      operation_id: "correct-review-log-1",
      match: {
        date: "2026-08-22",
        subject: "民法",
        chapter: "周六错题复盘·监护顺位与抵押财产范围",
        activity: "复盘",
      },
      replacement: {
        date: "2026-08-22",
        subject: "综合",
        chapter: "周六跨科错题复盘·法制史/刑法/法理/民法",
        activity: "复盘",
        feeling: "整场聚合记录",
      },
    }]);
    const scripted = scriptedDb([
      { data: [{ id: 230, operation_id: "original-review-log", attempt_expected: false }], error: null },
      { data: [{ id: 230 }], error: null },
    ]);

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-23", now: new Date("2026-08-23T08:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({
      kind: "study_log_correction",
      action: "updated",
      studyLogId: 230,
      operationId: "original-review-log",
    });
    expect(scripted.calls).toHaveLength(2);
    const update = scripted.calls[1].steps.find((step) => step.method === "update");
    expect(update.args[0]).toMatchObject({
      log_date: "2026-08-22",
      subject: "综合",
      chapter: "周六跨科错题复盘·法制史/刑法/法理/民法",
      activity: "复盘",
      feeling: "整场聚合记录",
    });
    expect(update.args[0]).not.toHaveProperty("operation_id");
    expect(readOutbox(path)).toEqual([]);
  });

  it("学习流水已存在而子尝试上次失败时会回读 id 并安全补写", async () => {
    // [gpt] 2026-08-10：父操作处于 failed 时重试，study_log 冲突不能让子事实永久漏写。
    const path = tempPath();
    writeOutbox(path, [{
      op: "study_log",
      operation_id: "retry-subjective-1",
      date: "2026-08-10",
      subject: "刑法",
      chapter: "案例题｜2022-57",
      activity: "做题",
      attempt: {
        sourceKind: "subjective_answer",
        questionRef: "案例题:2022-57",
        sessionKey: "SUBJ-20260810-CAS-2022-57",
        attemptRole: "primary",
        dimension: "application",
        result: "partial",
        score: 8,
        maxScore: 15,
      },
    }]);
    const scripted = scriptedDb([
      { data: [], error: null },
      { data: [{ id: 91 }], error: null },
    ]);
    const rpcResponses = [
      { data: { action: "apply", attempt_count: 2 }, error: null },
      { data: { kind: "learning_attempt", attempt_id: 92, projected: false }, error: null },
      { data: { status: "applied" }, error: null },
    ];
    scripted.db.rpc = async () => rpcResponses.shift();

    const result = await syncStudyOutbox({ db: scripted.db, path, today: "2026-08-10", now: new Date("2026-08-10T12:00:00.000Z") });

    expect(result.failed).toEqual([]);
    expect(result.succeeded[0].result).toMatchObject({ studyLogId: 91 });
    expect(scripted.calls.map((call) => call.table)).toEqual(["study_log", "study_log"]);
    expect(scripted.calls[1].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "eq", args: ["operation_id", "retry-subjective-1"] }),
    ]));
    expect(readOutbox(path)).toEqual([]);
  });
});
