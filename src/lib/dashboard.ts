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

// 2026-07-22 订正：原 2026-12-21 是【周一】，初试不可能在周一。12-19=周六，与云"距考 150 天"吻合。
// 与 config/coach.json「考试日期」保持同源；教育部 9 月官宣后需复核一次。
const EXAM_DATE = "2026-12-19";
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

/**
 * 从日志识别覆盖的官方章号集合：优先章/节标题匹配，退回解析"第X章"数字（封顶）。
 * 2026-07-22：chapter 标题匹配不中时，**降级到 `raw_input`（云的原始汇报）再试一次标题匹配**。
 * 因为 chapter 是压缩后的短标签，罪名/章名常被压掉，而原话里往往写全了。教训：#47
 * chapter="第十章、第十一章"（云教材自编章号，与官方错位）走数字兜底误记为官方第10/11章，
 * 但 raw_input 原话"第十章共同犯罪，第十一章罪数形态"里罪名齐全 —— 信息一直在库里没参与计算。
 * ⚠️ 必须是**降级**而非两者合并扫：raw_input 是自然语言，含否定/枚举（"除渎职罪外都学过"）会反向
 * 误判成学过（2026-07-22 实测踩到，刑法广度虚涨到 100%）。chapter 已能定章时就不许再读原话。
 * 数字兜底仍**只扫 chapter**：原始汇报里的章号本就与官方错位、且常顺带提及多章，精度不够。
 */
function detectChapters(subject: string, text: string, raw?: string | null): Set<number> {
  const found = new Set<number>();
  const total = TOTAL_CH[subject] ?? 99;
  const outline = OUTLINE[subject] ?? [];
  for (const c of outline) {
    if (c.keys.some((k) => text.includes(k))) found.add(c.num);
  }
  if (found.size === 0 && raw) {
    // 只用长标题（≥4 字）去咬原话：raw_input 是自然语言，短标题会误咬——2026-07-22 实测
    // "法理学背完第四章"里的"法理学"咬中绪论章、"动机一般影响量刑"里的"量刑"咬中量刑章。
    // chapter 是我写的受控标签，仍按 ≥2 字匹配。
    for (const c of outline) {
      if (c.keys.some((k) => k.length >= 4 && raw.includes(k))) found.add(c.num);
    }
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
    supabaseAdmin.from("study_log").select("subject, chapter, activity, accuracy, log_date, raw_input").order("log_date", { ascending: false }).limit(1000),
    supabaseAdmin.from("study_error").select("subject, knowledge, status, absorbed_at, log_date, kp_id, source").in("status", ["open", "absorbed"]).limit(3000),
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
    for (const n of detectChapters(subj, ch, r.raw_input as string | null)) {
      let set = m.get(n);
      if (!set) { set = new Set(); m.set(n, set); }
      set.add(step);
    }
  }
  // —— 错题：按科统计 闭环 + 重犯（同一知识点反复错=没真懂，北大扣分；dismissed 已在查询侧排除）——
  // 2026-07-22 重犯判定重做：原本只认「subject::knowledge 全字符串相同」，而错题描述中位数 245 字、
  // 最长 1188 字，两条永不可能一字不差 —— 实测 51 条只揪出 1 组，惩罚系数 0.989，这一维（权重 0.30）
  // 的重犯扣分形同虚设，而"重复犯老错"恰恰是云的核心病根。
  // 新口径按可靠性排序，**不做文本模糊匹配**（245 字描述算相似度＝伪精度，会把不同错题错并）：
  //   ① kp_id 相同（考点级连线，最可靠，但下线背诵检测后仅 8% 有值）
  //   ② source 标了「复发」（cuoti.mjs recheck 失败 / add --recur-of 显式连线 → 写入时就标死）
  //   ③ knowledge 全字符串相同（兜底，只兜得住 recheck 原样复制那条路径）
  // 一行最多算一次重犯，三条口径不叠加。
  const errBy = new Map<string, { open: number; absorbed: number; repeat: number }>();
  const seenKey = new Set<string>();
  for (const r of errs) {
    const s = (r.subject as string | null) ?? "未分类";
    const e = errBy.get(s) ?? { open: 0, absorbed: 0, repeat: 0 };
    if (r.status === "absorbed") e.absorbed++; else e.open++;
    const explicitRecur = /复发/.test(String(r.source ?? ""));
    const key = `${s}::${r.kp_id ?? r.knowledge}`;
    const dup = seenKey.has(key);
    seenKey.add(key);
    if (explicitRecur || dup) e.repeat++;
    errBy.set(s, e);
  }

  // 闭环先验（2026-07-22）：某科「有学习记录但一条错题都没登记」时，闭环无法实测，必须给个先验。
  // 三种选法里挑最客观的一种：
  //   ✗ 旧法 (0.25B+0.20D+0.25R)/0.70 —— 数学上等于"假设闭环≈该科其他三维的均值"。循环自证，
  //     且在真实闭环低于其他三维时**不登记错题反而得分更高**（刑法实测 60 vs 56）。
  //   ✗ 拍一个常数 0.5 —— 对到处都弱的科反成奖励（模拟：广度30/深度40/背诵20 由 29 涨到 36）。
  //   ✓ 用云自己**已实测科目的合并闭环率**当经验先验（empirical prior）：不循环、不拍脑袋、随他
  //     真实表现自更新。全库一条错题都没有时退回 0.5。
  const pooled = [...errBy.values()].reduce((a, e) => ({ absorbed: a.absorbed + e.absorbed, seen: a.seen + e.open + e.absorbed, repeat: a.repeat + e.repeat }), { absorbed: 0, seen: 0, repeat: 0 });
  const closurePrior = pooled.seen > 0
    ? (pooled.absorbed / pooled.seen) * (1 - 0.5 * (pooled.repeat / pooled.seen))
    : 0.5;

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
    // 各科能力（北大严标准）= 广度0.25 + 深度0.20 + 背诵0.25 + 闭环0.30
    // 2026-07-22 堵洞（详见上方 closurePrior 注释）：
    //   · 有错题实测 → 用实测闭环
    //   · 有学习记录但零错题 → 用云自己已实测科目的合并闭环率作经验先验
    //   · 零学习记录（未开张）→ 0，四维全 0，能力 0（不因"没错题"凭空得分）
    const B = progress / 100, D = depth / 100, R = recitePct / 100;
    const C = closure != null ? closure / 100 : (covered > 0 ? closurePrior : 0);
    const ability = Math.round(100 * (0.25 * B + 0.20 * D + 0.25 * R + 0.30 * C));
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
  // 2026-07-22：papers14d 原本数「近14天所有英语日志」，没排作文——而 essays30d 排了非作文，
  // 两边口径不一致：一周写 4 篇作文就能把"阅读节奏"顶满格。这里改为只数非作文（＝阅读篇数）。
  const papers14d = enLogs.filter((r) => String(r.log_date) >= d14 && !/作文/.test(String(r.chapter ?? ""))).length;
  const essays30d = enLogs.filter((r) => String(r.log_date) >= d30 && /作文/.test(String(r.chapter ?? ""))).length;
  const enErr = errBy.get("英语") ?? { open: 0, absorbed: 0, repeat: 0 };
  const enSeen = enErr.open + enErr.absorbed;
  const enClosure = enSeen > 0 ? Math.round((enErr.absorbed / enSeen) * (1 - 0.5 * (enErr.repeat / enSeen)) * 100) : null;
  // 闭环维同专业课口径（2026-07-22）：有学习记录但零错题→用同一条经验先验，零记录→0。
  // 原「无错题 → /0.85 重归一化」同样是"不记错题反而赚"。
  const eR = (reading ?? 0) / 100, eP = Math.min(1, papers14d / 4), eW = Math.min(1, essays30d / 2);
  const eC = enClosure != null ? enClosure / 100 : (enLogs.length > 0 ? closurePrior : 0);
  const englishAbility = Math.round(100 * (0.45 * eR + 0.20 * eP + 0.20 * eW + 0.15 * eC));
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
