// [gpt] 2026-08-12：命题完整性 Gate 的真实失败回放与正常题防误杀。
import { describe, expect, it } from "vitest";
import {
  auditReviewQuestion,
  invalidReviewDisposition,
  rewriteReviewQuestion,
} from "./question-integrity.mjs";

const stem = [
  "【多选题】关于某制度，下列说法正确的有：",
  "①甲说法",
  "②乙说法",
  "③丙说法",
  "④丁说法",
].join("\n");

describe("复检题命题完整性 Gate", () => {
  it("拦截点名错误选项的追问，并给可再次过 Gate 的安全改写", () => {
    const input = {
      questionType: "multiple-choice",
      stem,
      requirements: "选出正确项，并指出③④错在哪里。",
      answerKey: "①②",
      originalAnswer: "③④",
    };
    const audit = auditReviewQuestion(input);
    expect(audit.ok).toBe(false);
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "named-option-verdict", responsibility: "teacher" }),
      expect.objectContaining({ code: "targeted-wrong-subset" }),
    ]));
    const rewritten = rewriteReviewQuestion(input, audit);
    expect(rewritten).toMatchObject({ rewritten: true, manualRewriteRequired: false, audit: { ok: true } });
    expect(rewritten.draft.requirements).toBe("请选择，并简述判断依据。");
  });

  it("拦截正确项数量与答案结构泄露", () => {
    const countLeak = auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "请选择两个正确选项。",
      answerKey: "①②",
    });
    expect(countLeak.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "correct-count-disclosed" })]));

    const structureLeak = auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      hints: "提示：正确项是①②。",
      answerKey: "①②",
    });
    expect(structureLeak.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      "preanswer-hint-present",
      "answer-structure-disclosed",
    ]));
  });

  it("回放 2026-08-03 监护题：决定答案的事实被加粗时必须失败", () => {
    const polluted = auditReviewQuestion({
      questionType: "single-choice",
      stem: [
        "【单选题】甲的父母均已死亡，下列亲属中谁应优先担任监护人？",
        "A. 姐姐，**患严重精神障碍**",
        "B. 哥哥，**无业**",
        "C. 弟弟，**在读研究生**",
        "D. 祖父，能够履行监护职责",
      ].join("\n"),
      requirements: "请选择，并简述判断依据。",
      answerKey: "D",
    });

    expect(polluted).toMatchObject({ ok: false, displayAllowed: false });
    expect(polluted.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "answer-salience-markup", field: "stem", responsibility: "teacher" }),
    ]));
  });

  it("同样拦截 HTML 粗体与下划线，不把格式换皮当成干净题面", () => {
    for (const marked of ["<b>无业</b>", "<u>在读研究生</u>", "<span style=\"font-weight:700\">严重精神障碍</span>"]) {
      const audit = auditReviewQuestion({
        questionType: "single-choice",
        stem: `【单选题】下列事实中应优先审查的是：\nA. ${marked}\nB. 能履职`,
        answerKey: "B",
      });
      expect(audit.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "answer-salience-markup" })]));
    }
  });

  it("拦截在附加追问中只点名正确项或复现原错答案", () => {
    expect(auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "回答后比较①②的规范依据。",
      answerKey: "①②",
    }).violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "targeted-answer-subset" })]));

    expect(auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "不要沿用上次选择的③④。",
      answerKey: "①②",
      originalAnswer: "③④",
    }).violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "original-answer-disclosed" })]));

    expect(auditReviewQuestion({
      questionType: "non-choice",
      stem: "甲实施某行为，应如何定性？",
      requirements: "请独立作答。上次你回答：甲成立犯罪中止并应当减轻处罚。",
      answerKey: "甲成立犯罪未遂并可以从轻或者减轻处罚",
      originalAnswer: "甲成立犯罪中止并应当减轻处罚",
    }).violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "original-answer-disclosed" })]));
  });

  it("正常的‘选择并说明理由’通过，不把要求逐项判断全部选项误拦截", () => {
    expect(auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "请选择，并简述判断依据。",
      answerKey: "①②",
    })).toMatchObject({ ok: true, action: "allow", displayAllowed: true });

    expect(auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "请逐项判断①至④并说明理由。",
      answerKey: "①②",
    }).ok).toBe(true);

    const latinStem = [
      "【单选题】下列说法正确的是：",
      "A. 甲说法",
      "B. 乙说法",
    ].join("\n");
    expect(auditReviewQuestion({
      questionType: "single-choice",
      stem: latinStem,
      requirements: "Please choose and explain the reason.",
      answerKey: "A",
    }).ok).toBe(true);

    expect(auditReviewQuestion({
      questionType: "multiple-choice",
      stem: latinStem.replace("【单选题】", "【多选题】"),
      requirements: "请选择，并简述判断依据。",
      answerKey: "AB",
    }).ok).toBe(true);
  });

  it("单选/多选必须显式标注，且 Gate 缺教练侧答案键时拒绝放行", () => {
    const missingLabel = auditReviewQuestion({
      questionType: "single-choice",
      stem: "下列说法正确的是：\nA.甲\nB.乙",
      answerKey: "A",
    });
    expect(missingLabel.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-choice-label" })]));

    const missingKey = auditReviewQuestion({
      questionType: "multiple-choice",
      stem,
      requirements: "请选择，并简述判断依据。",
    });
    expect(missingKey.violations).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing-answer-key" })]));
  });

  it("漏检后的 void 只归责教练，不计用户错误、有效题量或冷却", () => {
    expect(invalidReviewDisposition("追问点名错误项")).toEqual(expect.objectContaining({
      result: "void",
      variantKind: "invalid",
      promptIntegrity: "invalid",
      cold: false,
      responsibility: "teacher",
      countAsValidAttempt: false,
      countAsUserError: false,
      advanceCooldown: false,
      closeSchedule: false,
    }));
  });
});
