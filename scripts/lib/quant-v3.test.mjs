import { describe, expect, it } from "vitest";
import { buildQuantV3, createChapterDetector, scoreEnglishV3, scoreSubjectV3 } from "../../src/lib/quant-v3.mjs";

const outline = `◆ 刑法（测试）
第一章 绪论
第三章 犯罪构成：第一节 犯罪客体；第二节 犯罪主体

◆ 民法（测试）
第一章 绪论

◆ 法理（测试）
第一章 绪论

◆ 宪法（测试）
第一章 宪法基本理论

◆ 法制史（测试）
第一章 绪论`;

describe("quant v3 shared core", () => {
  it("保持 dashboard v3.1 的铁律与英语样本闸", () => {
    expect(scoreSubjectV3({ total: 21, chapSteps: [1], outChapters: 0, open: 0, absorbed: 0, repeat: 0 })).toMatchObject({ covered: 1, progress: 5, depth: 2, ability: 1 });
    expect(scoreEnglishV3({ accs: [], papers14d: 0, essays30d: 0, open: 0, absorbed: 0, repeat: 0 }).ability).toBe(0);
    expect(scoreEnglishV3({ accs: [80], papers14d: 1, essays30d: 0, open: 0, absorbed: 0, repeat: 0 }).ability)
      .toBeLessThan(scoreEnglishV3({ accs: [80, 80, 80, 80], papers14d: 4, essays30d: 0, open: 0, absorbed: 0, repeat: 0 }).ability);
  });

  it("章节识别优先受控标签，原话只作长标题降级", () => {
    const detect = createChapterDetector(outline);
    expect([...detect("刑法", "犯罪构成", "")]).toEqual([3]);
    expect([...detect("刑法", "自定义标签", "今天学了犯罪主体")]).toEqual([3]);
    expect([...detect("刑法", "第三章", "")]).toEqual([3]);
  });

  it("从同一组流水和错题生成稳定快照", () => {
    const snapshot = buildQuantV3({
      referenceDate: "2026-08-05",
      examOutline: outline,
      logs: [
        { subject: "刑法", chapter: "犯罪构成", activity: "听课", log_date: "2026-08-01" },
        { subject: "刑法", chapter: "犯罪构成", activity: "做题", log_date: "2026-08-02" },
        { subject: "英语", chapter: "阅读", activity: "做题", accuracy: 80, log_date: "2026-08-04" },
      ],
      errors: [
        { subject: "刑法", knowledge: "边界", status: "open", source: "pc" },
        { subject: "刑法", knowledge: "边界", status: "absorbed", source: "pc" },
      ],
    });

    expect(snapshot.version).toBe("3.1");
    expect(snapshot.subjects.find((subject) => subject.subject === "刑法")).toMatchObject({ covered: 1, open: 1, absorbed: 1, repeat: 1 });
    expect(snapshot.overall.english).toMatchObject({ papers14d: 1, reading: 80 });
  });
});
