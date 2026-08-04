import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from("content_mirror").select("path, content, updated_at").eq("kind", "xinde").order("path");
if (error) { console.error(error.message); process.exit(1); }
for (const r of data) {
  const c = r.content || "";
  const hasNew = /自非分亦|实证主义.*分析法学派|自然法学派/.test(c);
  console.log(`\n${r.path}  updated=${r.updated_at}  长度=${c.length}`);
  console.log("  含#83(自非分亦/实证主义)：", hasNew ? "是" : "否");
  // 待观察表行数（| 开头、非分隔/表头）
  const rows = c.split(/\r?\n/).filter((l) => l.trimStart().startsWith("|") && !/规律|:---|---\s*\|/.test(l));
  console.log("  待观察表数据行数：", rows.length);
}
