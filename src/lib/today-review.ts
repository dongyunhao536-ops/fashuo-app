import { supabaseAdmin } from "./supabase";
import { bjDayStart, bjDayEnd, bjDateStr } from "./dates";

/**
 * 今日已背明细（RSC 直接调，零 LLM）。
 * 数据源=detection_log 今天的记录；按考点去重（保留最新一次结果 + 统计今天测了几次），
 * 关联 kp_state 取考点名/科目。供「今天背了哪些」页展示——不只看到数字，能看到具体背了啥、过没过。
 */

export interface ReviewedItem {
  kp_id: string;
  name: string;
  subject: string;
  level: string;
  grade: string; // 最新一次 ai_grade：干净通过/勉强/未过
  passed: boolean;
  attempts: number; // 今天测这个考点的次数（含"再测一次"）
}

export interface TodayReviewed {
  items: ReviewedItem[];
  total: number; // 去重考点数
  passedCount: number; // 最新结果=干净通过 的考点数
}

export async function getTodayReviewed(): Promise<TodayReviewed> {
  const todayStr = bjDateStr(new Date());
  const { data: logs } = await supabaseAdmin
    .from("detection_log")
    .select("kp_id, level, ai_grade, passed, ts")
    .gte("ts", bjDayStart(todayStr))
    .lte("ts", bjDayEnd(todayStr))
    .order("ts", { ascending: false }); // 最新在前 → 去重时第一条即最新结果

  // 去重：每考点保留最新结果，attempts 累计今天的次数
  const byKp = new Map<string, ReviewedItem>();
  for (const r of logs ?? []) {
    const kp = r.kp_id;
    if (!kp) continue;
    const seen = byKp.get(kp);
    if (seen) {
      seen.attempts++;
    } else {
      byKp.set(kp, {
        kp_id: kp,
        name: kp,
        subject: "",
        level: String(r.level ?? ""),
        grade: String(r.ai_grade ?? ""),
        passed: !!r.passed,
        attempts: 1,
      });
    }
  }

  const ids = [...byKp.keys()];
  if (ids.length === 0) return { items: [], total: 0, passedCount: 0 };

  const { data: kps } = await supabaseAdmin
    .from("kp_state")
    .select("kp_id, subject, ext")
    .in("kp_id", ids);
  for (const k of kps ?? []) {
    const item = byKp.get(k.kp_id);
    if (item) {
      item.subject = k.subject;
      item.name = (k.ext as { name?: string })?.name ?? k.kp_id;
    }
  }

  const items = [...byKp.values()]; // Map 保插入序=最新在前
  return {
    items,
    total: items.length,
    passedCount: items.filter((i) => i.grade === "干净通过").length,
  };
}
