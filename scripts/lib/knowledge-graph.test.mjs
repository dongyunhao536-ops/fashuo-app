import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph, wouldCreatePrerequisiteCycle } from "./knowledge-graph.mjs";

const catalog = {
  items: [
    { kpId: "XF-0001", subject: "刑法", name: "基础规则" },
    { kpId: "XF-0002", subject: "刑法", name: "中间规则" },
    { kpId: "XF-0003", subject: "刑法", name: "应用规则" },
  ],
};

const relation = (from, to, overrides = {}) => ({
  prerequisite_kp_id: from,
  dependent_kp_id: to,
  relation_type: "prerequisite",
  required_stage: "understanding",
  relation_status: "confirmed",
  strength: 4,
  confidence: 95,
  source_kind: "curated",
  evidence_anchor: `${from}->${to}`,
  ...overrides,
});

const states = (stages = {}) => ({
  items: catalog.items.map((item) => ({ ...item, stage: stages[item.kpId] ?? "unseen", activated: item.kpId === "XF-0003" })),
});

describe("knowledge prerequisite graph", () => {
  it("只用 confirmed 前置边阻塞目标，并给出根前置路径", () => {
    const graph = buildKnowledgeGraph({
      catalog,
      relations: [relation("XF-0001", "XF-0002"), relation("XF-0002", "XF-0003")],
      knowledgeStates: states(),
    });
    const target = graph.byKnowledgePoint.find((item) => item.kpId === "XF-0003");
    expect(target.blocked).toBe(true);
    expect(target.blockers.map((item) => item.kpId)).toEqual(["XF-0001", "XF-0002"]);
    expect(target.blockers.find((item) => item.kpId === "XF-0001")).toMatchObject({ root: true, path: ["XF-0001", "XF-0002", "XF-0003"] });
    expect(graph.rootBlockers[0].unblocks[0].kpId).toBe("XF-0003");
  });

  it("前置达到要求后不再阻塞，pending 候选从不改派单", () => {
    const graph = buildKnowledgeGraph({
      catalog,
      relations: [
        relation("XF-0001", "XF-0003"),
        relation("XF-0002", "XF-0003", { relation_status: "pending", evidence_anchor: null, source_kind: "model" }),
      ],
      knowledgeStates: states({ "XF-0001": "understanding" }),
    });
    const target = graph.byKnowledgePoint.find((item) => item.kpId === "XF-0003");
    expect(target.blocked).toBe(false);
    expect(target.directPrerequisites).toHaveLength(1);
  });

  it("新增前置边前可检测成环", () => {
    const existing = [relation("XF-0001", "XF-0002"), relation("XF-0002", "XF-0003")];
    expect(wouldCreatePrerequisiteCycle(existing, "XF-0003", "XF-0001")).toMatchObject({ ok: false, reason: "cycle" });
    expect(wouldCreatePrerequisiteCycle(existing, "XF-0001", "XF-0003")).toMatchObject({ ok: true });
  });
});
