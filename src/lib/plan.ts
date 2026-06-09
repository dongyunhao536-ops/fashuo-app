import { supabaseAdmin } from "./supabase";
import { buildDailyPlan, type KpRow } from "./scheduler";
import { listDuelPairs, type DuelPair } from "./yixiao";

/**
 * 今日背诵清单（RSC 直接调，零 LLM 花费）。
 * 复用调度器 buildDailyPlan，保证背诵 tab 与仪表盘双核入口同源。
 *
 * 流程：读全部 kp_state（可按 subject 过滤）+ pending 复验请求(G2) → 价值加权排清单。
 */
export async function getTodayPlan(subject?: string, capacity = 30) {
  let q = supabaseAdmin.from("kp_state").select("*");
  if (subject) q = q.eq("subject", subject);
  const [{ data: kps, error }, { data: reviewEv }] = await Promise.all([
    q,
    supabaseAdmin
      .from("events")
      .select("kp_id")
      .eq("type", "复验请求")
      .eq("status", "pending"),
  ]);
  if (error) throw new Error(`getTodayPlan 读取 kp_state 失败：${error.message}`);

  const reviewKpIds = (reviewEv ?? [])
    .map((e) => e.kp_id)
    .filter((x): x is string => !!x);

  return buildDailyPlan({
    kps: (kps ?? []) as KpRow[],
    reviewKpIds,
    capacity,
  });
}

/**
 * 今日易混对决清单（调度接入，零 LLM 花费）。
 * 选 N 对易混概念让云做区分题——优先弱项科目（error_count 集中处），每日轮换避免老是同 3 对。
 * 数据源=易混概念库（content_mirror kind=yixiao）。出题/评分才花钱（点开才调 /api/yixiao）。
 */
const DAY_MS_PLAN = 86400000;
function hashPath(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export async function getDuelPlan(limit = 3, today = new Date()) {
  const pairs = await listDuelPairs();
  if (pairs.length === 0) return { items: [] as DuelPair[], total: 0 };

  // 弱项科目权重：error_count>0 的考点按科目聚合
  const { data: weak } = await supabaseAdmin
    .from("kp_state")
    .select("subject, error_count")
    .gt("error_count", 0);
  const weakBySubject = new Map<string, number>();
  for (const w of weak ?? []) {
    weakBySubject.set(w.subject, (weakBySubject.get(w.subject) ?? 0) + (Number(w.error_count) || 0));
  }

  const seed = Math.floor(today.getTime() / DAY_MS_PLAN);
  const scored = pairs
    .map((p) => ({ p, score: weakBySubject.get(p.subject) ?? 0, jitter: (hashPath(p.path) + seed) % 997 }))
    .sort((a, b) => b.score - a.score || a.jitter - b.jitter);

  return { items: scored.slice(0, limit).map((s) => s.p), total: pairs.length };
}
