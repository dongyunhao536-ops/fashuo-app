// [gpt] 2026-08-11：锁定同步与本地检索共用的白名单、排除、封存和哈希边界。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expandMirrorScope } from "./mirror-scope.mjs";

function fakeGlob(listings) {
  return (pattern) => (async function* generate() {
    for (const entry of listings.get(pattern) ?? []) yield entry;
  }());
}

describe("expandMirrorScope", () => {
  it("保留白名单且排除显式规则、当年净卷和年份未知净卷", async () => {
    const config = {
      root: "C:\\archive",
      sealedExamFromYear: 2025,
      excludedPatterns: ["易混概念库/草稿*.md"],
      rules: [
        { pattern: "教材/*.txt", kind: "textbook" },
        { pattern: "真题/_文本/*.txt", kind: "exam" },
        { pattern: "易混概念库/*.md", kind: "yixiao" },
      ],
    };
    const listings = new Map([
      ["教材/*.txt", ["教材/考试分析_文本.txt"]],
      ["真题/_文本/*.txt", [
        "真题/_文本/2024年法律硕士专业基础.txt",
        "真题/_文本/2025年法律硕士专业基础.txt",
        "真题/_文本/年份未知法律硕士专业基础.txt",
      ]],
      ["易混概念库/*.md", ["易混概念库/刑法-共同犯罪.md", "易混概念库/草稿-刑法.md"]],
    ]);

    const result = await expandMirrorScope(config, { globFiles: fakeGlob(listings) });

    expect(result.files.map((file) => file.rel).sort()).toEqual([
      "教材/考试分析_文本.txt",
      "易混概念库/刑法-共同犯罪.md",
      "真题/_文本/2024年法律硕士专业基础.txt",
    ].sort());
    expect(result.excluded.map((file) => file.rel).sort()).toEqual([
      "易混概念库/草稿-刑法.md",
      "真题/_文本/2025年法律硕士专业基础.txt",
      "真题/_文本/年份未知法律硕士专业基础.txt",
    ].sort());
  });

  it("必需资产仍按原始字节做 sha256 校验", async () => {
    const bytes = Buffer.from("固定材料", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const config = {
      root: "C:\\archive",
      rules: [{
        pattern: "教材/带背/刑法.txt",
        kind: "textbook",
        required: true,
        sha256,
      }],
    };

    const result = await expandMirrorScope(config, {
      globFiles: fakeGlob(new Map([["教材/带背/刑法.txt", ["教材/带背/刑法.txt"]]])),
      readBytes: () => bytes,
    });

    expect(result.verified).toEqual([expect.objectContaining({ verified: true, sha256 })]);
  });

  it("必需资产缺失时失败，不把材料缺口伪装成零命中", async () => {
    await expect(expandMirrorScope({
      root: "C:\\archive",
      rules: [{ pattern: "教材/带背/刑法.txt", kind: "textbook", required: true }],
    }, { globFiles: fakeGlob(new Map()) })).rejects.toThrow("必需镜像资产未匹配");
  });
});
