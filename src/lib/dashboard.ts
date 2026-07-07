import { supabaseAdmin } from "./supabase";
import type { ErrorItem } from "./errorbook";
import { bjDateStr, bjWeekMonday, bjDayStart } from "./dates";
import { EXAM_OUTLINE } from "./exam-outline.gen";

/**
 * 今日页数据聚合（RSC 直接调）。2026-07-06 量化重做（更严谨）：
 * 量化全部落真实数据、透明标注依据，不编分：
 *   - 章节识别：优先按《考试分析》官方【章节标题】匹配官方章号（治"云的章号≠官方章号"，如云"第八章正当化"官方是第四章），
 *     退回解析"第X章"数字（云自己的编号，封顶总章数）——比纯数字更真实。
 *   - 分维度：铺开(听课/做题) / 背诵(背诵) 分开算；错题闭环(absorbed/(open+absorbed))。
 *   - 各科能力 = 0.45×铺开率 + 0.30×背诵率 + 0.25×闭环率（无错题则前两项重归一化）。
 *   - 综合备考指数 = 各科能力按【分值权重】加权平均。
 */

export interface SubjectStat {
  subject: string;
  weight: number;
  total: number;
  learned: number; // 听课/做题铺开章数
  recited: number; // 背诵章数
  covered: number; // 铺开∪背诵 去重章数
  progress: number; // 铺开率 covered/total ×100
  recitePct: number; // 背诵率 ×100
  open: number;
  absorbed: number;
  closure: number | null; // 错题闭环率 ×100
  ability: number; // 综合能力分 0-100
}

export interface DashboardData {
  hero: { examDate: string; daysLeft: number; daysToBase: number };
  overall: { index: number };
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
    supabaseAdmin.from("study_log").select("subject, chapter, activity, log_date").order("log_date", { ascending: false }).limit(1000),
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

  // 各科：铺开(听课/做题) / 背诵 章节集合
  const learnedBy = new Map<string, Set<number>>();
  const recitedBy = new Map<string, Set<number>>();
  for (const r of logs) {
    const subj = r.subject as string;
    const ch = r.chapter as string | null;
    const act = (r.activity as string | null) ?? "";
    if (!SUBJECTS.includes(subj) || !ch) continue;
    const target = act === "背诵" || act === "带背" ? recitedBy : act === "听课" || act === "做题" ? learnedBy : null; // 带背(PC辅导带背)计入"背诵"维度·云2026-07-07
    if (!target) continue;
    const set = target.get(subj) ?? new Set<number>();
    for (const n of detectChapters(subj, ch)) set.add(n);
    target.set(subj, set);
  }
  const errBy = new Map<string, { open: number; absorbed: number }>();
  for (const r of errs) {
    const s = (r.subject as string | null) ?? "未分类";
    const e = errBy.get(s) ?? { open: 0, absorbed: 0 };
    if (r.status === "absorbed") e.absorbed++; else e.open++;
    errBy.set(s, e);
  }

  const subjects: SubjectStat[] = SUBJECTS.map((s) => {
    const total = TOTAL_CH[s];
    const learnedSet = learnedBy.get(s) ?? new Set<number>();
    const recitedSet = recitedBy.get(s) ?? new Set<number>();
    const covered = new Set<number>([...learnedSet, ...recitedSet]);
    const progress = Math.round((covered.size / total) * 100);
    const recitePct = Math.round((recitedSet.size / total) * 100);
    const e = errBy.get(s) ?? { open: 0, absorbed: 0 };
    const seen = e.open + e.absorbed;
    const closure = seen > 0 ? Math.round((e.absorbed / seen) * 100) : null;
    // 能力 = 0.45铺开 + 0.30背诵 + 0.25闭环（无错题→前两项重归一化到 0.75）
    const R1 = progress / 100, R2 = recitePct / 100, R3 = closure != null ? closure / 100 : null;
    const ability = Math.round((R3 != null ? 0.45 * R1 + 0.3 * R2 + 0.25 * R3 : (0.45 * R1 + 0.3 * R2) / 0.75) * 100);
    return { subject: s, weight: WEIGHT[s], total, learned: learnedSet.size, recited: recitedSet.size, covered: covered.size, progress, recitePct, open: e.open, absorbed: e.absorbed, closure, ability };
  });

  const wSum = SUBJECTS.reduce((a, s) => a + WEIGHT[s], 0);
  const index = Math.round(subjects.reduce((a, x) => a + x.weight * x.ability, 0) / wSum);

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
    overall: { index },
    subjects,
    ask: { openCount: askCount.count ?? 0, lastConfusion: askLatest.data?.[0]?.confusion ?? null },
    coach: { openErrors: openAgg.size },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    today: { studied, absorbed: todayAbsorbed },
    week: { absorbed: weekAbsorbed, logs: weekLogs },
    top5: openItems.slice(0, 5),
  };
}
