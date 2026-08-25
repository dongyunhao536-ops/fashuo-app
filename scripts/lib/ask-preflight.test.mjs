// [claude] 2026-08-25：锁住六步预检不能再退回"执行者自己填/自己签"。
// 事故：2026-08-25 答疑实测中，preflight_checked 只是白名单里的字符串，
// 我没读过它的定义就 --done 签了，答案也没输出预检清单与证据卡。
import { describe, expect, it } from "vitest";
import {
  AskPreflightError,
  assertPreflightSignable,
  buildPreflightChecklist,
  evaluatePreflight,
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
  it("心得/教材/真题三选二实锤才算正常作答", () => {
    expect(evaluatePreflight({ xinde: 2, textbook: 17, exam: 9 }).verdict).toBe("normal");
    expect(evaluatePreflight({ xinde: 0, textbook: 17, exam: 0 }).verdict).toBe("single_source");
    expect(evaluatePreflight({ xinde: 0, textbook: 0, exam: 0, zhenti: 0 }).verdict).toBe("discussion_only");
  });

  it("exam 与 zhenti 合并计入真题一项，不重复加权", () => {
    const scored = evaluatePreflight({ exam: 4, zhenti: 5 });
    expect(scored.zhenti).toBe(9);
    expect(scored.solid).toBe(1);
  });

  it("易混库零命中不拉低判权——它本就只收录成对易混概念", () => {
    const scored = evaluatePreflight({ xinde: 1, textbook: 1, yixiao: 0 });
    expect(scored.yixiao).toBe(0);
    expect(scored.verdict).toBe("normal");
  });

  it("问题归类必须带题型，含糊归类直接 BLOCK", () => {
    const hits = { xinde: 1, textbook: 1 };
    expect(() => buildPreflightChecklist({ category: "法制史随便写", hits }))
      .toThrow(/必须含题型之一/u);
    expect(buildPreflightChecklist({ category: "法制史/西周/概念辨析", hits }).checklist)
      .toContain("1 问题归类：法制史/西周/概念辨析");
  });

  it("清单六项按规定格式输出，零命中项写「无」而不是省略", () => {
    const { checklist } = buildPreflightChecklist({
      category: "法制史/西周/概念辨析",
      hits: { xinde: 2, textbook: 17, exam: 9, yixiao: 0 },
      queries: 2,
    });
    expect(checklist).toContain("3 易混检索：无");
    expect(checklist).toContain("4 教材锚定：命中 17 行");
    expect(checklist).toContain("判权：第 2/4/5 项 3 项实锤");
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
