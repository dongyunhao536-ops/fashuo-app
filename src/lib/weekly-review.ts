import { supabaseAdmin } from "./supabase";
import { bjDateStr, bjDayStart } from "./dates";
import { RMB_PER_USD } from "./cost";

/**
 * 周复盘聚合（系统设计 BUILD_PLAN 🔖）——把 5 张账本表转成"下周怎么调"的一页报告。
 * 零 LLM：纯 SQL 聚合 + 纯函数排版。云周日打开 /weekly 自助看；建议层（可选 Opus）另接。
 *
 * 含评分质量审计（#7）：本周低信心(confidence<阈值)或★的检测抽样，供人眼校准评分有没有漂。
 */

const AUDIT_CONFIDENCE = 70; // 低于此信心的评分进审计抽样

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  activity: { detections: number; asks: number; coachLogs: number };
  passByLevel: { level: string; passed: number; total: number; pct: number }[];
  passBySubject: { subject: string; passed: number; total: number; pct: number }[];
  study: {
    totalMinutes: number;
    bySubject: { subject: string; minutes: number }[];
    planAdoption: { 采纳: number; 改一改: number; 不按: number; rate: number | null };
  };
  askPoints: { subject: string; confusion: string; type: string | null }[];
  repeatedFails: { kp_id: string; subject: string; name: string; failCount: number }[];
  inbox: { createdByType: Record<string, number>; pendingBacklog: number };
  cost: { totalUsd: number; byRoute: { route: string; usd: number }[] };
  gradingAudit: {
    kp_id: string;
    level: string;
    grade: string | null;
    confidence: number | null;
    starred: boolean;
    question: string | null;
  }[];
}

const pct = (passed: number, total: number) => (total === 0 ? 0 : Math.round((passed / total) * 100));

export async function buildWeeklyReview(today = new Date()): Promise<WeeklyReview> {
  const weekEnd = bjDateStr(today);
  const weekStartDate = new Date(today.getTime() - 6 * 86400000);
  const weekStart = bjDateStr(weekStartDate);
  const sinceTs = bjDayStart(weekStart);

  const [detRes, studyRes, askRes, evCreatedRes, evPendingRes, usageRes] = await Promise.all([
    supabaseAdmin
      .from("detection_log")
      .select("kp_id, level, passed, ai_grade, confidence, starred, question")
      .gte("ts", sinceTs),
    supabaseAdmin.from("study_log").select("subject, minutes, plan_decision").gte("log_date", weekStart),
    supabaseAdmin.from("ask_summary").select("subject, confusion, question_type").gte("created_at", sinceTs),
    supabaseAdmin.from("events").select("type").gte("created_at", sinceTs),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs),
  ]);

  const det = detRes.data ?? [];
  const study = studyRes.data ?? [];
  const asks = askRes.data ?? [];

  // —— 通过率（按档 / 按科目）——
  const levelAgg = new Map<string, { passed: number; total: number }>();
  const failByKp = new Map<string, number>();
  for (const d of det) {
    const lv = String(d.level ?? "?");
    const la = levelAgg.get(lv) ?? { passed: 0, total: 0 };
    la.total++;
    if (d.passed) la.passed++;
    else if (d.kp_id) failByKp.set(d.kp_id, (failByKp.get(d.kp_id) ?? 0) + 1);
    levelAgg.set(lv, la);
  }
  const passByLevel = [...levelAgg.entries()]
    .map(([level, a]) => ({ level, passed: a.passed, total: a.total, pct: pct(a.passed, a.total) }))
    .sort((a, b) => a.level.localeCompare(b.level));

  // 按科目通过率需 kp→subject，统一在下方拉 kp 名称时一并取
  const failedKpIds = [...failByKp.keys()];
  const allKpIds = [...new Set(det.map((d) => d.kp_id).filter((x): x is string => !!x))];
  const kpMetaRes = allKpIds.length
    ? await supabaseAdmin.from("kp_state").select("kp_id, subject, ext").in("kp_id", allKpIds)
    : { data: [] as { kp_id: string; subject: string; ext: unknown }[] };
  const kpMeta = new Map(
    (kpMetaRes.data ?? []).map((k) => [k.kp_id, { subject: k.subject, name: (k.ext as { name?: string })?.name ?? k.kp_id }]),
  );

  const subjAgg = new Map<string, { passed: number; total: number }>();
  for (const d of det) {
    const subj = (d.kp_id && kpMeta.get(d.kp_id)?.subject) || "未知";
    const sa = subjAgg.get(subj) ?? { passed: 0, total: 0 };
    sa.total++;
    if (d.passed) sa.passed++;
    subjAgg.set(subj, sa);
  }
  const passBySubject = [...subjAgg.entries()]
    .map(([subject, a]) => ({ subject, passed: a.passed, total: a.total, pct: pct(a.passed, a.total) }))
    .sort((a, b) => b.total - a.total);

  // —— 学习投入 + 采纳率 ——
  const subjMin = new Map<string, number>();
  let totalMinutes = 0;
  const adopt = { 采纳: 0, 改一改: 0, 不按: 0 };
  for (const s of study) {
    const m = s.minutes ?? 0;
    totalMinutes += m;
    subjMin.set(s.subject, (subjMin.get(s.subject) ?? 0) + m);
    const d = s.plan_decision as keyof typeof adopt | null;
    if (d && d in adopt) adopt[d]++;
  }
  const adoptTotal = adopt.采纳 + adopt.改一改 + adopt.不按;
  const study_ = {
    totalMinutes,
    bySubject: [...subjMin.entries()].map(([subject, minutes]) => ({ subject, minutes })).sort((a, b) => b.minutes - a.minutes),
    planAdoption: { ...adopt, rate: adoptTotal === 0 ? null : Math.round((adopt.采纳 / adoptTotal) * 100) },
  };

  // —— 高频答疑卡点 ——
  const askPoints = asks
    .filter((a) => a.confusion)
    .slice(0, 10)
    .map((a) => ({ subject: a.subject, confusion: String(a.confusion), type: a.question_type ?? null }));

  // —— 本周反复失败考点 ——
  const repeatedFails = failedKpIds
    .map((kp_id) => ({
      kp_id,
      subject: kpMeta.get(kp_id)?.subject ?? "未知",
      name: kpMeta.get(kp_id)?.name ?? kp_id,
      failCount: failByKp.get(kp_id) ?? 0,
    }))
    .sort((a, b) => b.failCount - a.failCount)
    .slice(0, 8);

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

  // —— 评分质量审计抽样（本周低信心或★）——
  const gradingAudit = det
    .filter((d) => d.starred || (d.confidence != null && d.confidence < AUDIT_CONFIDENCE))
    .slice(0, 12)
    .map((d) => ({
      kp_id: String(d.kp_id ?? "?"),
      level: String(d.level ?? "?"),
      grade: d.ai_grade ?? null,
      confidence: d.confidence ?? null,
      starred: !!d.starred,
      question: d.question ? String(d.question).slice(0, 60) : null,
    }));

  return {
    weekStart,
    weekEnd,
    activity: { detections: det.length, asks: asks.length, coachLogs: study.length },
    passByLevel,
    passBySubject,
    study: study_,
    askPoints,
    repeatedFails,
    inbox: { createdByType, pendingBacklog: (evPendingRes.data ?? []).length },
    cost: {
      totalUsd,
      byRoute: [...routeUsd.entries()].map(([route, usd]) => ({ route, usd })).sort((a, b) => b.usd - a.usd),
    },
    gradingAudit,
  };
}

/** 纯函数：把聚合结果排成 markdown 文本（脚本/复制用；可单测） */
export function formatWeeklyReportText(r: WeeklyReview): string {
  const yuan = (usd: number) => `¥${(usd * RMB_PER_USD).toFixed(2)}`;
  const L: string[] = [];
  L.push(`# 周复盘 ${r.weekStart} ~ ${r.weekEnd}`);
  L.push("");
  L.push(`## 1. 活动量`);
  L.push(`- 检测 ${r.activity.detections} 次 · 答疑 ${r.activity.asks} 次 · 教练打卡 ${r.activity.coachLogs} 条`);
  L.push("");
  L.push(`## 2. 检测通过率`);
  L.push(`按档：${r.passByLevel.map((x) => `${x.level} ${x.pct}%(${x.passed}/${x.total})`).join(" · ") || "（本周无检测）"}`);
  L.push(`按科：${r.passBySubject.map((x) => `${x.subject} ${x.pct}%(${x.passed}/${x.total})`).join(" · ") || "—"}`);
  L.push("");
  L.push(`## 3. 学习投入`);
  L.push(`- 总时长 ${(r.study.totalMinutes / 60).toFixed(1)}h：${r.study.bySubject.map((x) => `${x.subject} ${(x.minutes / 60).toFixed(1)}h`).join(" · ") || "—"}`);
  L.push(
    `- 规划采纳率：${r.study.planAdoption.rate == null ? "（无表态）" : r.study.planAdoption.rate + "%"}（采纳${r.study.planAdoption.采纳}/改${r.study.planAdoption.改一改}/不按${r.study.planAdoption.不按}）`,
  );
  L.push("");
  L.push(`## 4. 高频答疑卡点`);
  L.push(r.askPoints.length ? r.askPoints.map((a) => `- [${a.subject}${a.type ? "·" + a.type : ""}] ${a.confusion}`).join("\n") : "（本周无答疑卡点记录）");
  L.push("");
  L.push(`## 5. 本周反复失败考点`);
  L.push(r.repeatedFails.length ? r.repeatedFails.map((f) => `- ${f.subject}·${f.name} 失败 ${f.failCount} 次（${f.kp_id}）`).join("\n") : "（本周无失败）");
  L.push("");
  L.push(`## 6. 待办筐`);
  L.push(`- 本周新增：${Object.entries(r.inbox.createdByType).map(([t, n]) => `${t} ${n}`).join(" · ") || "无"}`);
  L.push(`- 待处理积压：${r.inbox.pendingBacklog} 条`);
  L.push("");
  L.push(`## 7. 成本`);
  L.push(`- 本周合计 ${yuan(r.cost.totalUsd)}：${r.cost.byRoute.map((x) => `${x.route} ${yuan(x.usd)}`).join(" · ") || "—"}`);
  L.push("");
  L.push(`## 8. 评分质量审计（人眼校准用）`);
  L.push(
    r.gradingAudit.length
      ? r.gradingAudit
          .map((g) => `- ${g.starred ? "★ " : ""}${g.kp_id} ${g.level} 判「${g.grade}」信心${g.confidence ?? "?"}${g.question ? "：" + g.question : ""}`)
          .join("\n")
      : "（本周无低信心/★评分，评分稳定）",
  );
  return L.join("\n");
}
