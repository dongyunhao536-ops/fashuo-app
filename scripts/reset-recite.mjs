// 重置某科【背诵进度】：kp_state 调度字段归零 + 删该科 detection_log 流水。
// 保留考点【材料】(ext：l1_cloze/l1_must/l1_keypoints/name/anki_note_ids 等)，只清进度。
// 必须指定科目（防误清全库）。跑法：node --env-file=.env.local scripts/reset-recite.mjs 法理
import { createClient } from "@supabase/supabase-js";

const subj = process.argv[2];
if (!subj) { console.error("必须指定科目，如：node ... reset-recite.mjs 法理"); process.exit(1); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: kps, error } = await sb.from("kp_state").select("kp_id").eq("subject", subj);
if (error) { console.error("查 kp_state 失败：", error.message); process.exit(1); }
const ids = (kps ?? []).map((k) => k.kp_id);
console.log(`科目「${subj}」：${ids.length} 个考点`);
if (!ids.length) process.exit(0);

// 1) 删该科检测流水（detection_log 无 subject 列，按 kp_id 删；分批防 URL 过长）
let delN = 0;
for (let i = 0; i < ids.length; i += 50) {
  const { error: e, count } = await sb.from("detection_log").delete({ count: "exact" }).in("kp_id", ids.slice(i, i + 50));
  if (e) { console.error("删 detection_log 失败：", e.message); process.exit(1); }
  delN += count ?? 0;
}
console.log(`✓ 已删检测流水 ${delN} 条`);

// 2) kp_state 调度字段归零（保留 ext 材料 / cap_level / parent_kp）
const { error: upErr } = await sb.from("kp_state").update({
  cur_level: "L1", l1_status: "untested", l2_status: "untested", l3_status: "untested",
  difficulty: 5, interval_idx: 0, last_review: null, next_due: null,
  mastered: false, review_count: 0, error_count: 0, priority: 0, updated_at: new Date().toISOString(),
}).eq("subject", subj);
if (upErr) { console.error("重置 kp_state 失败：", upErr.message); process.exit(1); }
console.log(`✓ 已把 ${ids.length} 个考点进度重置为初始（L1/未测/难度5/无错次/未掌握/即到期），材料保留`);
console.log(`\n✅ ${subj} 背诵进度已清空，可重新开始背。`);
