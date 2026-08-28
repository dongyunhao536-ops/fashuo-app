// [claude] 2026-08-25：锁住六步预检不能再退回"执行者自己填/自己签"。
// 事故：2026-08-25 答疑实测中，preflight_checked 只是白名单里的字符串，
// 我没读过它的定义就 --done 签了，答案也没输出预检清单与证据卡。
import { describe, expect, it } from "vitest";
import {
  AskPreflightError,
  assertPreflightSignable,
  buildPreflightChecklist,
  evaluatePreflight,
  mergeMaterialHits,
} from "./ask-preflight.mjs";
import { AskEvidenceCardError, renderAskEvidenceCard, validateAskEvidenceCard } from "./ask-evidence-card.mjs";
import { SKILL_AUTOMATIC_STEPS, SKILL_MANUAL_STEPS } from "./skill-run.mjs";

const FULL_CARD = {
  textbook: {
    subject: "法制史",
    chapter: "第二章·第二节 西周法律制度",
    title: "二、刑事立法",
    page: "该书第 7 页",
    lines: "第 60 行",
    excerpt: "西周有嘉石之制，是拘押轻罪犯者的惩罚制度。",
  },
  zhenti: "2024 年 综合第 33 题，答案 D",
  xinde: "_法制史讲义心得.md 行 106-107",
  yixiao: "易混库 0 命中——未收录为易混对",
  updated: "不适用——历史制度",
  confidence: 95,
};

describe("六步预检判权从检索回执推导", () => {
  it("考试分析/讲义/真题三轴中两轴实锤才算正常作答", () => {
    expect(evaluatePreflight({ kaoshi: 15, jiangyi: 9, zhenti: 0 }).verdict).toBe("normal");
    expect(evaluatePreflight({ kaoshi: 15, jiangyi: 0, zhenti: 4 }).verdict).toBe("normal");
    expect(evaluatePreflight({ kaoshi: 0, jiangyi: 17, zhenti: 0 }).verdict).toBe("single_source");
    expect(evaluatePreflight({ kaoshi: 0, jiangyi: 0, zhenti: 0 }).verdict).toBe("discussion_only");
  });

  // 本条锁住 8-25 实测证伪的那个缺陷：讲义心得 100% 是讲义摘抄，
  // 旧判权把"心得＋教材"当两项独立实锤，实际是同一个源被数了两遍。
  it("讲义心得不与讲义构成第二轴——同源不得重复计数", () => {
    const onlyJiangyi = evaluatePreflight({ kaoshi: 0, jiangyi: 20, zhenti: 0 });
    expect(onlyJiangyi.solid).toBe(1);
    expect(onlyJiangyi.verdict).toBe("single_source");
  });

  it("做题心得与易混库只记录、不进判权", () => {
    const scored = evaluatePreflight({ kaoshi: 0, jiangyi: 0, zhenti: 0, xinde: 30, yixiao: 30 });
    expect(scored.xinde).toBe(30);
    expect(scored.yixiao).toBe(30);
    expect(scored.solid).toBe(0);
    expect(scored.verdict).toBe("discussion_only");
  });

  it("exam 与 zhenti 合并计入真题一轴，不重复加权", () => {
    const scored = evaluatePreflight({ exam: 4, zhenti: 5 });
    expect(scored.zhenti).toBe(9);
    expect(scored.solid).toBe(1);
  });

  it("旧格式回执拆不出考试分析与讲义，整体只当一轴", () => {
    const legacy = evaluatePreflight({ legacyDoctrine: 19, zhenti: 0 });
    expect(legacy.solid).toBe(1);
    expect(legacy.verdict).toBe("single_source");
    expect(evaluatePreflight({ legacyDoctrine: 19, zhenti: 4 }).verdict).toBe("normal");
  });

  it("只有讲义有、考试分析没有时，清单必须给出口径警告", () => {
    const { checklist } = buildPreflightChecklist({
      category: "民法/监护/概念辨析",
      hits: { kaoshi: 0, jiangyi: 12, zhenti: 3 },
    });
    expect(checklist).toContain("只有讲义有、《考试分析》没有");
    expect(buildPreflightChecklist({ category: "民法/监护/概念辨析", hits: { kaoshi: 5, jiangyi: 12, zhenti: 3 } }).checklist)
      .not.toContain("只有讲义有");
  });

  it("问题归类必须带题型，含糊归类直接 BLOCK", () => {
    const hits = { kaoshi: 1, jiangyi: 1 };
    expect(() => buildPreflightChecklist({ category: "法制史随便写", hits }))
      .toThrow(/必须含题型之一/u);
    expect(buildPreflightChecklist({ category: "法制史/西周/概念辨析", hits }).checklist)
      .toContain("1 问题归类：法制史/西周/概念辨析");
  });

  it("清单按规定格式输出，零命中项写「无」而不是省略", () => {
    const { checklist } = buildPreflightChecklist({
      category: "法制史/西周/概念辨析",
      hits: { kaoshi: 15, jiangyi: 0, zhenti: 9, xinde: 2, yixiao: 0 },
      queries: 2,
    });
    expect(checklist).toContain("2 考试分析锚定★：命中 15 行");
    expect(checklist).toContain("3 讲义锚定★：无");
    expect(checklist).toContain("5 辅助检索：做题心得 2 行｜易混库 0 行（只提示争点，不进判权）");
    expect(checklist).toContain("★三轴（考试分析／讲义／真题）中 2 轴实锤");
  });

  it("零实锤时拒签，除非显式承认这是讨论性回答", () => {
    const scored = evaluatePreflight({});
    expect(() => assertPreflightSignable(scored)).toThrow(AskPreflightError);
    expect(() => assertPreflightSignable(scored)).toThrow(/全部零命中/u);
    expect(() => assertPreflightSignable(scored, { discussionOnly: true })).not.toThrow();
  });

  it("preflight_checked 已移出手工步骤，不能再被 --done 补签", () => {
    expect(SKILL_MANUAL_STEPS).not.toContain("preflight_checked");
    expect(SKILL_AUTOMATIC_STEPS).toContain("preflight_checked");
  });
});

// [claude] 2026-08-27：锁住"补检索不必重跑全量"。
// 事故：2026-08-27 那场答疑里 material-batch 跑了三次。第二次是我自己 head 截断输出
// 造成的重复；第三次是漏了「对向犯」这个争点后补检索，而 preflight 当时只读最后一条
// 回执，只跑增量会把 q:7 覆盖成 q:2、判权掉档，只能重扫全库。两次共赔约 240 秒。
describe("多条检索回执聚合", () => {
  const full = { queries: 5, kaoshi: 277, jiangyi: 375, xinde: 15, yixiao: 45, zhenti: 151, legacyDoctrine: null };
  const topUp = { queries: 2, kaoshi: 0, jiangyi: 38, xinde: 1, yixiao: 1, zhenti: 0, legacyDoctrine: null };

  it("只读最后一条回执会掉档——这就是要修的行为", () => {
    // 旧实现等价物：补检索后只看增量那条。考试分析与真题两轴归零，3 轴掉到 1 轴。
    expect(evaluatePreflight(topUp).solid).toBe(1);
    expect(evaluatePreflight(topUp).verdict).toBe("single_source");
  });

  it("聚合后判权回到 3 轴，补检索不必重跑全量", () => {
    const merged = mergeMaterialHits([full, topUp]);
    expect(evaluatePreflight(merged).solid).toBe(3);
    expect(evaluatePreflight(merged).verdict).toBe("normal");
  });

  it("各轴取 max 不取 sum，重叠争点不得被数两遍", () => {
    const merged = mergeMaterialHits([full, topUp]);
    expect(merged.jiangyi).toBe(375);
    expect(merged.kaoshi).toBe(277);
    expect(merged.queries).toBe(5);
    // 同一批检索重跑一次，命中数不得翻倍。
    expect(mergeMaterialHits([full, full]).jiangyi).toBe(375);
  });

  it("混进旧格式回执就整体降级为两轴，宁严勿宽", () => {
    const legacy = { queries: 3, kaoshi: 0, jiangyi: 0, xinde: 0, yixiao: 2, zhenti: 90, legacyDoctrine: 120 };
    const merged = mergeMaterialHits([full, legacy]);
    expect(merged.legacyDoctrine).toBe(652); // max(277+375, 120)
    expect(merged.kaoshi).toBe(0);
    expect(merged.jiangyi).toBe(0);
    expect(evaluatePreflight(merged).solid).toBe(2);
  });

  it("没有回执时返回 null，让调用方回落而不是伪造零命中", () => {
    expect(mergeMaterialHits([])).toBeNull();
    expect(mergeMaterialHits(null)).toBeNull();
    expect(mergeMaterialHits([null, "x"])).toBeNull();
  });

  it("聚合了多条时清单要写出来，别让人以为只检索过一轮", () => {
    const merged = mergeMaterialHits([full, topUp]);
    const built = buildPreflightChecklist({
      category: "刑法·第十章量刑·选项排除",
      hits: merged,
      queries: merged.queries,
      receipts: 2,
    });
    expect(built.checklist).toMatch(/已聚合本 Run 2 条检索回执/u);
    // 各轴取 max 后 queries 也是单次最大值，不是累计跑过的组数——措辞不许把它说成"共 N 组"。
    expect(built.checklist).toMatch(/单次最多 5 组检索/u);
    expect(built.checklist).not.toMatch(/共 5 组检索/u);
    expect(built.receipts).toBe(2);
  });

  it("单条回执时清单保持原样，不多话", () => {
    const built = buildPreflightChecklist({
      category: "刑法·第十章量刑·选项排除",
      hits: full,
      queries: full.queries,
    });
    expect(built.checklist).not.toMatch(/已聚合/u);
    expect(built.receipts).toBe(1);
  });
});

describe("证据卡出处四件套硬校验", () => {
  it("只报行号——正是 8-25 栽的那种引用——必须 BLOCK", () => {
    let caught = null;
    try {
      validateAskEvidenceCard({ textbook: { lines: "第 60 行", excerpt: "原文" }, confidence: 95 });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AskEvidenceCardError);
    const codes = caught.issues.map((item) => item.code);
    expect(codes).toContain("textbook_subject_missing");
    expect(codes).toContain("textbook_chapter_missing");
    expect(codes).toContain("textbook_title_missing");
    expect(codes).toContain("textbook_page_missing");
  });

  it("页码查不到必须显式写出来，不许整项省略", () => {
    const ok = validateAskEvidenceCard({ ...FULL_CARD, textbook: { ...FULL_CARD.textbook, page: "该书页码未知" } });
    expect(ok.textbook.page).toBe("该书页码未知");
  });

  it("出现「法考」直接阻断——纯法硕口径红线", () => {
    expect(() => validateAskEvidenceCard({ ...FULL_CARD, xinde: "法考通说同此" }))
      .toThrow(AskEvidenceCardError);
  });

  it("信心度必须是 0-100 的数字，<70% 渲染时挂核对提醒", () => {
    expect(() => validateAskEvidenceCard({ ...FULL_CARD, confidence: "高" })).toThrow(AskEvidenceCardError);
    const low = renderAskEvidenceCard(validateAskEvidenceCard({ ...FULL_CARD, confidence: 60 }));
    expect(low).toContain("必须提醒核对标答");
    expect(renderAskEvidenceCard(validateAskEvidenceCard(FULL_CARD))).not.toContain("必须提醒核对标答");
  });

  it("完整卡渲染出科目·章节·标题·页码·行号全串", () => {
    const rendered = renderAskEvidenceCard(validateAskEvidenceCard(FULL_CARD));
    expect(rendered).toContain("《考试分析》·法制史·第二章·第二节 西周法律制度·二、刑事立法·该书第 7 页·第 60 行");
    expect(rendered).toContain("纯法硕口径");
  });
});
