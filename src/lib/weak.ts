import { supabaseAdmin } from "./supabase";

/**
 * 弱项清单（RSC 直接调）。
 * "弱项" = kp_state.error_count > 0 或 任一档 status=failed。
 * 排序：error_count desc → 最近 last_review desc → kp_id asc。
 * 来源：仪表盘 Top5 与本页同源，此页是 Top5 的完整版（不截断、可按科目过滤）。
 */

export interface WeakKp {
  kp_id: string;
  subject: string;
  name: string;
  page: number | null;
  src_line: number | null;
  error_count: number;
  review_count: number;
  cur_level: string;
  cap_level: string;
  l1_status: string;
  l2_status: string;
  l3_status: string;
  difficulty: number;
  last_review: string | null;
  next_due: string | null;
  zhenti_freq: string;
}

export async function getWeakKps(subject?: string): Promise<WeakKp[]> {
  let q = supabaseAdmin
    .from("kp_state")
    .select(
      "kp_id, subject, ext, error_count, review_count, cur_level, cap_level, l1_status, l2_status, l3_status, difficulty, last_review, next_due",
    )
    .or("error_count.gt.0,l1_status.eq.failed,l2_status.eq.failed,l3_status.eq.failed")
    .order("error_count", { ascending: false })
    .order("last_review", { ascending: false, nullsFirst: false })
    .order("kp_id");
  if (subject) q = q.eq("subject", subject);
  const { data, error } = await q;
  if (error) throw new Error(`getWeakKps 失败：${error.message}`);

  return (data ?? []).map((k) => ({
    kp_id: k.kp_id,
    subject: k.subject,
    name: (k.ext as { name?: string })?.name ?? k.kp_id,
    page: (k.ext as { page?: number | null })?.page ?? null,
    src_line: (k.ext as { src_line?: number | null })?.src_line ?? null,
    error_count: k.error_count,
    review_count: k.review_count,
    cur_level: k.cur_level,
    cap_level: k.cap_level,
    l1_status: k.l1_status,
    l2_status: k.l2_status,
    l3_status: k.l3_status,
    difficulty: k.difficulty,
    last_review: k.last_review,
    next_due: k.next_due,
    zhenti_freq:
      ((k.ext as { zhenti_freq?: string })?.zhenti_freq as string | undefined) ??
      "低",
  }));
}
