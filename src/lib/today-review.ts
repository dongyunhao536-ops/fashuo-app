import { supabaseAdmin, fetchAllRows } from "./supabase";
import { bjDayStart, bjDayEnd, bjDateStr } from "./dates";
import { buildChapterIndex, type KpRow } from "./scheduler";

/**
 * 今日已背明细（RSC 直接调，零 LLM）。
 * 数据源=detection_log 今天的记录；按考点去重（保留最新一次结果 + 统计今天测了几次），
 * 关联 kp_state 取考点名/科目/章节定位 + next_due（下次出现时间）。
 * 供「今天背了哪些」页用——和背诵卡片同一套 科目→章→节 编号排版，并显示每个点的下次复习时间。
 */

const DAY_MS = 86400000;

export interface ReviewedItem {
  kp_id: string;
  name: string;
  subject: string;
  level: string;
  grade: string; // 最新一次 ai_grade：干净通过/勉强/未过
  passed: boolean;
  attempts: number; // 今天测这个考点的次数（含"再测一次"）
  question: string | null; // 最新一次的题目（供查看记录，不必重测）
  answer: string | null; // 最新一次的作答
  confidence: number | null;
  // 最新一次的评分结果正文（迁移007 起落库；历史行为空 → 前端提示重测补全）
  hits: string[]; // 命中要点
  missing: string[]; // 缺失要点
  explanation: string | null; // 为什么没过 / 评分理由
  // 章节定位（与背诵卡片同源，buildChapterIndex 推导）
  chapterNo: number;
  chapterName: string;
  sectionNo: number;
  sectionName: string;
  seq: number; // 该科教材内全局序号（= kp_id 尾号）
  // 下次出现
  nextDue: string | null; // 北京日历日串，如 2026-06-26
  nextDueLabel: string; // 友好相对文案："今天可复习" / "明天" / "3 天后" / "已掌握" / "未排期"
}

export interface TodayReviewed {
  items: ReviewedItem[];
  total: number; // 去重考点数
  passedCount: number; // 最新结果=干净通过 的考点数
}

/** next_due → 相对今天（北京日）的友好文案 + 具体日期。
 *  「已掌握」是里程碑（三档至少各过一次），不代表退出复习——卡仍按 next_due 复现，
 *  故 mastered 也要显示具体日期（用户 2026-06-27：「我要具体日期」）。 */
function nextDueLabel(nextDue: string | null, mastered: boolean, todayStr: string): string {
  if (!nextDue) return mastered ? "已掌握" : "未排期";
  const days = Math.round((Date.parse(nextDue) - Date.parse(todayStr)) / DAY_MS);
  if (Number.isNaN(days)) return mastered ? "已掌握" : "未排期";
  const [, mm, dd] = nextDue.split("-");
  const md = `${Number(mm)}月${Number(dd)}日`;
  let rel: string;
  if (days <= 0) rel = `今天可复习（${md}）`;
  else if (days === 1) rel = `明天 ${md}`;
  else rel = `${days} 天后 ${md}`;
  return mastered ? `已掌握 · ${rel}` : rel;
}

export async function getTodayReviewed(): Promise<TodayReviewed> {
  const todayStr = bjDateStr(new Date());
  const { data: logs } = await supabaseAdmin
    .from("detection_log")
    .select("kp_id, level, ai_grade, passed, ts, question, answer, confidence, hits, missing, explanation")
    .gte("ts", bjDayStart(todayStr))
    .lte("ts", bjDayEnd(todayStr))
    .order("ts", { ascending: false }); // 最新在前 → 去重时第一条即最新结果

  // 去重：每考点保留最新结果，attempts 累计今天的次数
  const byKp = new Map<string, ReviewedItem>();
  for (const r of logs ?? []) {
    const kp = r.kp_id;
    if (!kp) continue;
    const seen = byKp.get(kp);
    if (seen) {
      seen.attempts++;
    } else {
      byKp.set(kp, {
        kp_id: kp,
        name: kp,
        subject: "",
        level: String(r.level ?? ""),
        grade: String(r.ai_grade ?? ""),
        passed: !!r.passed,
        attempts: 1,
        question: r.question != null ? String(r.question) : null,
        answer: r.answer != null ? String(r.answer) : null,
        confidence: typeof r.confidence === "number" ? r.confidence : null,
        hits: Array.isArray(r.hits) ? (r.hits as unknown[]).map(String) : [],
        missing: Array.isArray(r.missing) ? (r.missing as unknown[]).map(String) : [],
        explanation: r.explanation != null ? String(r.explanation) : null,
        chapterNo: 0,
        chapterName: "未分类",
        sectionNo: 0,
        sectionName: "",
        seq: Number(kp.split("-")[1]) || 0,
        nextDue: null,
        nextDueLabel: "未排期",
      });
    }
  }

  const ids = [...byKp.keys()];
  if (ids.length === 0) return { items: [], total: 0, passedCount: 0 };

  // 章节编号需全科考点（与背诵卡片严格一致）；明细只取今天测过的几个考点 ext/next_due。
  const [allLoc, { data: kps }] = await Promise.all([
    fetchAllRows<{ kp_id: string; subject: string; parent_kp: string | null }>((from, to) =>
      supabaseAdmin.from("kp_state").select("kp_id, subject, parent_kp").order("kp_id").range(from, to),
    ),
    supabaseAdmin.from("kp_state").select("kp_id, subject, ext, next_due, mastered").in("kp_id", ids),
  ]);

  const chapterIndex = buildChapterIndex(allLoc as unknown as KpRow[]);
  for (const k of kps ?? []) {
    const item = byKp.get(k.kp_id);
    if (!item) continue;
    item.subject = k.subject;
    item.name = (k.ext as { name?: string })?.name ?? k.kp_id;
    item.nextDue = (k.next_due as string | null) ?? null;
    item.nextDueLabel = nextDueLabel(item.nextDue, !!k.mastered, todayStr);
    const lc = chapterIndex.get(k.kp_id);
    if (lc) {
      item.chapterNo = lc.chapterNo;
      item.chapterName = lc.chapterName;
      item.sectionNo = lc.sectionNo;
      item.sectionName = lc.sectionName;
    }
  }

  const items = [...byKp.values()]; // Map 保插入序=最新在前
  return {
    items,
    total: items.length,
    passedCount: items.filter((i) => i.grade === "干净通过").length,
  };
}
