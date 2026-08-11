import { supabaseAdmin } from "./supabase";
import type { ErrorItem } from "./errorbook";
import { bjDateStr, bjWeekMonday, bjDayStart } from "./dates";
import { EXAM_OUTLINE } from "./exam-outline.gen";
import { buildQuantV3, scoreEnglishV3, scoreSubjectV3 } from "./quant-v3.mjs";
import { buildTargetReadinessV4 } from "./readiness-v4.mjs";
import coachConfig from "../../config/coach.json";

/**
 * [gpt] 2026-08-10：今日页主量化升级到“目标达成指数 v4”。
 * v3.1 继续负责把历史流水压成覆盖/深度/背诵等基础证据，v4 再按 378 目标、真实三张已追踪试卷、
 * 训练正确率、错题风险和模考闸门合成唯一主数；政治自管且无过程证据，按 0 证据显式进入 378 分母。
 */

/**
 * 历史量化 v3.1 兼容层（保留给 PC 快照与性质测试，不再直接作为首页主指数）：
 * 全部落真实数据、透明标注依据，不编分。核心理念——"覆盖≠掌握，北大区分度在深度与均衡"：
 *   - 章节识别：优先按《考试分析》官方【章节标题】匹配官方章号（治"云的章号≠官方章号"），退回解析"第X章"数字（封顶总章数）。
 *   - 能力台阶：每章按经历的台阶累积——听课=输入(in) / 做题·复盘=检验(test) / 背诵·带背=输出(out)。
 *     （复盘＝最高频活动，v2 里被丢弃，v3 计入"检验"台阶；带背仍计入"输出"。）
 *
 * 【铁律一】覆盖型维度（广度/深度/背诵）分母恒为「总章数」，绝不许用「已覆盖章」当分母。
 *   缺证据时自然趋 0，不需要任何兜底。否则"只听 1 章"会被算成"平均厚度 33%"这种虚高。
 * 【铁律二】比率型维度（闭环率/正确率）不许当加分项，只能当乘法折扣系数作用在实体分上；
 *   且必须平滑（+K 条虚拟"未销账"观测）、保守锚取 0（未登记的错题一律按未销账算）。
 *   掌握度 = 覆盖 × 质量，本就是乘法；加法允许"覆盖满分＋质量为零"仍拿 70 分，荒谬。
 *   保守锚令「瞒报错题必亏」在数学上成立，于是不再需要任何借来的先验。
 * 新增维度一律照这两条办。四条性质测试（dashboard.test.ts）钉死它们，改公式必须先跑绿。
 *
 *   - 各科能力 = 实体分 × 质量系数：
 *       实体分 = (广度0.25 + 深度0.20 + 背诵0.25)/0.70 ×100
 *         · 广度 = 覆盖章/总章   · 深度 = Σmin(台阶,3)/3 / 总章   · 背诵 = 有"输出"台阶的章/总章
 *       质量系数 = 0.5 + 0.5×闭环质量，闭环质量 = 已吸收/(已见+K) ×(1−0.5×重犯率)
 *         （下限 0.5＝错题全不销账最多打对折，不归零：覆盖本身在考场上有分。）
 *         ⚠️ 2026-07-31 更正一句写错的不变量：原注写「登记未销账错题不掉分」——**只在 absorbed=0 时成立**。
 *           absorbed>0 时 open 进了分母，多登记一条诚实的未销账错题确实会掉分（实测刑法 50→49；
 *           把 25 条 open 全瞒下、只留 27 条销账 → 质量 73→88、能力 +9~10，法理同形 +10，合计综合指数 +3）。
 *           这是「诚实税」，不是 bug：闭环率本来就该拖分，而瞒报无法从数据侧识别。**故意不改公式**——
 *           把 open 从分母里拿掉能让 ∂quality/∂open=0（可证明的激励相容），代价是「挂账 43 条」这个
 *           云的核心病根在能力分里彻底隐形（刑法会从 45 跳到 57），信号损失大于激励收益。
 *           改为：①测试侧钉死这笔税的上界（P3-c），常数一改就报警；②每次报指数时口头披露它。
 *     由 深度≤广度、背诵≤广度 ⇒ 实体分 ≤ 100×广度 ⇒ 能力 ≤ 100×广度 **结构性成立**：
 *     只摸过 5% 的章，哪怕这 5% 吃得透透的，对整科的掌握度也不可能超 5%。数学上界，非启发式。
 *   - 专业课指数 = 分值加权均 ×0.7 + 最弱科 ×0.3（法硕有单科线，一科瘸腿全盘皆输→反偏科）。
 *   - 英语能力（2026-07-10 接入·云拍板计入综合）：无覆盖底座，铁律二不适用（读准是"水平"本身、
 *       不是质量折扣），仍用加权四维——读准0.45（近8篇均值 × 样本闸 min(1,篇数/4)·75+过关线=稳80）
 *       + 节奏0.20（近14天篇数/4 封顶）+ 作文0.20（近30天篇数/2 封顶）+ 闭环0.15（同保守平滑）。
 *   - 综合备考指数 = 专业课 ×0.75 + 英语 ×0.25（按分值 300:100；政治不追踪不计入）。
 *     英语刚启动无数据时能力≈0 会拉低综合——这是严标准设计（只认账本行为），刷起来即回升。
 *
 * —— 已知失真清单（2026-07-31 立·云问"综合指数两天不涨、是不是虚低"时逐条量化出来的；
 *      都不是算错，是量表本身的边界。报数时该披露哪条就披露，别让他拿指数当唯一方向盘）——
 *   ① **章级粒度双向偏**：广度分母是「章」，触到一章即记满 1，章内后续再深耕对广度＝0。
 *      法制史实况（EXAM_OUTLINE 实测）：全书 7 章、18 节（绪论无节，按 1 个单位算＝19 个节级单位），
 *      「第四章 隋唐宋」自己占 3 节，且是真题占比第一的章（2014-2025 综合卷 203 题里隋唐 34 题、16.7%）。
 *      云 7-28~7-30 啃的隋＋唐（约 1.7 节）→ 章级广度 14%(1/7)、节级只值 ~9%(1.7/19)：**当前是偏高、不是偏低**；
 *      但他在第四章里再啃两晚，广度一动不动。要修得换节级底座（EXAM_OUTLINE 已有节标题）＝又一个断点，未做。
 *   ② **综合指数两侧不同尺**（stock vs flow）：专业课是存量（分母＝全书总章，按月动），英语大头是水平/节奏
 *      （读准过 4 篇样本闸、节奏分母 4 篇/14 天，按天动）。实测：英语 1 篇 80% ＝ 综合 +4（0→14）、4 篇 ＝ 综合 +14；
 *      而一整晚法制史（第四章 2→3 台阶）＝ 专业课 +0.06，四舍五入归零。**指数对英语过敏、对已覆盖章加深近乎失明**。
 *      这是"英语 100 分完全没数据"的严标准设计取舍，不当 bug 改；但别把 11→25 读成水平翻倍。
 *   ③ **诚实税 ≈ 综合 3 分**：见上文质量系数处的 2026-07-31 更正。
 *
 * —— 口径变更日志（改公式必须在此留痕；断点前后的历史评估报告/周报分数不可比）——
 *   v3.0 2026-07-07 建。
 *   v3.1 2026-07-26 根治「缺证据时默认给分」这一类失效（同一失效模式第 4 次现形，故改为立铁律+性质测试）：
 *     ① 深度分母 已覆盖章 → 总章。原口径下民法只听 1 章、深度即 33%；且"多听一章新课反而掉分"
 *        （某科 5 章满台阶再听第 6 章：广度 +1.25 分、深度 100→88.9 扣 2.22 分，净 −1）。
 *     ② 闭环从加分项改为乘法折扣系数，删除 closurePrior（借他科闭环率当先验）。原口径下民法能力
 *        20 分里 11.9 分是借来的——刑法多登记 2 道错题，民法一节课没上也跟着掉 1 分；且法理把 12 条
 *        错题全删掉，能力反涨 2 分（58→60），说明 7-22 堵的"不记错题反而赚"并没堵死。
 *     ③ 英语读准加样本闸。原口径下第 1 篇阅读拿 80%，英语能力当场 41 分。
 */

export interface SubjectStatV3 {
  subject: string;
  weight: number;      // 分值权重（占比越高越重要）
  total: number;       // 官方总章数
  covered: number;     // 触及章数（听课/做题/背诵/带背/复盘任一台阶）
  progress: number;    // 广度 covered/total ×100
  depth: number;       // 深度：Σmin(台阶,3)/3 / total ×100（铁律一：分母恒为总章，不是已覆盖章）
  recitePct: number;   // 背诵密度：有"输出(背诵)"台阶的章 / total ×100
  open: number;        // 未闭环错题数
  absorbed: number;    // 已吸收错题数
  repeat: number;      // 重犯错题条数（同一知识点反复错）
  closure: number | null; // 错题闭环健康度实测值（闭环率×重犯惩罚）×100，无错题=null（仅供展示）
  quality: number;     // 质量系数 ×100（铁律二：实际乘在实体分上的那个数，50-100）
  ability: number;     // 各科能力分 0-100 = 实体分 × 质量系数
}

export interface SubjectStat extends SubjectStatV3 {
  target: number;
  maximum: number;
  stock: number;              // 广度/深度/背诵形成的过程存量 0-100
  performance: number | null; // 最近 8 条训练正确率均值
  performanceSamples: number;
  performanceConfidence: number;
  riskPenalty: number;
  stalenessPenalty: number;
  lastEvidenceDate: string | null;
  mastery: { total: number; open: number; monitoring: number; stable: number; recurrent: number };
  readiness: number;          // 当前结构证据折算的满分能力 0-100
  estimatedScore: number;
  targetAttainment: number;   // 对该科目标分的达成 0-100
}

export interface EnglishStatV3 {
  ability: number;          // 英语能力 0-100（读准0.45+节奏0.20+作文0.20+闭环0.15）
  reading: number | null;   // 近8篇阅读 accuracy 均值，无篇=null
  papers14d: number;        // 近14天英语打卡条数（节奏分母4）
  essays30d: number;        // 近30天作文篇数（分母2）
  open: number;
  absorbed: number;
  closure: number | null;
}

export interface EnglishStat extends EnglishStatV3 {
  target: number;
  maximum: number;
  performance: number | null;
  performanceSamples: number;
  stock: number;
  riskPenalty: number;
  stalenessPenalty: number;
  lastEvidenceDate: string | null;
  mastery: { total: number; open: number; monitoring: number; stable: number; recurrent: number };
  readiness: number;
  estimatedScore: number;
  targetAttainment: number;
}

export interface PaperReadiness {
  paper: string;
  targetScore: number;
  estimatedScore: number;
  attainment: number;
  subjects: string[];
}

export interface DashboardData {
  hero: { today: string; examDate: string; daysLeft: number; daysToBase: number };
  overall: {
    index: number;
    processIndex: number;
    trackedIndex: number;
    pointAttainment: number;
    paperBalance: number;
    supportedPoints: number;
    trackedTargetPoints: number;
    fullTarget: number;
    untrackedTargetPoints: number;
    weakestPaper: { paper: string; attainment: number };
    calibration: {
      tier: string;
      label: string;
      completeMocks: number;
      requiredMocks: number;
      mockIndex: number | null;
      mockWeight: number;
    };
    papers: PaperReadiness[];
    notStarted: number;
    english: EnglishStat;
    /** v3.1 兼容诊断；不再参与首页主指数。 */
    legacy: { proIndex: number; balanced: number; weakest: { subject: string; ability: number } };
  };
  subjects: SubjectStat[];
  ask: { openCount: number; lastConfusion: string | null };
  coach: { openErrors: number };
  inbox: { pendingCount: number; byType: Record<string, number> };
  today: { studied: { subject: string; chapter: string | null; activity: string }[]; absorbed: number };
  week: { absorbed: number; logs: number };
  top5: ErrorItem[];
  /** 首页「日报」栏摘要行：最新一份日报的靶心句（当天的没出就退回派单）。纯展示，不入量化。 */
  daily: string | null;
}

// 2026-07-22 订正：原 2026-12-21 是【周一】，初试不可能在周一。12-19=周六，与云"距考 150 天"吻合。
// 与 config/coach.json「考试日期」保持同源；教育部 9 月官宣后需复核一次。
const EXAM_DATE = "2026-12-19";
const BASE_DEADLINE = "2026-09-30";
const DAY = 86400000;

/**
 * 各科能力打分（纯函数）。性质测试直接打这里 —— 改动前先让 dashboard.test.ts 跑绿。
 * chapSteps: 每个已覆盖章走过的台阶数(1..3)；outChapters: 其中有"输出(背诵)"台阶的章数。
 */
export function scoreSubject(ev: {
  total: number;
  chapSteps: number[];
  outChapters: number;
  open: number;
  absorbed: number;
  repeat: number;
}): Omit<SubjectStatV3, "subject" | "weight" | "total"> {
  return scoreSubjectV3(ev) as Omit<SubjectStatV3, "subject" | "weight" | "total">;
}

/** 英语能力打分（纯函数）。无覆盖底座 → 仍是加权四维，但读准过样本闸、闭环用同一条保守平滑。 */
export function scoreEnglish(ev: {
  accs: number[]; // 近 8 篇阅读正确率 0-100（已排除作文）
  papers14d: number;
  essays30d: number;
  open: number;
  absorbed: number;
  repeat: number;
}): EnglishStatV3 {
  return scoreEnglishV3(ev) as EnglishStatV3;
}

export async function getDashboard(): Promise<DashboardData> {
  const now = new Date();
  const todayStr = bjDateStr(now);
  const weekStart = bjWeekMonday(now);

  const [askLatest, askCount, eventsPending, allLog, allErr, errorBook, dailyLatest] = await Promise.all([
    supabaseAdmin.from("ask_point_v2").select("confusion").eq("active", true).order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("ask_point_v2").select("*", { count: "exact", head: true }).eq("active", true),
    supabaseAdmin.from("events").select("type").eq("status", "pending"),
    supabaseAdmin.from("study_log").select("subject, chapter, activity, accuracy, log_date, raw_input").order("log_date", { ascending: false }).limit(1000),
    supabaseAdmin.from("study_error").select("subject, knowledge, status, absorbed_at, log_date, kp_id, source").in("status", ["open", "absorbed"]).limit(3000),
    // [gpt] v4 只读主题掌握态，用 stable/monitoring 抵消对应错题风险；查询失败不冒充“已稳定”。
    supabaseAdmin.from("error_book_v2").select("study_error_id, log_date, event_subject, event_status, topic_id, topic_subject, mastery_status").limit(5000),
    // 日报只取最新一条的靶心句/派单，给首页「日报」栏当摘要行（2026-07-28）。
    // 不参与任何量化计算——量化 v3 的口径别因为加了个展示字段被动过（见记忆 today-quant-v3-beida）。
    supabaseAdmin.from("daily_report").select("report_date, headline, dispatch").order("report_date", { ascending: false }).limit(1),
  ]);

  const daysLeft = Math.max(0, Math.ceil((new Date(EXAM_DATE).getTime() - now.getTime()) / DAY));
  const daysToBase = Math.ceil((new Date(BASE_DEADLINE).getTime() - now.getTime()) / DAY);
  const byType: Record<string, number> = {};
  for (const e of eventsPending.data ?? []) byType[e.type] = (byType[e.type] ?? 0) + 1;

  // 查询失败时 supabase-js 只在 .error 里报，data 为 null。原先直接 ?? [] 吞掉 ——
  // 结果是"数据库连不上"和"一条记录都没有"在页面上长得一模一样（全科未启动、综合 0 分）。
  // 这与本文件"不编分"的原则冲突：读不到数据就该喊，而不是渲染一个假的零。
  if (allLog.error) console.error("[dashboard] study_log 查询失败（能力分会偏低）:", allLog.error.message);
  if (allErr.error) console.error("[dashboard] study_error 查询失败（闭环质量会偏低）:", allErr.error.message);
  if (errorBook.error) console.error("[dashboard] error_book_v2 查询失败（错题风险按未获冷复检抵消处理）:", errorBook.error.message);
  const logs = allLog.data ?? [];
  const errs = allErr.data ?? [];
  const topicRows = errorBook.data ?? [];

  const studied = logs.filter((r) => r.log_date === todayStr).map((r) => ({
    subject: (r.subject as string | null) ?? "未识别",
    chapter: (r.chapter as string | null) ?? null,
    activity: (r.activity as string | null) ?? "其他",
  }));
  const weekLogs = logs.filter((r) => String(r.log_date) >= weekStart).length;
  const todayTs = bjDayStart(todayStr), weekTs = bjDayStart(weekStart);
  const todayAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= todayTs).length;
  const weekAbsorbed = errs.filter((r) => r.status === "absorbed" && r.absorbed_at && String(r.absorbed_at) >= weekTs).length;

  // v3 只生成基础证据；首页唯一主数由 v4 按目标分与真实试卷重新聚合。
  const quant = buildQuantV3({ logs, errors: errs, referenceDate: todayStr, examOutline: EXAM_OUTLINE });
  const readiness = buildTargetReadinessV4({
    quantV3: quant,
    logs,
    topicRows,
    referenceDate: todayStr,
    targets: coachConfig["目标分"],
    mockRecords: coachConfig["模拟分记录"]?.["记录"] ?? [],
  });
  const subjects = readiness.subjects as SubjectStat[];
  const english = readiness.english as EnglishStat;

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
    hero: { today: todayStr, examDate: EXAM_DATE, daysLeft, daysToBase },
    overall: {
      ...readiness.overall,
      papers: readiness.papers as PaperReadiness[],
      english,
      legacy: {
        proIndex: quant.overall.proIndex,
        balanced: quant.overall.balanced,
        weakest: quant.overall.weakest,
      },
    },
    subjects,
    ask: { openCount: askCount.count ?? 0, lastConfusion: askLatest.data?.[0]?.confusion ?? null },
    coach: { openErrors: openAgg.size },
    inbox: { pendingCount: (eventsPending.data ?? []).length, byType },
    today: { studied, absorbed: todayAbsorbed },
    week: { absorbed: weekAbsorbed, logs: weekLogs },
    top5: openItems.slice(0, 5),
    daily: (() => {
      const r = dailyLatest.data?.[0];
      if (!r) return null;
      const body = r.headline ?? r.dispatch ?? null;
      if (!body) return null;
      // 不是今天的就标出来——日报靠电脑端 17:20 定时出，没开机会顺延，
      // 首页不能让昨天的结论看起来像今天的（见记忆 report-fake-numbers）。
      return String(r.report_date) === todayStr ? body : `${String(r.report_date).slice(5)}：${body}`;
    })(),
  };
}
