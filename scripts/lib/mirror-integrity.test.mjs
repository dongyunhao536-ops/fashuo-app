import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMirrorRuleMatches } from "./mirror-integrity.mjs";

describe("mirror integrity", () => {
  it("必需资产缺失时失败，不再静默缩小同步范围", () => {
    expect(() => verifyMirrorRuleMatches({ pattern: "教材/带背/a.txt", required: true }, []))
      .toThrow(/必需镜像资产未匹配/);
  });

  it("精确资产按原始字节校验 sha256", () => {
    const bytes = Buffer.from("带背 OCR\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const match = [{ abs: "virtual.txt", rel: "教材/带背/a.txt" }];
    const result = verifyMirrorRuleMatches(
      { pattern: "教材/带背/a.txt", required: true, sha256 },
      match,
      { readBytes: () => bytes },
    );
    expect(result).toMatchObject({ matched: 1, verified: true, sha256 });
    expect(() => verifyMirrorRuleMatches(
      { pattern: "教材/带背/a.txt", sha256: "0".repeat(64) },
      match,
      { readBytes: () => bytes },
    )).toThrow(/哈希不一致/);
  });
});
