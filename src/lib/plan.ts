import { supabaseAdmin, fetchAllRows } from "./supabase";
import { buildDailyPlan, type KpRow } from "./scheduler";
import { listDuelPairs, type DuelPair } from "./yixiao";

/**
 * 今日背诵清单（RSC 直接调，零 LLM 花费）。
 * 复用调度器 buildDailyPlan，保证背诵 tab 与仪表盘双核入口同源。
 *
 * 流程：读全部 kp_state（可按 subject 过滤）+ pending 复验请求(G2) → 价值加权排清单。
 */
export async function getTodayPlan(subject?: string, capacity = 30) {
  const [kps, { data: reviewEv }] = await Promise.all([
    fetchAllRows<KpRow>((from, to) => {
      let q = supabaseAdmin.from("kp_state").select("*").order("kp_id").range(from, to);
      if (subject) q = q.eq("subject", subject);
      return q;
    }),
    supabaseAdmin
      .from("events")
      .select("kp_id")
      .eq("type", "复验请求")
      .eq("status", "pending"),
  ]);

  const reviewKpIds = (reviewEv ?? [])
    .map((e) => e.kp_id)
    .filter((x): x is string => !!x);

  return buildDailyPlan({
    kps,
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

/**
 * 每科每日 perSubject 个（云 2026-06-10 拍板：每科每天只展示 5 对），
 * 同科内按 path+日期 hash 轮换，避免老是同几对。
 */
export async function getDuelPlan(perSubject = 5, today = new Date()) {
  const pairs = await listDuelPairs();
  if (pairs.length === 0) return { items: [] as DuelPair[], total: 0 };

  const seed = Math.floor(today.getTime() / DAY_MS_PLAN);
  const bySubject = new Map<string, DuelPair[]>();
  for (const p of pairs) {
    if (!bySubject.has(p.subject)) bySubject.set(p.subject, []);
    bySubject.get(p.subject)!.push(p);
  }
  const items: DuelPair[] = [];
  for (const list of bySubject.values()) {
    list.sort((a, b) => ((hashPath(a.path) + seed) % 997) - ((hashPath(b.path) + seed) % 997));
    items.push(...list.slice(0, perSubject));
  }
  return { items, total: pairs.length };
}
