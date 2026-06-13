// node --env-file=.env.local scripts/sync-content.mjs
// 把 D:\fashuo 下的刑民 markdown / txt 同步进 Supabase content_mirror。
// 走 PostgREST（443，国内通），不走 5432。每次全量重写命中文件（idempotent）。
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

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

const cfg = JSON.parse(readFileSync("config/mirror-scope.json", "utf8"));
// ARCHIVE_DIR 覆盖档案根（与 register-events.mjs 统一）：PC 不设 → 用 mirror-scope.json 的 root；
// ECS autosync 设 ARCHIVE_DIR=/opt/fashuo-archive 指向 clone 的档案，两脚本共用同一目录（不必各维护 config）。
const ROOT = process.env.ARCHIVE_DIR || cfg.root;

/** 把 Windows 反斜杠路径标准化为正斜杠（schema 里 path 字段一致用 / 分隔） */
const norm = (p) => p.split(sep).join("/");

/** 展开 rules → [{absPath, relPath, kind}] */
async function expandRules() {
  const out = [];
  for (const rule of cfg.rules) {
    const pattern = norm(rule.pattern);
    const it = glob(pattern, { cwd: ROOT });
    for await (const f of it) {
      const abs = join(ROOT, f);
      out.push({ abs, rel: norm(relative(ROOT, abs)), kind: rule.kind });
    }
  }
  return out;
}

const files = await expandRules();
if (files.length === 0) {
  console.error("No files matched. Check config/mirror-scope.json.");
  process.exit(2);
}

console.log(`Matched ${files.length} file(s). Syncing → content_mirror ...\n`);

let okCount = 0;
let failCount = 0;
let bytesTotal = 0;

for (const f of files) {
  try {
    const content = readFileSync(f.abs, "utf8");
    bytesTotal += content.length;

    // 删旧
    const del = await withRetry(`delete ${f.rel}`, () =>
      sb.from("content_mirror").delete().eq("path", f.rel),
    );
    if (del.error) throw new Error(`delete: ${del.error.message ?? del.error}`);

    // 插新（一文件一行，start_line=1；grep 行号 = 1 + i 即源文件真实行号）
    const ins = await withRetry(`insert ${f.rel}`, () =>
      sb.from("content_mirror").insert({
        kind: f.kind,
        path: f.rel,
        chunk_no: 0,
        start_line: 1,
        content,
      }),
    );
    if (ins.error) throw new Error(`insert: ${ins.error.message ?? ins.error}`);

    okCount++;
    console.log(`  ✓ [${f.kind.padEnd(8)}] ${f.rel}  (${content.length} chars)`);
  } catch (e) {
    failCount++;
    console.log(`  ✗ [${f.kind.padEnd(8)}] ${f.rel}  — ${e.message}`);
  }
}

console.log(
  `\nDone. ${okCount} synced, ${failCount} failed, total ${(bytesTotal / 1024).toFixed(1)} KB.`,
);

// 总览 by kind
const summary = await sb.from("content_mirror").select("kind", { count: "exact" });
if (!summary.error) {
  const byKind = files.reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  console.log("By kind:", byKind);
}

process.exit(failCount === 0 ? 0 : 3);
