// [gpt] 2026-08-10：把退役 kp_state 中仍然有效的稳定 ID/材料元数据，
// 与 Anki 卡片元数据合并成只读目录。这里绝不读取或解释旧掌握字段。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// [claude] 2026-08-24：原来硬编码 D:/fashuo，迁到 macOS 后必然落空。
// 而 loadAnkiExtract 找不到文件只返回 available:false 不抛错，
// 于是 assessment/knowledge 静默少一个证据源，评估四维会无声偏低。
import { resolveArchiveRoot } from "./workspace-paths.mjs";

export function defaultAnkiExtractPath(options = {}) {
  return join(resolveArchiveRoot(options), "考点库", "anki_extracted.json");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value, limit = 180) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function normalizeKnowledgeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。；、：:,.!?！？“”‘’"'（）()【】\[\]《》<>·|｜\-—_/\\=+]+/g, "")
    .trim();
}

function bigrams(value) {
  const clean = normalizeKnowledgeText(value);
  if (!clean) return new Set();
  if (clean.length === 1) return new Set([clean]);
  return new Set(Array.from({ length: clean.length - 1 }, (_, index) => clean.slice(index, index + 2)));
}

function jaccard(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function priorityBucket(note) {
  for (const [rank, field] of [[1, "P1必背高精"], [2, "P2必背"], [3, "P3选背"], [4, "P4浏览"]]) {
    if (asArray(note?.[field]).length) return rank;
  }
  return null;
}

export function toAnkiReference(note) {
  const noteId = note?.note_id == null ? null : String(note.note_id);
  const pointCounts = {
    p1: asArray(note?.["P1必背高精"]).length,
    p2: asArray(note?.["P2必背"]).length,
    p3: asArray(note?.["P3选背"]).length,
    p4: asArray(note?.["P4浏览"]).length,
    objective: asArray(note?.["客观点"]).length,
    criticalObjective: asArray(note?.["极重要客观点"]).length,
  };
  return {
    noteId,
    subject: compactText(note?.subject, 20) || null,
    deck: compactText(note?.deck, 220) || null,
    chapter: compactText(note?.chapter, 120) || null,
    title: compactText(note?.title, 220) || null,
    kind: compactText(note?.kind, 40) || null,
    questionType: compactText(note?.["题型"], 40) || null,
    stars: Number.isFinite(Number(note?.["星级"])) ? Number(note["星级"]) : 0,
    priorityBucket: priorityBucket(note),
    pointCounts,
  };
}

export function loadAnkiExtract(path = process.env.ANKI_EXTRACTED_PATH || defaultAnkiExtractPath()) {
  if (!path || !existsSync(path)) {
    // 缺源必须能被上游看见：报出实际找过的路径，别只说"不存在"。
    return { path, notes: [], available: false, issue: `Anki 导出文件不存在：${path}` };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Anki 导出不是数组：${path}`);
  return { path, notes: parsed, available: true, issue: null };
}

function importanceScore(row, references) {
  const frequency = String(row?.zhenti_freq ?? row?.ext?.zhenti_freq ?? "");
  let score = { 高: 82, 中: 58, 低: 34 }[frequency] ?? 45;
  const years = asArray(row?.zhenti_years ?? row?.ext?.zhenti_years);
  score += Math.min(10, new Set(years.map(String)).size * 2);
  const exact = String(row?.anki_match_level ?? row?.ext?.anki_match_level ?? "") === "exact";
  const bestBucket = references.map((item) => item.priorityBucket).filter(Number.isInteger).sort()[0] ?? null;
  if (exact && bestBucket === 1) score += 8;
  else if (exact && bestBucket === 2) score += 5;
  else if (bestBucket != null) score += 2;
  const maxStars = Math.max(0, ...references.map((item) => item.stars || 0));
  score += Math.min(5, maxStars);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeKpRow(row, notesById) {
  const ext = row?.ext && typeof row.ext === "object" ? row.ext : {};
  const noteIds = asArray(row?.anki_note_ids ?? ext.anki_note_ids).map(String);
  const references = noteIds.map((id) => notesById.get(id)).filter(Boolean);
  const matchLevel = row?.anki_match_level ?? ext.anki_match_level ?? null;
  return {
    kpId: String(row?.kp_id ?? ""),
    subject: String(row?.subject ?? ""),
    parentKp: row?.parent_kp ?? null,
    name: compactText(row?.name ?? ext.name, 180) || null,
    page: row?.page ?? ext.page ?? null,
    sourceLine: row?.src_line ?? ext.src_line ?? null,
    examMethod: row?.kaofa ?? ext.kaofa ?? null,
    zhentiFrequency: row?.zhenti_freq ?? ext.zhenti_freq ?? null,
    zhentiYears: asArray(row?.zhenti_years ?? ext.zhenti_years),
    keypoints: asArray(row?.keypoints ?? ext.l1_keypoints).map((value) => compactText(value, 260)).filter(Boolean),
    anki: {
      matchLevel,
      noteIds,
      references,
      directEvidenceEligible: false,
      usage: matchLevel === "exact"
        ? "精确材料参考；仍不能代替学习表现证据"
        : matchLevel === "section"
          ? "章节级参考；不得冒充该知识点的精确卡片"
          : "无 Anki 映射",
    },
    importanceScore: importanceScore(row, references),
    stateAuthority: "knowledge_evidence_v2",
    legacyMasteryIgnored: true,
  };
}

export function buildKnowledgeCatalog(kpRows = [], ankiNotes = []) {
  const notesById = new Map();
  for (const note of ankiNotes) {
    const reference = toAnkiReference(note);
    if (reference.noteId) notesById.set(reference.noteId, reference);
  }
  const duplicateIds = [];
  const seen = new Set();
  const items = kpRows.map((row) => normalizeKpRow(row, notesById));
  for (const item of items) {
    if (seen.has(item.kpId)) duplicateIds.push(item.kpId);
    seen.add(item.kpId);
  }
  const unresolvedAnkiIds = items.flatMap((item) => item.anki.noteIds
    .filter((id) => !notesById.has(id))
    .map((id) => ({ kpId: item.kpId, noteId: id })));
  const bySubject = Object.fromEntries([...new Set(items.map((item) => item.subject))].sort()
    .map((subject) => [subject, items.filter((item) => item.subject === subject).length]));
  const issues = [
    ...duplicateIds.map((kpId) => ({ code: "duplicate_kp_id", kpId })),
    ...items.filter((item) => !/^[A-Z]{2,4}-\d{4}$/.test(item.kpId)).map((item) => ({ code: "invalid_kp_id", kpId: item.kpId })),
    ...items.filter((item) => !item.name).map((item) => ({ code: "missing_name", kpId: item.kpId })),
    ...unresolvedAnkiIds.map((item) => ({ code: "missing_anki_note", ...item })),
  ];
  return {
    version: 2,
    counts: {
      total: items.length,
      bySubject,
      ankiExact: items.filter((item) => item.anki.matchLevel === "exact").length,
      ankiSection: items.filter((item) => item.anki.matchLevel === "section").length,
      ankiUnlinked: items.filter((item) => !item.anki.noteIds.length).length,
      issues: issues.length,
    },
    issues,
    items,
  };
}

function searchableText(item) {
  return [
    item.kpId,
    item.name,
    item.parentKp,
    ...item.keypoints,
    ...item.anki.references.flatMap((reference) => [reference.title, reference.chapter, reference.deck]),
  ].filter(Boolean).join(" ");
}

export function scoreKnowledgeMatch(item, query) {
  const needle = normalizeKnowledgeText(query);
  if (!needle) return 0;
  const id = normalizeKnowledgeText(item.kpId);
  const name = normalizeKnowledgeText(item.name);
  const parent = normalizeKnowledgeText(item.parentKp);
  const haystack = normalizeKnowledgeText(searchableText(item));
  if (needle === id) return 1000;
  if (needle === name) return 960;
  if (name && (needle.includes(name) || name.includes(needle))) return 860 + Math.min(80, Math.min(name.length, needle.length));
  if (parent && needle === parent) return 800;
  if (haystack.includes(needle)) return 720 + Math.min(100, needle.length * 3);
  return Math.round(jaccard(searchableText(item), query) * 650);
}

export function searchKnowledgeCatalog(catalog, query, { subject = null, limit = 10 } = {}) {
  return (catalog?.items ?? [])
    .filter((item) => !subject || item.subject === subject)
    .map((item) => ({ item, matchScore: scoreKnowledgeMatch(item, query) }))
    .filter((entry) => entry.matchScore > 0)
    .sort((left, right) => right.matchScore - left.matchScore || right.item.importanceScore - left.item.importanceScore || left.item.kpId.localeCompare(right.item.kpId))
    .slice(0, limit);
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function sourceLinkKey(kind, id) {
  return `${kind}:${String(id ?? "")}`;
}

function uniqueTexts(values) {
  const seen = new Set();
  const output = [];
  for (const value of values.flat(Infinity)) {
    const text = compactText(value, 120);
    const key = normalizeKnowledgeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function quotedFragments(value) {
  const text = String(value ?? "");
  const output = [];
  const pattern = /[「『“"【《]([^」』”"】》]{2,40})[」』”"】》]/g;
  for (const match of text.matchAll(pattern)) output.push(match[1]);
  return output;
}

function recordSignals(record) {
  const signals = [];
  const seen = new Set();
  const add = (kind, value) => {
    const text = compactText(value, 120);
    const key = normalizeKnowledgeText(text);
    if (!key || key.length < 2 || seen.has(`${kind}:${key}`)) return;
    seen.add(`${kind}:${key}`);
    signals.push({ kind, text });
  };
  add("title", record?.title);
  for (const part of String(record?.title ?? "").split(/[：:、/｜|·→—]+/)) add("title_part", part);
  for (const value of asArray(record?.searchTerms)) add("context", value);
  for (const value of quotedFragments(record?.searchText)) add("context", value);
  return signals.slice(0, 24);
}

function matchEvidence(item, signal, matchScore) {
  const query = normalizeKnowledgeText(signal.text);
  const id = normalizeKnowledgeText(item.kpId);
  const name = normalizeKnowledgeText(item.name);
  const inField = (value) => {
    const field = normalizeKnowledgeText(value);
    return Boolean(field && query && field.includes(query));
  };
  if (query === id) return { confidence: 99, method: "manual", reason: `稳定 ID 精确命中 ${item.kpId}` };
  if (name && query === name) return { confidence: 96, method: "exact_name", reason: `名称精确命中「${item.name}」` };
  if (name && query.includes(name) && name.length >= 3) return { confidence: 90, method: "exact_name", reason: `标题包含知识点名「${item.name}」` };
  if (name && name.includes(query) && query.length >= 3) return { confidence: signal.kind === "title" ? 86 : 72, method: "exact_name", reason: `名称包含检索片段「${signal.text}」` };
  if (item.keypoints.some(inField)) return {
    confidence: signal.kind.startsWith("title") ? 84 : 72,
    method: "fuzzy",
    reason: `目录要点包含「${signal.text}」`,
  };
  if (inField(item.parentKp)) return {
    confidence: signal.kind.startsWith("title") ? 78 : 66,
    method: "fuzzy",
    reason: `目录父级包含「${signal.text}」`,
  };
  if (item.anki.references.some((reference) => [reference.title, reference.chapter, reference.deck].some(inField))) return {
    confidence: signal.kind.startsWith("title") ? 74 : 62,
    method: "fuzzy",
    reason: `Anki 材料元数据包含「${signal.text}」；仅作检索线索`,
  };
  return {
    confidence: Math.min(signal.kind.startsWith("title") ? 64 : 52, Math.max(1, Math.round(matchScore / 10))),
    method: "fuzzy",
    reason: `文本相似候选「${signal.text}」`,
  };
}

function scopeMatchBonus(record, item) {
  const source = normalizeKnowledgeText([record?.title, record?.chapter, record?.section].filter(Boolean).join("/"));
  const leafParent = normalizeKnowledgeText(String(item?.parentKp ?? "").split("/").at(-1));
  const scopes = [
    ["秦", "秦朝"], ["汉", "汉朝"], ["隋", "隋朝"], ["唐", "唐朝"], ["宋", "宋朝"],
    ["辽", "辽朝"], ["西夏", "西夏"], ["金", "金朝"], ["元", "元朝"], ["明", "明朝"], ["清", "清朝"],
    ["清末", "清末"], ["北洋", "北洋政府"], ["南京国民政府", "南京国民政府"],
  ];
  const matches = scopes.filter(([sourceToken, parentToken]) => source.includes(normalizeKnowledgeText(sourceToken)) && leafParent.includes(normalizeKnowledgeText(parentToken))).length;
  return Math.min(8, matches * 4);
}

function decisionForCandidates(candidates, subjectSupported) {
  if (!subjectSupported) return {
    status: "catalog_unsupported",
    reason: "稳定知识目录没有该科目；保留未映射并转交对应 skill",
    autoConfirm: false,
  };
  if (!candidates.length) return {
    status: "no_candidate",
    reason: "没有达到展示阈值的候选；需要人工检索或保留未映射",
    autoConfirm: false,
  };
  const [first, second] = candidates;
  const reviewable = candidates.filter((candidate) => candidate.confidence >= 65);
  const ambiguous = Boolean(
    second
    && second.confidence >= 65
    && (first.confidence - second.confidence <= 8 || !first.hasTitleEvidence || reviewable.length > 2),
  );
  if (ambiguous) return {
    status: "ambiguous",
    reason: "存在多个接近或仅由原题上下文命中的候选，不能替用户选定知识点",
    autoConfirm: false,
  };
  if (first.tier === "strong" && first.hasTitleEvidence) return {
    status: "strong_candidate",
    reason: "主题标题与单一知识点高度吻合；仍须核对对象原文与目录详情",
    autoConfirm: false,
  };
  return {
    status: first.confidence >= 65 ? "manual_review" : "weak_only",
    reason: first.confidence >= 65
      ? "候选可用于缩小检索范围，但不足以确认映射"
      : "只有弱相似候选，不应据此写入学习事实",
    autoConfirm: false,
  };
}

/**
 * [gpt] 2026-08-10：通用知识对象候选器。相似度只缩小人工核验范围，
 * 无论分数多高都只返回 pending；confirmed 只能由显式人工确认命令写入。
 */
export function suggestKnowledgeLinks(records, catalog, {
  limitPerRecord = 3,
  minConfidence = 0,
  sourceKind = null,
} = {}) {
  return (records ?? []).map((record) => {
    const resolvedSourceKind = record.sourceKind ?? sourceKind ?? "manual";
    const resolvedSourceId = String(record.sourceId ?? record.id ?? "");
    if (record.mappingPolicy === "keep_unmapped") return {
      ...record,
      sourceKind: resolvedSourceKind,
      sourceId: resolvedSourceId,
      candidates: [],
      decision: {
        status: "keep_unmapped",
        reason: record.mappingReason ?? "该对象不属于稳定知识目录的内容知识点",
        autoConfirm: false,
      },
    };
    const subjectItems = (catalog?.items ?? []).filter((item) => !record.subject || item.subject === record.subject);
    const byKp = new Map();
    for (const signal of recordSignals(record)) {
      const matches = searchKnowledgeCatalog(catalog, signal.text, {
        subject: record.subject,
        limit: Math.max(12, limitPerRecord * 4),
      });
      for (const { item, matchScore } of matches) {
        const evidence = matchEvidence(item, signal, matchScore);
        const known = byKp.get(item.kpId) ?? { item, evidences: [], bestScore: 0 };
        known.evidences.push({
          signalKind: signal.kind,
          query: signal.text,
          score: matchScore,
          confidence: evidence.confidence,
          reason: evidence.reason,
          matchMethod: evidence.method,
        });
        known.bestScore = Math.max(known.bestScore, matchScore);
        byKp.set(item.kpId, known);
      }
    }
    const candidates = [...byKp.values()].map(({ item, evidences, bestScore }) => {
      const sortedEvidence = evidences.sort((left, right) => right.confidence - left.confidence || right.score - left.score);
      const best = sortedEvidence[0];
      const supportBonus = Math.min(8, Math.max(0, new Set(sortedEvidence.map((entry) => normalizeKnowledgeText(entry.query))).size - 1) * 2);
      const hasTitleEvidence = sortedEvidence.some((entry) => entry.signalKind.startsWith("title") && entry.confidence >= 65);
      const confidence = Math.min(hasTitleEvidence ? 99 : 88, best.confidence + supportBonus + scopeMatchBonus(record, item));
      return {
        kpId: item.kpId,
        name: item.name,
        parentKp: item.parentKp,
        confidence,
        tier: confidence >= 90 && hasTitleEvidence ? "strong" : confidence >= 65 ? "review" : "weak",
        hasTitleEvidence,
        matchMethod: sortedEvidence.some((entry) => entry.matchMethod === "exact_name") ? "exact_name" : "fuzzy",
        suggestedStatus: "pending",
        confirmationRequired: true,
        matchEvidence: sortedEvidence.slice(0, 3),
        bestScore,
        ankiMatchLevel: item.anki.matchLevel,
        ankiNoteIds: item.anki.noteIds,
      };
    }).filter((candidate) => candidate.confidence >= minConfidence)
      .sort((left, right) => right.confidence - left.confidence || right.bestScore - left.bestScore || left.kpId.localeCompare(right.kpId))
      .slice(0, limitPerRecord);
    return {
      ...record,
      sourceKind: resolvedSourceKind,
      sourceId: resolvedSourceId,
      candidates,
      decision: decisionForCandidates(candidates, subjectItems.length > 0),
    };
  });
}

/**
 * [gpt] 2026-08-10：只挑出仍无稳定 kp_id / confirmed 对象映射的细粒度错题证据。
 * 优先给长期主题建链接；没有主题时才退回单次错题事件。
 */
export function buildUnmappedErrorLinkRecords(errorRows = [], objectLinks = [], { subject = null } = {}) {
  const confirmed = new Set(objectLinks.filter((row) => rowValue(row, "linkStatus", "link_status") === "confirmed")
    .map((row) => sourceLinkKey(rowValue(row, "sourceKind", "source_kind"), rowValue(row, "sourceId", "source_id"))));
  const linksBySource = new Map();
  for (const link of objectLinks) {
    const key = sourceLinkKey(rowValue(link, "sourceKind", "source_kind"), rowValue(link, "sourceId", "source_id"));
    const list = linksBySource.get(key) ?? [];
    list.push({
      kpId: rowValue(link, "kpId", "kp_id"),
      role: rowValue(link, "role", "role"),
      status: rowValue(link, "linkStatus", "link_status"),
      method: rowValue(link, "matchMethod", "match_method"),
      confidence: rowValue(link, "confidence", "confidence"),
    });
    linksBySource.set(key, list);
  }

  const groups = new Map();
  for (const [sequence, row] of errorRows.entries()) {
    const failurePattern = rowValue(row, "failurePatternCode", "failure_pattern_code");
    const diagnosisStatus = String(rowValue(row, "diagnosisStatus", "diagnosis_status") ?? "pending");
    if (!failurePattern || diagnosisStatus === "rejected") continue;
    const eventId = String(rowValue(row, "studyErrorId", "study_error_id") ?? "");
    const topicIdValue = rowValue(row, "topicId", "topic_id");
    const topicId = topicIdValue == null ? null : String(topicIdValue);
    const rowSubject = rowValue(row, "topicSubject", "topic_subject") ?? rowValue(row, "eventSubject", "event_subject") ?? null;
    if (subject && rowSubject !== subject) continue;
    const directKp = rowValue(row, "topicKpId", "topic_kp_id") ?? rowValue(row, "eventKpId", "event_kp_id");
    if (directKp) continue;
    if ((topicId && confirmed.has(sourceLinkKey("error_topic", topicId))) || confirmed.has(sourceLinkKey("study_error", eventId))) continue;

    const sourceKind = topicId ? "error_topic" : "study_error";
    const sourceId = topicId ?? eventId;
    if (!sourceId) continue;
    const key = sourceLinkKey(sourceKind, sourceId);
    const knowledge = compactText(rowValue(row, "knowledge", "knowledge"), 800);
    const title = compactText(rowValue(row, "topicTitle", "topic_title"), 180)
      || compactText(knowledge, 100)
      || `${sourceKind}#${sourceId}`;
    const chapter = rowValue(row, "chapter", "chapter");
    const section = rowValue(row, "section", "section");
    const methodTopic = sourceKind === "error_topic" && /跨科做题方法|通用做题方法|做题方法/.test(`${chapter ?? ""}/${section ?? ""}`);
    const known = groups.get(key) ?? {
      sourceKind,
      sourceId,
      subject: rowSubject,
      title,
      chapter,
      section,
      mappingPolicy: methodTopic ? "keep_unmapped" : "candidate_search",
      mappingReason: methodTopic
        ? "这是跨科做题方法主题，不是单一内容知识点；保留主题未映射，必要时另核对具体错题事件的内容归属"
        : null,
      searchTerms: [],
      evidence: [],
      existingLinks: linksBySource.get(key) ?? [],
    };
    known.searchTerms.push(...quotedFragments(knowledge));
    known.evidence.push({
      sequence,
      studyErrorId: eventId,
      failurePatternCode: failurePattern,
      diagnosisStatus,
      date: rowValue(row, "logDate", "log_date"),
      anchor: rowValue(row, "evidenceAnchor", "evidence_anchor"),
      knowledgeSnippet: compactText(knowledge, 220),
    });
    groups.set(key, known);
  }

  return [...groups.values()].map((record) => ({
    ...record,
    searchTerms: uniqueTexts([
      record.searchTerms,
      record.chapter,
      record.section,
    ]).slice(0, 20),
  })).sort((left, right) => String(left.subject).localeCompare(String(right.subject), "zh-CN")
    || left.sourceKind.localeCompare(right.sourceKind)
    || String(left.sourceId).localeCompare(String(right.sourceId), "zh-CN", { numeric: true }));
}

export function suggestReciteKnowledgeLinks(records, catalog, { limitPerRecord = 3 } = {}) {
  return suggestKnowledgeLinks((records ?? []).map((record) => ({
    ...record,
    sourceKind: "recite_ledger",
    sourceId: record.id,
  })), catalog, { limitPerRecord, sourceKind: "recite_ledger" });
}
