import { supabaseAdmin } from "./supabase";
import type { ErrorItem } from "./errorbook";
import { bjDateStr, bjWeekMonday, bjDayStart } from "./dates";
import { EXAM_OUTLINE } from "./exam-outline.gen";

/**
 * 今日页数据聚合（RSC 直接调）。2026-07-07 量化 v3（北大 375+ 严标准·更全面/真实）：
 * 全部落真实数据、透明标注依据，不编分。核心理念——"覆盖≠掌握，北大区分度在深度与均衡"：
 *   - 章节识别：优先按《考试分析》官方【章节标题】匹配官方章号（治"云的章号≠官方章号"），退回解析"第X章"数字（封顶总章数）。
 *   - 能力台阶：每章按经历的台阶累积——听课=输入(in) / 做题·复盘=检验(test) / 背诵·带背=输出(out)。
 *     （复盘＝最高频活动，v2 里被丢弃，v3 计入"检验"台阶；带背仍计入"输出"。）
 *   - 各科能力（四维·北大严标准）= 广度0.25 + 深度0.20 + 背诵0.25 + 闭环0.30（无错题→前三维重归一化到0.70）：
 *       · 广度 = 覆盖章/总章（"听过"权重从 v2 的 0.45 砍到 0.25，不虚高）
 *       · 深度 = 已覆盖章平均台阶厚度/3（3 台阶=输入→检验→输出全走过=吃透）
 *       · 背诵 = 有"输出"台阶的章/总章
 *       · 闭环 = 闭环率 ×(1−0.5×重犯率)（同一知识点反复错=没真懂，扣分）
 *   - 专业课指数 = 分值加权均 ×0.7 + 最弱科 ×0.3（法硕有单科线，一科瘸腿全盘皆输→反偏科）。
 *   - 英语能力（2026-07-10 接入·云拍板计入综合）：章节四维不适用（无章节底座），改用英语自己的四维——
 *       读准0.45（近8篇阅读 accuracy 均值·75+过关线=稳80）+ 节奏0.20（近14天篇数/4 封顶）
 *       + 作文0.20（近30天作文篇数/2 封顶·零准备是真实短板）+ 闭环0.15（同专业课口径；无错题重归一化）。
 *   - 综合备考指数 = 专业课 ×0.75 + 英语 ×0.25（按分值 300:100；政治不追踪不计入）。
 *     英语刚启动无数据时能力≈0 会拉低综合——这是严标准设计（只认账本行为），刷起来即回升。
 */

export interface SubjectStat {
  subject: string;
  weight: number;      // 分值权重（占比越高越重要）
  total: number;       // 官方总章数
  covered: number;     // 触及章数（听课/做题/背诵/带背/复盘任一台阶）
  progress: number;    // 广度 covered/total ×100
  depth: number;       // 深度：已覆盖章平均经历的能力台阶(输入→检验→输出)厚度 ×100
  recitePct: number;   // 背诵密度：有"输出(背诵)"台阶的章 / total ×100
  open: number;        // 未闭环错题数
  absorbed: number;    // 已吸收错题数
  repeat: number;      // 重犯错题条数（同一知识点反复错）
  closure: number | null; // 错题闭环健康度（闭环率×重犯惩罚）×100，无错题=null
  ability: number;     // 各科能力分 0-100（北大严标准四维加权）
}

export interface EnglishStat {
  ability: number;          // 英语能力 0-100（读准0.45+节奏0.20+作文0.20+闭环0.15）
  reading: number | null;   // 近8篇阅读 accuracy 均值，无篇=null
  papers14d: number;        // 近14天英语打卡条数（节奏分母4）
  essays30d: number;        // 近30天作文篇数（分母2）
  open: number;
  absorbed: number;
  closure: number | null;
}

export interface DashboardData {
  hero: { examDate: string; daysLeft: number; daysToBase: number };
  overall: { index: number; proIndex: number; balanced: number; weakest: { subject: string; ability: number }; notStarted: number; english: EnglishStat };
  subjects: SubjectStat[];
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  today: { studied: { subject: string; chapter: string | null; activity: string }[]; absorbed: number };
  week: { absorbed: number; logs: number };
  top5: ErrorItem[];
}

const EXAM_DATE = "2026-12-21";
const BASE_DEADLINE = "2026-09-30";
const DAY = 86400000;
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const TOTAL_CH: Record<string, number> = { 刑法: 21, 民法: 21, 法理: 13, 宪法: 5, 法制史: 7 };
const WEIGHT: Record<string, number> = { 刑法: 75, 民法: 75, 法理: 60, 宪法: 50, 法制史: 40 };

// —— 解析《考试分析》知识架构 → {科目: [{num, keys:[章标题, ...节标题]}]}（供按标题匹配官方章号）——
const OUTLINE: Record<string, { num: number; keys: string[] }[]> = (() => {
  const CN = "一二三四五六七八九十";
  const cn2num = (t: string): number | null => {
    if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
    if (t === "十") return 10;
    if (t.startsWith("二十")) return t === "二十" ? 20 : 20 + CN.indexOf(t[2]) + 1;
    if (t.startsWith("十")) return 10 + CN.indexOf(t[1]) + 1;
    const i = CN.indexOf(t);
    return i >= 0 ? i + 1 : null;
  };
  const out: Record<string, { num: number; keys: string[] }[]> = {};
  for (const block of EXAM_OUTLINE.split("◆").slice(1)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const subj = SUBJECTS.find((s) => lines[0]?.startsWith(s));
    if (!subj) continue;
    const chapters: { num: number; keys: string[] }[] = [];
    for (const ln of lines.slice(1)) {
      const m = ln.match(/^第([0-9一二三四五六七八九十]+)章\s*([^：:]*)(?:[：:](.*))?$/);
      if (!m) continue;
      const num = cn2num(m[1]);
      if (num == null) continue;
      const title = (m[2] || "").trim();
      const sections = (m[3] || "").split(/[；;]/).map((s) => s.replace(/^第[0-9一二三四五六七八九十]+节\s*/, "").trim()).filter((s) => s.length >= 2);
      chapters.push({ num, keys: [title, ...sections].filter((k) => k.length >= 2) });
    }
    out[subj] = chapters;
  }
  return out;
})();

/** 从日志章节自由文本识别出覆盖的官方章号集合：优先章/节标题匹配，退回解析"第X章"数字（封顶）。 */
function detectChapters(subject: string, text: string): Set<number> {
  const found = new Set<number>();
  const total = TOTAL_CH[subject] ?? 99;
  for (const c of OUTLINE[subject] ?? []) {
    if (c.keys.some((k) => text.includes(k))) found.add(c.num);
  }
  if (found.size === 0) {
    // 无标题命中 → 退回云自己的"第X章"编号（可能与官方错位，仅作计数兜底）
    const CN = "一二三四五六七八九十";
    const re = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const t = m[1];
      let n: number | null = /^[0-9]+$/.test(t) ? parseInt(t, 10) : t === "十" ? 10 : t.startsWith("二十") ? (t === "二十" ? 20 : 20 + CN.indexOf(t[2]) + 1) : t.startsWith("十") ? 10 + CN.indexOf(t[1]) + 1 : CN.indexOf(t) + 1;
      if (n && n >= 1 && n <= total) found.add(n);
    }
    if (found.size === 0 && /绪论/.test(text)) found.add(1);
  }
  return found;
}

export async function getDashboard(): Promise<DashboardData> {
  const now = new Date();
  const todayStr = bjDateStr(now);
  const weekStart = bjWeekMonday(now);

  const [askLatest, askCount, eventsPending, allLog, allErr] = await Promise.all([
    supabaseAdmin.from("ask_summary").select("confusion").eq("status", "open").order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("ask_summary").select("*", { count: "exact", head: true }).eq("status", "open"),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin.from("study_log").select("subject, chapter, activity, accuracy, log_date").order("log_date", { ascending: false }).limit(1000),
    supabaseAdmin.from("study_error").select("subject, knowledge, status, absorbed_at, log_date").in("status", ["open", "absorbed"]).limit(3000),
  ]);

  const daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE).getTime() - now.getTime()) / DAY));
  const daysToBase = Math.ceil((new Date(BASE_DEADLINE).getTime() - now.getTime()) / DAY);
  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const logs = allLog.data ?? [];
  const errs = allErr.data ?? [];

  const studied = logs.filter((r) => r.log_date === todayStr).map((r) => ({
    subject: (r.subject as string | null) ?? "未识别",
    chapter: (r.chapter as string | null) ?? null,
    activity: (r.activity as string | null) ?? "其他",
  }));
  const weekLogs = logs.filter((r) => String(r.log_date) >= weekStart).length;
  const todayTs = bjDayStart(todayStr), weekTs = bjDayStart(weekStart);
  const todayAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= todayTs).length;
  const weekAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= weekTs).length;

  // —— 各科能力台阶（四维之源）：每章按经历的台阶累积 听课=输入(in) / 做题·复盘=检验(test) / 背诵·带背=输出(out)。
  //    复盘(最高频活动)与带背首次纳入——检验/输出是"吃透"的量化，非"听过=会了"。
  const stepsBy = new Map<string, Map<number, Set<string>>>();
  const stepOf = (act: string): "in" | "test" | "out" | null =>
    act === "听课" ? "in" : act === "做题" || act === "复盘" ? "test" : act === "背诵" || act === "带背" ? "out" : null;
  for (const r of logs) {
    const subj = r.subject as string;
    const ch = r.chapter as string | null;
    const step = stepOf((r.activity as string | null) ?? "");
    if (!SUBJECTS.includes(subj) || !ch || !step) continue;
    let m = stepsBy.get(subj);
    if (!m) { m = new Map(); stepsBy.set(subj, m); }
    for (const n of detectChapters(subj, ch)) {
      let set = m.get(n);
      if (!set) { set = new Set(); m.set(n, set); }
      set.add(step);
    }
  }
  // —— 错题：按科统计 闭环 + 重犯（同一知识点反复错=没真懂，北大扣分；dismissed 已在查询侧排除）——
  const errBy = new Map<string, { open: number; absorbed: number; repeat: number }>();
  const knowSeen = new Map<string, number>();
  for (const r of errs) {
    const s = (r.subject as string | null) ?? "未分类";
    const e = errBy.get(s) ?? { open: 0, absorbed: 0, repeat: 0 };
    if (r.status === "absorbed") e.absorbed++; else e.open++;
    errBy.set(s, e);
    const k = `${s}::${r.knowledge}`;
    knowSeen.set(k, (knowSeen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of knowSeen) {
    if (n <= 1) continue;
    const e = errBy.get(k.slice(0, k.indexOf("::")));
    if (e) e.repeat += n - 1;
  }

  const subjects: SubjectStat[] = SUBJECTS.map((s) => {
    const total = TOTAL_CH[s];
    const chapMap = stepsBy.get(s) ?? new Map<number, Set<string>>();
    const covered = chapMap.size;
    const progress = Math.round((covered / total) * 100);
    const outChs = [...chapMap.values()].filter((set) => set.has("out")).length;
    const recitePct = Math.round((outChs / total) * 100);
    let depthSum = 0;
    for (const set of chapMap.values()) depthSum += Math.min(set.size, 3) / 3; // 3 台阶(输入→检验→输出)全走过=吃透
    const depth = covered > 0 ? Math.round((depthSum / covered) * 100) : 0;
    const e = errBy.get(s) ?? { open: 0, absorbed: 0, repeat: 0 };
    const seen = e.open + e.absorbed;
    const closure = seen > 0 ? Math.round((e.absorbed / seen) * (1 - 0.5 * (e.repeat / seen)) * 100) : null;
    // 各科能力（北大严标准）= 广度0.25 + 深度0.20 + 背诵0.25 + 闭环0.30（无错题→前三维重归一化到 0.70）
    const B = progress / 100, D = depth / 100, R = recitePct / 100, C = closure != null ? closure / 100 : null;
    const ability = Math.round(100 * (C != null
      ? 0.25 * B + 0.20 * D + 0.25 * R + 0.30 * C
      : (0.25 * B + 0.20 * D + 0.25 * R) / 0.70));
    return { subject: s, weight: WEIGHT[s], total, covered, progress, depth, recitePct, open: e.open, absorbed: e.absorbed, repeat: e.repeat, closure, ability };
  });

  // 专业课指数（北大严标准）= 分值加权均 ×0.7 + 最弱科 ×0.3（法硕有单科线，一科瘸腿全盘皆输→反偏科）
  const wSum = SUBJECTS.reduce((a, s) => a + WEIGHT[s], 0);
  const balanced = Math.round(subjects.reduce((a, x) => a + x.weight * x.ability, 0) / wSum);
  const weakestSub = subjects.reduce((m, x) => (x.ability < m.ability ? x : m), subjects[0]);
  const proIndex = Math.round(0.7 * balanced + 0.3 * weakestSub.ability);
  const notStarted = subjects.filter((x) => x.covered === 0 && x.open === 0 && x.absorbed === 0).length;

  // —— 英语能力（无章节底座 → 英语自己的四维；口径见文件头注释）——
  const enLogs = logs.filter((r) => r.subject === "英语");
  const accs = enLogs.filter((r) => r.accuracy != null && !/作文/.test(String(r.chapter ?? ""))).slice(0, 8).map((r) => Number(r.accuracy));
  const reading = accs.length > 0 ? Math.round(accs.reduce((a, b) => a + b, 0) / accs.length) : null;
  const d14 = bjDateStr(new Date(now.getTime() - 14 * DAY)), d30 = bjDateStr(new Date(now.getTime() - 30 * DAY));
  const papers14d = enLogs.filter((r) => String(r.log_date) >= d14).length;
  const essays30d = enLogs.filter((r) => String(r.log_date) >= d30 && /作文/.test(String(r.chapter ?? ""))).length;
  const enErr = errBy.get("英语") ?? { open: 0, absorbed: 0, repeat: 0 };
  const enSeen = enErr.open + enErr.absorbed;
  const enClosure = enSeen > 0 ? Math.round((enErr.absorbed / enSeen) * (1 - 0.5 * (enErr.repeat / enSeen)) * 100) : null;
  const eR = (reading ?? 0) / 100, eP = Math.min(1, papers14d / 4), eW = Math.min(1, essays30d / 2), eC = enClosure != null ? enClosure / 100 : null;
  const englishAbility = Math.round(100 * (eC != null
    ? 0.45 * eR + 0.20 * eP + 0.20 * eW + 0.15 * eC
    : (0.45 * eR + 0.20 * eP + 0.20 * eW) / 0.85));
  const english: EnglishStat = { ability: englishAbility, reading, papers14d, essays30d, open: enErr.open, absorbed: enErr.absorbed, closure: enClosure };

  // 综合备考指数 = 专业课 ×0.75 + 英语 ×0.25（分值 300:100；政治不追踪。2026-07-10 云拍板英语计入）
  const index = Math.round(0.75 * proIndex + 0.25 * englishAbility);

  const openAgg = new Map<string, ErrorItem>();
  for (const r of errs) {
    if (r.status !== "open" || !r.knowledge) continue;
    const subj = (r.subject as string | null) ?? null;
    const key = `${subj ?? "未分类"}::${r.knowledge}`;
    const cur = openAgg.get(key) ?? { subject: subj, knowledge: String(r.knowledge), n: 0, last: "" };
    cur.n++;
    const d = String(r.log_date ?? "");
    if (d > cur.last) cur.last = d;
    openAgg.set(key, cur);
  }
  const openItems = [...openAgg.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1));

  return {
    hero: { examDate: EXAM_DATE, daysLeft, daysToBase },
    overall: { index, proIndex, balanced, weakest: { subject: weakestSub.subject, ability: weakestSub.ability }, notStarted, english },
    subjects,
    ask: { openCount: askCount.count ?? 0, lastConfusion: askLatest.data?.[0]?.confusion ?? null },
    coach: { openErrors: openAgg.size },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    today: { studied, absorbed: todayAbsorbed },
    week: { absorbed: weekAbsorbed, logs: weekLogs },
    top5: openItems.slice(0, 5),
  };
}
