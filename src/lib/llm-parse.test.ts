import { describe, it, expect } from "vitest";
import { parseGeneratedQuestion, parseGradeJson } from "./detection";
import { blocks, bullets } from "./yixiao";
import { splitMeta } from "./ask-prompt";

/**
 * LLM 输出解析器回归锁（云 2026-06-14）。
 * 这些是"模型漂移→静默坏"的高风险面（历史踩过：答案要点括号、Opus 用 ASCII 引号破坏 JSON）。
 * 纯函数、零 IO，把已修的坑钉死，防回归。
 */

describe("parseGeneratedQuestion（出题解析）", () => {
  it("标准格式：抽出题干 + 要点（剥项目符号）", () => {
    const raw = `题目：简述正当防卫的概念及其成立条件
参考答案要点（4-6 条，命中其中 ≥3 条算通过）：
- 正当防卫的概念
- 起因条件：存在不法侵害
- 时间条件：正在进行
教材锚点：P12·行345`;
    const { question, answerKey } = parseGeneratedQuestion(raw);
    expect(question).toBe("简述正当防卫的概念及其成立条件");
    expect(answerKey).toHaveLength(3);
    expect(answerKey[0]).toBe("正当防卫的概念");
    expect(answerKey).toContain("起因条件：存在不法侵害"); // 内部冒号不被剥
  });

  it("标签后带括号说明再接冒号（bee3c08 修过的坑）也能吃到要点", () => {
    const raw = `题目：什么是连续犯
参考答案要点（逐条短句）：
1. 基于同一犯罪故意
2. 连续多次实施
教材锚点：`;
    const { answerKey } = parseGeneratedQuestion(raw);
    expect(answerKey).toEqual(["基于同一犯罪故意", "连续多次实施"]); // 数字编号被剥
  });

  it("无要点段：answerKey 为空、question 兜底为全文", () => {
    const { question, answerKey } = parseGeneratedQuestion("一段没有规范结构的输出");
    expect(answerKey).toEqual([]);
    expect(question).toBe("一段没有规范结构的输出");
  });
});

describe("parseGradeJson（评分 JSON 解析）", () => {
  it("干净 JSON 全字段解析", () => {
    const r = parseGradeJson(
      `{"grade":"干净通过","hits":["概念准确"],"missing":[],"confidence":92,"starred":false,"grep_lines":[1983,2052],"explanation":"命中核心要点"}`,
    );
    expect(r.grade).toBe("干净通过");
    expect(r.confidence).toBe(92);
    expect(r.grep_lines).toEqual([1983, 2052]);
  });

  it("JSON 外裹前后杂文也能抽出", () => {
    const r = parseGradeJson(`好的，评分如下：\n{"grade":"未过","missing":["定性错误"]}\n谢谢`);
    expect(r.grade).toBe("未过");
    expect(r.missing).toEqual(["定性错误"]);
  });

  it("非法 grade 值回落到「勉强」（不放水也不误判通过）", () => {
    const r = parseGradeJson(`{"grade":"通过","confidence":80}`);
    expect(r.grade).toBe("勉强");
  });

  it("完全不是 JSON → fallback（勉强 + starred 标★ + 留原文片段）", () => {
    const r = parseGradeJson("模型今天抽风没给 JSON");
    expect(r.grade).toBe("勉强");
    expect(r.starred).toBe(true);
    expect(r.explanation).toContain("未返回合法 JSON");
  });

  it("grep_lines 混入字符串/非数字 → 仅留有限数字", () => {
    const r = parseGradeJson(`{"grade":"未过","grep_lines":["12","x",34,null]}`);
    expect(r.grep_lines).toEqual([12, 34]);
  });
});

describe("blocks / bullets（易混对决解析）", () => {
  it("blocks 按 ===KEY=== 切段", () => {
    const raw = `===GRADE===
未过
===HITS===
- 选对了概念
===MISSING===
- 没说出关键区分 test
===EXPLANATION===
核心在「不特定多数人」`;
    const b = blocks(raw, ["GRADE", "HITS", "MISSING", "EXPLANATION"]);
    expect(b.GRADE).toBe("未过");
    expect(b.EXPLANATION).toContain("不特定多数人");
  });

  it("bullets 剥符号 + 过滤过短/过长", () => {
    expect(bullets("- 要点一\n* 要点二\n·\n   ")).toEqual(["要点一", "要点二"]);
  });
});

describe("splitMeta（答疑 META 抽取）", () => {
  it("正常抽出展示文本 + meta", () => {
    const { clean, meta } = splitMeta(
      `答案正文部分。\n\n<<<ASK_META\n{"subject":"民法","confidence":82,"weak_candidates":[]}\nASK_META>>>`,
    );
    expect(clean).toBe("答案正文部分。");
    expect(meta?.subject).toBe("民法");
    expect(meta?.confidence).toBe(82);
  });

  it("模型用 ```json 包裹 META 也能解析", () => {
    const { meta } = splitMeta('正文\n<<<ASK_META\n```json\n{"subject":"刑法"}\n```\nASK_META>>>');
    expect(meta?.subject).toBe("刑法");
  });

  it("无 META 块 → meta=null，clean=全文", () => {
    const { clean, meta } = splitMeta("纯答案没有元数据");
    expect(meta).toBeNull();
    expect(clean).toBe("纯答案没有元数据");
  });

  it("META 坏掉 → meta=null 但保住展示正文（不连答案一起丢）", () => {
    const { clean, meta } = splitMeta("正文在此\n<<<ASK_META\n{坏的 json\nASK_META>>>");
    expect(meta).toBeNull();
    expect(clean).toBe("正文在此");
  });

  it("缺失闭合标记也能解析到结尾", () => {
    const { meta } = splitMeta('正文\n<<<ASK_META\n{"subject":"宪法"}');
    expect(meta?.subject).toBe("宪法");
  });
});
