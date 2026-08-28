#!/usr/bin/env node
// [claude] 2026-08-26：把无版本／不合规的历史判题 artifact 移出工作目录。
//
// 起因：`.local/` 下 33 份 judgment JSON 里，多数是 2026-08-13 之前的扁平写法。
// 严格化之前它们能通过校验并被静默降级；严格化之后它们只是「照抄就出错」的样例源。
// 原地加 legacy 标记不行——同目录同命名照样会被抄，而且 legacy 字段本身就是未知键。
//
// 判据只有一条：有 schemaVersion 且通过当前严格校验器 → 留；否则 → 隔离。
// 不按「有没有 diagnosis 对象」分组，那个判据会把 11 份实际已阻断的嵌套文件误判成合规。

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateJudgmentResult } from "./lib/judgment-result.mjs";

const SOURCE_DIR = ".local";
const QUARANTINE_DIR = join(SOURCE_DIR, "legacy-judgments");
const MANIFEST = join(QUARANTINE_DIR, "清单.md");
const PATTERN = /^judgment-.*\.json$/u;

export function classify(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return { keep: false, reason: `无法解析 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  const hasVersion = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.hasOwn(parsed, "schemaVersion");
  if (!hasVersion) return { keep: false, reason: "无 schemaVersion" };
  try {
    validateJudgmentResult(parsed);
    return { keep: true, reason: "有版本且通过当前严格校验器" };
  } catch (error) {
    const codes = Array.isArray(error?.issues) ? error.issues.map((item) => item.code) : [];
    return { keep: false, reason: `校验阻断：${[...new Set(codes)].join("、") || "未知"}` };
  }
}

export function main(argv = process.argv.slice(2)) {
  const dry = argv.includes("--dry");
  if (!existsSync(SOURCE_DIR)) throw new Error(`目录不存在：${SOURCE_DIR}`);
  const files = readdirSync(SOURCE_DIR).filter((name) => PATTERN.test(name)).sort();
  const kept = [];
  const moved = [];
  for (const name of files) {
    const verdict = classify(join(SOURCE_DIR, name));
    (verdict.keep ? kept : moved).push({ name, reason: verdict.reason });
  }

  console.log(`扫描 ${SOURCE_DIR}/judgment-*.json：共 ${files.length} 份｜留 ${kept.length}｜隔离 ${moved.length}`);
  for (const item of moved) console.log(`  隔离 ${item.name}｜${item.reason}`);
  for (const item of kept) console.log(`  保留 ${item.name}｜${item.reason}`);
  if (dry) {
    console.log("（--dry：未移动任何文件）");
    return 0;
  }
  if (!moved.length) {
    console.log("没有需要隔离的文件。");
    return 0;
  }

  mkdirSync(QUARANTINE_DIR, { recursive: true });
  for (const item of moved) {
    renameSync(join(SOURCE_DIR, item.name), join(QUARANTINE_DIR, item.name));
  }
  const lines = [
    "# 历史判题 artifact 隔离清单",
    "",
    `隔离日期：北京 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}`,
    `判据：有 \`schemaVersion\` 且通过 \`validateJudgmentResult\` → 留在 \`.local/\`；否则移到本目录。`,
    "",
    "**这些文件只作审计留存，不得当作新判题 JSON 的样例。**",
    "新文件一律用 `skill-context` 开场输出里的模板，或 `judgmentResultTemplate()`。",
    "",
    `共 ${moved.length} 份：`,
    "",
    "| 文件 | 隔离原因 |",
    "|---|---|",
    ...moved.map((item) => `| \`${item.name}\` | ${item.reason} |`),
    "",
  ];
  writeFileSync(MANIFEST, lines.join("\n"), "utf8");
  for (const item of moved) {
    try { chmodSync(join(QUARANTINE_DIR, item.name), 0o444); } catch { /* 只读失败不阻断隔离本身 */ }
  }
  try { chmodSync(MANIFEST, 0o444); } catch { /* 同上 */ }
  console.log(`✅ 已隔离 ${moved.length} 份到 ${QUARANTINE_DIR}/，清单：${MANIFEST}（已置只读）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`QUARANTINE_ERROR｜${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
