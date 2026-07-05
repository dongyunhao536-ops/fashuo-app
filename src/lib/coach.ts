import { runSingleTurn, extractText, parsePlan, dedupeSearches } from "./anthropic";
import type { ChatImage } from "./chat-image";
import { stripMetaBlocks } from "./ask-prompt";
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
 * 考试分析接入（2026-07-01 升级，2026-07-03 降本重构）：① 知识架构（exam-outline.gen.ts 五科章节）
 *   注入稳定前缀 → 建议落到具体章节；② 两段式按需检索（Sonnet 规划 → 本地 grep → 结果进 user 消息）
 *   → 聊到具体考点时能引《考试分析》原文/心得/真题，不破坏 system 缓存（七牛云带 tools 缓存失效）；
 *   ③ 当轮科目的真题高频考点（规划器顺带判科目，~4千字）注入 user 侧——五科全量高频/心得不再常驻前缀。
 * 成本教训（2026-07-03，api_usage 实锤）：七牛云缓存 TTL 5 分钟 < 教练对话轮间隔（云在思考/答题）
 *   → 实战几乎轮轮 cache miss、每轮重付全量 cache_write（且 $6.25/M > input $5/M，miss 为主时缓存净亏）。
 *   全量心得(5万字)+高频(2万字)曾把前缀撑到 7 万 token ≈ ¥3.4/轮；两段式检索本就覆盖同一批库，纯冗余，已删。
 *   前缀瘦身后 ≈6 千 token。2026-07-03 云拍板预算 ¥1.5/轮（含答疑）→ 用省出的空间加质量：
 *   检索 6 条/1.2 万字、历史 12 条(近 6 全文)——miss 轮典型 ≈¥0.9-1.1（全项叠满 ≈¥1.4）、命中轮 ≈¥0.6。
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
  /** 云明确要求修正过往进度时才有值（指令制）→ 改该科最近一条章节含 from 的 study_log */
  log_fix?: { subject?: string | null; from?: string | null; to?: string | null };
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
  logFixed: string | null; // 云指令"修正进度"→ 实际改动描述（null=本轮无修正）
  costUsd: number;
  metaParsed: boolean; // META 是否解析成功（debug）
}

/** 模型不听"留空"时的占位词——一律视为空 */
const PLACEHOLDER_RE = /^[（(\[【]?\s*(无|没有|留空|暂无|不适用|待定|null|n\/?a|none|-|—)\s*[）)\]】]?$/i;

/**
 * 从回复中抽 <<<COACH_META{json}>>> 块，返回 { clean(剥离后展示文本), meta }。纯函数（与 splitMeta 共用底座），便于单测。
 * 解析失败 → meta=null + 打日志（本轮结构化沉淀丢弃，但对话正文照常展示，不阻塞）。
 * 2026-07-04 同答疑 splitMeta 一并修复：META 块提前吐时块后正文不再被静默吞掉（stripMetaBlocks 两侧都保）。
 */
export function splitCoachMeta(full: string): { clean: string; meta: CoachMeta | null } {
  const { clean, raws } = stripMetaBlocks(full, COACH_META_OPEN, COACH_META_CLOSE);
  let meta: CoachMeta | null = null;
  let failedRaw: string | null = null;
  for (const raw of raws) {
    try {
      meta = JSON.parse(raw.replace(/```json|```/g, "").trim()) as CoachMeta; // 多块时以最后一块解析成功的为准
    } catch {
      failedRaw = raw;
    }
  }
  if (meta === null && failedRaw !== null) {
    console.error("[coach] META 块 JSON 解析失败，本轮结构化沉淀丢弃。片段：", failedRaw.slice(0, 300));
  }
  return { clean, meta };
}

/** 行列表清洗：剥行首符号/序号、去占位词（wrongs/absorbed 容错） */
const cleanList = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? arr
        .map((s) => String(s).replace(/^[\s\-•·*]+/, "").replace(/^\d+\s*[.、)]\s*/, "").trim())
        .filter((s) => s.length > 0 && !PLACEHOLDER_RE.test(s))
    : [];

/** 错题本聚合的输入行（study_error open+absorbed 全生命周期） */
export interface ErrorBookRow {
  subject: string | null;
  kp_id: string | null;
  knowledge: string | null;
  log_date: string | null;
  status: string;
  absorbed_at: string | null;
}

/** 吸收复检窗口：销账满 5 天才值得抽查（太快没意义），60 天后交给真题滚动覆盖 */
const RECHECK_MIN_DAYS = 5;
const RECHECK_MAX_DAYS = 60;
const RECHECK_MAX_ITEMS = 4;

/**
 * 错题本聚合（纯函数，2026-07-04 复发感知）：
 * - lines：仍在挂账（有 open 行）的弱项，按【累计】错次（open+absorbed，销账不清零）×新近排序；
 *   吸收过又错的挂 🔁（云的病根=重复犯老错，这个信号必须点破）；🔺转专题按累计错次触发。
 * - recheck：已全部吸收、销账 5-60 天的旧错题（最老优先，≤4 条）——周日复盘时给教练做突袭抽查，
 *   防"销账后又忘了没人管"。答不上云说"记进错题本"就重新挂账，下轮自动带 🔁。
 */
export function aggregateErrorBook(
  rows: ErrorBookRow[],
  escalateAt: number,
  nowMs: number,
): { lines: string[]; recheck: string[] } {
  const agg = new Map<string, { label: string; nOpen: number; nAbs: number; last: string; oldestAbs: number }>();
  for (const r of rows) {
    const subj = r.subject ?? "未分类";
    const key = r.kp_id ?? `${subj}::${r.knowledge}`;
    const cur =
      agg.get(key) ?? { label: `${subj}·${r.knowledge}`, nOpen: 0, nAbs: 0, last: "", oldestAbs: Infinity };
    if (r.status === "absorbed") {
      cur.nAbs++;
      const at = r.absorbed_at ? new Date(r.absorbed_at).getTime() : NaN;
      if (!Number.isNaN(at) && at < cur.oldestAbs) cur.oldestAbs = at;
    } else {
      cur.nOpen++;
      const d = String(r.log_date ?? "");
      if (d > cur.last) cur.last = d;
    }
    agg.set(key, cur);
  }
  const lines = [...agg.values()]
    .filter((e) => e.nOpen > 0)
    .sort((a, b) => b.nOpen + b.nAbs - (a.nOpen + a.nAbs) || (a.last < b.last ? 1 : -1))
    .slice(0, 8)
    .map((e) => {
      const n = e.nOpen + e.nAbs;
      return `${e.label}${n > 1 ? " ×" + n : ""}${e.nAbs > 0 ? " 🔁曾吸收又错" : ""}${n >= escalateAt ? " 🔺转专题" : ""}（最近${e.last || "?"}）`;
    });
  const recheck = [...agg.values()]
    .filter((e) => e.nOpen === 0 && Number.isFinite(e.oldestAbs))
    .filter((e) => {
      const age = nowMs - e.oldestAbs;
      return age >= RECHECK_MIN_DAYS * DAY && age <= RECHECK_MAX_DAYS * DAY;
    })
    .sort((a, b) => a.oldestAbs - b.oldestAbs)
    .slice(0, RECHECK_MAX_ITEMS)
    .map((e) => `${e.label}（${bjDateStr(new Date(e.oldestAbs))} 吸收）`);
  return { lines, recheck };
}

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
      // 错题本 = 弱项（云主动记录的）。拉全生命周期 open+absorbed（2026-07-04 复发感知）：
      // 销账只是退出挂账名单、历史不删——云的病根是"重复犯老错"，吸收过又错的点必须
      // 被点破（🔁标记），转专题阈值也按【累计】错次算（销账不清零）；absorbed 行还供周日复检抽查。
      supabaseAdmin
        .from("study_error")
        .select("id, subject, kp_id, knowledge, log_date, status, absorbed_at")
        .in("status", ["open", "absorbed"])
        .limit(500),
      // 答疑最近卡点（互通只读：云在答疑里确实卡过的点，ask_summary 指令制严控后噪音低）
      supabaseAdmin
        .from("ask_summary")
        .select("subject, confusion, created_at")
        .eq("status", "open")
        .not("confusion", "is", null)
        .order("created_at", { ascending: false })
        .limit(6),
      // 近 12 条对话（对话连续性；截断策略见 conversationLines 注释）
      supabaseAdmin
        .from("coach_message")
        .select("role, content")
        .order("id", { ascending: false })
        .limit(12),
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

  // 错题本 = 弱项（唯一事实源 study_error）：全生命周期聚合（复发感知 + 周日复检名单）
  const { lines: selfErrorLines, recheck: recheckLines } = aggregateErrorBook(
    (selfErrRes.data ?? []) as ErrorBookRow[],
    coachCfg.红线.同弱项错次转专题,
    today.getTime(),
  );

  // 答疑最近卡点（互通只读）：云在答疑里确实卡过的点，聊到相关时可顺手帮他打通
  const askStuckLines = (askStuckRes.data ?? []).map((r) => {
    const subj = (r.subject as string | null) ?? "未分类";
    const d = r.created_at ? bjDateStr(new Date(r.created_at)) : "?";
    return `${subj}·${String(r.confusion).slice(0, 60)}（答疑${d}）`;
  });

  // 对话历史（chronological：旧→新）。最近 6 条全文（封顶 1600 字兜底）、更早的只留【尾部】500 字——
  // 教练的追问都在回复末尾，旧版 slice(0,500) 截头会把"它自己上一轮问了什么"截掉，
  // 导致教练看不懂云在答哪一问、连环张冠李戴（2026-07-02 #60→#64 实锤）。截断必须保尾不保头。
  const msgs = (msgRes.data ?? []).slice().reverse();
  const conversationLines = msgs.map((m, i) => {
    const text = String(m.content);
    const cap = msgs.length - i <= 6 ? 1600 : 500;
    const kept = text.length <= cap ? text : "……" + text.slice(-cap);
    return `${m.role === "user" ? "云" : "教练"}：${kept}`;
  });

  const memoryFacts = (memRes.data ?? []).map(
    (m) => `- ${m.category ? `[${m.category}] ` : ""}${m.fact}`,
  );

  return {
    stage, daysToExam, daysToBase,
    progressLines, recentLines, selfErrorLines, recheckLines, askStuckLines, conversationLines, memoryFacts,
  };
}

/**
 * 五科真题高频考点全量（content_mirror kind=zhenti，真题分析/0X_XX高频考点.md，2014-2025 归纳）。
 * 【仅周报用】（weekly-narrative.ts，周频调用注入 2 万字可接受）。教练侧 2026-07-03 起
 * 不再全量注入——改走 loadGaopinFor 按当轮科目取一份进 user 侧（成本账见文件头注释）。
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
 * 当轮科目的真题高频考点（约 4 千字），注入 user 侧（不碰 system 缓存前缀）。
 * 科目由规划器顺带判定；无科目轮（闲聊/谈节奏/情绪）返回空串 → 零注入零成本。
 * 心得不做对应的常驻注入：聊到具体考点时规划器会列 search_xinde 检索，同库按需取。
 */
async function loadGaopinFor(subject: string | null | undefined): Promise<string> {
  if (!subject || !SUBJECTS.includes(subject)) return "";
  const { data, error } = await supabaseAdmin
    .from("content_mirror")
    .select("content")
    .eq("kind", "zhenti")
    .ilike("path", `%${subject}%高频考点%`);
  if (error || !data || !data.length) return "";
  const body = data.map((r) => String(r.content).trim()).join("\n\n");
  return `【${subject}真题高频考点（2014-2025 真题归纳·哪章是重点就看这）】
排学习/背诵/做题优先级时对照它：⭐⭐⭐ 必考核心优先攻，冷门章别让云死磕。考他、复盘也优先从高频点下手。
${body}`;
}

/**
 * 稳定前缀（跨请求字节稳定 → cache_control 缓存）：人设 + 方法论参考 + 考试分析知识架构
 *   + config 节奏 + 输出契约。≈8 千字 ≈6 千 token。
 * ⚠️ 别再往这里塞按科目/按话题才用得上的大块参考（高频/心得/原文）——缓存 TTL 5 分钟
 *   扛不住对话轮间隔，前缀每大 1 万 token ≈ miss 轮多 ¥0.45（cache_write $6.25/M）。
 *   那类内容走 planAndSearch 检索或 loadGaopinFor 按科注入 user 侧。
 */
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

【检验=理解层，不是背诵层】当云说"检验我/考我/看我掌握没"：考【理解吸收】不是【逐字会背】——让他用自己的话讲、举例、辨析易混点（如犯罪客体 vs 犯罪对象）、答"为什么"、套一个小情境；然后给反馈、点出哪里没真吃透、追问到底。逐字背诵云在 Anki app 里自己练，你不做默写打分。

${METHODOLOGY}

${SUBJECT_METHODS}

【《考试分析》知识架构（官方教材章节，你给建议的坐标系）】
给学习建议/规划/复盘时【必须落到具体科目和章节】（如"民法第十四章 合同通则·第三节 合同的效力"），不许只说"多背民法"这种空话；主动点出跨章节联系（如刑法停止形态×共同犯罪、民法物权变动×合同效力），带云把散点串成架构。
${EXAM_OUTLINE}

【按需参考（系统按当轮话题注入 user 消息，不在这里常驻）】
- 聊到具体考点时，系统会预检索《考试分析》原文/做题心得/真题命中给你——引用时钉到原文和章节。
- 心得命中里标「手动登记」的条目（云亲自录入）优先级最高：与其它心得或教材冲突时一律以它为准。
- 云聊某科时，该科真题高频考点会随消息给你——排优先级、考他、复盘优先从高频点下手。

【云的节奏参考（来自他自己的设定，可随真实进度调）】
- 四轮三阶段：${rounds}
- 在职双轨：${tracks}。

【输出格式】先【自然回复云】（用 markdown，正常对话口吻，不要分段标记、不要 JSON、不要把下面的字段名写进正文）。回复完后另起一行，输出且仅输出一个机器块（系统会剥离，云看不到）：
${COACH_META_OPEN}
{"is_report":true/false（【只看"本轮云说"那一条消息】是否在汇报自己学了什么——他这条消息主动说"今天听了/看了/做了第几章"才是 true；提问、讨论、被你考、闲聊一律 false。⚠️此前对话里的汇报你已经记过账了，据它填 true 会造成重复记账）,"subject":"刑法|民法|法理|宪法|法制史 或省略","chapter":"如 第3章 或省略","activity":"听课|做题|背诵|复盘|其他 或省略","accuracy":0-100或省略,"feeling":"一句或省略","confusion":"云本轮最卡的一句或省略（仅供你理解上下文、更好追问，不入任何库，可正常填）","wrongs":["【默认空·仅主动指令】只有云本轮明确说'记进错题本/记录进错题本/这个记错题'时才填对应考点"],"xinde_notes":["【默认空·仅主动指令】只有云本轮明确说'记录进心得/记进心得/这条记下来'时，才把那条规律原话整理成一句填进来"],"absorbed":["今天云明确说懂了/掌握了的考点短语"],"log_fix":{"subject":"刑法","from":"原记录里的章节关键词（如'第四章'）","to":"修正后的章节全名"}（【默认省略·仅主动指令】只有云本轮明确要求修正/改正之前记错的进度时才填）,"memory_updates":[{"fact":"关于云的【新】耐久事实","category":"画像|倾向|目标|偏好|约束"}]}
${COACH_META_CLOSE}
规则（记录=云主动指令制，2026-06-30）：
- **学习日志只认汇报**：is_report=true（云明确在汇报学习进度）时才填 subject/chapter/activity/accuracy；云提问/讨论/被考时这些全省略、is_report=false——系统只在 is_report=true 时写学习日志。
- **错题本/心得只认指令**：wrongs 只在云说"记进错题本"时填；xinde_notes 只在云说"记录进心得"时填。你觉得某个错误/规律很值得记时，【可以在正文里问一句】"要不要我记进错题本/心得？"——云答应了，下一轮再填；【绝不允许不问自记】。
- **修正过往进度只有 log_fix 一条路**：云要求改之前记错的章节时填 log_fix，系统会把该科最近一条章节含 from 的学习日志改成 to。没填 log_fix 就【什么都没被修改】——不许口头宣称"我给你改过来了"（2026-07-04 事故：口头答应但库里没改）。
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

【错题本（=弱项·唯一事实源，云主动说"记进错题本"才进来；按【累计】错次×新近，销账不清零；🔁=吸收过又错的复发点（云的病根，点破它、加倍盯）；🔺=累计错次到阈值建议转专题；吸收前一直挂着）
${backlogDirective}】
${ledger.selfErrorLines.length ? ledger.selfErrorLines.map((l) => "- " + l).join("\n") : "- （错题本是空的）"}
${
  isSunday && ledger.recheckLines.length
    ? `
【吸收复检名单（周日抽查·防"销账后又忘"：这些是销账 5-60 天的旧错题，本次复盘顺手挑 1-2 条用理解层突袭考一下——答上来就过、不用记录；答不上让云说"记进错题本"重新挂账，系统会自动标 🔁）】
${ledger.recheckLines.map((l) => "- " + l).join("\n")}`
    : ""
}

【答疑最近卡点（互通·只读参考：云在答疑页确实卡过的点——聊到相关时顺手用【理解层】考他、帮他打通；他讲清了就引导他自己去答疑页或跟你说"记进错题本/我会了"）】
${ledger.askStuckLines.length ? ledger.askStuckLines.map((l) => "- " + l).join("\n") : "- （无）"}`;
}

/** 拼用户消息：嵌入近 N 轮对话（供理解上文）+ 本轮新消息 + 可选按需块（当科高频 + 检索命中）
 *  （仿答疑做法，runSingleTurn 只收单条 user；按需块放 user 侧，不碰 system 缓存前缀）。 */
function buildUserMessage(conversationLines: string[], input: string, extraBlock = ""): string {
  const convo =
    conversationLines.length === 0
      ? ""
      : `【此前对话（旧→新。这些轮次你【都已经回复过、该记的账也都记过了】——只用于理解上文和指代：
- 不要把旧问题重新回答一遍，不要复述你自己说过的内容（2026-07-04 事故：把前一天的回复整段重播）；
- 不要把云在此前轮次说的话当成他本轮说的；
- 此前有云没接的问题，想追就简短一句带过，别重写答案。引用证据仍以账本为准）】
${conversationLines.join("\n")}

`;
  if (!convo && !extraBlock) return input;
  return `${convo}【本轮云说（你只回应这一条）】
${input}${extraBlock ? `\n\n${extraBlock}` : ""}`;
}

/** 教练侧检索结果总量兜底（字符，≈8-9 千 token）。2026-07-03 云拍板预算 ¥1.5/轮后从 9000 放宽：
 *  前缀瘦身省出的空间买检索深度——教练考云/带章节时引原文更扎实。顶格轮全项叠满 ≈¥1.4，仍在预算内。 */
const COACH_GREP_CLIP = 12000;

/**
 * 两段式·段①（2026-07-01 教练升级）：Sonnet 小调用判断本轮要不要查《考试分析》原文/心得/真题，
 * 要则列关键词 → 本地 grep content_mirror → 结果拼成注入块。
 * 闲聊/汇报进度等与具体知识点无关的轮次规划器给空数组 → 零注入零额外 Opus input。
 * 任何一步失败都吞掉返回空串（教练退回纯账本+架构作答，不阻塞）。
 */
async function planAndSearch(input: string, conversationTail: string[], signal?: AbortSignal, image?: ChatImage | null): Promise<{ block: string; costUsd: number; subject: string | null }> {
  const planSystem = `你是法硕教练的检索规划器。教练回答前可先查库：search_textbook（《考试分析》教材+刑法讲义原文）/ search_xinde（做题心得）/ search_zhenti（真题，参数 year、question_no）。
两件事：
① 判科目：云本轮主要涉及哪科（刑法|民法|法理|宪法|法制史）——汇报进度/提问/被考都算；跨科或无科目给 null。
② 判断需不需要查库：
- 需要：聊到具体科目/章节/考点的学习安排或疑问、问某章重点/怎么学、让教练考他、涉及具体法律概念——列出检索词。
- 不需要：纯闲聊、汇报进度、谈时间/情绪/节奏、与具体知识点无关 → "searches" 给空数组。
输出且仅输出 JSON（无其他文字）：{"subject":"刑法或null","searches":[{"tool":"search_textbook","keyword":"教材原词≤8字"}]}
最多 6 条；涉及具体考点时同一概念尽量 search_textbook + search_xinde 各一条（原文+考法都拿到）；keyword 用教材里会出现的短词（如"想象竞合""表见代理"），别整句。`;
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
      image, // 拍照轮：考点/章节多半在图里，规划器不看图判不了科目和检索词
    });
    const plan = parsePlan(extractText(message));
    const subject = plan.subject && SUBJECTS.includes(plan.subject) ? plan.subject : null;
    // 封顶 6（2026-07-03 从 4 放宽）：同一概念 教材+心得 各一条 → 3 个概念全覆盖；总量由 COACH_GREP_CLIP 兜底
    const searches = dedupeSearches(plan.searches).slice(0, 6);
    if (searches.length === 0) return { block: "", costUsd, subject };

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
      subject,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.error("[coach] 预检索失败（本轮退回纯账本作答）：", err instanceof Error ? err.message : String(err));
    return { block: "", costUsd: 0, subject: null };
  }
}

export async function runCoach(
  input: string,
  today = new Date(),
  signal?: AbortSignal,
  /** 拍照上传（错题页/笔记）：只随本轮进规划+作答两次调用；不写 coach_message 账本
   *  （账本只存文字并标〔附图〕——图片 base64 进账本会把后续每轮的对话回喂撑爆，复利成本红线） */
  image?: ChatImage | null,
): Promise<CoachResult> {
  const todayStr = bjDateStr(today);
  // 北京星期（+8h 后取 UTC 星期）：周日做"本周积压未吸收错题"复盘，非周日不主动翻账。
  const isSunday = new Date(today.getTime() + 8 * 3600 * 1000).getUTCDay() === 0;
  const ledger = await loadLedger(today);
  // 两段式段①：按本轮话题按需查《考试分析》原文/心得/真题 + 顺带判科目（结果都进 user 消息，
  // system 缓存前缀不动）；再按科目取该科真题高频。前缀常驻大块已删，成本账见文件头注释。
  const { block: grepBlock, costUsd: planCost, subject: planSubject } = await planAndSearch(
    input,
    ledger.conversationLines.slice(-4),
    signal,
    image,
  );
  const gaopinBlock = await loadGaopinFor(planSubject);
  const extraBlocks = [gaopinBlock, grepBlock].filter(Boolean).join("\n\n");

  const { message, costUsd: answerCost } = await runSingleTurn({
    system: {
      stable: buildSystemStable(),
      volatile: buildSystemVolatile(ledger, todayStr, isSunday),
    },
    user: buildUserMessage(ledger.conversationLines, input, extraBlocks),
    model: MODELS.COACH,
    signal,
    route: "coach",
    maxTokens: 4000, // 对话式回复可能较长 + 尾部 META
    image,
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
    // 同日同科同章防重（2026-07-04 事故：模型把历史里已入账的汇报当本轮又报一遍 → 第九章记了两条）。
    // 章节名一含一（"第九章" vs "第九章 故意犯罪的停止形态"）也算重——模型复述时经常补全/缩短章名。
    let dup = false;
    if (parsed.chapter) {
      const { data: sameDay } = await supabaseAdmin
        .from("study_log")
        .select("id, chapter")
        .eq("log_date", todayStr)
        .eq("subject", parsed.subject ?? "未识别");
      dup = (sameDay ?? []).some((r) => {
        const a = String(r.chapter ?? "");
        return a && (a.includes(parsed.chapter!) || parsed.chapter!.includes(a));
      });
    }
    if (dup) {
      console.log("[coach] 同日同章已入账，跳过重复学习日志：", parsed.subject, parsed.chapter);
    } else {
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
  }

  // 进度修正（指令制，2026-07-04）：云明确要求修正时 META.log_fix 才有值 →
  // 把该科【最近 14 天内最新一条】章节含 from 的学习日志改成 to（只动一行，防误伤）。
  let logFixed: string | null = null;
  const fix = meta?.log_fix;
  if (fix?.subject && fix?.from && fix?.to) {
    const fixSubj = String(fix.subject);
    const fixFrom = String(fix.from).trim();
    const fixTo = String(fix.to).trim().slice(0, 80);
    if (SUBJECTS.includes(fixSubj) && fixFrom && fixTo) {
      const since = bjDateStr(new Date(today.getTime() - 14 * DAY));
      const { data: hit } = await supabaseAdmin
        .from("study_log")
        .select("id, chapter, log_date")
        .eq("subject", fixSubj)
        .ilike("chapter", `%${fixFrom}%`)
        .gte("log_date", since)
        .order("id", { ascending: false })
        .limit(1);
      if (hit && hit.length) {
        const { error: fixErr } = await supabaseAdmin
          .from("study_log")
          .update({ chapter: fixTo })
          .eq("id", hit[0].id);
        if (fixErr) console.error("[coach] 进度修正失败：", fixErr.message);
        else logFixed = `${hit[0].log_date} ${fixSubj}「${hit[0].chapter}」→「${fixTo}」`;
      } else {
        console.log("[coach] 进度修正未命中（近14天无匹配行）：", fixSubj, fixFrom);
      }
    }
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

  // 存本轮对话（连续性）：云消息 + 教练回复。附图轮只存文字+标记——
  // 教练回复已复述图中要点，后续轮靠文字回喂足够，图不进账本（复利成本红线）
  const { error: msgErr } = await supabaseAdmin.from("coach_message").insert([
    { role: "user", content: image ? `${input}〔附图片〕` : input },
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
    logFixed,
    costUsd,
    metaParsed: meta != null,
  };
}
