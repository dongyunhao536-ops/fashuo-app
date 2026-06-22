import { supabaseAdmin } from "./supabase";
import { bjDateStr, bjDayStart } from "./dates";

/**
 * 周复盘·真实数据聚合（系统设计 BUILD_PLAN 🔖）。
 * 【所有字段必须来源其他模块的真实使用数据】——零编造：
 *   学了/背了什么 = study_log(章节/活动) + detection_log(本周测过的考点/通过率)
 *   解决了什么     = study_error 本周已吸收 + 复验请求本周已消费 + 本周检测通过的考点
 *   弱项是什么     = kp_state Top错次 + study_error 未吸收 + 本周反复失败 + 答疑未收口卡点
 * 这份聚合既直接喂 /weekly 页展示，又作为 weekly-narrative.ts 复盘/指导层的【唯一事实源】。
 * 本文件零 LLM（纯 SQL + 纯函数排版）；复盘/下周指导的权威叙事在 weekly-narrative.ts。
 */

const AUDIT_CONFIDENCE = 70; // 低于此信心的评分进审计抽样

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  activity: { detections: number; asks: number; coachLogs: number };
  /** 本周学了/背了什么：study_log 按科目聚合的章节 + 活动 */
  studied: { subject: string; chapters: string[]; activities: string[] }[];
  /** 本周测过的去重考点数（detection_log） */
  kpTested: number;
  passByLevel: { level: string; passed: number; total: number; pct: number }[];
  passBySubject: { subject: string; passed: number; total: number; pct: number }[];
  /** 解决了什么（真实闭环兑现） */
  solved: {
    absorbedErrors: { subject: string; knowledge: string }[]; // 本周吸收的错题
    reviewResolved: number; // 本周消费的复验请求
    passedKp: number; // 本周检测通过的去重考点
  };
  /** 弱项全景 */
  weak: {
    top: { kp_id: string; subject: string; name: string; errorCount: number }[];
    openErrors: { subject: string; knowledge: string }[]; // 未吸收自报错题
    repeatedFails: { kp_id: string; subject: string; name: string; failCount: number }[];
  };
  askPoints: { subject: string; confusion: string; type: string | null }[];
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
const nameOf = (ext: unknown, fallback: string) => (ext as { name?: string })?.name ?? fallback;

export async function buildWeeklyReview(today = new Date()): Promise<WeeklyReview> {
  const weekEnd = bjDateStr(today);
  const weekStartDate = new Date(today.getTime() - 6 * 86400000);
  const weekStart = bjDateStr(weekStartDate);
  const sinceTs = bjDayStart(weekStart);

  const [
    detRes,
    studyRes,
    askRes,
    evCreatedRes,
    evPendingRes,
    usageRes,
    absorbedRes,
    openErrRes,
    reviewDoneRes,
    topWeakRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("detection_log")
      .select("kp_id, level, passed, ai_grade, confidence, starred, question")
      .gte("ts", sinceTs),
    supabaseAdmin.from("study_log").select("subject, chapter, activity").gte("log_date", weekStart),
    supabaseAdmin.from("ask_summary").select("subject, confusion, question_type").gte("created_at", sinceTs),
    supabaseAdmin.from("events").select("type").gte("created_at", sinceTs),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs),
    // 解决了什么①：本周吸收的错题（study_error.absorbed_at 在窗内）
    supabaseAdmin
      .from("study_error")
      .select("subject, knowledge, absorbed_at")
      .eq("status", "absorbed")
      .gte("absorbed_at", sinceTs),
    // 弱项①：未吸收自报错题（开口子的）
    supabaseAdmin.from("study_error").select("subject, knowledge").eq("status", "open").limit(40),
    // 解决了什么②：本周消费的复验请求（答疑澄清后背诵复验兑现）
    supabaseAdmin
      .from("events")
      .select("id")
      .eq("type", "复验请求")
      .eq("status", "consumed")
      .gte("consumed_at", sinceTs),
    // 弱项②：错次最多的考点（与仪表盘/教练同口径）
    supabaseAdmin
      .from("kp_state")
      .select("kp_id, subject, ext, error_count")
      .gt("error_count", 0)
      .eq("mastered", false)
      .order("error_count", { ascending: false })
      .limit(8),
  ]);

  const det = detRes.data ?? [];
  const study = studyRes.data ?? [];
  const asks = askRes.data ?? [];

  // —— 通过率（按档 / 按科目）+ 本周测过/通过的考点 ——
  const levelAgg = new Map<string, { passed: number; total: number }>();
  const failByKp = new Map<string, number>();
  const kpTestedSet = new Set<string>();
  const kpPassedSet = new Set<string>();
  for (const d of det) {
    const lv = String(d.level ?? "?");
    const la = levelAgg.get(lv) ?? { passed: 0, total: 0 };
    la.total++;
    if (d.passed) la.passed++;
    else if (d.kp_id) failByKp.set(d.kp_id, (failByKp.get(d.kp_id) ?? 0) + 1);
    levelAgg.set(lv, la);
    if (d.kp_id) {
      kpTestedSet.add(d.kp_id);
      if (d.passed) kpPassedSet.add(d.kp_id);
    }
  }
  const passByLevel = [...levelAgg.entries()]
    .map(([level, a]) => ({ level, passed: a.passed, total: a.total, pct: pct(a.passed, a.total) }))
    .sort((a, b) => a.level.localeCompare(b.level));

  // kp→subject/name（按科目通过率 + 反复失败命名）
  const failedKpIds = [...failByKp.keys()];
  const allKpIds = [...new Set(det.map((d) => d.kp_id).filter((x): x is string => !!x))];
  const kpMetaRes = allKpIds.length
    ? await supabaseAdmin.from("kp_state").select("kp_id, subject, ext").in("kp_id", allKpIds)
    : { data: [] as { kp_id: string; subject: string; ext: unknown }[] };
  const kpMeta = new Map(
    (kpMetaRes.data ?? []).map((k) => [k.kp_id, { subject: k.subject, name: nameOf(k.ext, k.kp_id) }]),
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

  // —— 本周学了/背了什么：study_log 按科目聚合章节 + 活动 ——
  const studyMap = new Map<string, { chapters: Set<string>; activities: Set<string> }>();
  for (const s of study) {
    const subj = (s.subject as string | null) ?? "未识别";
    const row = studyMap.get(subj) ?? { chapters: new Set<string>(), activities: new Set<string>() };
    if (s.chapter) row.chapters.add(String(s.chapter));
    if (s.activity) row.activities.add(String(s.activity));
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
  const solved = {
    absorbedErrors,
    reviewResolved: (reviewDoneRes.data ?? []).length,
    passedKp: kpPassedSet.size,
  };

  // —— 弱项全景 ——
  const topWeak = (topWeakRes.data ?? []).map((k) => ({
    kp_id: k.kp_id as string,
    subject: k.subject as string,
    name: nameOf(k.ext, k.kp_id as string),
    errorCount: (k.error_count as number) ?? 0,
  }));
  // openErrors 去重（subject+knowledge）
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
  const repeatedFails = failedKpIds
    .map((kp_id) => ({
      kp_id,
      subject: kpMeta.get(kp_id)?.subject ?? "未知",
      name: kpMeta.get(kp_id)?.name ?? kp_id,
      failCount: failByKp.get(kp_id) ?? 0,
    }))
    .sort((a, b) => b.failCount - a.failCount)
    .slice(0, 8);

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
    studied,
    kpTested: kpTestedSet.size,
    passByLevel,
    passBySubject,
    solved,
    weak: { top: topWeak, openErrors, repeatedFails },
    askPoints,
    inbox: { createdByType, pendingBacklog: (evPendingRes.data ?? []).length },
    cost: {
      totalUsd,
      byRoute: [...routeUsd.entries()].map(([route, usd]) => ({ route, usd })).sort((a, b) => b.usd - a.usd),
    },
    gradingAudit,
  };
}

/**
 * 把真实聚合序列化成紧凑 markdown——【作为复盘/指导层的事实源喂给 Opus】（也可复制阅读）。
 * 纯函数、可单测。复盘层据此推理，故这里的数字/考点必须与 WeeklyReview 完全一致。
 */
export function formatWeeklyDataText(r: WeeklyReview): string {
  const L: string[] = [];
  L.push(`【本周真实使用数据 ${r.weekStart} ~ ${r.weekEnd}】`);
  L.push(`· 活动量：检测 ${r.activity.detections} 次 / 答疑 ${r.activity.asks} 次 / 教练打卡 ${r.activity.coachLogs} 条`);

  L.push(`· 学了/背了什么：`);
  if (r.studied.length) {
    for (const s of r.studied) {
      const ch = s.chapters.length ? s.chapters.join("、") : "（未记章节）";
      const act = s.activities.length ? s.activities.join("/") : "";
      L.push(`  - ${s.subject}：${ch}${act ? `　[${act}]` : ""}`);
    }
  } else {
    L.push(`  - （本周无学习流水记录）`);
  }
  L.push(`  - 本周检测覆盖 ${r.kpTested} 个去重考点；通过率：${r.passByLevel.map((x) => `${x.level} ${x.pct}%(${x.passed}/${x.total})`).join(" · ") || "无检测"}`);
  L.push(`  - 按科目通过率：${r.passBySubject.map((x) => `${x.subject} ${x.pct}%(${x.passed}/${x.total})`).join(" · ") || "—"}`);

  L.push(`· 解决了什么（真实闭环）：`);
  L.push(`  - 本周吸收错题 ${r.solved.absorbedErrors.length} 个${r.solved.absorbedErrors.length ? "：" + r.solved.absorbedErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、") : ""}`);
  L.push(`  - 本周检测通过 ${r.solved.passedKp} 个考点；复验兑现 ${r.solved.reviewResolved} 个`);

  L.push(`· 弱项是什么：`);
  L.push(`  - 错次最高（实证）：${r.weak.top.map((w) => `${w.subject}·${w.name}(错${w.errorCount})`).join("、") || "（暂无错次记录）"}`);
  L.push(`  - 本周反复失败：${r.weak.repeatedFails.map((f) => `${f.subject}·${f.name}(失败${f.failCount})`).join("、") || "（无）"}`);
  L.push(`  - 未吸收错题：${r.weak.openErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、") || "（无）"}`);
  L.push(`  - 答疑未收口卡点：${r.askPoints.map((a) => `${a.subject}${a.type ? "·" + a.type : ""} ${a.confusion}`).join("；") || "（无）"}`);

  L.push(`· 待办筐：本周新增 ${Object.entries(r.inbox.createdByType).map(([t, n]) => `${t}${n}`).join("/") || "无"}；待处理积压 ${r.inbox.pendingBacklog} 条`);
  return L.join("\n");
}
