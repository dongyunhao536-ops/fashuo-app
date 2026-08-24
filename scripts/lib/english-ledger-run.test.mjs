// [gpt] 2026-08-12：英语阅读与作文台账必须走各自证据链，防止互相冒签。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEnglishLedgerEntry, verifyEnglishReadingClosure } from "../english-growth.mjs";
import {
  recordAutomaticSkillStep,
  recordManualSkillStep,
  startSkillRun,
} from "./skill-run.mjs";

function harness(name) {
  const directory = mkdtempSync(join(tmpdir(), `english-ledger-${name}-`));
  const file = join(directory, "skill-runs.jsonl");
  const ledgerPath = join(directory, "英语训练台账.md");
  const corpusPath = join(directory, "英语作文语料.md");
  const distractorPath = join(directory, "干扰项实证库.md");
  return { file, ledgerPath, corpusPath, distractorPath };
}

describe("英语训练台账 Run 回执", () => {
  it("作文不需要答案键，但必须有题源、参考标准、无泄题与采分表", () => {
    const test = harness("essay");
    const run = startSkillRun({ skill: "yingyu-pc", runId: "SR-EN-ESSAY", file: test.file });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2024-REPLY", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "作文十年题库:2024", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "reference_answer_checked", evidenceRef: "考研评分档", file: test.file });
    recordAutomaticSkillStep({ runId: run.runId, step: "question_integrity_pass", source: "question-integrity", artifactHash: "a".repeat(64), artifactLength: 20, file: test.file });
    writeFileSync(test.ledgerPath, `## 2026-08-12｜作文｜2024 小作文
- **会话键**：EN-20260812-W-2024-REPLY
- **诊断依据**：考研评分档
- **载体**：回信
- **得分**：7/10
- **证据锚点**：题干两问；首稿逐项核对
`, "utf8");
    expect(() => verifyEnglishLedgerEntry({ runId: run.runId, session: "EN-20260812-W-2024-REPLY", ledgerPath: test.ledgerPath, runFile: test.file })).toThrow(/rubric_applied/);
    recordManualSkillStep({ runId: run.runId, step: "rubric_applied", evidenceRef: "scorecard:7/10", file: test.file });
    const verified = verifyEnglishLedgerEntry({ runId: run.runId, session: "EN-20260812-W-2024-REPLY", ledgerPath: test.ledgerPath, runFile: test.file });
    expect(verified.run.steps).toMatchObject({ ledger_validated: { status: "pass" } });
    expect(verified.run.steps.answer_key_checked).toBeUndefined();
  });

  it("阅读台账不能绕过本地答案键回执", () => {
    const test = harness("reading");
    const run = startSkillRun({ skill: "yingyu-pc", runId: "SR-EN-READING", file: test.file });
    recordAutomaticSkillStep({ runId: run.runId, step: "context_loaded", source: "test", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2016-T1", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "2016卷", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "reading_page_verified", evidenceRef: "净卷页", file: test.file });
    writeFileSync(test.ledgerPath, `## 2026-08-12｜阅读｜2016 Text 1
- **会话键**：EN-20260812-R-2016-T1
- **诊断依据**：答案键+原文
- **得分**：4/5
- **证据锚点**：Q21-Q25 原文定位
`, "utf8");
    expect(() => verifyEnglishLedgerEntry({ runId: run.runId, session: "EN-20260812-R-2016-T1", ledgerPath: test.ledgerPath, runFile: test.file })).toThrow(/answer_key_checked/);
  });

  it("阅读收口强制核验犹豫题实证、2–3 条作文语料和生命周期", () => {
    const test = harness("reading-close");
    const run = startSkillRun({ skill: "yingyu-pc", runId: "SR-EN-READING-CLOSE", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "target_frozen", evidenceRef: "2017-T1", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "source_checked", evidenceRef: "2017卷", file: test.file });
    recordManualSkillStep({ runId: run.runId, step: "reading_page_verified", evidenceRef: "净卷页", file: test.file });
    recordAutomaticSkillStep({ runId: run.runId, step: "answer_key_checked", source: "test", evidenceRef: `reading:2017:T1:score=5/5:key=${"a".repeat(12)}:paper=${"b".repeat(12)}`, file: test.file });
    writeFileSync(test.ledgerPath, `## 2026-08-12｜阅读｜2017 Text 1
- **会话键**：EN-20260812-R-2017-T1
- **诊断依据**：答案键+原文
- **得分**：5/5
- **证据锚点**：Q25 C·偏向，主旨范围判断正确
- **生命周期动作**：本场无错题；Q25 仅留训练证据
`, "utf8");
    verifyEnglishLedgerEntry({ runId: run.runId, session: "EN-20260812-R-2017-T1", ledgerPath: test.ledgerPath, runFile: test.file });
    writeFileSync(test.corpusPath, `## D3. 从阅读薅来的可挪用句式

**2026-08-12 · 2017 Text 1**
- 🌱 句式一
  \`There is one step ______ could take: ______.\`
- 🌱 句式二
  \`This allows ______ to focus on ______.\`
`, "utf8");
    writeFileSync(test.distractorPath, `## 2017 · Text 1 · 安检排队

### Q25 Which title is best? → **[C]**
- D 只覆盖末段现象，不能代表全文。
`, "utf8");

    expect(() => verifyEnglishReadingClosure({
      runId: run.runId,
      session: "EN-20260812-R-2017-T1",
      reviewQuestions: ["none"],
      ledgerPath: test.ledgerPath,
      corpusPath: test.corpusPath,
      distractorPath: test.distractorPath,
      runFile: test.file,
    })).toThrow(/犹豫题/);

    const verified = verifyEnglishReadingClosure({
      runId: run.runId,
      session: "EN-20260812-R-2017-T1",
      reviewQuestions: ["Q25"],
      ledgerPath: test.ledgerPath,
      corpusPath: test.corpusPath,
      distractorPath: test.distractorPath,
      runFile: test.file,
    });
    expect(verified.phraseCount).toBe(2);
    expect(verified.run.steps).toMatchObject({
      reading_artifacts_verified: { status: "pass" },
      lifecycle_checked: { status: "pass" },
    });
  });
});
