// node --env-file=.env.local scripts/smoke-grep.mjs
// 烟测：复刻 search-tools.ts 的 grepMirror 逻辑，确认 content_mirror 数据可被检索。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

async function grep(kind, keyword) {
  const { data, error } = await sb
    .from("content_mirror")
    .select("path, content, start_line")
    .eq("kind", kind);
  if (error) throw error;
  const hits = [];
  for (const row of data) {
    const lines = String(row.content).split("\n");
    lines.forEach((ln, i) => {
      if (keyword && ln.includes(keyword)) {
        hits.push({ path: row.path, line: (row.start_line ?? 1) + i, text: ln.trim() });
      }
    });
  }
  return hits;
}

const cases = [
  { kind: "yixiao",   kw: "想象竞合" },
  { kind: "xinde",    kw: "定金" },
  { kind: "textbook", kw: "犯罪构成" },
  { kind: "zhenti",   kw: "高频" },
];

for (const c of cases) {
  const hits = await grep(c.kind, c.kw);
  const top = hits.slice(0, 3);
  console.log(`\n[${c.kind}] "${c.kw}" → ${hits.length} 行`);
  for (const h of top) console.log(`  ${h.path}:${h.line}  ${h.text.slice(0, 80)}`);
}
