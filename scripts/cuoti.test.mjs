import { describe, expect, it } from "vitest";
import {
  KINDS,
  buildMaterialBatchOutput,
  buildMaterialOutput,
  clip,
  findNearestPageAnchor,
  formatMaterialBlocks,
  grep,
  parseMaterialArgs,
  parseMaterialBatchArgs,
  requireMaterialRows,
} from "./cuoti.mjs";
import { buildErrorIntakeBatchOperations, verifyExistingErrorIntakeBatch } from "./lib/error-intake-batch.mjs";

describe("cuoti material sources", () => {
  it("给每类来源独立正配额，并把原始真题与二次总结分开", () => {
    const byKind = new Map(KINDS.map(([kind, label, quota]) => [kind, { label, quota }]));

    expect(byKind.size).toBe(KINDS.length);
    expect([...byKind.values()].every(({ quota }) => quota > 0)).toBe(true);
    expect(byKind.get("exam")).toEqual({ label: "真题原卷/随卷参考答案解析", quota: 4000 });
    expect(byKind.get("zhenti")?.label).toContain("二次总结");
  });
});

describe("cuoti grep", () => {
  it("保留真实行号、合并相邻命中，并过滤目录点线", () => {
    const rows = [{
      path: "教材/测试.txt",
      start_line: 20,
      content: ["前文", "正当防卫", "正当防卫......99", "说明", "正当防卫", "后文"].join("\n"),
    }];

    const result = grep(rows, "正当防卫");

    expect(result.totalHits).toBe(2);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toEqual([21, 24]);
    expect(result.blocks[0].text).toContain("21► 正当防卫");
    expect(result.blocks[0].text).toContain("24► 正当防卫");
  });

  it("超长命中行围绕关键词截取，不再只显示行首", () => {
    const prefix = "甲".repeat(240);
    const suffix = "乙".repeat(240);
    const { blocks } = grep([{ path: "真题/长行.txt", start_line: 1, content: `${prefix}想象竞合${suffix}` }], "想象竞合");

    expect(blocks[0].text).toContain("想象竞合");
    expect(blocks[0].text).not.toContain("甲".repeat(200));
    expect(clip(`${prefix}想象竞合${suffix}`, "想象竞合")).toMatch(/^….*想象竞合.*…$/);
  });

  it("为命中片段附上最近的页码锚点", () => {
    const content = [
      "===== 第4页 =====",
      "上一点",
      "正反结合是背诵方法",
      "补充说明",
      "===== 第5页 =====",
      "下一页",
    ].join("\n");

    const { blocks } = grep([{ path: "教材/带背/法理.txt", start_line: 50, content }], "正反结合");
    const { segments } = formatMaterialBlocks(blocks, 1000);

    expect(blocks[0].pageAnchor).toEqual({ page: 4, line: 50 });
    expect(segments[0]).toContain("最近页码：第4页（页码锚点行 50）");
    expect(findNearestPageAnchor(content.split("\n"), 5, 50)).toEqual({ page: 5, line: 54 });
  });

  it("有命中时即使首片段超出配额也至少输出一块", () => {
    const blocks = [{ path: "真题/_文本/2024.txt", text: "命中内容".repeat(1000) }];
    const { segments, shown } = formatMaterialBlocks(blocks, 100);

    expect(shown).toBe(1);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toContain("真题/_文本/2024.txt");
    expect(segments[0]).toContain("本片段过长已截断");
  });

  it("数据库读取失败时中止，而不是伪装成零命中", () => {
    expect(() => requireMaterialRows({ data: null, error: { message: "network down" } }, "textbook"))
      .toThrow("读取 material 来源 textbook 失败：network down");
    expect(requireMaterialRows({ data: null, error: null }, "exam")).toEqual([]);
  });
});

describe("cuoti material CLI", () => {
  it("批量参数把 refine 绑定到前一查询，且各概念保持独立", () => {
    expect(parseMaterialBatchArgs([
      "--query", "犯罪中止", "--refine", "因果",
      "--query", "正当防卫", "--refine", "时间条件",
      "--query", "偶然防卫",
    ])).toEqual({
      source: "local",
      runId: null,
      queries: [
        { keyword: "犯罪中止", refine: "因果" },
        { keyword: "正当防卫", refine: "时间条件" },
        { keyword: "偶然防卫", refine: undefined },
      ],
    });
    expect(parseMaterialArgs(["犯罪中止", "因果", "--db"])).toEqual({
      source: "db",
      runId: null,
      queries: [{ keyword: "犯罪中止", refine: "因果" }],
    });
    expect(parseMaterialArgs(["犯罪中止", "--run", "SR-1"])).toMatchObject({ runId: "SR-1" });
  });

  it("拒绝游离 refine、缺关键词和额外位置参数", () => {
    expect(() => parseMaterialBatchArgs(["--refine", "因果"])).toThrow("必须跟在对应 --query 后");
    expect(() => parseMaterialBatchArgs(["--query"])).toThrow("--query 后需要关键词");
    expect(() => parseMaterialArgs(["甲", "乙", "丙"])).toThrow("最多接收");
  });

  it("单查与批量中的每一查询复用完全相同的检索和配额输出", () => {
    const corpus = new Map(KINDS.map(([kind]) => [kind, kind === "textbook" ? [{
      path: "教材/考试分析_文本.txt",
      start_line: 100,
      content: "前文\n犯罪中止的因果关系\n后文",
    }] : []]));
    const first = buildMaterialOutput(corpus, "犯罪中止", "因果");
    const second = buildMaterialOutput(corpus, "正当防卫");
    const batch = buildMaterialBatchOutput(corpus, [
      { keyword: "犯罪中止", refine: "因果" },
      { keyword: "正当防卫" },
    ]);

    expect(batch).toBe(`${first}\n\n══════════ 下一组独立检索 ══════════\n\n${second}`);
    expect(first).toContain("教材重排/机构讲义/法律更新混合库");
    expect(first).toContain("101► 犯罪中止的因果关系");
  });
});

describe("错题截图批次摄取", () => {
  it("上传几道即错几道，并只生成一条带准确率的进度流水", () => {
    const batch = buildErrorIntakeBatchOperations({
      batchId: "ownership-20260813",
      subject: "民法",
      chapter: "第十章 所有权（分章真题16题完成）",
      totalQuestions: 16,
      uploadedCount: 2,
      errors: [
        { knowledge: "11401038：误选C，正确D", evidenceKind: "objective_question" },
        { knowledge: "11801037：误选C，正确B", evidenceKind: "objective_question" },
      ],
    }, { today: "2026-08-13" });

    expect(batch).toMatchObject({ errorCount: 2, accuracy: 87.5 });
    expect(batch.operations.filter((item) => item.op === "study_log")).toHaveLength(1);
    expect(batch.operations.filter((item) => item.op === "new_error")).toHaveLength(2);
    expect(batch.operations.filter((item) => item.op === "new_error")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entrySource: "batch",
        chapter: "第十章 所有权（分章真题16题完成）",
        entryState: expect.objectContaining({ classificationStatus: "pending", rootCauseCode: "unclassified" }),
      }),
    ]));
    expect(batch.operations[0]).toMatchObject({
      accuracy: 87.5,
      date: "2026-08-13",
      ts: "2026-08-13T00:00:00.000+08:00",
    });
  });

  it("拒绝把截图解释成抽样或写入不一致的错题数", () => {
    expect(() => buildErrorIntakeBatchOperations({
      subject: "民法",
      chapter: "所有权",
      totalQuestions: 16,
      uploadedCount: 2,
      errors: [{ knowledge: "只列了一道", evidenceKind: "objective_question" }],
    }, { today: "2026-08-13" })).toThrow(/上传题数 2 与错题明细 1 不一致/);
  });

  it("批次中的 confirmed 病根缺认领说明时在生成 outbox 前阻断", () => {
    expect(() => buildErrorIntakeBatchOperations({
      subject: "民法",
      chapter: "所有权",
      totalQuestions: 1,
      errors: [{
        knowledge: "处分规则误判",
        evidenceKind: "objective_question",
        topic: {
          title: "无权处分的效力",
          classificationStatus: "confirmed",
          rootCauseCode: "boundary_miss",
          diagnosisStatus: "confirmed",
        },
      }],
    }, { today: "2026-08-13" })).toThrow(/confirmed_cause_note_missing/);
  });

  it("同一批次生成稳定 operation_id，重跑不会制造重复流水", () => {
    const manifest = {
      subject: "民法",
      chapter: "所有权",
      totalQuestions: 5,
      errors: [{ knowledge: "错题A", evidenceKind: "objective_question" }],
    };
    const first = buildErrorIntakeBatchOperations(manifest, { today: "2026-08-13" });
    const second = buildErrorIntakeBatchOperations(manifest, { today: "2026-08-13" });
    expect(first.operations.map((item) => item.operation_id)).toEqual(second.operations.map((item) => item.operation_id));
    expect(first.operations).toEqual(second.operations);
  });

  it("历史批次回放只接受唯一进度和逐题唯一事件", () => {
    const manifest = {
      subject: "民法", chapter: "所有权", totalQuestions: 16,
      errors: [{ knowledge: "错题A" }, { knowledge: "错题B" }],
    };
    const verified = verifyExistingErrorIntakeBatch(manifest, {
      studyLogs: [{ id: 193, subject: "民法", chapter: "所有权", log_date: "2026-08-13", activity: "做题", accuracy: 87.5 }],
      errors: [
        { id: 112, subject: "民法", log_date: "2026-08-13", knowledge: "错题A" },
        { id: 113, subject: "民法", log_date: "2026-08-13", knowledge: "错题B" },
      ],
    }, { today: "2026-08-13" });
    expect(verified).toMatchObject({ verified: true, studyLogId: 193, errorIds: [112, 113] });
    expect(verified.legacyEvidenceKindAssumed).toBe(true);
  });

  it("背诵掉点整批拒绝且返回结构化接收轨，不生成半条 study_log", () => {
    let caught;
    try {
      buildErrorIntakeBatchOperations({
        subject: "刑法",
        chapter: "犯罪停止形态",
        activity: "背诵",
        totalQuestions: 2,
        errors: [
          { knowledge: "中止时间性想不起来", evidenceKind: "recall_lapse" },
          { knowledge: "应当与可以互换", evidenceKind: "wording_lapse" },
        ],
      }, { today: "2026-08-24" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "ERROR_INTAKE_ROUTING_REQUIRED",
      routes: [
        expect.objectContaining({ evidenceKind: "recall_lapse", destination: "recite_ledger", routingState: "pending_confirmation" }),
        expect.objectContaining({ evidenceKind: "wording_lapse", destination: "recognition_light_roll", routingState: "pending_confirmation", preserveReciteEntry: true }),
      ],
    });
    expect(caught.message).toContain("recitation_lapse_not_study_error");
    expect(caught.operations).toBeUndefined();
  });

  it("背诵场景缺 evidenceKind 时阻断，但有独立题面锚点的应用错可入账", () => {
    expect(() => buildErrorIntakeBatchOperations({
      subject: "刑法",
      chapter: "犯罪停止形态",
      activity: "背诵",
      totalQuestions: 1,
      errors: [{ knowledge: "默错一处" }],
    }, { today: "2026-08-24" })).toThrow(/evidence_kind_required/);

    const batch = buildErrorIntakeBatchOperations({
      subject: "刑法",
      chapter: "犯罪停止形态",
      activity: "背诵",
      totalQuestions: 1,
      errors: [{
        knowledge: "独立案例题把中止判成未遂",
        evidenceKind: "application_probe",
        questionAnchor: "本次题面#犯罪中止案例1",
      }],
    }, { today: "2026-08-24" });
    expect(batch.operations.filter((item) => item.op === "new_error")).toEqual([
      expect.objectContaining({ evidenceKind: "application_probe", questionAnchor: "本次题面#犯罪中止案例1" }),
    ]);
  });

  it("application_probe 没有题面锚点时拒绝写入", () => {
    expect(() => buildErrorIntakeBatchOperations({
      subject: "民法",
      chapter: "监护",
      totalQuestions: 1,
      errors: [{ knowledge: "案例判断错误", evidenceKind: "application_probe" }],
    }, { today: "2026-08-24" })).toThrow(/question_anchor_required/);
  });
});
