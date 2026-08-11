// [gpt] 2026-08-10：覆盖知识映射候选分层、歧义保护与明确保留未映射。
import { describe, expect, it } from "vitest";
import {
  buildUnmappedErrorLinkRecords,
  buildKnowledgeCatalog,
  searchKnowledgeCatalog,
  suggestKnowledgeLinks,
  suggestReciteKnowledgeLinks,
  toAnkiReference,
} from "./knowledge-catalog.mjs";

const notes = [{
  note_id: 1660984947609,
  subject: "法理",
  deck: "考试分析::法理::法学",
  title: "法学的概念",
  kind: "背诵",
  题型: "简答",
  星级: 3,
  P1必背高精: ["定义"],
  P2必背: [],
  P3选背: [],
  P4浏览: [],
  客观点: ["性质"],
  极重要客观点: [],
}];

const rows = [{
  kp_id: "FL-0001",
  subject: "法理",
  parent_kp: "绪论/法学",
  ext: {
    name: "法学的概念",
    zhenti_freq: "高",
    zhenti_years: [2019, 2022],
    l1_keypoints: ["法学以法律现象为研究对象"],
    anki_note_ids: [1660984947609],
    anki_match_level: "exact",
  },
}, {
  kp_id: "FL-0002",
  subject: "法理",
  parent_kp: "绪论/法学",
  ext: { name: "法学的产生和发展", zhenti_freq: "低", anki_note_ids: [1660984947609], anki_match_level: "section" },
}];

describe("knowledge catalog", () => {
  it("只抽取 Anki 元数据，并明确卡片不构成掌握证据", () => {
    const reference = toAnkiReference(notes[0]);
    expect(reference).toMatchObject({ noteId: "1660984947609", priorityBucket: 1, stars: 3 });
    const catalog = buildKnowledgeCatalog(rows, notes);
    expect(catalog.counts).toMatchObject({ total: 2, ankiExact: 1, ankiSection: 1 });
    expect(catalog.items[0]).toMatchObject({
      kpId: "FL-0001",
      stateAuthority: "knowledge_evidence_v2",
      legacyMasteryIgnored: true,
      anki: { directEvidenceEligible: false, matchLevel: "exact" },
    });
    expect(catalog.items[0].importanceScore).toBeGreaterThan(catalog.items[1].importanceScore);
  });

  it("按稳定 ID、名称、要点和 Anki 标题检索", () => {
    const catalog = buildKnowledgeCatalog(rows, notes);
    expect(searchKnowledgeCatalog(catalog, "FL-0002")[0].item.kpId).toBe("FL-0002");
    expect(searchKnowledgeCatalog(catalog, "法律现象")[0].item.kpId).toBe("FL-0001");
    expect(searchKnowledgeCatalog(catalog, "法学的概念")[0].item.kpId).toBe("FL-0001");
  });

  it("带背标题只生成有置信标记的候选，不把章节级 Anki 映射冒充精确链接", () => {
    const catalog = buildKnowledgeCatalog(rows, notes);
    const [suggestion] = suggestReciteKnowledgeLinks([{ id: "L1", subject: "法理", title: "法学的概念：定义别漏" }], catalog);
    expect(suggestion.candidates[0]).toMatchObject({ kpId: "FL-0001", matchMethod: "exact_name" });
    expect(suggestion.candidates[0]).toMatchObject({ suggestedStatus: "pending", confirmationRequired: true });
    expect(suggestion.candidates[0].ankiMatchLevel).toBe("exact");
    expect(suggestion.candidates.find((item) => item.kpId === "FL-0002")?.ankiMatchLevel).toBe("section");
  });

  it("多个强候选保持歧义且一律不自动 confirmed", () => {
    const catalog = buildKnowledgeCatalog([{
      kp_id: "FL-0001", subject: "法理", ext: { name: "法律规则", anki_note_ids: [], anki_match_level: null },
    }, {
      kp_id: "FL-0002", subject: "法理", ext: { name: "法律原则", anki_note_ids: [], anki_match_level: null },
    }], []);
    const [suggestion] = suggestKnowledgeLinks([{
      sourceKind: "error_topic",
      sourceId: "12",
      subject: "法理",
      title: "法律规则与法律原则的区别",
    }], catalog, { limitPerRecord: 3 });
    expect(suggestion.decision).toMatchObject({ status: "ambiguous", autoConfirm: false });
    expect(suggestion.candidates).toHaveLength(2);
    expect(suggestion.candidates.every((item) => item.suggestedStatus === "pending")).toBe(true);
  });

  it("原题上下文命中只能形成待人工核对候选，不能冒充主题标题匹配", () => {
    const catalog = buildKnowledgeCatalog([{
      kp_id: "LS-0014",
      subject: "法制史",
      parent_kp: "秦汉法律制度/秦朝法律制度",
      ext: { name: "立法概况", l1_keypoints: ["主要法律形式包括律、令、廷行事"], anki_note_ids: [], anki_match_level: null },
    }], []);
    const [suggestion] = suggestKnowledgeLinks([{
      sourceKind: "error_topic",
      sourceId: "3",
      subject: "法制史",
      title: "反向设问方向识别",
      searchTerms: ["廷行事"],
    }], catalog);
    expect(suggestion.candidates[0]).toMatchObject({ kpId: "LS-0014", hasTitleEvidence: false, tier: "review", suggestedStatus: "pending" });
    expect(suggestion.decision).toMatchObject({ status: "manual_review", autoConfirm: false });
  });

  it("只汇总真正未映射的细粒度错题，并优先以长期主题为链接对象", () => {
    const errorRows = [{
      study_error_id: 95,
      event_subject: "法制史",
      event_kp_id: null,
      knowledge: "原题涉及『廷行事』",
      topic_id: 3,
      topic_subject: "法制史",
      topic_kp_id: null,
      topic_title: "反向设问方向识别",
      failure_pattern_code: "question_layer",
      diagnosis_status: "confirmed",
    }, {
      study_error_id: 96,
      event_subject: "法制史",
      event_kp_id: "LS-0014",
      failure_pattern_code: "knowledge_gap",
      diagnosis_status: "confirmed",
    }, {
      study_error_id: 97,
      event_subject: "法制史",
      topic_id: 4,
      topic_subject: "法制史",
      topic_title: "已确认对象",
      failure_pattern_code: "boundary_shift",
      diagnosis_status: "confirmed",
    }];
    const records = buildUnmappedErrorLinkRecords(errorRows, [{
      source_kind: "error_topic", source_id: "4", kp_id: "LS-0020", link_status: "confirmed",
    }, {
      source_kind: "error_topic", source_id: "3", kp_id: "LS-0014", link_status: "pending", confidence: 72,
    }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceKind: "error_topic",
      sourceId: "3",
      subject: "法制史",
      existingLinks: [{ kpId: "LS-0014", status: "pending", confidence: 72 }],
      evidence: [{ studyErrorId: "95", failurePatternCode: "question_layer" }],
    });
    expect(records[0].searchTerms).toContain("廷行事");
  });

  it("跨科做题方法主题明确保留未映射，不拿原题内容候选硬连主题", () => {
    const catalog = buildKnowledgeCatalog([{
      kp_id: "LS-0030", subject: "法制史", ext: { name: "民事立法", l1_keypoints: ["唐朝借贷契约"], anki_note_ids: [], anki_match_level: null },
    }], []);
    const records = buildUnmappedErrorLinkRecords([{
      study_error_id: 95,
      event_subject: "法制史",
      knowledge: "唐朝借贷契约题",
      topic_id: 3,
      topic_subject: "法制史",
      topic_title: "反向设问方向识别",
      chapter: "跨科做题方法",
      failure_pattern_code: "question_layer",
      diagnosis_status: "confirmed",
    }]);
    const [suggestion] = suggestKnowledgeLinks(records, catalog);
    expect(suggestion).toMatchObject({
      mappingPolicy: "keep_unmapped",
      candidates: [],
      decision: { status: "keep_unmapped", autoConfirm: false },
    });
  });

  it("同词候选优先按主题朝代与目录叶级父项收窄，但仍只标 review", () => {
    const catalog = buildKnowledgeCatalog([{
      kp_id: "LS-0022", subject: "法制史", parent_kp: "秦汉制度/汉朝法律制度", ext: { name: "司法制度", l1_keypoints: ["决事比属于判例"], anki_note_ids: [], anki_match_level: null },
    }, {
      kp_id: "LS-0066", subject: "法制史", parent_kp: "清末民初/北洋政府法律制度", ext: { name: "司法制度", l1_keypoints: ["判例成为法律渊源"], anki_note_ids: [], anki_match_level: null },
    }], []);
    const [suggestion] = suggestKnowledgeLinks([{
      sourceKind: "error_topic", sourceId: "2", subject: "法制史", title: "汉代判例性质的法律形式", searchTerms: ["判例"],
    }], catalog);
    expect(suggestion.candidates[0]).toMatchObject({ kpId: "LS-0022", tier: "review", suggestedStatus: "pending" });
    expect(suggestion.candidates[0].confidence).toBeGreaterThan(suggestion.candidates[1].confidence);
  });
});
