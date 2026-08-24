// [gpt] 2026-08-13：锁定错题写回的来源、章节、标签与病根机器门槛。
import { describe, expect, it } from "vitest";
import { ErrorEntryValidationError, isLegacyErrorEntry, migrateLegacyErrorEntry, validateErrorEntry } from "./error-entry.mjs";

describe("validateErrorEntry", () => {
  it("把未确认标签和病根规范为显式 pending，而不是要求模型猜测", () => {
    const entry = validateErrorEntry({
      op: "new_error",
      subject: "民法学",
      knowledge: "所有权题误选 C，正确 D",
    }, { entrySource: "batch", chapter: "第十章 所有权" });

    expect(entry).toMatchObject({
      subject: "民法",
      chapter: "第十章 所有权",
      entrySource: "batch",
      topic: null,
      entryState: {
        classificationStatus: "pending",
        diagnosisStatus: "pending",
        rootCauseCode: "unclassified",
        chapterStatus: "explicit",
      },
    });
  });

  it("confirmed 病根必须有具体代码和认领说明", () => {
    expect(() => validateErrorEntry({
      subject: "刑法",
      knowledge: "遗漏例外",
      entrySource: "direct",
      chapter: "犯罪论",
      topic: {
        title: "违法阻却事由的例外",
        classificationStatus: "confirmed",
        diagnosisStatus: "confirmed",
        rootCauseCode: "unclassified",
      },
    })).toThrow(ErrorEntryValidationError);

    try {
      validateErrorEntry({
        subject: "刑法",
        knowledge: "遗漏例外",
        entrySource: "direct",
        chapter: "犯罪论",
        topic: {
          title: "违法阻却事由的例外",
          classificationStatus: "confirmed",
          diagnosisStatus: "confirmed",
          rootCauseCode: "unclassified",
        },
      });
    } catch (error) {
      expect(error.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        "confirmed_cause_unclassified",
        "confirmed_cause_note_missing",
      ]));
    }
  });

  it("单条新错缺来源或章节时用结构化错误拒绝写入", () => {
    try {
      validateErrorEntry({ subject: "宪法", knowledge: "权限主体看错", entrySource: "direct" });
      throw new Error("预期校验失败");
    } catch (error) {
      expect(error.code).toBe("ERROR_ENTRY_INVALID");
      expect(error.issues.map((item) => item.code)).toContain("chapter_missing");
    }

    expect(() => validateErrorEntry({ subject: "宪法", knowledge: "权限主体看错", chapter: "国家机构" }))
      .toThrow(/entry_source_invalid/);
  });

  it("复发条目允许章节由源事件主题继承，但必须显式连 recurOf", () => {
    expect(validateErrorEntry({
      subject: "法理",
      knowledge: "法律关系客体再次混淆",
      recurOf: 81,
      entrySource: "recurrence",
    })).toMatchObject({
      recurOf: 81,
      chapter: null,
      entryState: { chapterStatus: "inherit" },
    });

    expect(() => validateErrorEntry({
      subject: "法理",
      knowledge: "法律关系客体再次混淆",
      entrySource: "recurrence",
    })).toThrow(/recurrence_source_missing_id/);
  });

  it("只在最终边界显式迁移旧 outbox，不放宽新写入契约", () => {
    const raw = { op: "new_error", subject: "刑法", knowledge: "旧缓冲" };
    expect(isLegacyErrorEntry(raw)).toBe(true);
    const legacy = migrateLegacyErrorEntry(raw);
    expect(isLegacyErrorEntry(legacy)).toBe(false);
    expect(validateErrorEntry(legacy)).toMatchObject({
      entrySource: "direct",
      chapter: "历史待补章节",
      entryState: { classificationStatus: "pending" },
    });
  });
});
