import { supabaseAdmin } from "./supabase";
import { bjDayStart, bjWeekMonday } from "./dates";
import { getErrorBook, type ErrorItem } from "./errorbook";

/**
 * 周复盘·真实数据聚合。只聚合【答疑 + 教练 + 待办 + 成本】：
 *   学了什么   = study_log(章节/活动，云在教练页汇报的)
 *   解决了什么 = study_error 本周已吸收
 *   需关注     = 错题本(=弱项，study_error open 聚合) + 答疑未收口卡点
 * 既直接喂 /weekly 页，又作 weekly-narrative.ts 复盘/指导层的【唯一事实源】。零 LLM（纯 SQL + 纯函数排版）。
 */

export interface WeeklyReview {
  weekStart: string;
  weekEnd: string;
  activity: { askPointsCreated?: number; asks?: number; coachLogs: number };
  /** 本周学了什么：study_log 按科目聚合的章节 + 活动 */
  studied: { subject: string; chapters: string[]; activities: string[] }[];
  /** 解决了什么：本周吸收的错题 */
  solved: { absorbedErrors: { subject: string; knowledge: string }[] };
  /** 错题本（=弱项）当前未吸收 Top（与错题页/教练/仪表盘同源聚合） */
  weak: { top: ErrorItem[] };
  askPoints: { subject: string; confusion: string; type: string | null }[];
  askPointClosure?: { clarified: number; dismissed: number; superseded: number; active: number; expired: number };
  inbox: { createdByType: Record<string, number>; pendingBacklog: number };
  cost: { totalUsd: number; byRoute: { route: string; usd: number }[] };
  /** 带"学习效果"(feeling)的流水——带背/背诵掌握轨迹，喂给复盘层（可选：老数据/单测可无） */
  effects?: { subject: string; chapter: string | null; activity: string; feeling: string }[];
  /** 上一份周报（用于周与周叙事衔接；可选） */
  priorReport?: { weekStart: string; content: string } | null;
}

// 2026-07-30 补「英语」：英语 2026-07-10 已接入账本（subject=英语，dashboard.ts 有独立四维、计入综合指数），
// 但这里的白名单还停在五科，导致英语 study_log 落了库却在「本周学了什么」和「学习效果」里整块消失
// ——云 07-30 刷完首篇 2016 Text 1（100%）后当场发现看不到。与 scripts/weekly.mjs 的白名单对齐。
// 注：五科雷达/覆盖率仍不含英语（章节口径不同），那是 dashboard.ts 的 SUBJECTS，别混改。
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史", "英语"];
// "学了什么" 只认这几类【实打实学习动作】——含带背(PC辅导带背，云 2026-07-07 要求计入)；把闲聊/被考(复盘)/策略讨论(其他)/未识别排除。
// 2026-07-28 补「复盘」：量化 v3 已把复盘计入"检验"台阶（见 dashboard.ts 文件头），
// 这里却还停在 v2 的旧白名单，导致云最高频的动作（销账/讲解）在「本周学了什么」里整块消失。
// 2026-07-31 补「看书」：自学看书＝输入台阶，此前无此档被塞进「听课」（云当日点名）；白名单漏掉它会重演英语那次"整块消失"。
const STUDY_ACTIVITIES = new Set(["听课", "看书", "做题", "背诵", "带背", "复盘"]);

export async function buildWeeklyReview(today = new Date()): Promise<WeeklyReview> {
  // 自然周窗口（云 2026-07-01）：北京时间本周一 ~ 周日，不再滚动最近 7 天。
  // week_start 整周不变 → weekly_report 同周覆盖真正生效；周一 cron 传昨天锚点即复盘上一整周。
  const weekStart = bjWeekMonday(today);
  // 纯日期加法（按 UTC 零点算，只为 +6 天得周日，不涉及时刻）
  const weekEnd = new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const sinceTs = bjDayStart(weekStart);

  const [studyRes, askRes, evCreatedRes, evPendingRes, usageRes, absorbedRes, errorBook, priorReportRes] =
    await Promise.all([
      supabaseAdmin.from("study_log").select("subject, chapter, activity, feeling").gte("log_date", weekStart),
      supabaseAdmin.from("ask_point_v2").select("id, subject, confusion, question_type, status, effective_status, active, created_at, resolved_at").limit(5000),
      supabaseAdmin.from("events").select("type").gte("created_at", sinceTs),
      supabaseAdmin.from("events").select("type").eq("status", "pending"),
      supabaseAdmin.from("api_usage").select("route, est_cost_usd").gte("ts", sinceTs),
      // 解决了什么：本周吸收的错题（study_error.absorbed_at 在窗内）
      supabaseAdmin
        .from("study_error")
        .select("subject, knowledge, absorbed_at")
        .eq("status", "absorbed")
        .gte("absorbed_at", sinceTs),
      // 错题本（=弱项）当前未吸收，聚合与错题页/教练/仪表盘同源
      getErrorBook(),
      // 上一份周报（周与周衔接：读上周复盘/指导，本周对照落实/欠账）
      supabaseAdmin.from("weekly_report").select("week_start, content").lt("week_start", weekStart).order("week_start", { ascending: false }).limit(1),
    ]);

  const study = studyRes.data ?? [];
  const asks = askRes.data ?? [];
  const inWeek = (value: unknown) => {
    const date = value == null ? "" : String(value).slice(0, 10);
    return date >= weekStart && date <= weekEnd;
  };
  const askCreated = asks.filter((a) => inWeek(a.created_at));
  const askResolved = asks.filter((a) => inWeek(a.resolved_at));

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

  // —— 带背/背诵学习效果（feeling·掌握轨迹）：喂复盘层定"下周精度重点"；不卡章节（小结行 chapter=null 也收）——
  const effects = study
    .filter((s) => SUBJECTS.includes((s.subject as string) ?? "") && s.feeling)
    .map((s) => ({
      subject: s.subject as string,
      chapter: (s.chapter as string | null) ?? null,
      activity: (s.activity as string | null) ?? "",
      feeling: String(s.feeling),
    }));

  const pr = priorReportRes.data?.[0];
  const priorReport = pr ? { weekStart: String(pr.week_start), content: String(pr.content ?? "").slice(0, 1500) } : null;

  // —— 解决了什么 ——
  const absorbedErrors = (absorbedRes.data ?? [])
    .filter((r) => r.knowledge)
    .map((r) => ({ subject: (r.subject as string | null) ?? "未分类", knowledge: String(r.knowledge) }));

  // —— 答疑未收口卡点：只认 active=true（TTL 过期退出；普通提问从不进这张表）——
  const askPoints = asks
    .filter((a) => a.confusion && a.active === true)
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
    activity: { askPointsCreated: askCreated.length, coachLogs: study.length },
    studied,
    effects,
    priorReport,
    solved: { absorbedErrors },
    weak: { top: errorBook.slice(0, 8) },
    askPoints,
    askPointClosure: {
      clarified: askResolved.filter((a) => a.status === "clarified").length,
      dismissed: askResolved.filter((a) => a.status === "dismissed").length,
      superseded: askResolved.filter((a) => a.status === "superseded").length,
      active: asks.filter((a) => a.active === true).length,
      expired: asks.filter((a) => a.effective_status === "expired").length,
    },
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
  L.push(`· 活动量：新增答疑卡点 ${r.activity.askPointsCreated ?? r.activity.asks ?? 0} 条（不是答疑次数） / 教练打卡 ${r.activity.coachLogs} 条`);

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

  if (r.effects?.length) {
    L.push(`· 带背/学习效果（掌握轨迹，据此定下周精度重点）：`);
    for (const e of r.effects) {
      L.push(`  - ${e.subject}${e.chapter ? "·" + e.chapter : ""}【${e.activity}】：${e.feeling}`);
    }
  }

  L.push(
    `· 解决了什么：本周吸收错题 ${r.solved.absorbedErrors.length} 个${
      r.solved.absorbedErrors.length
        ? "：" + r.solved.absorbedErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、")
        : ""
    }`,
  );

  L.push(`· 需关注：`);
  L.push(`  - 错题本（=弱项，未吸收）：${r.weak.top.map((w) => `${w.subject ?? "未分类"}·${w.knowledge}${w.n > 1 ? `(×${w.n})` : ""}`).join("、") || "（暂无错次记录）"}`);
  L.push(`  - 答疑未收口卡点：${r.askPoints.map((a) => `${a.subject}${a.type ? "·" + a.type : ""} ${a.confusion}`).join("；") || "（无）"}`);
  if (r.askPointClosure) L.push(`  - 答疑卡点闭环：本周打通 ${r.askPointClosure.clarified} / 移噪 ${r.askPointClosure.dismissed} / 被新卡点顶替 ${r.askPointClosure.superseded}；当前有效 open ${r.askPointClosure.active} / 过期 open ${r.askPointClosure.expired}`);

  L.push(`· 待办筐：本周新增 ${Object.entries(r.inbox.createdByType).map(([t, n]) => `${t}${n}`).join("/") || "无"}；待处理积压 ${r.inbox.pendingBacklog} 条`);

  if (r.priorReport?.content) {
    L.push(`\n【上一份周报（${r.priorReport.weekStart} 那周）——衔接用：对照上周"下周指导"看本周落实/欠账，别孤立地只讲本周】`);
    L.push(r.priorReport.content);
  }
  return L.join("\n");
}
