import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ASK_SCRIPT = fileURLToPath(new URL("./ask.mjs", import.meta.url));

function run(cwd, args) {
  return execFileSync(process.execPath, [ASK_SCRIPT, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

// [gpt] 2026-08-10：覆盖 PC ask 命令到可靠 outbox 的真实参数链，不连接远端数据库。
describe("ask CLI", () => {
  it("带 KP 新增卡点与理解验证可纯本地 stage，并保留证据字段", () => {
    const directory = mkdtempSync(join(tmpdir(), "ask-cli-"));
    try {
      run(directory, [
        "add", "--subject", "刑法", "--confusion", "未遂边界仍混淆",
        "--kp", "XF-0054", "--evidence", "fail", "--anchor", "考试分析未遂章节", "--stage",
      ]);
      run(directory, [
        "verify", "55", "pass", "--kp", "XF-0054", "--anchor", "变式题#2",
        "--note", "无提示讲清规则和边界", "--cold", "--stage",
      ]);

      const operations = readFileSync(join(directory, ".local", "cuoti-pending.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(operations).toHaveLength(2);
      expect(operations[0]).toMatchObject({
        op: "ask_point", kpId: "XF-0054", initialUnderstanding: "fail", evidenceAnchor: "考试分析未遂章节",
      });
      expect(operations[1]).toMatchObject({
        op: "ask_verification", pointId: 55, kpId: "XF-0054", result: "pass",
        promptIntegrity: "clean", cold: true, evidenceAnchor: "变式题#2", note: "无提示讲清规则和边界",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("拒绝直接 clarified，也拒绝把无效题面记成非 void", () => {
    const directory = mkdtempSync(join(tmpdir(), "ask-cli-guard-"));
    try {
      expect(() => run(directory, ["resolve", "55", "--action", "clarified", "--stage"])).toThrow();
      expect(() => run(directory, [
        "verify", "55", "pass", "--kp", "XF-0054", "--anchor", "坏题面", "--note", "题面污染", "--invalid-prompt", "--stage",
      ])).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
