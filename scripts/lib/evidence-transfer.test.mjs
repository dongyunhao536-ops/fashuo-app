// [gpt] 2026-08-10：迁移等级与考试环境的共享契约测试。
import { describe, expect, it } from "vitest";
import { normalizeTransferMetadata } from "./evidence-transfer.mjs";

describe("evidence transfer metadata", () => {
  it("按变式固定维度与迁移等级", () => {
    expect(normalizeTransferMetadata({
      dimension: "application",
      result: "pass",
      variantKind: "novel_case",
      transferLevel: 4,
    })).toEqual({
      variantKind: "novel_case",
      transferLevel: 4,
      assessmentContext: "practice",
      durationSeconds: null,
    });
    expect(() => normalizeTransferMetadata({
      dimension: "recall",
      result: "pass",
      variantKind: "novel_case",
      transferLevel: 4,
    })).toThrow("dimension 必须是 application");
    expect(() => normalizeTransferMetadata({
      dimension: "application",
      result: "pass",
      variantKind: "novel_case",
      transferLevel: 3,
    })).toThrow("transferLevel 必须是 4");
  });

  it("变式与等级必须成对出现", () => {
    expect(() => normalizeTransferMetadata({ dimension: "application", result: "pass", variantKind: "novel_case" })).toThrow("必须成对提供");
    expect(() => normalizeTransferMetadata({ dimension: "application", result: "pass", transferLevel: 4 })).toThrow("必须成对提供");
  });

  it("限时与成套模考必须留时长，普通练习可不留", () => {
    expect(() => normalizeTransferMetadata({ dimension: "application", result: "pass", assessmentContext: "timed" })).toThrow("必须记录 durationSeconds");
    expect(normalizeTransferMetadata({
      dimension: "application",
      result: "pass",
      assessmentContext: "full_mock",
      durationSeconds: 9000,
    })).toMatchObject({ assessmentContext: "full_mock", durationSeconds: 9000 });
  });

  it("作废题语义不能与普通通过混用", () => {
    expect(() => normalizeTransferMetadata({
      dimension: "application",
      result: "pass",
      promptIntegrity: "clean",
      variantKind: "invalid",
      transferLevel: 0,
    })).toThrow("作废复检必须同时使用");
  });
});
