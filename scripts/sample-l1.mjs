// 一次性：抽样看 L1 要点(ext.l1_keypoints)长什么样，给"关键词填空"定格式用。
// 跑法：node --env-file=.env.local scripts/sample-l1.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data, error } = await sb.from("kp_state").select("kp_id, ext").limit(600);
if (error) {
  console.error(error);
  process.exit(1);
}

const withKp = data.filter((r) => Array.isArray(r.ext?.l1_keypoints) && r.ext.l1_keypoints.length);
console.log(`总 ${data.length} 行，其中有 l1_keypoints 的 ${withKp.length} 行\n`);

// 各科各抽几个
const bySubj = {};
for (const r of withKp) {
  const s = r.ext?.subject ?? "?";
  (bySubj[s] ??= []).push(r);
}
for (const [subj, rows] of Object.entries(bySubj)) {
  console.log(`==== ${subj}（${rows.length}）====`);
  for (const r of rows.slice(0, 4)) {
    const kps = r.ext.l1_keypoints;
    const lens = kps.map((k) => String(k).length);
    console.log(`【${r.ext?.name ?? r.kp_id}】 共${kps.length}条 长度${JSON.stringify(lens)}`);
    kps.forEach((k, i) => console.log(`   ${i + 1}. ${k}`));
  }
  console.log();
}
