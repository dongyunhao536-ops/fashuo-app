// 验证「今天背了哪些」新排版的数据路径：章/节/seq 编号（与背诵卡片同源）+ 下次出现时间。
// 复刻 today-review.ts 的 enrichment（buildChapterIndex + nextDueLabel）跑真库。
// 跑法：node --env-file=.env.local scripts/probe-reviewed-layout.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DAY_MS = 86400000;
const BJ = 8 * 3600000;
const bjDateStr = (d = new Date()) => new Date(d.getTime() + BJ).toISOString().slice(0, 10);
const todayStr = bjDateStr();

// --- buildChapterIndex 的忠实移植 ---
const splitParent = (p) => { const [c = "未分类", s = ""] = (p ?? "").split("/"); return { chapter: c.trim() || "未分类", section: s.trim() }; };
function buildChapterIndex(kps) {
  const loc = new Map(), bySub = new Map();
  for (const k of kps) { if (!bySub.has(k.subject)) bySub.set(k.subject, []); bySub.get(k.subject).push(k); }
  for (const list of bySub.values()) {
    list.sort((a, b) => a.kp_id.localeCompare(b.kp_id));
    const chapNo = new Map(), secNo = new Map();
    for (const k of list) {
      const { chapter, section } = splitParent(k.parent_kp);
      if (!chapNo.has(chapter)) chapNo.set(chapter, chapNo.size + 1);
      const secKey = chapter + " " + section;
      if (!secNo.has(secKey)) { const inChap = [...secNo.keys()].filter((s) => s.startsWith(chapter + " ")).length; secNo.set(secKey, inChap + 1); }
      loc.set(k.kp_id, { chapterNo: chapNo.get(chapter), chapterName: chapter, sectionNo: secNo.get(secKey), sectionName: section });
    }
  }
  return loc;
}
const nextDueLabel = (nextDue, mastered) => {
  if (mastered) return "已掌握";
  if (!nextDue) return "未排期";
  const days = Math.round((Date.parse(nextDue) - Date.parse(todayStr)) / DAY_MS);
  if (Number.isNaN(days)) return "未排期";
  if (days <= 0) return "今天可复习";
  if (days === 1) return "明天";
  return `${days} 天后`;
};

// 全量 slim → 章节编号
const { data: allLoc } = await sb.from("kp_state").select("kp_id, subject, parent_kp").order("kp_id");
const chapterIndex = buildChapterIndex(allLoc);

// 今天测过的考点（北京日）
const { data: logs } = await sb.from("detection_log")
  .select("kp_id").gte("ts", `${todayStr}T00:00:00+08:00`).lte("ts", `${todayStr}T23:59:59.999+08:00`);
let ids = [...new Set((logs ?? []).map((r) => r.kp_id).filter(Boolean))];
console.log(`今天(${todayStr})测过 ${ids.length} 个考点`);

let demo = false;
if (ids.length === 0) {
  demo = true;
  // 演示：取前 8 个法理考点，证明新排版的章/节/seq/下次出现会怎么渲染
  ids = allLoc.filter((k) => k.subject === "法理").sort((a, b) => a.kp_id.localeCompare(b.kp_id)).slice(0, 8).map((k) => k.kp_id);
  console.log(`（今天无记录，改用前 8 个法理考点演示排版）`);
}

const { data: kps } = await sb.from("kp_state").select("kp_id, subject, ext, next_due, mastered").in("kp_id", ids);
const rows = (kps ?? []).map((k) => {
  const lc = chapterIndex.get(k.kp_id) ?? { chapterNo: 0, chapterName: "未分类", sectionNo: 0, sectionName: "" };
  return {
    subject: k.subject, name: k.ext?.name ?? k.kp_id, seq: Number(k.kp_id.split("-")[1]) || 0,
    ...lc, label: nextDueLabel(k.next_due ?? null, !!k.mastered), nextDue: k.next_due ?? null,
  };
}).sort((a, b) => (a.subject.localeCompare(b.subject)) || (a.chapterNo - b.chapterNo) || (a.sectionNo - b.sectionNo) || (a.seq - b.seq));

let curSub = "", curCh = "", curSec = "";
for (const r of rows) {
  if (r.subject !== curSub) { console.log(`\n【${r.subject}】`); curSub = r.subject; curCh = curSec = ""; }
  const chKey = `${r.chapterNo}|${r.chapterName}`;
  if (chKey !== curCh) { console.log(`  第${r.chapterNo}章 ${r.chapterName}`); curCh = chKey; curSec = ""; }
  const secKey = `${r.sectionNo}|${r.sectionName}`;
  if (secKey !== curSec) { console.log(`    第${r.sectionNo}节 ${r.sectionName || "（无节）"}`); curSec = secKey; }
  console.log(`      ${String(r.seq).padStart(3, "0")} ${r.name}  →  下次 ${r.label}${r.nextDue ? ` (${r.nextDue})` : ""}`);
}
if (demo) console.log(`\n※ 演示数据 next_due 多为 null（法理刚重置）→ 真机背一遍判分后即写入下次时间。`);
