import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildKnowledgeBaseline,
  collectArchiveInventory,
  formatKnowledgeBaselineMarkdown,
  isAnkiPath,
  isExcludedArchivePath,
  isSealedExamArchivePath,
  matchesGlob,
  normalizeArchivePath,
  shouldFingerprintPath,
} from "./knowledge-baseline.mjs";

const tempDirectories = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureFile(path, bytes, mtimeUtc = "2026-08-04T00:00:00.000Z", sha256) {
  return { path, bytes, mtimeUtc, ...(sha256 ? { sha256 } : {}) };
}

function fixtureConfig() {
  return {
    root: "D:\\fashuo",
    rules: [
      { pattern: "教材/考试分析_文本.txt", kind: "textbook" },
      { pattern: "法律更新档案/01_*.md", kind: "textbook" },
      { pattern: "易混概念库/刑法-*.md", kind: "yixiao" },
    ],
  };
}

function buildFixture(files) {
  return buildKnowledgeBaseline({
    archiveRoot: "D:\\fashuo",
    configPath: "D:\\fashuo-app\\config\\mirror-scope.json",
    configSha256: "config-digest",
    config: fixtureConfig(),
    files,
    scan: {
      directoryCount: 7,
      hiddenDirectoryCount: 1,
      symbolicLinkCount: 0,
      otherEntryCount: 0,
    },
  });
}

describe("knowledge baseline path matching", () => {
  it("normalizes Windows paths and keeps * inside one segment", () => {
    expect(normalizeArchivePath(".\\易混概念库\\刑法-01.md")).toBe(
      "易混概念库/刑法-01.md",
    );
    expect(matchesGlob("易混概念库\\刑法-01.md", "易混概念库/刑法-*.md")).toBe(true);
    expect(matchesGlob("易混概念库/子目录/刑法-01.md", "易混概念库/刑法-*.md")).toBe(false);
    expect(matchesGlob("真题/_文本/a.txt", "真题/**/a.txt")).toBe(true);
  });

  it("identifies only archive Anki assets, not arbitrary dependency names", () => {
    expect(isAnkiPath("【DYL】考试分析重新排版311.apkg")).toBe(true);
    expect(isAnkiPath("考点库/anki_extracted.json")).toBe(true);
    expect(isAnkiPath("node_modules/example/anki-helper.js")).toBe(false);
    expect(shouldFingerprintPath("法律更新档案/03_宪法.md", [])).toBe(true);
    expect(
      isExcludedArchivePath("真题/_文本/2025年综合.txt", [
        "真题/_文本/2025年*.txt",
      ]),
    ).toBe(true);
    expect(isSealedExamArchivePath("真题/_文本/2024年综合.txt", 2025)).toBe(false);
    expect(isSealedExamArchivePath("真题/_文本/2025年综合.txt", 2025)).toBe(true);
    expect(isSealedExamArchivePath("真题/_文本/待确认年份综合.txt", 2025)).toBe(true);
  });
});

describe("buildKnowledgeBaseline", () => {
  const files = [
    fixtureFile("教材/考试分析_文本.txt", 100, undefined, "a".repeat(64)),
    fixtureFile("法律更新档案/01_刑法相关更新.md", 20, undefined, "b".repeat(64)),
    fixtureFile("法律更新档案/03_宪法行政法相关更新.md", 30, undefined, "c".repeat(64)),
    fixtureFile(
      "真题/2025年全国硕士研究生招生考试法律硕士综合(非法学)试题及参考答案解析.pdf",
      40,
      undefined,
      "d".repeat(64),
    ),
    fixtureFile(
      "真题/_文本/2025年全国硕士研究生招生考试法律硕士综合(非法学)试题及参考答案解析.txt",
      50,
      undefined,
      "e".repeat(64),
    ),
    fixtureFile("【DYL】考试分析重新排版311.apkg", 60, undefined, "f".repeat(64)),
    fixtureFile("考点库/anki_extracted.json", 70, undefined, "0".repeat(64)),
    fixtureFile(".hidden/audit-note.md", 80),
  ];

  it("reports source coverage and the three critical scope gaps", () => {
    const report = buildFixture(files);

    expect(report.tree).toMatchObject({
      fileCount: 8,
      bytes: 450,
      hiddenFileCount: 1,
      fingerprintedFileCount: 7,
    });
    expect(report.scope).toMatchObject({
      matchedRuleCount: 2,
      missingRuleCount: 1,
      uniqueFileCount: 2,
    });
    expect(report.scope.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.scope.missingPatterns).toEqual([
      { index: 3, pattern: "易混概念库/刑法-*.md", kind: "yixiao" },
    ]);

    const legal = report.gaps.find((gap) => gap.id === "legal-updates");
    expect(legal).toMatchObject({
      status: "partial",
      foundFileCount: 2,
      scopedFileCount: 1,
      unscopedFileCount: 1,
    });

    const exams = report.gaps.find((gap) => gap.id === "past-exam-originals");
    expect(exams).toMatchObject({
      status: "uncovered",
      foundFileCount: 2,
      unscopedFileCount: 2,
      details: {
        pdfCount: 1,
        extractedTextCount: 1,
        detectedYears: [2025],
        pairedPdfAndTextCount: 1,
      },
    });

    const anki = report.gaps.find((gap) => gap.id === "anki");
    expect(anki).toMatchObject({
      status: "uncovered",
      foundFileCount: 2,
      unscopedFileCount: 2,
    });
  });

  it("is byte-for-byte deterministic regardless of input file order", () => {
    const forward = buildFixture(files);
    const reversed = buildFixture([...files].reverse());
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(reversed.reportSha256).toBe(forward.reportSha256);
  });

  it("renders a concise Markdown summary with exact gap names", () => {
    const markdown = formatKnowledgeBaselineMarkdown(buildFixture(files), { pathLimit: 1 });
    expect(markdown).toContain("# 知识基线审计");
    expect(markdown).toContain("真题原卷与提取文本");
    expect(markdown).toContain("Anki 牌组与提取数据");
    expect(markdown).toContain("法律更新档案");
    expect(markdown).toContain("用 `--json` 查看完整清单");
  });

  it("keeps sealed exam text out of scope and reports it as intentional", () => {
    const config = {
      root: "D:\\fashuo",
      sealedExamFromYear: 2025,
      rules: [{ pattern: "真题/_文本/*.txt", kind: "exam" }],
    };
    const report = buildKnowledgeBaseline({
      archiveRoot: "D:\\fashuo",
      configPath: "D:\\fashuo-app\\config\\mirror-scope.json",
      configSha256: "config-digest",
      config,
      files: [
        fixtureFile(
          "真题/_文本/2024年全国硕士研究生招生考试法律硕士综合(非法学)试题及参考答案解析.txt",
          40,
          undefined,
          "1".repeat(64),
        ),
        fixtureFile(
          "真题/_文本/2025年全国硕士研究生招生考试法律硕士综合(非法学)试题及参考答案解析.txt",
          50,
          undefined,
          "2".repeat(64),
        ),
      ],
    });

    expect(report.scope.uniqueFileCount).toBe(1);
    expect(report.scope.exclusions).toMatchObject({ fileCount: 1, bytes: 50 });
    expect(report.scope.exclusions.sealedExamFromYear).toBe(2025);
    const exams = report.gaps.find((gap) => gap.id === "past-exam-originals");
    expect(exams).toMatchObject({
      status: "covered",
      foundFileCount: 2,
      eligibleFileCount: 1,
      excludedFileCount: 1,
      scopedFileCount: 1,
      unscopedFileCount: 0,
    });
  });
});

describe("collectArchiveInventory", () => {
  it("walks hidden directories and hashes only scoped or critical files", async () => {
    const root = mkdtempSync(join(tmpdir(), "fashuo-baseline-"));
    tempDirectories.push(root);
    mkdirSync(join(root, ".hidden"));
    mkdirSync(join(root, "教材"));
    mkdirSync(join(root, "法律更新档案"));
    writeFileSync(join(root, ".hidden", "note.md"), "hidden");
    writeFileSync(join(root, "教材", "考试分析_文本.txt"), "textbook");
    writeFileSync(join(root, "法律更新档案", "03_宪法.md"), "update");
    writeFileSync(join(root, "unrelated.bin"), "unrelated");

    const rules = [{ pattern: "教材/考试分析_文本.txt", kind: "textbook" }];
    const inventory = await collectArchiveInventory(root, rules);
    const byPath = new Map(inventory.files.map((file) => [file.path, file]));

    expect([...byPath.keys()]).toEqual([
      ".hidden/note.md",
      "unrelated.bin",
      "教材/考试分析_文本.txt",
      "法律更新档案/03_宪法.md",
    ]);
    expect(byPath.get("教材/考试分析_文本.txt").sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(byPath.get("法律更新档案/03_宪法.md").sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(byPath.get(".hidden/note.md").sha256).toBeUndefined();
    expect(byPath.get("unrelated.bin").sha256).toBeUndefined();
    expect(inventory.scan.hiddenDirectoryCount).toBe(1);
  });
});
