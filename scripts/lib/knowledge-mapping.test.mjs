// [gpt] 2026-08-10：个人知识图谱二期的映射审计、直连回填与答疑候选边界测试。
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeMappingAudit,
  buildUnmappedAskLinkRecords,
  directMappingBackfillOperations,
} from "./knowledge-mapping.mjs";

const catalog = {
  items: [
    { kpId: "XF-0001", subject: "刑法", name: "共同犯罪" },
    { kpId: "XF-0002", subject: "刑法", name: "教唆犯" },
  ],
};

describe("knowledge mapping audit", () => {
  it("区分已有主点、安全直连回填、主题继承、pending、冲突与明确排除", () => {
    const audit = buildKnowledgeMappingAudit({
      catalog,
      objectLinks: [
        { source_kind: "recite_ledger", source_id: "X1", kp_id: "XF-0001", role: "primary", link_status: "confirmed" },
        { source_kind: "error_topic", source_id: "2", kp_id: "XF-0002", role: "primary", link_status: "pending" },
        { source_kind: "ask_point", source_id: "2", kp_id: "XF-0002", role: "primary", link_status: "confirmed" },
      ],
      askPoints: [
        { id: 1, subject: "刑法", kp_id: "XF-0001", confusion: "已有直连待迁移", effective_status: "open", active: true },
        { id: 2, subject: "刑法", kp_id: "XF-0001", confusion: "直连与显式主点冲突", effective_status: "open", active: true },
        { id: 3, subject: "刑法", confusion: "已撤销", effective_status: "dismissed", active: false },
      ],
      errorTopics: [
        { id: 1, subject: "刑法", title: "主题直连", kp_id: "XF-0002" },
        { id: 2, subject: "刑法", title: "只有候选" },
        { id: 3, subject: "刑法", title: "反向设问", chapter: "跨科做题方法" },
      ],
      errorRows: [{ id: 9, subject: "刑法", knowledge: "从主题继承", status: "open" }],
      studyErrorTopics: [{ study_error_id: 9, topic_id: 1, role: "primary" }],
      reciteRecords: [{ id: "X1", subject: "刑法", title: "已确认" }, { id: "X2", subject: "刑法", title: "未映射" }],
    });
    const statuses = Object.fromEntries(audit.items.map((item) => [`${item.sourceKind}:${item.sourceId}`, item.status]));
    expect(statuses).toMatchObject({
      "ask_point:1": "direct_backfill",
      "ask_point:2": "conflict",
      "ask_point:3": "excluded",
      "error_topic:1": "direct_backfill",
      "error_topic:2": "pending_only",
      "error_topic:3": "excluded",
      "study_error:9": "inherited_topic",
      "recite_ledger:X1": "confirmed_primary",
      "recite_ledger:X2": "unmapped",
    });
  });

  it("只为已有合法稳定 kp_id 且无冲突的对象生成确定性 confirmed 回填", () => {
    const audit = buildKnowledgeMappingAudit({
      catalog,
      askPoints: [
        { id: 1, subject: "刑法", kp_id: "XF-0001", effective_status: "open", active: true },
        { id: 2, subject: "刑法", kp_id: "BAD", effective_status: "open", active: true },
      ],
    });
    expect(directMappingBackfillOperations(audit)).toEqual([expect.objectContaining({
      operation_id: "backfill:direct-v2:ask_point:1:XF-0001",
      sourceKind: "ask_point",
      kpId: "XF-0001",
      matchMethod: "legacy_direct",
      linkStatus: "confirmed",
      evidenceAnchor: "ask_summary.kp_id",
    })]);
  });
});

describe("unmapped ask records", () => {
  it("默认只给有效未映射卡点生成候选，历史模式可纳入 clarified，但永不纳入 dismissed", () => {
    const rows = [
      { id: 1, subject: "刑法", confusion: "教唆犯和帮助犯混淆", effective_status: "open", active: true },
      { id: 2, subject: "刑法", confusion: "已有直连", kp_id: "XF-0001", effective_status: "open", active: true },
      { id: 3, subject: "刑法", confusion: "已经打通", effective_status: "clarified", active: false },
      { id: 4, subject: "刑法", confusion: "已移噪", effective_status: "dismissed", active: false },
    ];
    const links = [{ source_kind: "ask_point", source_id: "1", kp_id: "XF-0002", role: "primary", link_status: "pending" }];
    expect(buildUnmappedAskLinkRecords(rows, links).map((item) => item.sourceId)).toEqual(["1"]);
    expect(buildUnmappedAskLinkRecords(rows, links, { includeHistory: true }).map((item) => item.sourceId)).toEqual(["1", "3"]);
    expect(buildUnmappedAskLinkRecords(rows, links)[0].existingLinks[0]).toMatchObject({ status: "pending", kpId: "XF-0002" });
  });
});
