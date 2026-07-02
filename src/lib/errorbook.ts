import { supabaseAdmin } from "./supabase";

/**
 * 错题本（= 弱项，唯一事实源 study_error，2026-07-01 合并）。
 * 云主动说"记进错题本"才进来（教练/答疑两口，指令制）；「我会了」absorbed /「不是错题」dismissed 退场。
 * 按 (科目, 知识点) 聚合、频次×新近排序——错题页 /errors、教练「错题」tab、仪表盘 Top5、周报同用这一份。
 */

export interface ErrorItem {
  subject: string | null;
  knowledge: string;
  n: number; // 记录次数（反复错）
  last: string; // 最近记录日期
}

export async function getErrorBook(subject?: string): Promise<ErrorItem[]> {
  let q = supabaseAdmin
    .from("study_error")
    .select("subject, knowledge, log_date")
    .eq("status", "open")
    .order("log_date", { ascending: false });
  if (subject) q = q.eq("subject", subject);
  const { data } = await q;

  const map = new Map<string, ErrorItem>();
  for (const r of data ?? []) {
    if (!r.knowledge) continue;
    const subj = (r.subject as string | null) ?? null;
    const key = `${subj ?? "未分类"}::${r.knowledge}`;
    const cur = map.get(key) ?? { subject: subj, knowledge: String(r.knowledge), n: 0, last: "" };
    cur.n++;
    const d = String(r.log_date ?? "");
    if (d > cur.last) cur.last = d;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1));
}
