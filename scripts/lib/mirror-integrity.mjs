// [gpt] 2026-08-10：关键 content_mirror 资产必须存在且内容与清单哈希一致，禁止静默少同步。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SHA256 = /^[a-f0-9]{64}$/i;

export function verifyMirrorRuleMatches(rule, matches, { readBytes = readFileSync } = {}) {
  const pattern = String(rule?.pattern ?? "");
  const candidates = Array.isArray(matches) ? matches : [];
  if ((rule?.required || rule?.sha256) && candidates.length === 0) {
    throw new Error(`必需镜像资产未匹配：${pattern}`);
  }
  if (!rule?.sha256) return { pattern, matched: candidates.length, verified: false };

  const expected = String(rule.sha256).toLowerCase();
  if (!SHA256.test(expected)) throw new Error(`镜像资产 sha256 配置无效：${pattern}`);
  if (candidates.length !== 1) throw new Error(`带 sha256 的镜像规则必须精确匹配 1 个文件：${pattern}（实际 ${candidates.length}）`);
  const actual = createHash("sha256").update(readBytes(candidates[0].abs)).digest("hex");
  if (actual !== expected) {
    throw new Error(`镜像资产哈希不一致：${pattern}（expected ${expected}，actual ${actual}）`);
  }
  return { pattern, matched: 1, verified: true, sha256: actual };
}
