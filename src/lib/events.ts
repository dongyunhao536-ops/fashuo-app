import { supabaseAdmin } from "./supabase";

/**
 * 待办筐（events 表）统一投递口——四个生产方（检测G1/答疑/教练复盘/易混对决）共用，
 * 防重标准从此只有一份（此前答疑/易混不防重，同一弱项会投出整屏重复 pending）。
 *
 * 防重语义：仅在 pending 期间去重（筐内噪音）；消费后可再投——
 * 错误频率的累计靠 PC 登记跨批次 +1，不靠重复 pending 行。
 */

export type EventType = "弱项候选" | "心得候选" | "复验请求" | "已强化";

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
   * - "kp"：同 type+kp_id 的 pending 已存在则跳过——适合考点级事件（G1/复验请求/已强化）。
   */
  dedupBy?: "kp" | "knowledge";
}

/**
 * 投递事件（带防重）。返回 true = 筐里有这条（本次新投或已在 pending）；false = 写入失败（已打日志）。
 * 防重查询失败时宁可冒重复也不丢事件（fail-open 直接投）。
 */
export async function emitEvent(ev: EmitEventArgs): Promise<boolean> {
  const dedupBy = ev.dedupBy ?? "knowledge";

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

/**
 * G2 兑现：考点完成一次检测后，把它 pending 的复验请求置 consumed。
 * 没有这一步，复验请求会永久 pending、每天占据每日清单复验桶（最高优先级），
 * 积累后把容量整个吃掉。复验的目的就是"澄清后优先重测一次"——测完即兑现；
 * 若这次没过，间隔退档会让它很快再到期，连续失败还有 G1 接手，不丢跟进。
 */
export async function consumeReviewRequests(kpId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("events")
    .update({ status: "consumed", consumed_at: new Date().toISOString() })
    .eq("type", "复验请求")
    .eq("kp_id", kpId)
    .eq("status", "pending");
  if (error) console.error("[events] 复验请求消费失败：", error.message);
}
