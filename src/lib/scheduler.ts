import schedulerCfg from "../../config/scheduler.json";

/**
 * 背诵调度器（build order ③ · 系统设计/03 §3.2 调度模型 + /06 每日清单形态）。
 *
 * 每日清单 = 复验请求(G2，最高优先) + 到期复习(价值加权排序) + 新考点(配速器额度)。
 * 优先级 = (w1·真题频率 + w2·弱项加权 + w3·科目权重) × 遗忘紧迫度（加权和×门控，防纯乘法归零）。
 * 纯逻辑、零 LLM 花费。数值全外置在 config/scheduler.json（调参不改代码）。
 *
 * 冷启动：295 刑法考点全为 untested → 走"新考点池"，按价值 V（真题频率主导）排序引入。
 */

type Cfg = typeof schedulerCfg;
const CFG = schedulerCfg as Cfg;

export interface KpRow {
  kp_id: string;
  subject: string;
  parent_kp: string | null;
  cap_level: string;
  cur_level: string;
  l1_status: string;
  l2_status: string;
  l3_status: string;
  difficulty: number;
  interval_idx: number;
  last_review: string | null;
  next_due: string | null;
  mastered: boolean;
  review_count: number;
  error_count: number;
  ext: Record<string, unknown>;
}

export interface PlanItem {
  kp_id: string;
  subject: string;
  name: string;
  parent_kp: string | null;
  level: string; // 本次检测档（cur_level）
  bucket: "复验" | "到期" | "新考点";
  value: number; // 价值 V
  urgency: number; // 遗忘紧迫度 U
  priority: number; // 排序分 P
  zhenti_freq: string;
  reason: string;
}

const DAY_MS = 86400000;
const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY_MS);

/** 当前阶段模式（按 config 的切换日期） */
export function currentStage(today = new Date()): string {
  let mode = CFG.阶段开关.当前模式;
  for (const sw of CFG.阶段开关.切换) {
    if (today >= new Date(sw.date)) mode = sw.模式;
  }
  return mode;
}

function subjectWeight(subject: string, stage: string): number {
  const table = CFG.阶段开关.科目权重 as Record<string, Record<string, number>>;
  // "纯弱项+主观题模板"阶段无独立表 → 回退到"高频+弱项优先"
  const row = table[stage] ?? table["高频+弱项优先"] ?? {};
  return row[subject] ?? 1.0;
}

/** 价值 V = w1·真题频率 + w2·弱项加权 + w3·科目权重 */
export function valueOf(kp: KpRow, stage: string): number {
  const f = CFG.调度公式;
  const freq = String(kp.ext?.zhenti_freq ?? "低");
  const freqScore = (f.真题频率映射 as Record<string, number>)[freq] ?? 1;
  const weakWeight = Math.min(kp.error_count, 5); // 弱项错误频率，封顶 5 防爆
  const subjW = subjectWeight(kp.subject, stage);
  return f.w1_真题频率 * freqScore + f.w2_弱项加权 * weakWeight + f.w3_科目权重 * subjW;
}

/** 遗忘紧迫度 U：到期度 = 距上次复习天数 ÷ 当前档间隔；U = max(0, 到期度 − 1) */
export function urgencyOf(kp: KpRow, today = new Date()): number {
  if (!kp.last_review || kp.review_count === 0) return 0; // 未复习过 → 走新考点池，不算到期
  const interval = CFG.间隔档_天[kp.interval_idx] ?? CFG.间隔档_天[0];
  const since = daysBetween(today, new Date(kp.last_review));
  return Math.max(0, since / interval - 1);
}

/** 配速器：每日新考点额度 = 剩余未学考点 ÷ 到结业死线的天数 */
export function paceQuota(untestedCount: number, today = new Date()): number {
  const milestone = new Date(CFG.红线预警.基础结业死线);
  const daysLeft = Math.max(1, daysBetween(milestone, today));
  return Math.max(1, Math.ceil(untestedCount / daysLeft));
}

const nameOf = (kp: KpRow) => String(kp.ext?.name ?? kp.kp_id);

const SUBJECT_ORDER = ["刑法", "民法", "法理", "宪法", "法制史"];
const subjectRank = (s: string) => {
  const i = SUBJECT_ORDER.indexOf(s);
  return i === -1 ? 99 : i;
};

/**
 * 生成今日背诵清单。
 * @param kps        全部考点状态（可按 subject 预过滤）
 * @param reviewKpIds G2 复验请求的考点ID（events 里 type=复验请求 pending）
 * @param capacity   每日清单容量上限（在职防过载，默认 30）
 */
export function buildDailyPlan(opts: {
  kps: KpRow[];
  reviewKpIds?: string[];
  capacity?: number;
  today?: Date;
}): {
  stage: string;
  date: string;
  items: PlanItem[];
  counts: { 复验: number; 到期: number; 新考点: number; 总数: number; 未学剩余: number };
} {
  const today = opts.today ?? new Date();
  const capacity = opts.capacity ?? 30;
  const stage = currentStage(today);
  const reviewSet = new Set(opts.reviewKpIds ?? []);

  const mk = (kp: KpRow, bucket: PlanItem["bucket"], urgency: number, reason: string): PlanItem => {
    const value = valueOf(kp, stage);
    return {
      kp_id: kp.kp_id,
      subject: kp.subject,
      name: nameOf(kp),
      parent_kp: kp.parent_kp,
      level: kp.cur_level,
      bucket,
      value: Number(value.toFixed(2)),
      urgency: Number(urgency.toFixed(2)),
      priority: Number((value * (1 + urgency)).toFixed(2)),
      zhenti_freq: String(kp.ext?.zhenti_freq ?? "低"),
      reason,
    };
  };

  const untested = opts.kps.filter(
    (k) => !k.mastered && k.review_count === 0 && !reviewSet.has(k.kp_id),
  );

  // ① 复验（G2）——最高优先，全部纳入
  const 复验 = opts.kps
    .filter((k) => reviewSet.has(k.kp_id))
    .map((k) => mk(k, "复验", urgencyOf(k, today), "答疑澄清后复验(G2)"))
    .sort((a, b) => b.priority - a.priority);

  // ② 到期复习——复习过且已到期，按 P 降序
  const 到期 = opts.kps
    .filter((k) => !reviewSet.has(k.kp_id) && k.review_count > 0 && urgencyOf(k, today) > 0)
    .map((k) => mk(k, "到期", urgencyOf(k, today), "间隔到期需复习"))
    .sort((a, b) => b.priority - a.priority);

  // ③ 新考点——按教材章节顺序引入（kp_id 即建库时的教材顺序；云 2026-06-10 拍板：
  //    每一科必须按章节体系推进，价值 V 仅作显示参考，不再决定新考点先后）。
  //    跨科目时按固定科目顺序排（刑→民→法理→宪→法史），同科目内章节序。
  //    额度=用户所选背诵量减去复验/到期后的余量（云自选 10/30/50，不再用配速器卡死）。
  const remaining = Math.max(0, capacity - 复验.length - 到期.length);
  const 新考点 = untested
    .map((k) => mk(k, "新考点", 0, `章节顺序推进(剩余未学${untested.length})`))
    .sort(
      (a, b) =>
        subjectRank(a.subject) - subjectRank(b.subject) ||
        a.kp_id.localeCompare(b.kp_id),
    )
    .slice(0, remaining);

  // 容量裁剪：复验 > 到期 > 新考点
  const items = [...复验, ...到期, ...新考点].slice(0, capacity);

  return {
    stage,
    date: today.toISOString().slice(0, 10),
    items,
    counts: {
      复验: items.filter((i) => i.bucket === "复验").length,
      到期: items.filter((i) => i.bucket === "到期").length,
      新考点: items.filter((i) => i.bucket === "新考点").length,
      总数: items.length,
      未学剩余: untested.length,
    },
  };
}
