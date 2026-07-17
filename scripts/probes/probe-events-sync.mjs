// 待办筐同步体检：events 最近 N 天各状态分布 + 未同步(pending/confirmed)明细。
// pending=刚收录待你确认；confirmed=已确认待 PC register-events 登记；consumed=已同步进库。
// 跑法：node --env-file=.env.local scripts/probe-events-sync.mjs [天数=14]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DAYS = Number(process.argv[2] || 14);
const sinceIso = new Date(Date.now() - DAYS * 86400000).toISOString();
const bj = (iso) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "—");

const { data: evs, error } = await sb
  .from("events")
  .select("id, type, status, subject, kp_id, knowledge, anchor, source, created_at, consumed_at")
  .gte("created_at", sinceIso)
  .order("created_at", { ascending: false });
if (error) { console.error("查询失败：", error.message); process.exit(1); }

console.log(`\n最近 ${DAYS} 天待办筐事件：共 ${evs.length} 条（北京时间 ${bj(sinceIso)} 起）\n`);

// 状态 × 类型 分布
const grid = {};
for (const e of evs) {
  const k = `${e.type}`;
  grid[k] ||= { pending: 0, confirmed: 0, consumed: 0, other: 0 };
  grid[k][e.status] = (grid[k][e.status] ?? 0) + 1;
  if (!["pending", "confirmed", "consumed"].includes(e.status)) grid[k].other++;
}
console.log("类型".padEnd(10), "pending", "confirmed", "consumed");
for (const [t, g] of Object.entries(grid)) {
  console.log(t.padEnd(12), String(g.pending).padStart(5), String(g.confirmed).padStart(8), String(g.consumed).padStart(9));
}

const notSynced = evs.filter((e) => e.status === "pending" || e.status === "confirmed");
console.log(`\n—— 未同步进库（${notSynced.length} 条）——`);
if (notSynced.length === 0) console.log("（无，最近收录的都已 consumed 或没有新收录）");
for (const e of notSynced) {
  const tag = e.status === "pending" ? "待确认" : "待登记";
  console.log(`#${e.id} [${tag}] ${e.type} · ${e.subject ?? "—"} · ${e.knowledge ?? e.kp_id ?? "—"}　来源:${e.source}　${bj(e.created_at)}`);
}

const synced = evs.filter((e) => e.status === "consumed");
console.log(`\n—— 已同步进库（最近 ${Math.min(synced.length, 12)}/${synced.length} 条）——`);
for (const e of synced.slice(0, 12)) {
  console.log(`#${e.id} ${e.type} · ${e.subject ?? "—"} · ${e.knowledge ?? e.kp_id ?? "—"}　登记:${bj(e.consumed_at)}`);
}
console.log("");
