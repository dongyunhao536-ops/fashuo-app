import { supabaseAdmin } from "./supabase";

/**
 * 待办筐（events 表）统一投递口——四个生产方（检测G1/答疑/教练复盘/易混对决）共用，
 * 防重标准从此只有一份（此前答疑/易混不防重，同一弱项会投出整屏重复 pending）。
 *
 * 防重语义：仅在 pending 期间去重（筐内噪音）；消费后可再投——
 * 错误频率的累计靠 PC 登记跨批次 +1，不靠重复 pending 行。
 */

export type EventType = "弱项候选" | "心得候选" | "已强化";

/**
 * 科目名归一到 5 个规范名（刑法/民法/法理/宪法/法制史）。
 * 答疑/教练的 LLM 偶尔吐全称「法理学/宪法学/中国法制史」→ 与 kp_state.subject 及
 * PC 登记员 XINDE_FILE 键（规范名）对不上，会被当「暂无心得文件」跳过、永远卡在待办筐。
 * 在唯一投递口归一，从源头断掉这类沉淀漂移。
 */
export const SUBJECT_CANON = new Set(["刑法", "民法", "法理", "宪法", "法制史"]);
const SUBJECT_ALIAS: Record<string, string> = {
  法理学: "法理",
  宪法学: "宪法",
  刑法学: "刑法",
  民法学: "民法",
  中国法制史: "法制史",
  法制史学: "法制史",
};
export function normalizeSubject(s: string | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t || SUBJECT_CANON.has(t)) return t || null;
  if (SUBJECT_ALIAS[t]) return SUBJECT_ALIAS[t];
  if (t.endsWith("学") && SUBJECT_CANON.has(t.slice(0, -1))) return t.slice(0, -1); // 兜底去尾「学」
  return t;
}

export interface EmitEventArgs {
  type: EventType;
  subject: string | null;
  kp_id: string | null;
  knowledge: string | null;
  anchor: string | null;
  source: string;
  payload?: Record<string, unknown>;
  /**
   * 防重键：
   * - "knowledge"（默认）：同 type+subject+knowledge 的 pending 已存在则跳过——
   *   适合自由短语类（答疑/教练/易混的弱项、心得）；同一 kp_id 可挂多条不同弱项。
   * - "kp"：同 type+kp_id 的 pending 已存在则跳过——适合考点级事件（已强化）。
   */
  dedupBy?: "kp" | "knowledge";
}

/**
 * 投递事件（带防重）。返回 true = 筐里有这条（本次新投或已在 pending）；false = 写入失败（已打日志）。
 * 防重查询失败时宁可冒重复也不丢事件（fail-open 直接投）。
 */
export async function emitEvent(ev: EmitEventArgs): Promise<boolean> {
  const dedupBy = ev.dedupBy ?? "knowledge";
  ev = { ...ev, subject: normalizeSubject(ev.subject) }; // 科目归一（防全称漂移卡筐）

  let q = supabaseAdmin
    .from("events")
    .select("id")
    .eq("type", ev.type)
    .eq("status", "pending")
    .limit(1);
  if (dedupBy === "kp" && ev.kp_id) {
    q = q.eq("kp_id", ev.kp_id);
  } else {
    q = ev.subject == null ? q.is("subject", null) : q.eq("subject", ev.subject);
    q = ev.knowledge == null ? q.is("knowledge", null) : q.eq("knowledge", ev.knowledge);
  }
  const { data: dup, error: dupErr } = await q;
  if (!dupErr && dup && dup.length > 0) return true; // 已在筐里，等同"已投"

  const { error } = await supabaseAdmin.from("events").insert({
    type: ev.type,
    subject: ev.subject,
    kp_id: ev.kp_id,
    knowledge: ev.knowledge,
    anchor: ev.anchor,
    source: ev.source,
    payload: ev.payload ?? {},
    status: "pending",
  });
  if (error) {
    console.error(`[events] ${ev.type} 投递失败：`, error.message);
    return false;
  }
  return true;
}
