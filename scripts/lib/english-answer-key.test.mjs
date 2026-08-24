// [gpt] 2026-08-12：英语阅读答案键机器判分回归。

import { describe, expect, it } from "vitest";
import { gradeEnglishReading, parseEnglishReadingAnswerKey, shortContentHash } from "./english-answer-key.mjs";

const KEY = `
| 年份 | 21-25 | 26-30 | 31-35 | 36-40 |
|------|-------|-------|-------|-------|
| 2016 | A D D C D | A D C A C | B C D A B | A B B C B |
| 2016 | 法国禁瘦模特法案 | 英国乡村保护 | 出版业与学术 | 报业衰落 |
`;

describe("英语阅读答案键", () => {
  it("按本地表格的篇号和题号判分", () => {
    expect(parseEnglishReadingAnswerKey(KEY)[2016][0]).toEqual(["A", "D", "D", "C", "D"]);
    const grade = gradeEnglishReading({ answerKeyMarkdown: KEY, year: 2016, text: 2, answers: "A,D,B,A,C" });
    expect(grade).toMatchObject({ firstQuestion: 26, lastQuestion: 30, score: 4, maximum: 5 });
    expect(grade.items.find((item) => !item.correct)).toMatchObject({ question: 28, answer: "B", expected: "C" });
  });

  it("拒绝缺题、非法篇号和不存在年份", () => {
    expect(() => gradeEnglishReading({ answerKeyMarkdown: KEY, year: 2016, text: 1, answers: "ADDC" })).toThrow(/5 个/);
    expect(() => gradeEnglishReading({ answerKeyMarkdown: KEY, year: 2016, text: 5, answers: "ADDCB" })).toThrow(/1-4/);
    expect(() => gradeEnglishReading({ answerKeyMarkdown: KEY, year: 2025, text: 1, answers: "ADDCB" })).toThrow(/没有/);
  });

  it("证据只保存内容短哈希", () => {
    expect(shortContentHash(KEY)).toMatch(/^[a-f0-9]{12}$/u);
  });
});
