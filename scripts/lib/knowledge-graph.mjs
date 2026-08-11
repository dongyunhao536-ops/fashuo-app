// [gpt] 2026-08-10：稳定 KP-ID 上的可审计知识图谱。
// 只有 confirmed prerequisite 边参与“先补 B 再学 A”的阻塞判断；pending/model 候选不改派单。

export const KNOWLEDGE_GRAPH_VERSION = "1.0";
export const KNOWLEDGE_RELATION_TYPES = Object.freeze(["prerequisite", "supports", "contrast"]);
export const KNOWLEDGE_RELATION_STATUSES = Object.freeze(["pending", "confirmed", "rejected"]);
export const KNOWLEDGE_RELATION_SOURCES = Object.freeze(["manual", "curated", "textbook", "catalog", "model"]);
export const PREREQUISITE_STAGES = Object.freeze(["understanding", "recall", "application", "stable"]);

const STAGE_RANK = Object.freeze({ unseen: 0, exposed: 1, understanding: 2, recall: 3, application: 4, stable: 5 });

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

export function normalizeKnowledgeRelation(row, sequence = 0) {
  const prerequisiteKpId = String(rowValue(row, "prerequisiteKpId", "prerequisite_kp_id") ?? "").toUpperCase();
  const dependentKpId = String(rowValue(row, "dependentKpId", "dependent_kp_id") ?? "").toUpperCase();
  const relationType = String(rowValue(row, "relationType", "relation_type") ?? "prerequisite");
  const relationStatus = String(rowValue(row, "relationStatus", "relation_status") ?? "pending");
  const sourceKind = String(rowValue(row, "sourceKind", "source_kind") ?? "manual");
  const requiredStage = relationType === "prerequisite"
    ? String(rowValue(row, "requiredStage", "required_stage") ?? "understanding")
    : null;
  const strength = Number(row?.strength ?? 3);
  const confidence = Number(row?.confidence ?? 0);
  const evidenceAnchor = rowValue(row, "evidenceAnchor", "evidence_anchor") ?? null;
  const valid = /^[A-Z]{2,4}-\d{4}$/.test(prerequisiteKpId)
    && /^[A-Z]{2,4}-\d{4}$/.test(dependentKpId)
    && prerequisiteKpId !== dependentKpId
    && KNOWLEDGE_RELATION_TYPES.includes(relationType)
    && KNOWLEDGE_RELATION_STATUSES.includes(relationStatus)
    && KNOWLEDGE_RELATION_SOURCES.includes(sourceKind)
    && Number.isInteger(strength) && strength >= 1 && strength <= 5
    && Number.isInteger(confidence) && confidence >= 0 && confidence <= 100
    && (relationType !== "prerequisite" || PREREQUISITE_STAGES.includes(requiredStage))
    && (relationStatus !== "confirmed" || Boolean(String(evidenceAnchor ?? "").trim()));
  return {
    id: row?.id ?? null,
    operationId: rowValue(row, "operationId", "operation_id") ?? null,
    prerequisiteKpId,
    dependentKpId,
    relationType,
    requiredStage,
    strength,
    relationStatus,
    confidence,
    sourceKind,
    evidenceAnchor,
    note: row?.note ?? null,
    sequence,
    valid,
  };
}

function cycleKey(cycle) {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((left, right) => left.join("|").localeCompare(right.join("|")));
  return rotations[0].join("|");
}

function detectCycles(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    const list = adjacency.get(edge.prerequisiteKpId) ?? [];
    list.push(edge.dependentKpId);
    adjacency.set(edge.prerequisiteKpId, list);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = new Map();
  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      cycles.set(cycleKey(cycle), cycle);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of adjacency.keys()) visit(node);
  return [...cycles.values()];
}

export function wouldCreatePrerequisiteCycle(relations, prerequisiteKpId, dependentKpId) {
  const candidate = normalizeKnowledgeRelation({
    prerequisiteKpId,
    dependentKpId,
    relationType: "prerequisite",
    requiredStage: "understanding",
    relationStatus: "confirmed",
    confidence: 100,
    strength: 3,
    sourceKind: "manual",
    evidenceAnchor: "cycle-check",
  });
  if (!candidate.valid) return { ok: false, reason: "invalid-relation", cycle: null };
  const edges = [...(relations ?? []).map(normalizeKnowledgeRelation), candidate]
    .filter((row) => row.valid && row.relationType === "prerequisite" && row.relationStatus === "confirmed");
  const cycles = detectCycles(edges);
  const cycle = cycles.find((item) => item.includes(candidate.prerequisiteKpId) && item.includes(candidate.dependentKpId)) ?? null;
  return cycle ? { ok: false, reason: "cycle", cycle } : { ok: true, reason: null, cycle: null };
}

function stageMeets(actual, required) {
  return (STAGE_RANK[actual] ?? 0) >= (STAGE_RANK[required] ?? 99);
}

export function buildKnowledgeGraph({ catalog, relations = [], knowledgeStates } = {}) {
  const catalogItems = catalog?.items ?? [];
  const catalogById = new Map(catalogItems.map((item) => [item.kpId, item]));
  const stateById = new Map((knowledgeStates?.items ?? []).map((item) => [item.kpId, item]));
  const normalized = relations.map(normalizeKnowledgeRelation);
  const issues = [];
  for (const row of normalized) {
    if (!row.valid) issues.push({ code: "invalid_relation", relation: row });
    else if (!catalogById.has(row.prerequisiteKpId) || !catalogById.has(row.dependentKpId)) {
      issues.push({ code: "missing_catalog_node", relation: row });
    }
  }
  const usable = normalized.filter((row) => row.valid && catalogById.has(row.prerequisiteKpId) && catalogById.has(row.dependentKpId));
  const prerequisites = usable.filter((row) => row.relationType === "prerequisite" && row.relationStatus === "confirmed");
  const cycles = detectCycles(prerequisites);
  for (const cycle of cycles) issues.push({ code: "prerequisite_cycle", cycle });
  const cycleNodes = new Set(cycles.flat());

  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of prerequisites) {
    const inList = incoming.get(edge.dependentKpId) ?? [];
    inList.push(edge);
    incoming.set(edge.dependentKpId, inList);
    const outList = outgoing.get(edge.prerequisiteKpId) ?? [];
    outList.push(edge);
    outgoing.set(edge.prerequisiteKpId, outList);
  }

  function collectBlockers(targetKpId, path = [targetKpId], seen = new Set()) {
    if (seen.has(targetKpId) || cycleNodes.has(targetKpId)) return [];
    const nextSeen = new Set(seen).add(targetKpId);
    const blockers = [];
    for (const edge of incoming.get(targetKpId) ?? []) {
      const state = stateById.get(edge.prerequisiteKpId);
      const actualStage = state?.stage ?? "unseen";
      const nextPath = [edge.prerequisiteKpId, ...path];
      if (!stageMeets(actualStage, edge.requiredStage)) {
        blockers.push({
          kpId: edge.prerequisiteKpId,
          name: catalogById.get(edge.prerequisiteKpId)?.name ?? null,
          subject: catalogById.get(edge.prerequisiteKpId)?.subject ?? null,
          stage: actualStage,
          requiredStage: edge.requiredStage,
          strength: edge.strength,
          confidence: edge.confidence,
          direct: path.length === 1,
          path: nextPath,
          relationId: edge.id,
        });
      }
      blockers.push(...collectBlockers(edge.prerequisiteKpId, nextPath, nextSeen));
    }
    const deduped = new Map();
    for (const blocker of blockers) {
      const known = deduped.get(blocker.kpId);
      if (!known || blocker.path.length > known.path.length) deduped.set(blocker.kpId, blocker);
    }
    return [...deduped.values()].sort((left, right) => right.path.length - left.path.length || right.strength - left.strength || left.kpId.localeCompare(right.kpId));
  }

  const involvedIds = [...new Set(usable.flatMap((row) => [row.prerequisiteKpId, row.dependentKpId]))].sort();
  const byKnowledgePoint = involvedIds.map((kpId) => {
    const point = catalogById.get(kpId);
    const state = stateById.get(kpId);
    const directPrerequisites = (incoming.get(kpId) ?? []).map((edge) => {
      const prerequisiteState = stateById.get(edge.prerequisiteKpId);
      return {
        kpId: edge.prerequisiteKpId,
        name: catalogById.get(edge.prerequisiteKpId)?.name ?? null,
        requiredStage: edge.requiredStage,
        currentStage: prerequisiteState?.stage ?? "unseen",
        meets: stageMeets(prerequisiteState?.stage ?? "unseen", edge.requiredStage),
        strength: edge.strength,
      };
    });
    const blockers = collectBlockers(kpId);
    return {
      kpId,
      subject: point?.subject ?? null,
      name: point?.name ?? null,
      stage: state?.stage ?? "unseen",
      activated: Boolean(state?.activated),
      directPrerequisites,
      blockers,
      blocked: blockers.length > 0,
      dependents: (outgoing.get(kpId) ?? []).map((edge) => ({
        kpId: edge.dependentKpId,
        name: catalogById.get(edge.dependentKpId)?.name ?? null,
        requiredStage: edge.requiredStage,
        strength: edge.strength,
      })),
    };
  });
  const nodeById = new Map(byKnowledgePoint.map((node) => [node.kpId, node]));
  for (const node of byKnowledgePoint) {
    node.blockers = node.blockers.map((blocker) => ({
      ...blocker,
      root: !(nodeById.get(blocker.kpId)?.blockers?.length),
    }));
  }
  const blockedTargets = byKnowledgePoint.filter((node) => node.blocked);
  const activeBlockedTargets = blockedTargets.filter((node) => node.activated);
  const rootBlockers = new Map();
  for (const target of activeBlockedTargets) {
    for (const blocker of target.blockers.filter((item) => item.root)) {
      const known = rootBlockers.get(blocker.kpId) ?? { ...blocker, unblocks: [] };
      known.unblocks.push({ kpId: target.kpId, name: target.name, path: blocker.path });
      rootBlockers.set(blocker.kpId, known);
    }
  }

  return {
    version: KNOWLEDGE_GRAPH_VERSION,
    counts: {
      totalRelations: normalized.length,
      confirmed: usable.filter((row) => row.relationStatus === "confirmed").length,
      pending: usable.filter((row) => row.relationStatus === "pending").length,
      rejected: usable.filter((row) => row.relationStatus === "rejected").length,
      confirmedPrerequisites: prerequisites.length,
      involvedKnowledgePoints: involvedIds.length,
      blockedTargets: blockedTargets.length,
      activeBlockedTargets: activeBlockedTargets.length,
      rootBlockers: rootBlockers.size,
      cycles: cycles.length,
      issues: issues.length,
    },
    relations: usable,
    byKnowledgePoint,
    activeBlockedTargets,
    rootBlockers: [...rootBlockers.values()].sort((left, right) => right.unblocks.length - left.unblocks.length || right.strength - left.strength || left.kpId.localeCompare(right.kpId)),
    cycles,
    issues,
    policy: "只有带锚点的 confirmed prerequisite 参与阻塞；图谱不改变掌握状态，只决定学习顺序。",
  };
}

export function formatKnowledgeGraph(graph, { kpId = null } = {}) {
  const nodes = (graph?.byKnowledgePoint ?? []).filter((node) => !kpId || node.kpId === kpId);
  const lines = [
    `知识图谱 v${graph?.version ?? "?"}｜确认前置 ${graph?.counts?.confirmedPrerequisites ?? 0}｜活跃目标受阻 ${graph?.counts?.activeBlockedTargets ?? 0}｜环 ${graph?.counts?.cycles ?? 0}`,
  ];
  if (!nodes.length) lines.push(kpId ? `${kpId} 暂无已确认图谱关系。` : "暂无图谱关系。");
  for (const node of nodes) {
    lines.push("", `${node.kpId} [${node.subject ?? "未分类"}] ${node.name ?? "未命名"}｜当前 ${node.stage}${node.blocked ? "｜受前置阻塞" : ""}`);
    for (const prerequisite of node.directPrerequisites) {
      lines.push(`- 前置 ${prerequisite.kpId} ${prerequisite.name ?? ""}：须到 ${prerequisite.requiredStage}，当前 ${prerequisite.currentStage}${prerequisite.meets ? "（已满足）" : "（未满足）"}`);
    }
    for (const dependent of node.dependents) lines.push(`- 解锁 ${dependent.kpId} ${dependent.name ?? ""}（要求本点达到 ${dependent.requiredStage}）`);
    for (const blocker of node.blockers.filter((item) => item.root)) lines.push(`- 根阻塞 ${blocker.kpId}：${blocker.path.join(" → ")}`);
  }
  lines.push("", graph?.policy ?? "图谱只决定学习顺序，不改写学习事实。");
  return lines.join("\n");
}
