import { supabaseAdmin } from "./supabase";
import { bjDateStr, bjDayStart } from "./dates";

/**
 * 周复盘·真实数据聚合。
 *
 * 背诵模块下线后（2026-06-29）只聚合【答疑 + 教练 + 待办 + 成本】的真实使用数据，
 * 原检测/通过率/按档·按科通过率/复验兑现/反复失败/评分审计等【背诵衍生统计】已整体撤掉：
 *   学了什么   = study_log(章节/活动)
 *   解决了什么 = study_error 本周已吸收
 *   弱项是什么 = kp_state Top错次 + study_error 未吸收 + 答疑未收口卡点
 * 既直接喂 /weekly 页，又作 weekly-narrative.ts 复盘/指导层的【唯一事实源】。零 LLM（纯 SQL + 纯函数排版）。
 */

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  activity: { asks: number; coachLogs: number };
  /** 本周学了什么：study_log 按科目聚合的章节 + 活动 */
  studied: { subject: string; chapters: string[]; activities: string[] }[];
  /** 解决了什么：本周吸收的错题 */
  solved: { absorbedErrors: { subject: string; knowledge: string }[] };
  /** 弱项全景 */
  weak: {
    top: { kp_id: string; subject: string; name: string; errorCount: number }[];
    openErrors: { subject: string; knowledge: string }[]; // 未吸收自报错题
  };
  askPoints: { subject: string; confusion: string; type: string | null }[];
  inbox: { createdByType: Record<string, number>; pendingBacklog: number };
  cost: { totalUsd: number; byRoute: { route: string; usd: number }[] };
}

const nameOf = (ext: unknown, fallback: string) => (ext as { name?: string })?.name ?? fallback;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
// "学了什么" 只认这三类【实打实学习动作】——把闲聊/被考(复盘)/策略讨论(其他)/未识别排除。
const STUDY_ACTIVITIES = new Set(["听课", "做题", "背诵"]);

export async function buildWeeklyReview(today = new Date()): Promise<WeeklyReview> {
  const weekEnd = bjDateStr(today);
  const weekStartDate = new Date(today.getTime() - 6 * 86400000);
  const weekStart = bjDateStr(weekStartDate);
  const sinceTs = bjDayStart(weekStart);

  const [studyRes, askRes, evCreatedRes, evPendingRes, usageRes, absorbedRes, openErrRes, topWeakRes] =
    await Promise.all([
      supabaseAdmin.from("study_log").select("subject, chapter, activity").gte("log_date", weekStart),
      supabaseAdmin.from("ask_summary").select("subject, confusion, question_type").gte("created_at", sinceTs),
      supabaseAdmin.from("events").select("type").gte("created_at", sinceTs),
      supabaseAdmin.from("events").select("type").eq("status", "pending"),
      supabaseAdmin.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs),
      // 解决了什么：本周吸收的错题（study_error.absorbed_at 在窗内）
      supabaseAdmin
        .from("study_error")
        .select("subject, knowledge, absorbed_at")
        .eq("status", "absorbed")
        .gte("absorbed_at", sinceTs),
      // 弱项①：未吸收自报错题
      supabaseAdmin.from("study_error").select("subject, knowledge").eq("status", "open").limit(40),
      // 弱项②：错次最多的考点（与仪表盘/教练同口径）
      supabaseAdmin
        .from("kp_state")
        .select("kp_id, subject, ext, error_count")
        .gt("error_count", 0)
        .eq("mastered", false)
        .order("error_count", { ascending: false })
        .limit(8),
    ]);

  const study = studyRes.data ?? [];
  const asks = askRes.data ?? [];

  // —— 本周学了什么：只取【实打实学习动作 + 真科目 + 有章节】的 study_log ——
  const studyMap = new Map<string, { chapters: Set<string>; activities: Set<string> }>();
  for (const s of study) {
    const subj = (s.subject as string | null) ?? "";
    const act = (s.activity as string | null) ?? "";
    if (!SUBJECTS.includes(subj) || !STUDY_ACTIVITIES.has(act) || !s.chapter) continue;
    const row = studyMap.get(subj) ?? { chapters: new Set<string>(), activities: new Set<string>() };
    row.chapters.add(String(s.chapter));
    row.activities.add(act);
    studyMap.set(subj, row);
  }
  const studied = [...studyMap.entries()].map(([subject, v]) => ({
    subject,
    chapters: [...v.chapters],
    activities: [...v.activities],
  }));

  // —— 解决了什么 ——
  const absorbedErrors = (absorbedRes.data ?? [])
    .filter((r) => r.knowledge)
    .map((r) => ({ subject: (r.subject as string | null) ?? "未分类", knowledge: String(r.knowledge) }));

  // —— 弱项全景 ——
  const topWeak = (topWeakRes.data ?? []).map((k) => ({
    kp_id: k.kp_id as string,
    subject: k.subject as string,
    name: nameOf(k.ext, k.kp_id as string),
    errorCount: (k.error_count as number) ?? 0,
  }));
  const seenErr = new Set<string>();
  const openErrors: { subject: string; knowledge: string }[] = [];
  for (const r of openErrRes.data ?? []) {
    if (!r.knowledge) continue;
    const subj = (r.subject as string | null) ?? "未分类";
    const key = `${subj}::${r.knowledge}`;
    if (seenErr.has(key)) continue;
    seenErr.add(key);
    openErrors.push({ subject: subj, knowledge: String(r.knowledge) });
    if (openErrors.length >= 15) break;
  }

  // —— 高频答疑卡点 ——
  const askPoints = asks
    .filter((a) => a.confusion)
    .slice(0, 10)
    .map((a) => ({ subject: a.subject, confusion: String(a.confusion), type: a.question_type ?? null }));

  // —— 待办筐流转 ——
  const createdByType: Record<string, number> = {};
  for (const e of evCreatedRes.data ?? []) createdByType[e.type] = (createdByType[e.type] ?? 0) + 1;

  // —— 成本 ——
  let totalUsd = 0;
  const routeUsd = new Map<string, number>();
  for (const u of usageRes.data ?? []) {
    const c = Number(u.est_cost_usd ?? 0);
    totalUsd += c;
    routeUsd.set(u.route, (routeUsd.get(u.route) ?? 0) + c);
  }

  return {
    weekStart,
    weekEnd,
    activity: { asks: asks.length, coachLogs: study.length },
    studied,
    solved: { absorbedErrors },
    weak: { top: topWeak, openErrors },
    askPoints,
    inbox: { createdByType, pendingBacklog: (evPendingRes.data ?? []).length },
    cost: {
      totalUsd,
      byRoute: [...routeUsd.entries()].map(([route, usd]) => ({ route, usd })).sort((a, b) => b.usd - a.usd),
    },
  };
}

/**
 * 把真实聚合序列化成紧凑 markdown——【作为复盘/指导层的事实源喂给 Opus】（也可复制阅读）。
 * 纯函数、可单测。复盘层据此推理，故这里的数字/考点必须与 WeeklyReview 完全一致。
 */
export function formatWeeklyDataText(r: WeeklyReview): string {
  const L: string[] = [];
  L.push(`【本周真实使用数据 ${r.weekStart} ~ ${r.weekEnd}】`);
  L.push(`· 活动量：答疑 ${r.activity.asks} 次 / 教练打卡 ${r.activity.coachLogs} 条`);

  L.push(`· 学了什么：`);
  if (r.studied.length) {
    for (const s of r.studied) {
      const ch = s.chapters.length ? s.chapters.join("、") : "（未记章节）";
      const act = s.activities.length ? s.activities.join("/") : "";
      L.push(`  - ${s.subject}：${ch}${act ? `　[${act}]` : ""}`);
    }
  } else {
    L.push(`  - （本周无学习流水记录）`);
  }

  L.push(
    `· 解决了什么：本周吸收错题 ${r.solved.absorbedErrors.length} 个${
      r.solved.absorbedErrors.length
        ? "：" + r.solved.absorbedErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、")
        : ""
    }`,
  );

  L.push(`· 弱项是什么：`);
  L.push(`  - 错次最高：${r.weak.top.map((w) => `${w.subject}·${w.name}(错${w.errorCount})`).join("、") || "（暂无错次记录）"}`);
  L.push(`  - 未吸收错题：${r.weak.openErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、") || "（无）"}`);
  L.push(`  - 答疑未收口卡点：${r.askPoints.map((a) => `${a.subject}${a.type ? "·" + a.type : ""} ${a.confusion}`).join("；") || "（无）"}`);

  L.push(`· 待办筐：本周新增 ${Object.entries(r.inbox.createdByType).map(([t, n]) => `${t}${n}`).join("/") || "无"}；待处理积压 ${r.inbox.pendingBacklog} 条`);
  return L.join("\n");
}
