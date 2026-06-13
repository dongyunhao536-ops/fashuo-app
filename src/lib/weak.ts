import { supabaseAdmin, fetchAllRows } from "./supabase";

/**
 * 弱项清单（RSC 直接调）。
 * "弱项" = 未 mastered 且（error_count > 0 或 任一档 status=failed）。
 * mastered 的退场——检测在弱项三档全过时投「已强化」事件，PC 登记把档案行移入已强化段，
 * 弱项有进有出，列表不随备考推进失真。
 * 排序：error_count desc → 最近 last_review desc → kp_id asc。
 * 口径对齐：仪表盘 Top5 / 教练账本 Top5 与本页同源（都排除 mastered），此页是完整版。
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
  interface Row {
    kp_id: string;
    subject: string;
    ext: Record<string, unknown> | null;
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
  }
  const data = await fetchAllRows<Row>((from, to) => {
    let q = supabaseAdmin
      .from("kp_state")
      .select(
        "kp_id, subject, ext, error_count, review_count, cur_level, cap_level, l1_status, l2_status, l3_status, difficulty, last_review, next_due",
      )
      .or("error_count.gt.0,l1_status.eq.failed,l2_status.eq.failed,l3_status.eq.failed")
      .eq("mastered", false) // 已强化（三档全过）的考点从弱项页退场
      .order("error_count", { ascending: false })
      .order("last_review", { ascending: false, nullsFirst: false })
      .order("kp_id")
      .range(from, to);
    if (subject) q = q.eq("subject", subject);
    return q;
  });

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
