// node --env-file=.env.local scripts/sync-content.mjs [--dry|--dry-run]
// 把 mirror-scope 中允许且未封存的档案文本同步进 Supabase content_mirror。
// 走 PostgREST（443，国内通），不走 5432。每次全量重写命中文件（idempotent）。
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  isExcludedArchivePath,
  isSealedExamArchivePath,
} from "./lib/knowledge-baseline.mjs";
import { inferMirrorSourceLevel, prepareMirrorGeneration } from "./lib/mirror-generation.mjs";
import { verifyMirrorRuleMatches } from "./lib/mirror-integrity.mjs";

/** 重试包装：sb 调用失败时（fetch failed / ETIMEDOUT / ECONNRESET），指数退避重试。
 *  国内家宽 → 阿里云 ECS 偶发 TCP 抖断，这层让幂等同步能扛过去。 */
async function withRetry(label, fn, max = 5) {
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      const res = await fn();
      const errMsg = res?.error ? String(res.error.message ?? res.error) : "";
      const isNetErr = /fetch failed|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(errMsg);
      if (!res?.error || !isNetErr) return res;
      lastErr = res.error;
    } catch (e) {
      lastErr = e;
    }
    if (i < max - 1) {
      const delay = 400 * Math.pow(2, i);
      process.stdout.write(`    ↻ ${label} 抖断，${delay}ms 后重试 (${i + 1}/${max - 1})\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { error: lastErr };
}

const configBytes = readFileSync("config/mirror-scope.json");
const cfg = JSON.parse(configBytes.toString("utf8"));
// ARCHIVE_DIR 覆盖档案根（与 register-events.mjs 统一）：PC 不设 → 用 mirror-scope.json 的 root；
// ECS autosync 设 ARCHIVE_DIR=/opt/fashuo-archive 指向 clone 的档案，两脚本共用同一目录（不必各维护 config）。
const ROOT = process.env.ARCHIVE_DIR || cfg.root;
// [gpt] 2026-08-10：同时接受常见的 --dry-run，避免把只读预检误当成正式同步。
const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");

/** 把 Windows 反斜杠路径标准化为正斜杠（schema 里 path 字段一致用 / 分隔） */
const norm = (p) => p.split(sep).join("/");

/** 展开 rules → [{absPath, relPath, kind}] */
async function expandRules() {
  const out = [];
  const excluded = [];
  const verified = [];
  const excludedPatterns = cfg.excludedPatterns ?? [];
  for (const rule of cfg.rules) {
    const pattern = norm(rule.pattern);
    const it = glob(pattern, { cwd: ROOT });
    const matched = [];
    for await (const f of it) {
      const abs = join(ROOT, f);
      const rel = norm(relative(ROOT, abs));
      const file = {
        abs,
        rel,
        kind: rule.kind,
        sourceLevel: inferMirrorSourceLevel(rule.kind, rel, rule.sourceLevel),
        sourceVersion: rule.sourceVersion ?? null,
      };
      matched.push(file);
      if (
        isExcludedArchivePath(rel, excludedPatterns) ||
        (rule.kind === "exam" &&
          isSealedExamArchivePath(rel, cfg.sealedExamFromYear))
      ) excluded.push(file);
      else out.push(file);
    }
    const verification = verifyMirrorRuleMatches(rule, matched);
    if (verification.verified) verified.push(verification);
  }
  return { files: out, excluded, verified };
}

const { files, excluded, verified } = await expandRules();
if (files.length === 0) {
  console.error("No files matched. Check config/mirror-scope.json.");
  process.exit(2);
}

// [gpt] 2026-08-10：所有文件先在本地读完、去重和指纹化；未形成完整世代前不触碰线上 active 镜像。
const generation = prepareMirrorGeneration(files, {
  configBytes,
  sourceCommit: process.env.ARCHIVE_COMMIT ?? null,
});

if (dryRun) {
  const byKind = files.reduce(
    (counts, file) => ((counts[file.kind] = (counts[file.kind] ?? 0) + 1), counts),
    {},
  );
  console.log(`Dry run: ${files.length} file(s) would sync; ${excluded.length} sealed file(s) stay excluded.`);
  console.log("By kind:", byKind);
  console.log(`Integrity: ${verified.length} pinned asset(s) verified.`);
  console.log(`Generation: files=${generation.expectedFileCount}, bytes=${generation.totalBytes}, scope=${generation.scopeSha256}, content=${generation.contentSha256}`);
  process.exit(0);
}

// [gpt] 2026-08-10：dry-run 只检查本地范围，不应要求或初始化数据库密钥。
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const active = await withRetry("read active generation", () => sb
  .from("content_mirror_generation")
  .select("generation_id,expected_row_count,config_sha256,scope_sha256,content_sha256,status")
  .eq("status", "active")
  .maybeSingle());
if (active.error) {
  console.error(`Failed to read active mirror generation: ${active.error.message ?? active.error}`);
  process.exit(4);
}
const activeRowCount = active.data
  ? await withRetry("count active generation rows", () => sb
    .from("content_mirror")
    .select("*", { count: "exact", head: true })
    .eq("generation_id", active.data.generation_id))
  : { count: 0 };
if (activeRowCount.error) {
  console.error(`Failed to count active mirror generation rows: ${activeRowCount.error.message ?? activeRowCount.error}`);
  process.exit(4);
}
if (
  active.data?.config_sha256 === generation.configSha256 &&
  active.data?.scope_sha256 === generation.scopeSha256 &&
  active.data?.content_sha256 === generation.contentSha256 &&
  activeRowCount.count === active.data.expected_row_count
) {
  console.log(`✓ content_mirror unchanged; active generation ${active.data.generation_id} already matches all fingerprints.`);
  process.exit(0);
}
if (active.data?.content_sha256 === generation.contentSha256) {
  console.log(`! active generation ${active.data.generation_id} is incomplete (${activeRowCount.count}/${active.data.expected_row_count}); rebuilding it atomically.`);
}

const createGeneration = await withRetry("create generation", () => sb
  .from("content_mirror_generation")
  .insert({
    generation_id: generation.generationId,
    status: "staging",
    expected_file_count: generation.expectedFileCount,
    expected_row_count: generation.expectedRowCount,
    total_bytes: generation.totalBytes,
    config_sha256: generation.configSha256,
    scope_sha256: generation.scopeSha256,
    content_sha256: generation.contentSha256,
    source_commit: generation.sourceCommit,
    metadata: {
      excluded_files: excluded.length,
      verified_assets: verified.length,
      producer: "sync-content[gpt]",
    },
  }));
if (createGeneration.error) {
  console.error(`Failed to create mirror generation: ${createGeneration.error.message ?? createGeneration.error}`);
  process.exit(4);
}

console.log(`Staging generation ${generation.generationId}: ${generation.expectedFileCount} files, ${(generation.totalBytes / 1024).toFixed(1)} KiB ...\n`);
let staged = 0;
for (const row of generation.rows) {
  const insert = await withRetry(`stage ${row.path}`, () => sb.from("content_mirror_stage").insert(row));
  if (insert.error) {
    const message = `stage ${row.path}: ${insert.error.message ?? insert.error}`;
    await sb.from("content_mirror_generation").update({ status: "failed", failure_reason: message }).eq("generation_id", generation.generationId);
    console.error(`✗ ${message}`);
    process.exit(3);
  }
  staged++;
  console.log(`  ✓ [${row.kind.padEnd(8)}|${row.source_level.padEnd(12)}] ${row.path}`);
}

// 单个 RPC 内校验完整性、替换 active 表并清理 staging；检索端看不到半个世代。
const activation = await withRetry("activate generation", () => sb.rpc(
  "activate_content_mirror_generation",
  { p_generation_id: generation.generationId },
));
if (activation.error) {
  await sb.from("content_mirror_generation").update({ failure_reason: activation.error.message ?? String(activation.error) }).eq("generation_id", generation.generationId);
  console.error(`Activation failed; staging retained for audit: ${activation.error.message ?? activation.error}`);
  process.exit(5);
}

const byKind = generation.rows.reduce((counts, row) => ((counts[row.kind] = (counts[row.kind] ?? 0) + 1), counts), {});
console.log(`\n✓ Activated ${generation.generationId}: ${staged} rows. Out-of-scope legacy rows left the active mirror atomically.`);
console.log("By kind:", byKind);
