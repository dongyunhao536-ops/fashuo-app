// 把抽取的 Anki 法综(法理/宪法/法制史)原文灌进 content_mirror → 补答疑的法综 grep 文本缺口。
// 用法: node --env-file=.env.local scripts/anki-load.mjs [--commit]
// 默认 dry-run。刑民已有教材文本，deck 刑民/法条卡暂存 JSON 留待 L1，不灌(避免重复/噪音)。
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const JSON_PATH = "D:/fashuo/考点库/anki_extracted.json";
const FZ = new Set(["法理", "宪法", "法制史"]); // 法综三科 = 缺教材文本，本次补
const COMMIT = process.argv.includes("--commit");
const PATH_PREFIX = "Anki法综";

const notes = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const fz = notes.filter((n) => FZ.has(n.subject) && !n.is_fatiao);

const rows = fz.map((n, i) => {
  const chapterLine = (n.chapter || "").split("\n")[0].slice(0, 60).trim();
  // ⚠️ 提取 JSON 的字段叫 title/原文全文（不是 题目/原文）——2026-06-10 修：
  //   旧字段名读出 undefined → content 全空 → 灌库 0 行（线上 content_mirror 实测为 0）。
  const content = [n.title, n.原文全文].filter(Boolean).join("\n").trim();
  return {
    kind: "textbook", // 复用 search_textbook，零改动即可被答疑 grep
    path: `${PATH_PREFIX}/${n.subject}/${chapterLine || n.note_id}`,
    chunk_no: i,
    start_line: 1,
    content,
  };
}).filter((r) => r.content.length > 10);

const bySubj = {};
for (const r of rows) {
  const s = r.path.split("/")[1];
  bySubj[s] = (bySubj[s] || 0) + 1;
}
console.log(`\n═══ Anki 法综灌库 ${COMMIT ? "· 正式" : "· DRY-RUN"} ═══`);
console.log(`待灌 content_mirror 行：${rows.length}（kind=textbook, path 前缀 ${PATH_PREFIX}/）`);
console.log("科目分布：", JSON.stringify(bySubj));
console.log("\n样本（前2行内容预览）：");
for (const r of rows.slice(0, 2)) {
  console.log(`  [${r.path}]`);
  console.log(`    ${r.content.replace(/\n/g, " ").slice(0, 160)}…`);
}

if (!COMMIT) {
  console.log("\n[DRY-RUN] 未写库。加 --commit 正式灌。");
  process.exit(0);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

/** 国内家宽 → 阿里云 ECS 偶发 TCP 抖断，重试指数退避（同 anki-index-kp.mjs） */
async function withRetry(label, fn, max = 5) {
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      const res = await fn();
      const msg = res?.error ? String(res.error.message ?? res.error) : "";
      const isNet = /fetch failed|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|socket hang up|terminated/i.test(msg);
      if (!res?.error || !isNet) return res;
      lastErr = res.error;
    } catch (e) { lastErr = e; }
    if (i < max - 1) {
      const delay = 400 * Math.pow(2, i);
      process.stdout.write(`    ↻ ${label} 抖断，${delay}ms 后重试 (${i + 1}/${max - 1})\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { error: lastErr };
}

// 幂等：先删旧的 Anki法综 行（不碰真实刑民教材 path）
const { error: delErr } = await withRetry("清旧行", () =>
  sb.from("content_mirror").delete().like("path", `${PATH_PREFIX}/%`),
);
if (delErr) {
  console.error("✗ 清旧行失败：", delErr.message);
  process.exit(1);
}
let done = 0;
for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200);
  const { error } = await withRetry(`插入批${i}`, () =>
    sb.from("content_mirror").insert(batch),
  );
  if (error) {
    console.error(`✗ 插入失败(批 ${i})：`, error.message);
    process.exit(1);
  }
  done += batch.length;
}
console.log(`\n✓ 已灌 content_mirror：${done} 行（法综可被答疑 grep 了）`);
