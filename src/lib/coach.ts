import { runSingleTurn, extractText } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { currentStage } from "./scheduler";
import { emitEvent } from "./events";
import { matchKpByName } from "./kp-match";
import { bjDateStr } from "./dates";
import coachCfg from "../../config/coach.json";

/**
 * 教练 T1（系统设计/13）—— 2026-06-21 重做为【个性化对话式法硕家教】。
 * 不再填四段表：自然对话（论策略 / 查理解 / 做规划，随云当下需要），结构化数据走尾部
 * <<<COACH_META>>> 块后台抽取（仿答疑 splitMeta，ask-prompt.ts）。
 *
 * 个性化地基（缓存稳定前缀，七牛云不带工具时 caching 生效）：家教人设 + 经验帖方法论综述
 *   （参考非法条，浓缩自 docs/经验帖方法论对比.md）+ config 轮次/双轨节奏。
 * 持续更新：账本每轮重查 + 对话(coach_message)每轮追加并回喂 + 长期记忆(coach_memory)按
 *   META.memory_updates 增量同步（进易变块，小、每轮重发）。
 * 闭环不动（A 期）：错题→study_error(独立通道，不碰 kp_state)、销账、复盘弱项→待办筐，均从 META 喂。
 * 检验=理解层（有没有吸收），逐字默写是背诵系统(L1/L2/L3)的事，教练不判分。
 * 复习闭环（2026-06-21 概念1）：答疑暴露的【非背诵】弱项候选（events,source=答疑,pending）并入账本，
 *   教练聊到相关时理解层捞回考；云吸收后报进 absorbed → 同时销 study_error + 把该答疑弱项置 consumed 退出待办筐。
 */

const EXAM_DATE = coachCfg.考试日期;
const BASE_DEADLINE = coachCfg.基础结业死线;
const DAY = 86400000;
const daysBetween = (a: Date, b: Date) => Math.ceil((a.getTime() - b.getTime()) / DAY);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const ACTIVITIES = ["听课", "做题", "背诵", "复盘", "其他"];

/** 机器块标记（路由据此抽取并从展示文本剥离，仿 ask-prompt 的 ASK_META） */
export const COACH_META_OPEN = "<<<COACH_META";
export const COACH_META_CLOSE = "COACH_META>>>";

/**
 * 方法论参考（浓缩自 docs/经验帖方法论对比.md，10+ 篇高分/在职/多战经验帖）。
 * 【是参考不是法条】——教练按云处境权衡，可不照搬。改这里即改教练方法论依据。
 * 导出供周报复盘/指导层复用（单一事实源，见 weekly-narrative.ts）。
 */
export const METHODOLOGY = `【方法论参考·浓缩自 10+ 篇高分/在职/多战经验帖（参考，按云处境权衡，可不照搬）】
共识（强信号）：
- 刑民"理解为本"：看分析→做题→理解→再背；《考试分析》是官方教材、99%答案在内，法综尤以它为准。
- 前期理解、9-10月起全面背（"普遍撒网重点打捞"，不只背重点）。
- 刑民最重(150分)给最多时间；法理偏难多给点；宪法超纲需另记法条；法制史纯背、可放后期突破。
- 背书梳理框架别死记（"背书强迫症"是坑）+ 难点编口诀；冲刺 4-5 天背一遍。
- 真题反复 2-3 遍；做题发现薄弱→回书补漏。
- 复盘是高分隐性共性、也是失败者最大教训（背了就忘 / 错题重复错）。
- 模考不可缺（没模考→考场时间分配崩、大题写不完）。
- 在职晚 3-5h + 碎片可多滚 1-2 轮；早开始、规律作息。
- 避坑：不盲信押题(机构每年≤3题)、不迷信辅导班、资料别盲从跟风。
分歧（判断项，按云处境定，别一刀切）：启动时长 / 全面背vs重点背 / 串学vs学透——经验帖无统一定论。
针对云（在职·五战）：最大风险不是学得不细，而是【重复犯老错 + 启动晚 + 不复盘】(=云自述病根)。
故教练优先级：复盘 > 错题闭环 > 模考节奏 > 进度铺开。"串学还是学透"的答案是【双轨】(刑民精学+法综碎片背)落地到今晚/明天，别空谈原则。`;

interface CoachMeta {
  subject?: string | null;
  chapter?: string | null;
  activity?: string | null;
  accuracy?: number | null;
  feeling?: string | null;
  confusion?: string | null;
  wrongs?: string[];
  absorbed?: string[];
  memory_updates?: { fact: string; category?: string | null }[];
}

export interface CoachResult {
  reply: string; // 自然对话正文（markdown，展示用，已剥离 META）
  errorsRecorded: { knowledge: string; matched: boolean }[]; // 自报错题写入 study_error（matched=钉到考点否）
  absorbedRecorded: string[]; // 云说"懂了"→标 absorbed 销账退场
  askWeakAbsorbed: number; // 顺带吸收掉的「答疑暴露弱项」条数（从待办筐消费）
  weakEmitted: boolean; // 困惑点是否投待办筐
  memorized: string[]; // 本轮新记住的长期事实（UI 轻提示）
  logId: number | null; // study_log 行 id（仅状态展示用）
  logSkipped: boolean; // true=纯咨询/无学习要素，主动不入库
  costUsd: number;
  metaParsed: boolean; // META 是否解析成功（debug）
}

/** 模型不听"留空"时的占位词——一律视为空 */
const PLACEHOLDER_RE = /^[（(\[【]?\s*(无|没有|留空|暂无|不适用|待定|null|n\/?a|none|-|—)\s*[）)\]】]?$/i;

/**
 * 从回复中抽 <<<COACH_META{json}>>> 块，返回 { clean(剥离后展示文本), meta }。纯函数（仿 splitMeta），便于单测。
 * 解析失败 → meta=null + 打日志（本轮结构化沉淀丢弃，但对话正文照常展示，不阻塞）。
 */
export function splitCoachMeta(full: string): { clean: string; meta: CoachMeta | null } {
  const start = full.indexOf(COACH_META_OPEN);
  if (start === -1) return { clean: full.trim(), meta: null };
  const end = full.indexOf(COACH_META_CLOSE, start);
  const jsonRaw =
    end === -1
      ? full.slice(start + COACH_META_OPEN.length)
      : full.slice(start + COACH_META_OPEN.length, end);
  const clean = full.slice(0, start).trim();
  try {
    const cleaned = jsonRaw.replace(/```json|```/g, "").trim();
    return { clean, meta: JSON.parse(cleaned) as CoachMeta };
  } catch {
    console.error("[coach] META 块 JSON 解析失败，本轮结构化沉淀丢弃。片段：", jsonRaw.slice(0, 300));
    return { clean, meta: null };
  }
}

/** 行列表清洗：剥行首符号/序号、去占位词（wrongs/absorbed 容错） */
const cleanList = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? arr
        .map((s) => String(s).replace(/^[\s\-•·*]+/, "").replace(/^\d+\s*[.、)]\s*/, "").trim())
        .filter((s) => s.length > 0 && !PLACEHOLDER_RE.test(s))
    : [];

interface WeakItem {
  label: string;
  errorCount: number;
}

/**
 * 读账本：阶段/死线/Top5弱项/近N周投入/已学章节/最近流水/未吸收自报错题
 *   + 近 N 轮对话(coach_message) + 长期记忆(coach_memory)。每轮重查 → 数据/记忆持续更新。
 */
async function loadLedger(today: Date) {
  const stage = currentStage(today);
  const daysToExam = Math.max(0, daysBetween(new Date(EXAM_DATE), today));
  const daysToBase = daysBetween(new Date(BASE_DEADLINE), today);

  const [weakRes, progressRes, recentRes, selfErrRes, askWeakRes, msgRes, memRes] =
    await Promise.all([
      supabaseAdmin
        .from("kp_state")
        .select("subject, ext, error_count")
        .gt("error_count", 0)
        .eq("mastered", false)
        .order("error_count", { ascending: false })
        .limit(5),
      supabaseAdmin
        .from("study_log")
        .select("log_date, subject, chapter")
        .not("chapter", "is", null)
        .order("log_date", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("study_log")
        .select("log_date, subject, chapter, activity, raw_input")
        .order("id", { ascending: false })
        .limit(3),
      // 未吸收自报错题（独立通道，仅教练读；不碰 kp_state）
      supabaseAdmin
        .from("study_error")
        .select("id, subject, kp_id, knowledge, log_date")
        .eq("status", "open"),
      // 答疑暴露、尚未处理的弱项候选（非背诵点）——并入教练复习闭环：聊天里理解层捞回考、吸收即销账
      supabaseAdmin
        .from("events")
        .select("subject, knowledge, anchor, created_at")
        .eq("type", "弱项候选")
        .eq("status", "pending")
        .eq("source", "答疑")
        .order("created_at", { ascending: false })
        .limit(8),
      // 近 8 条对话（对话连续性）
      supabaseAdmin
        .from("coach_message")
        .select("role, content")
        .order("id", { ascending: false })
        .limit(8),
      // 长期记忆（关于云的耐久事实）
      supabaseAdmin
        .from("coach_memory")
        .select("fact, category")
        .order("updated_at", { ascending: false })
        .limit(40),
    ]);

  const topWeak: WeakItem[] = (weakRes.data ?? []).map((k) => ({
    label: `${k.subject}·${(k.ext as { name?: string })?.name ?? "?"}（错${k.error_count}）`,
    errorCount: k.error_count ?? 0,
  }));

  const chaptersBySubject = new Map<string, string[]>();
  for (const r of progressRes.data ?? []) {
    if (!r.subject || !SUBJECTS.includes(r.subject) || !r.chapter) continue;
    const list = chaptersBySubject.get(r.subject) ?? [];
    if (!list.includes(r.chapter) && list.length < 6) list.push(r.chapter);
    chaptersBySubject.set(r.subject, list);
  }
  const progressLines = SUBJECTS.flatMap((s) => {
    const ch = chaptersBySubject.get(s);
    return ch?.length ? [`${s}：${ch.join("、")}`] : [];
  });

  const recentLines = (recentRes.data ?? []).map((r) => {
    const head = [r.log_date, r.subject, r.chapter, r.activity]
      .filter(Boolean)
      .join(" ");
    const quote = r.raw_input ? `（原话：${String(r.raw_input).slice(0, 40)}）` : "";
    return `${head}${quote}`;
  });

  // 自报错题自动退场：匹配考点已在背诵 mastered → 标 absorbed（仅【读】kp_state 判定）
  const openErrs = selfErrRes.data ?? [];
  const openKpIds = [...new Set(openErrs.map((r) => r.kp_id).filter((x): x is string => !!x))];
  let masteredIds = new Set<string>();
  if (openKpIds.length) {
    const { data: mas } = await supabaseAdmin
      .from("kp_state")
      .select("kp_id")
      .in("kp_id", openKpIds)
      .eq("mastered", true);
    masteredIds = new Set((mas ?? []).map((r) => r.kp_id as string));
    if (masteredIds.size) {
      await supabaseAdmin
        .from("study_error")
        .update({ status: "absorbed", absorbed_via: "kp_mastered", absorbed_at: new Date().toISOString() })
        .in("kp_id", [...masteredIds])
        .eq("status", "open");
    }
  }
  const escT = coachCfg.红线.同弱项错次转专题;
  const errMap = new Map<string, { label: string; n: number; last: string }>();
  for (const r of openErrs) {
    if (r.kp_id && masteredIds.has(r.kp_id)) continue;
    const subj = (r.subject as string | null) ?? "未分类";
    const key = (r.kp_id as string | null) ?? `${subj}::${r.knowledge}`;
    const cur = errMap.get(key) ?? { label: `${subj}·${r.knowledge}`, n: 0, last: "" };
    cur.n++;
    const d = String(r.log_date ?? "");
    if (d > cur.last) cur.last = d;
    errMap.set(key, cur);
  }
  const selfErrorLines = [...errMap.values()]
    .sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1))
    .slice(0, 8)
    .map((e) => `${e.label}${e.n > 1 ? " ×" + e.n : ""}${e.n >= escT ? " 🔺转专题" : ""}（最近${e.last || "?"}）`);

  // 答疑暴露弱项（非背诵点）：并入复习闭环，聊到相关时理解层捞回考、吸收即销账
  const askWeakLines = (askWeakRes.data ?? []).map((r) => {
    const subj = (r.subject as string | null) ?? "未分类";
    const d = r.created_at ? bjDateStr(new Date(r.created_at)) : "?";
    return `${subj}·${r.knowledge}${r.anchor ? `（锚${r.anchor}）` : ""}（答疑${d}）`;
  });

  // 对话历史（chronological：旧→新；每条截断防爆）
  const conversationLines = (msgRes.data ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.role === "user" ? "云" : "教练"}：${String(m.content).slice(0, 500)}`);

  const memoryFacts = (memRes.data ?? []).map(
    (m) => `- ${m.category ? `[${m.category}] ` : ""}${m.fact}`,
  );

  return {
    stage, daysToExam, daysToBase, topWeak,
    progressLines, recentLines, selfErrorLines, askWeakLines, conversationLines, memoryFacts,
  };
}

/** 稳定前缀（跨请求字节稳定 → cache_control 缓存）：人设 + 方法论参考 + config 节奏 + 输出契约。 */
function buildSystemStable(): string {
  const rounds = Object.entries(coachCfg.轮次表)
    .filter((e): e is [string, { 窗口: string; 范围: string; 强度: string }] => typeof e[1] === "object" && e[1] !== null)
    .map(([name, r]) => `${name}(${r.窗口})：${r.范围}·${r.强度}`)
    .join(" / ");
  const tracks = Object.entries(coachCfg.双轨节奏)
    .filter((e): e is [string, string] => !e[0].startsWith("_") && typeof e[1] === "string")
    .map(([slot, what]) => `${slot} ${what}`)
    .join("；");

  return `你是云的私人法硕（非法学）家教，不是填表的规划器。像一个真正懂他、记得住他、为他定制的过来人学长那样【自然对话】：
- 该论策略就掰扯利弊、该考他理解就出题追问、该规划就给可执行的今晚/明天安排——随云当下需要，别套固定格式、别每次都四平八稳分段。
- 云在职、五战、目标北大 375+，三次失败病根=启动晚 + 从不复盘。你掌握他的【全部学习数据 + 长期记忆】（见下方易变块），建议必须【个性化】、扣着他的真实进度和老毛病说，不要通用大模型那种放之四海的泛泛而谈。
- 接地气、点透、不灌鸡汤；该泼冷水（比如五战了还在纠结原则不落地）就直说。

【检验=理解层，不是背诵层】当云说"检验我/考我/看我掌握没"：考【理解吸收】不是【逐字会背】——让他用自己的话讲、举例、辨析易混点（如犯罪客体 vs 犯罪对象）、答"为什么"、套一个小情境；然后给反馈、点出哪里没真吃透、追问到底。逐字默写判分是背诵系统(L1/L2/L3)的事，你不做默写打分。

${METHODOLOGY}

【云的节奏参考（来自他自己的设定，可随真实进度调）】
- 四轮三阶段：${rounds}
- 在职双轨：${tracks}。

【输出格式】先【自然回复云】（用 markdown，正常对话口吻，不要分段标记、不要 JSON、不要把下面的字段名写进正文）。回复完后另起一行，输出且仅输出一个机器块（系统会剥离，云看不到）：
${COACH_META_OPEN}
{"subject":"刑法|民法|法理|宪法|法制史 或省略","chapter":"如 第3章 或省略","activity":"听课|做题|背诵|复盘|其他 或省略","accuracy":0-100或省略,"feeling":"一句或省略","confusion":"最不懂一句或省略","wrongs":["今天明确做错/没掌握的考点短语"],"absorbed":["今天明确说懂了/掌握了的考点短语"],"memory_updates":[{"fact":"关于云的【新】耐久事实","category":"画像|倾向|目标|偏好|约束"}]}
${COACH_META_CLOSE}
规则：只在云【确有】对应信息时填，纯闲聊/提问就大多留空数组/省略；memory_updates 只发【新的/变化的】事实，已在长期记忆里的别重复发。这个块外不要再写任何东西。`;
}

/** 易变块（每轮重发，不缓存）：长期记忆 + 学习数据账本。isSunday=周日做积压复盘。 */
function buildSystemVolatile(
  ledger: Awaited<ReturnType<typeof loadLedger>>,
  todayStr: string,
  isSunday: boolean,
): string {
  const backlogDirective = isSunday
    ? "　⚠️今天是周日·做【本周积压复盘】：主动把下面未吸收的逐条跟云过一遍，挑最老/最高频的用【理解层】考他、帮他收口，吸收的写进 META.absorbed 销账。这是周日固定动作，专治云'错题不闭环'。"
    : "　（非周日不必主动翻这本账；云聊到相关或问起时，再顺手用理解层帮他收口即可）";
  return `【关于云·长期记忆（你记住的耐久事实，据此个性化）】
${ledger.memoryFacts.length ? ledger.memoryFacts.join("\n") : "- （暂无，留意从对话里提炼并写进 META.memory_updates）"}

【当前账本】
- 今天：${todayStr}　距初试 ${ledger.daysToExam} 天　距基础结业死线 ${ledger.daysToBase > 0 ? ledger.daysToBase + " 天" : "已过期 " + -ledger.daysToBase + " 天"}
- 阶段模式：${ledger.stage}
- Top5 弱项（检测实证）：${ledger.topWeak.length ? ledger.topWeak.map((w) => w.label).join("；") : "（暂无错次记录）"}

【已学进度·学习流水聚合（每科最多6章、最近在前）】
${ledger.progressLines.length ? ledger.progressLines.map((l) => "- " + l).join("\n") : "- （暂无章节流水——刚起步，按「尚未铺开」判断）"}

【自报错题·未吸收清单（云汇报做错的，按频次×新近；🔺=反复错建议转专题；吸收前一直挂着）
${backlogDirective}】
${ledger.selfErrorLines.length ? ledger.selfErrorLines.map((l) => "- " + l).join("\n") : "- （无未吸收的自报错题）"}

【答疑暴露·待复习吸收（云在答疑里卡过/可能答错的【非背诵点】，吸收前一直挂着——聊到相关时顺手用【理解层】考他、帮他打通；他用自己话讲清/会辨析了，就在 absorbed 里报上来销账）】
${ledger.askWeakLines.length ? ledger.askWeakLines.map((l) => "- " + l).join("\n") : "- （无）"}`;
}

/** 拼用户消息：嵌入近 N 轮对话（供理解上文）+ 本轮新消息（仿答疑做法，runSingleTurn 只收单条 user）。 */
function buildUserMessage(conversationLines: string[], input: string): string {
  if (conversationLines.length === 0) return input;
  return `【此前对话（最近几轮，供你理解上文/指代；引用证据仍以账本为准）】
${conversationLines.join("\n")}

【本轮云说】
${input}`;
}

export async function runCoach(
  input: string,
  today = new Date(),
  signal?: AbortSignal,
): Promise<CoachResult> {
  const todayStr = bjDateStr(today);
  // 北京星期（+8h 后取 UTC 星期）：周日做"本周积压未吸收错题"复盘，非周日不主动翻账。
  const isSunday = new Date(today.getTime() + 8 * 3600 * 1000).getUTCDay() === 0;
  const ledger = await loadLedger(today);

  const { message, costUsd } = await runSingleTurn({
    system: { stable: buildSystemStable(), volatile: buildSystemVolatile(ledger, todayStr, isSunday) },
    user: buildUserMessage(ledger.conversationLines, input),
    model: MODELS.COACH,
    signal,
    route: "coach",
    maxTokens: 4000, // 对话式回复可能较长 + 尾部 META
  });

  const { clean, meta } = splitCoachMeta(extractText(message));
  const reply = clean || "（这轮我没接住，换种说法再说一次？）";

  // 从 META 还原结构化字段（白名单/范围净化，同旧逻辑）
  const rawAct = meta?.activity ? String(meta.activity) : null;
  const parsed = {
    subject: SUBJECTS.includes(String(meta?.subject)) ? String(meta?.subject) : null,
    chapter: meta?.chapter ? String(meta.chapter) : null,
    activity: rawAct ? (ACTIVITIES.includes(rawAct) ? rawAct : "其他") : null,
    accuracy: typeof meta?.accuracy === "number" ? clamp(meta.accuracy, 0, 100) : null,
    feeling: meta?.feeling ? String(meta.feeling) : null,
    confusion: meta?.confusion ? String(meta.confusion) : null,
  };
  const wrongs = cleanList(meta?.wrongs);
  const absorbed = cleanList(meta?.absorbed);

  // 入库门槛：有学习要素才写 study_log（纯咨询不污染进度记录）
  const isStudyRecord =
    parsed.subject != null || parsed.chapter != null ||
    parsed.accuracy != null || (parsed.activity != null && parsed.activity !== "其他") || wrongs.length > 0;

  let logId: number | null = null;
  if (isStudyRecord) {
    const { data: logRow, error: logErr } = await supabaseAdmin
      .from("study_log")
      .insert({
        log_date: todayStr,
        subject: parsed.subject ?? "未识别",
        chapter: parsed.chapter,
        activity: parsed.activity ?? "其他",
        accuracy: parsed.accuracy,
        feeling: parsed.feeling,
        source: "manual",
        raw_input: input,
      })
      .select("id")
      .single();
    if (logErr) console.error("[coach] study_log 写入失败：", logErr.message);
    logId = (logRow?.id as number | undefined) ?? null;
  }

  // 困惑点 → 待办筐弱项候选（vague 标记）
  let weakEmitted = false;
  if (parsed.confusion) {
    weakEmitted = await emitEvent({
      type: "弱项候选",
      subject: parsed.subject ?? "未分类",
      kp_id: null,
      knowledge: parsed.confusion,
      anchor: null,
      source: "复盘",
      payload: { from: "教练复盘", chapter: parsed.chapter, vague: true },
    });
  }

  // 错题闭环：钉考点→study_error；钉不到按科目记+投待办筐兜底（A 期逻辑，改由 META 喂）
  const errorsRecorded: { knowledge: string; matched: boolean }[] = [];
  for (const phrase of wrongs.slice(0, 12)) {
    let kpId: string | null = null;
    try {
      kpId = (await matchKpByName(parsed.subject, phrase))?.kp_id ?? null;
    } catch (err) {
      console.error("[coach] 错题匹配失败：", err instanceof Error ? err.message : String(err));
    }
    const { error: seErr } = await supabaseAdmin.from("study_error").insert({
      log_date: todayStr,
      subject: parsed.subject,
      kp_id: kpId,
      knowledge: phrase,
      source: "coach",
      study_log_id: logId,
      raw_input: input,
    });
    if (seErr) console.error("[coach] study_error 写入失败：", seErr.message);
    if (!kpId) {
      await emitEvent({
        type: "弱项候选",
        subject: parsed.subject ?? "未分类",
        kp_id: null,
        knowledge: phrase,
        anchor: null,
        source: "教练错题",
        payload: { from: "教练自报错题", chapter: parsed.chapter, unmatched: true },
      });
    }
    errorsRecorded.push({ knowledge: phrase, matched: !!kpId });
  }

  // 销账：云说"懂了"→ 把未吸收的对应 study_error 标 absorbed（手动退场）
  const absorbedRecorded: string[] = [];
  let askWeakAbsorbed = 0;
  for (const phrase of absorbed.slice(0, 12)) {
    let kpId: string | null = null;
    try {
      kpId = (await matchKpByName(parsed.subject, phrase))?.kp_id ?? null;
    } catch {
      /* 退回按 knowledge 模糊销账 */
    }
    let q = supabaseAdmin
      .from("study_error")
      .update({ status: "absorbed", absorbed_via: "manual", absorbed_at: new Date().toISOString() })
      .eq("status", "open");
    if (parsed.subject) q = q.eq("subject", parsed.subject);
    q = kpId ? q.eq("kp_id", kpId) : q.ilike("knowledge", `%${phrase}%`);
    const { error: absErr } = await q;
    if (absErr) console.error("[coach] 销账失败：", absErr.message);
    else absorbedRecorded.push(phrase);

    // 同步关掉「答疑暴露弱项」里被吸收的那条（教练理解层吸收 = 一种合法消费，退出待办筐）
    let ev = supabaseAdmin
      .from("events")
      .update({ status: "consumed", consumed_at: new Date().toISOString() })
      .eq("type", "弱项候选")
      .eq("status", "pending")
      .eq("source", "答疑")
      .ilike("knowledge", `%${phrase}%`);
    if (parsed.subject) ev = ev.eq("subject", parsed.subject);
    const { data: closedEv, error: evErr } = await ev.select("id");
    if (evErr) console.error("[coach] 答疑弱项消费失败：", evErr.message);
    else askWeakAbsorbed += closedEv?.length ?? 0;
  }

  // 长期记忆增量同步（云要的"随时同步记忆"）：只写新事实，精确去重
  const memorized: string[] = [];
  for (const u of (meta?.memory_updates ?? []).slice(0, 8)) {
    const fact = (u?.fact ?? "").toString().trim();
    if (!fact || PLACEHOLDER_RE.test(fact)) continue;
    const { data: dup } = await supabaseAdmin.from("coach_memory").select("id").eq("fact", fact).limit(1);
    if (dup && dup.length) {
      await supabaseAdmin.from("coach_memory").update({ updated_at: new Date().toISOString() }).eq("id", dup[0].id);
    } else {
      const { error: memErr } = await supabaseAdmin
        .from("coach_memory")
        .insert({ fact, category: u?.category ? String(u.category) : null });
      if (memErr) console.error("[coach] coach_memory 写入失败：", memErr.message);
    }
    memorized.push(fact);
  }

  // 存本轮对话（连续性）：云消息 + 教练回复
  const { error: msgErr } = await supabaseAdmin.from("coach_message").insert([
    { role: "user", content: input },
    { role: "assistant", content: reply },
  ]);
  if (msgErr) console.error("[coach] coach_message 写入失败：", msgErr.message);

  return {
    reply,
    errorsRecorded,
    absorbedRecorded,
    askWeakAbsorbed,
    weakEmitted,
    memorized,
    logId,
    logSkipped: !isStudyRecord,
    costUsd,
    metaParsed: meta != null,
  };
}
