import { runSingleTurn, extractText, parsePlan, dedupeSearches } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { currentStage } from "./scheduler";
import { matchKpByName } from "./kp-match";
import { bjDateStr } from "./dates";
import { executeSearchTool, createMirrorCache } from "./search-tools";
import { EXAM_OUTLINE } from "./exam-outline.gen";
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
 * 记录=云主动指令制（2026-07-01）：错题本(study_error，=弱项唯一事实源)只在云说"记进错题本"才写；
 *   心得只在云说"记录进心得"才写（confirmed 直通「手动登记」正文）；学习日志只在云【汇报】(is_report)才写。
 *   教练觉得值得记可以在正文里【询问】，云答应后下一轮才落 META——绝不自作主张记录。
 * 互通：教练每轮注入 答疑最近卡点(ask_summary open)；答疑侧注入 错题本+学习进度（ask-prompt.ts volatile）。
 * 检验=理解层（有没有吸收），云的逐字背诵在 Anki app 做，教练不判分。
 * 考试分析接入（2026-07-01 升级）：① 知识架构（exam-outline.gen.ts 五科章节）+ 真题高频考点
 *   注入稳定前缀 → 建议落到具体章节、知道哪章重点；② 两段式按需检索（Sonnet 规划 → 本地 grep
 *   → 结果进 user 消息）→ 聊到具体考点时能引《考试分析》原文，不破坏 system 缓存（七牛云带 tools 缓存失效）。
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

/**
 * 科目级学习方法（浓缩自 docs/科目学习方法经验贴.md，2026-07-01 教练升级）。
 * 比 METHODOLOGY（宏观计划层）细一层：到科目/章节/背书/做题的具体做法。
 * 与知识架构(EXAM_OUTLINE)+真题高频配合。导出供周报指导层复用。
 */
export const SUBJECT_METHODS = `【科目级方法参考·浓缩自科目学习方法经验贴（到科目/章节/背书/做题层面）】
刑法：总则重理解（犯罪论是地基：构成→正当化→停止形态→共犯→罪数一条线）；分则按类罪名抓"构成要件+近似罪区分点"，高频罪名优先、冷门混脸熟。学完一章白纸默画简版思维导图+做该章分章真题，错的回分析对应节补漏。案例题先看设问，列主体×行为清单逐一定性。
民法：先总后分（总则/物权通则/合同通则先吃透，越抽象越要扎实）。法律行为效力五格表（有效/无效/可撤销/效力待定/不成立）是最大题仓（每年6-8道），每格挂真题例子。紧跟民法典新制度。法条分析五步：识考点→默框架(定义/要件/范围/例外)→定位原文→分析→分点归纳。
法理：论述大头踏实背；规则/原则、法律关系等分类辨析靠例子理解着背（真题爱在分类挖坑）；论述骨架=概念→特征分类→意义/联系实际。
宪法：最抽象+超纲——立法法/选举法/民族区域自治法/监督法要额外记；国家机构做职权对比表（谁提名/谁决定/谁任免）；数字类(比例/期限/人数)单独过。
法制史：背多分——朝代主线+制度纵线（五刑/会审等跨朝演变）双向组织；口诀标页边后期对口诀回忆；每周至少滚3次，隋唐/明清极高频优先。
背书通用：理解1-2遍后再开背；重复>单次时长（5分钟×3胜15分钟×1），必须滚动复背；框架先行再填肉、别一字不差强迫症；单科推进别五科并行背；目标=考场那天记忆最新鲜。
做题复盘通用：简答第一步先写概念（分析原文口径）再分点；一切主观题分点作答；真题2-3遍（分章→成套→滚错题）；错题定位到分析具体章节→回原文补漏→记错题本→滚动检验。`;

interface CoachMeta {
  /** 云本轮是否在【汇报学习进度】——只有 true 才写学习日志（提问/讨论/被考=false） */
  is_report?: boolean;
  subject?: string | null;
  chapter?: string | null;
  activity?: string | null;
  accuracy?: number | null;
  feeling?: string | null;
  confusion?: string | null;
  wrongs?: string[];
  /** 云明确说"记录进心得"时才有值（指令制）→ 直通心得「手动登记」正文 */
  xinde_notes?: string[];
  absorbed?: string[];
  memory_updates?: { fact: string; category?: string | null }[];
}

export interface CoachResult {
  reply: string; // 自然对话正文（markdown，展示用，已剥离 META）
  errorsRecorded: { knowledge: string; matched: boolean }[]; // 云指令"记进错题本"→ study_error（matched=钉到考点否）
  xindeRecorded: string[]; // 云指令"记录进心得"→ 心得候选 confirmed 直通正文
  absorbedRecorded: string[]; // 云说"懂了"→标 absorbed 销账退场
  memorized: string[]; // 本轮新记住的长期事实（UI 轻提示）
  logId: number | null; // study_log 行 id（仅状态展示用）
  logSkipped: boolean; // true=非汇报轮（提问/讨论），不入学习日志
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

/**
 * 读账本：阶段/死线/近N周投入/已学章节/最近流水/错题本(=弱项，study_error)
 *   + 答疑最近卡点(ask_summary，互通只读) + 近 N 轮对话(coach_message) + 长期记忆(coach_memory)。
 * 每轮重查 → 数据/记忆持续更新。2026-07-01：弱项与错题本合一（只有 study_error 一个事实源）；
 * 答疑侧数据经 ask_summary 注入（原 events 弱项候选链已随指令制下线）。
 */
async function loadLedger(today: Date) {
  const stage = currentStage(today);
  const daysToExam = Math.max(0, daysBetween(new Date(EXAM_DATE), today));
  const daysToBase = daysBetween(new Date(BASE_DEADLINE), today);

  const [progressRes, recentRes, selfErrRes, askStuckRes, msgRes, memRes] =
    await Promise.all([
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
      // 错题本 = 弱项（云主动记录的，status=open 未吸收）
      supabaseAdmin
        .from("study_error")
        .select("id, subject, kp_id, knowledge, log_date")
        .eq("status", "open"),
      // 答疑最近卡点（互通只读：云在答疑里确实卡过的点，ask_summary 指令制严控后噪音低）
      supabaseAdmin
        .from("ask_summary")
        .select("subject, confusion, created_at")
        .eq("status", "open")
        .not("confusion", "is", null)
        .order("created_at", { ascending: false })
        .limit(6),
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

  // 错题本 = 弱项（唯一事实源 study_error）：按 (考点/科目+短语) 聚合，频次×新近排序
  const openErrs = selfErrRes.data ?? [];
  const escT = coachCfg.红线.同弱项错次转专题;
  const errMap = new Map<string, { label: string; n: number; last: string }>();
  for (const r of openErrs) {
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

  // 答疑最近卡点（互通只读）：云在答疑里确实卡过的点，聊到相关时可顺手帮他打通
  const askStuckLines = (askStuckRes.data ?? []).map((r) => {
    const subj = (r.subject as string | null) ?? "未分类";
    const d = r.created_at ? bjDateStr(new Date(r.created_at)) : "?";
    return `${subj}·${String(r.confusion).slice(0, 60)}（答疑${d}）`;
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
    stage, daysToExam, daysToBase,
    progressLines, recentLines, selfErrorLines, askStuckLines, conversationLines, memoryFacts,
  };
}

/**
 * 从一篇做题心得 markdown 里剥掉【非正文】段（待观察 / 候选规律 / 维护规则），只留权威正文。
 * 段以 `## ` 二级标题切；标题含上述任一关键词的整段（直到下一个 `## ` 或文末）丢弃。
 * 「手动登记」段标题不含这些词 → 保留（云直接录入的，最高优先级）。
 */
function stripProvisionalSections(md: string): string {
  const PROVISIONAL = ["待观察", "候选规律", "维护规则"];
  let skipping = false;
  return md
    .split(/\r?\n/)
    .filter((ln) => {
      if (/^##\s/.test(ln)) skipping = PROVISIONAL.some((k) => ln.includes(k));
      return !skipping;
    })
    .join("\n")
    .trim();
}

/**
 * 五科真题高频考点（content_mirror kind=zhenti，真题分析/0X_XX高频考点.md，2014-2025 归纳）。
 * 注入稳定前缀：教练据此知道【哪章是重点、真题怎么考】，把建议落到章节。按 path 排序字节稳定（缓存）。
 * 导出供周报指导层复用（weekly-narrative.ts，下周指导也要按章节排优先级）。
 */
export async function loadGaopin(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("content_mirror")
    .select("path, content")
    .eq("kind", "zhenti")
    .ilike("path", "%高频考点%");
  if (error || !data || !data.length) return "";
  return data
    .slice()
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .map((r) => String(r.content).trim())
    .join("\n\n———\n\n");
}

/**
 * 五科做题心得【正文】（与答疑同源：content_mirror kind=xinde），剥掉待观察/候选/维护段后拼接。
 * 注入家教稳定前缀（缓存）让家教也能引用心得。按 path 排序保证跨请求字节稳定（缓存命中）；
 * 镜像每晚重生成，当天内稳定。冷启动/查不到时返回空串（家教退回纯账本，不阻塞）。
 */
async function loadZhengwenInsights(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("content_mirror")
    .select("path, content")
    .eq("kind", "xinde")
    // 刑法讲义心得(230KB)只供答疑 search_xinde；教练暂不接讲义（太大、会撑爆注入），按路径排除
    .not("path", "ilike", "%讲义%");
  if (error || !data || !data.length) return "";
  return data
    .slice()
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .map((r) => stripProvisionalSections(String(r.content)))
    .filter(Boolean)
    .join("\n\n———\n\n");
}

/**
 * 稳定前缀（跨请求字节稳定 → cache_control 缓存）：人设 + 方法论参考 + config 节奏
 *   + 考试分析知识架构/真题高频（2026-07-01 教练升级）+ 五科正文心得 + 输出契约。
 * insightsBlock/gaopinBlock 折进缓存段：镜像每晚才变，当天内字节稳定，照常命中缓存。
 */
function buildSystemStable(insightsBlock = "", gaopinBlock = ""): string {
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

${SUBJECT_METHODS}

【《考试分析》知识架构（官方教材章节，你给建议的坐标系）】
给学习建议/规划/复盘时【必须落到具体科目和章节】（如"民法第十四章 合同通则·第三节 合同的效力"），不许只说"多背民法"这种空话；主动点出跨章节联系（如刑法停止形态×共同犯罪、民法物权变动×合同效力），带云把散点串成架构。
${EXAM_OUTLINE}
${
  gaopinBlock
    ? `
【真题高频考点（2014-2025 真题归纳·哪章是重点就看这）】
排学习/背诵/做题优先级时对照它：⭐⭐⭐ 必考核心优先攻，冷门章别让云死磕。考他、复盘也优先从高频点下手。
${gaopinBlock}
`
    : ""
}
【云的节奏参考（来自他自己的设定，可随真实进度调）】
- 四轮三阶段：${rounds}
- 在职双轨：${tracks}。
${
  insightsBlock
    ? `
【五科做题心得·正文（与答疑同源·权威参考）】
下面是从历年真题归纳的"怎么考、怎么答"规律（判断倾向／陷阱／答题套路）。考云理解、点他易错处、帮他打通时【按需引用】；这是参考、不是要你逐字背或主动复述（默写判分是背诵系统的事）。
★【手动登记规则】区（标题含"手动登记"，云亲自录入）优先级最高：与其它心得条目或教材冲突时，一律以「手动登记」为准。
${insightsBlock}
`
    : ""
}
【输出格式】先【自然回复云】（用 markdown，正常对话口吻，不要分段标记、不要 JSON、不要把下面的字段名写进正文）。回复完后另起一行，输出且仅输出一个机器块（系统会剥离，云看不到）：
${COACH_META_OPEN}
{"is_report":true/false（云本轮是否在【汇报自己学了什么】——他主动说"今天听了/看了/做了第几章"才是 true；提问、讨论、被你考、闲聊一律 false）,"subject":"刑法|民法|法理|宪法|法制史 或省略","chapter":"如 第3章 或省略","activity":"听课|做题|背诵|复盘|其他 或省略","accuracy":0-100或省略,"feeling":"一句或省略","confusion":"云本轮最卡的一句或省略（仅供你理解上下文、更好追问，不入任何库，可正常填）","wrongs":["【默认空·仅主动指令】只有云本轮明确说'记进错题本/记录进错题本/这个记错题'时才填对应考点"],"xinde_notes":["【默认空·仅主动指令】只有云本轮明确说'记录进心得/记进心得/这条记下来'时，才把那条规律原话整理成一句填进来"],"absorbed":["今天云明确说懂了/掌握了的考点短语"],"memory_updates":[{"fact":"关于云的【新】耐久事实","category":"画像|倾向|目标|偏好|约束"}]}
${COACH_META_CLOSE}
规则（记录=云主动指令制，2026-06-30）：
- **学习日志只认汇报**：is_report=true（云明确在汇报学习进度）时才填 subject/chapter/activity/accuracy；云提问/讨论/被考时这些全省略、is_report=false——系统只在 is_report=true 时写学习日志。
- **错题本/心得只认指令**：wrongs 只在云说"记进错题本"时填；xinde_notes 只在云说"记录进心得"时填。你觉得某个错误/规律很值得记时，【可以在正文里问一句】"要不要我记进错题本/心得？"——云答应了，下一轮再填；【绝不允许不问自记】。
- confusion 仅供你追问、不入库。memory_updates 只发【新的/变化的】耐久事实，已在长期记忆里的别重复发。这个块外不要再写任何东西。`;
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

【已学进度·学习流水（云在教练页汇报的学习进度记在这——你要【持续关注、主动对照引用】，让云觉得每次汇报都被记住、被跟进；每科最多6章、最近在前）】
${ledger.progressLines.length ? ledger.progressLines.map((l) => "- " + l).join("\n") : "- （暂无章节流水——刚起步，按「尚未铺开」判断）"}

【错题本（=弱项·唯一事实源，云主动说"记进错题本"才进来；按频次×新近；🔺=反复错建议转专题；吸收前一直挂着）
${backlogDirective}】
${ledger.selfErrorLines.length ? ledger.selfErrorLines.map((l) => "- " + l).join("\n") : "- （错题本是空的）"}

【答疑最近卡点（互通·只读参考：云在答疑页确实卡过的点——聊到相关时顺手用【理解层】考他、帮他打通；他讲清了就引导他自己去答疑页或跟你说"记进错题本/我会了"）】
${ledger.askStuckLines.length ? ledger.askStuckLines.map((l) => "- " + l).join("\n") : "- （无）"}`;
}

/** 拼用户消息：嵌入近 N 轮对话（供理解上文）+ 本轮新消息 + 可选教材检索结果
 *  （仿答疑做法，runSingleTurn 只收单条 user；检索结果放 user 侧，不碰 system 缓存前缀）。 */
function buildUserMessage(conversationLines: string[], input: string, grepBlock = ""): string {
  const convo =
    conversationLines.length === 0
      ? ""
      : `【此前对话（最近几轮，供你理解上文/指代；引用证据仍以账本为准）】
${conversationLines.join("\n")}

`;
  if (!convo && !grepBlock) return input;
  return `${convo}【本轮云说】
${input}${grepBlock ? `\n\n${grepBlock}` : ""}`;
}

/** 教练侧检索结果总量兜底（字符，≈4-5 千 token）：教练引用原文是佐证不是判卷，比答疑(2.4万)砍一半再一半 */
const COACH_GREP_CLIP = 9000;

/**
 * 两段式·段①（2026-07-01 教练升级）：Sonnet 小调用判断本轮要不要查《考试分析》原文/心得/真题，
 * 要则列关键词 → 本地 grep content_mirror → 结果拼成注入块。
 * 闲聊/汇报进度等与具体知识点无关的轮次规划器给空数组 → 零注入零额外 Opus input。
 * 任何一步失败都吞掉返回空串（教练退回纯账本+架构作答，不阻塞）。
 */
async function planAndSearch(input: string, conversationTail: string[], signal?: AbortSignal): Promise<{ block: string; costUsd: number }> {
  const planSystem = `你是法硕教练的检索规划器。教练回答前可先查库：search_textbook（《考试分析》教材+刑法讲义原文）/ search_xinde（做题心得）/ search_zhenti（真题，参数 year、question_no）。
判断云本轮消息需不需要查库：
- 需要：聊到具体科目/章节/考点的学习安排或疑问、问某章重点/怎么学、让教练考他、涉及具体法律概念——列出检索词。
- 不需要：纯闲聊、汇报进度、谈时间/情绪/节奏、与具体知识点无关 → "searches" 给空数组。
输出且仅输出 JSON（无其他文字）：{"searches":[{"tool":"search_textbook","keyword":"教材原词≤8字"}]}
最多 4 条；keyword 用教材里会出现的短词（如"想象竞合""表见代理"），别整句。`;
  try {
    const { message, costUsd } = await runSingleTurn({
      system: planSystem,
      user: conversationTail.length
        ? `【最近对话】\n${conversationTail.join("\n")}\n\n【云本轮说】\n${input}`
        : input,
      model: MODELS.PLAN,
      maxTokens: 500,
      route: "coach:plan",
      signal,
    });
    const searches = dedupeSearches(parsePlan(extractText(message)).searches).slice(0, 4);
    if (searches.length === 0) return { block: "", costUsd };

    const cache = createMirrorCache();
    const parts: string[] = [];
    let used = 0;
    for (const s of searches) {
      const inputArgs: Record<string, unknown> =
        s.tool === "search_zhenti" ? { year: s.year, question_no: s.question_no } : { keyword: s.keyword };
      const { result } = await executeSearchTool(s.tool, inputArgs, cache);
      const seg = `■ ${s.tool}「${s.keyword ?? s.year ?? ""}」\n${result}`;
      if (used + seg.length > COACH_GREP_CLIP && parts.length > 0) continue;
      parts.push(seg);
      used += seg.length;
    }
    return {
      block: `【系统预检索（考试分析/心得/真题命中，供你把建议钉到原文和章节；与云的问题无关的命中忽略）】\n${parts.join("\n\n")}`,
      costUsd,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.error("[coach] 预检索失败（本轮退回纯账本作答）：", err instanceof Error ? err.message : String(err));
    return { block: "", costUsd: 0 };
  }
}

export async function runCoach(
  input: string,
  today = new Date(),
  signal?: AbortSignal,
): Promise<CoachResult> {
  const todayStr = bjDateStr(today);
  // 北京星期（+8h 后取 UTC 星期）：周日做"本周积压未吸收错题"复盘，非周日不主动翻账。
  const isSunday = new Date(today.getTime() + 8 * 3600 * 1000).getUTCDay() === 0;
  // 账本、五科正文心得、真题高频并行拉（心得/高频注入稳定前缀，让家教能引用心得+知道哪章重点）
  const [ledger, insights, gaopin] = await Promise.all([
    loadLedger(today),
    loadZhengwenInsights(),
    loadGaopin(),
  ]);
  // 两段式段①：按本轮话题按需查《考试分析》原文（结果进 user 消息，system 缓存前缀不动）
  const { block: grepBlock, costUsd: planCost } = await planAndSearch(
    input,
    ledger.conversationLines.slice(-4),
    signal,
  );

  const { message, costUsd: answerCost } = await runSingleTurn({
    system: {
      stable: buildSystemStable(insights, gaopin),
      volatile: buildSystemVolatile(ledger, todayStr, isSunday),
    },
    user: buildUserMessage(ledger.conversationLines, input, grepBlock),
    model: MODELS.COACH,
    signal,
    route: "coach",
    maxTokens: 4000, // 对话式回复可能较长 + 尾部 META
  });
  const costUsd = planCost + answerCost;

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
  const xindeNotes = cleanList(meta?.xinde_notes);

  // 学习日志只认汇报（云 2026-07-01）：is_report=true（云明确在汇报学了什么）且有实质学习要素才写；
  // 提问/讨论/被考一律不记——系统绝不自作主张记进度。
  const isStudyRecord =
    meta?.is_report === true &&
    (parsed.subject != null || parsed.chapter != null ||
      parsed.accuracy != null || (parsed.activity != null && parsed.activity !== "其他"));

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

  // 错题本：只有云本轮【明确说"记进错题本"】时 META.wrongs 才有值（见 prompt 严控）；否则 wrongs 恒空、不写。
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
    errorsRecorded.push({ knowledge: phrase, matched: !!kpId });
  }

  // 心得（指令制）：云明确说"记录进心得"→ 走手动直通管线（心得候选 status=confirmed + payload.拓展，
  // register-events 认它并写进做题心得「手动登记」正文区，与 /api/xinde/add 同管线同语义）。
  const xindeRecorded: string[] = [];
  for (const rule of xindeNotes.slice(0, 5)) {
    const { data: dup } = await supabaseAdmin
      .from("events")
      .select("id")
      .eq("type", "心得候选")
      .eq("subject", parsed.subject ?? "")
      .eq("knowledge", rule)
      .in("status", ["pending", "confirmed"])
      .limit(1);
    if (dup && dup.length) {
      xindeRecorded.push(rule);
      continue;
    }
    const { error: xdErr } = await supabaseAdmin.from("events").insert({
      type: "心得候选",
      subject: parsed.subject,
      kp_id: null,
      knowledge: rule,
      anchor: null,
      source: "教练记录",
      payload: { note: "云主动指令·直通正文·即时生效", 拓展: true },
      status: "confirmed",
    });
    if (xdErr) console.error("[coach] 心得记录失败：", xdErr.message);
    else xindeRecorded.push(rule);
  }

  // 销账：云说"懂了"→ 把未吸收的对应 study_error 标 absorbed（手动退场）
  const absorbedRecorded: string[] = [];
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
    xindeRecorded,
    absorbedRecorded,
    memorized,
    logId,
    logSkipped: !isStudyRecord,
    costUsd,
    metaParsed: meta != null,
  };
}
