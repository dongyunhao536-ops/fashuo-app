// [gpt] 2026-08-26：带背母版快路径必须验证现役版本、考试分析锚点与 Run 科目，
// 不能为省一次检索把任意 Markdown 冒充材料证据。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindDaibeiTemplateMaterials,
  loadDaibeiAnswerTemplate,
  parseDaibeiAnswerTemplates,
} from "./daibei-answer-template.mjs";
import { startSkillRun } from "./skill-run.mjs";

const ENTRY = "法理｜第八章 法律实施｜第三节 司法｜司法责任原则";

function markdown({ anchor = "《考试分析》法理学，第八章第三节；本地文本第 370 行；纸书页码 42" } = {}) {
  return `# 带背标准答案母版

## ${ENTRY}

- 状态：现役 v1
- 标准设问：简述司法责任原则的核心要求。
- 原文锚点：${anchor}
- A0 固定核心（第 1 轮）：司法责任原则要求权力与责任相统一。
- A1（第 2 轮）：补充说明。
- A2（第 3 轮 A）：未开放。
- A3（第 3 轮 B）：未开放。
`;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "daibei-template-"));
  const templateFile = join(dir, "answers.md");
  const runFile = join(dir, "runs.jsonl");
  writeFileSync(templateFile, markdown(), "utf8");
  return { templateFile, runFile };
}

describe("带背标准答案母版快路径", () => {
  it("解析现役 A0 与已开放增量层，未开放层不进入答案", () => {
    const entry = parseDaibeiAnswerTemplates(markdown()).get(ENTRY);
    expect(entry.subject).toBe("法理");
    expect(entry.answerText).toContain("权力与责任相统一");
    expect(entry.answerText).toContain("补充说明");
    expect(entry.answerText).not.toContain("未开放");
    expect(entry.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("缺《考试分析》、页码或行号时拒绝把母版冒充权威材料", () => {
    expect(() => parseDaibeiAnswerTemplates(markdown({ anchor: "讲义第八章" }))).toThrow(/原文锚点不完整/u);
  });

  it("母版不存在时明确要求章节级 material-batch 回源", () => {
    const { templateFile } = harness();
    expect(() => loadDaibeiAnswerTemplate("法理｜不存在", { file: templateFile })).toThrow(/material-batch/u);
  });

  it("现役母版可自动签 daibei materials_checked，并绑定模板 hash", () => {
    const { templateFile, runFile } = harness();
    const template = loadDaibeiAnswerTemplate(ENTRY, { file: templateFile });
    const run = startSkillRun({
      skill: "daibei-pc",
      subject: "法理",
      kind: "question",
      targetRef: "司法责任原则",
      entryMode: "direct",
      file: runFile,
      runId: "SR-DAIBEI-TEMPLATE",
    });
    const bound = bindDaibeiTemplateMaterials({ runId: run.runId, template, runFile });
    expect(bound.steps.materials_checked.source).toBe("daibei-answer-template");
    expect(bound.steps.materials_checked.referenceHash).toBe(template.hash);
    expect(bound.steps.materials_checked.evidenceRef).toContain("template:法理");
  });

  it("母版科目与 Run 不一致时拒绝签回执", () => {
    const { templateFile, runFile } = harness();
    const template = loadDaibeiAnswerTemplate(ENTRY, { file: templateFile });
    const run = startSkillRun({
      skill: "daibei-pc",
      subject: "刑法",
      kind: "question",
      targetRef: "司法责任原则",
      entryMode: "direct",
      file: runFile,
      runId: "SR-DAIBEI-MISMATCH",
    });
    expect(() => bindDaibeiTemplateMaterials({ runId: run.runId, template, runFile })).toThrow(/科目与 Run 不一致/u);
  });
});
