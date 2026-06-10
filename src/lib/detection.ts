import { runPlanThenAnswer, extractText, fmtCost } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import schedulerCfg from "../../config/scheduler.json";
import ankiData from "../data/anki_extracted.json";
import type { KpRow } from "./scheduler";

/**
 * 检测引擎（build order ③ · 系统设计/03 §4 + /14 §6 G1/G2）。
 *
 * 统一三档接口（避免先建 L2/L3 再补 L1 的返工）：
 *   - generateQuestion(kpId, level) → { question, answerKey, source, sourceRef }
 *   - gradeAnswer(...)              → { grade, passed, hits, missing, confidence, starred, explanation }
 *
 * L1 = 规则秒判（关键词命中率，模糊带 Haiku 兜底）—— 内容底座=Anki 标注体系（P1必背高精/P2必背/口诀）
 * L2 = 理解（简答），Opus + grep 教材锚定        —— 题源三层：真题直取 → 真题改造 → 教材生成
 * L3 = 应用（迷你案例），Opus + grep 教材锚定    —— 同上
 *
 * 红线（不可破，对应 BUILD_PLAN §红线）：
 *   ① 评分 Opus 不降级（放水=假掌握，飞轮变自欺机器）
 *   ② L2/L3 题源真题优先，AI 生成必标 source 供云抽查（防出题=评分循环论证）
 *   ③ grade 后必写 detection_log + kp_state；连续失败达阈值发 events(弱项候选)（G1 闭环）
 */

export type Level = "L1" | "L2" | "L3";
export type QuestionSource = "anki" | "real" | "adapted" | "ai" | "none";
export type Grade = "干净通过" | "勉强" | "未过";

export interface DetectQuestion {
  kpId: string;
  level: Level;
  question: string;
  /** L1=参考关键词集（评分用）；L2/L3=参考答案要点 */
  answerKey: string[];
  source: QuestionSource;
  /** 来源标注：anki note_id / 真题 "2024-48" / 教材行号区间 / "ai-generated"，供抽查 */
  sourceRef: string;
  /** 出题成本（L2/L3 有 Opus 改造/生成时 > 0） */
  costUsd?: number;
  /** 缺料：L1 无 Anki 卡，或 L2/L3 教材锚为空 */
  warning?: string;
}

export interface GradeResult {
  kpId: string;
  level: Level;
  grade: Grade;
  passed: boolean;
  /** 命中的关键词/要点（评分理由可解释） */
  hits: string[];
  /** 缺失的关键词/要点 */
  missing: string[];
  confidence: number; // 0-100
  starred: boolean;
  explanation: string;
  /** L1 规则评分=undefined；L2/L3 Opus 评分=$ */
  costUsd: number;
  /** grep 教材命中行号（L2/L3） */
  grepLines: number[];
  /** kp_state 升降档/到期推算的更新（已写库），返回前端展示 */
  stateUpdate: KpStateUpdate;
  /** G1：是否触发 events(弱项候选) */
  weakEventEmitted: boolean;
  /** 评分使用的模型（红线审计） */
  model: string;
}

export interface KpStateUpdate {
  prev: { cur_level: Level; interval_idx: number; difficulty: number };
  next: { cur_level: Level; interval_idx: number; difficulty: number; next_due: string };
  mastered: boolean;
}

const CFG = schedulerCfg;
const INTERVALS: number[] = CFG.间隔档_天 as number[];
const MAX_INTERVAL = INTERVALS.length - 1;
const DIFF_MIN = CFG.难度D.min;
const DIFF_MAX = CFG.难度D.max;
const G1_THRESHOLD = (CFG as { G1_背诵失败转弱项: { 连续失败阈值: number } }).G1_背诵失败转弱项.连续失败阈值;

/** Anki 全量解析结果（构建一次缓存到 module-level，~860 张卡 ≈ 几 MB） */
interface AnkiCard {
  note_id: number;
  subject: string;
  is_fatiao: boolean;
  deck: string;
  chapter: string;
  题型: string;
  星级: number;
  title: string;
  口诀: string[];
  P1必背高精: string[];
  P2必背: string[];
  P3选背: string[];
  P4浏览: string[];
  客观点: string[];
  极重要客观点: string[];
  /** 原始 HTML 保真层（2026-06-10）：与 Anki 卡颜色/排版一字不差，背诵原文以此为准 */
  章节HTML?: string;
  题目HTML?: string;
  原文HTML?: string;
  笔记HTML?: string;
  /** 小节分段（L1 出题/评分单位）：一卡多考点时题目与 answerKey 必须同段 */
  分段?: AnkiSegment[];
}

interface AnkiSegment {
  标题: string;
  星级: number;
  口诀: string[];
  P1必背高精: string[];
  P2必背: string[];
}

// Anki 卡组随仓库一起打包（src/data/anki_extracted.json，~6 MB / 863 张卡）。
// import 让 Next 在 build 时把数据序列化进 server bundle —— Railway/Vercel 上无需 fs。
// 更新流程：PC 跑 scripts/anki-extract.py → 覆盖 src/data/anki_extracted.json → 部署。
let ANKI_CACHE: Map<number, AnkiCard> | null = null;
function loadAnki(): Map<number, AnkiCard> {
  if (ANKI_CACHE) return ANKI_CACHE;
  const raw = ankiData as unknown as AnkiCard[] | { cards: AnkiCard[] };
  const cards = Array.isArray(raw) ? raw : raw.cards;
  ANKI_CACHE = new Map(cards.map((c) => [c.note_id, c]));
  return ANKI_CACHE;
}

// ============================================================
// 背诵原文（编码阶段·零成本，从 Anki 卡取，不调 LLM）
// ============================================================

export interface StudyMaterial {
  kpId: string;
  name: string;
  subject: string;
  level: Level;
  capLevel: Level;
  anchor: string;
  zhentiFreq: string;
  /** 每张关联 Anki 卡的背诵原文（按星级降序，最重要的在前） */
  cards: {
    title: string;
    star: number;
    type: string; // 题型：主观/客观/其他
    p1: string[]; // P1 必背高精
    p2: string[]; // P2 必背
    mnemonics: string[]; // 口诀
    objectivePoints: string[]; // 客观点
    /** 原始 HTML 保真层：contentHtml=Anki 答案面主体（题目字段，无则原文），
     *  sourceHtml=考试分析原文对照（仅当与主体不同），chapterHtml=章节结构图，noteHtml=我的笔记 */
    contentHtml: string;
    sourceHtml: string;
    chapterHtml: string;
    noteHtml: string;
  }[];
  /** 无 Anki 卡时给出提示（法综覆盖率低 / 冷点） */
  warning?: string;
}

/**
 * 取考点的背诵原文（编码阶段，效果图 ①·5 屏）。
 * 零 LLM 成本：直接读 Anki 卡的标注体系（P1必背高精/P2必背/口诀/客观点）。
 * 检测阶段（提取）才调 generateQuestion 出题。
 */
export async function getStudyMaterial(kpId: string): Promise<StudyMaterial> {
  const kp = await loadKp(kpId);
  const noteIds = ((kp.ext as { anki_note_ids?: number[] })?.anki_note_ids ?? []) as number[];
  const anki = loadAnki();
  const cards = noteIds
    .map((id) => anki.get(id))
    .filter((c): c is AnkiCard => !!c)
    .sort((a, b) => (b.星级 ?? 0) - (a.星级 ?? 0))
    .map((c) => {
      const timu = c.题目HTML ?? "";
      const yuanwen = c.原文HTML ?? "";
      return {
        title: c.title.trim(),
        star: c.星级 ?? 0,
        type: c.题型 ?? "其他",
        p1: c.P1必背高精 ?? [],
        p2: c.P2必背 ?? [],
        mnemonics: (c.口诀 ?? []).map((s) => s.replace(/【.+?】/g, "")),
        objectivePoints: c.客观点 ?? [],
        // 主体=题目字段（带优先级配色的背诵内容）；无题目的"要点速刷"卡直接用原文
        contentHtml: timu || yuanwen,
        sourceHtml: timu && yuanwen ? yuanwen : "",
        chapterHtml: c.章节HTML ?? "",
        noteHtml: c.笔记HTML ?? "",
      };
    });

  return {
    kpId: kp.kp_id,
    name: (kp.ext as { name?: string })?.name ?? kp.kp_id,
    subject: kp.subject,
    level: kp.cur_level as Level,
    capLevel: kp.cap_level as Level,
    anchor: formatAnchor(kp),
    zhentiFreq: String((kp.ext as { zhenti_freq?: string })?.zhenti_freq ?? "低"),
    cards,
    warning:
      cards.length === 0
        ? "本考点暂无关联 Anki 卡（法综覆盖率较低或冷点）——可直接进入检测，或在答疑 tab 提问。"
        : undefined,
  };
}

// ============================================================
// 全卡浏览（/cards 卡组入口，零成本零 DB）——保证 863 张卡一张不漏可达，
// 不依赖考点匹配（民法法条卡等无法按名挂 kp 的卡由此入口兜底）。
// ============================================================

export interface CardListItem {
  noteId: number;
  subject: string;
  /** 去掉牌组根名的卡组路径，如 "民法法条分析" / "A 刑法学/05.故意犯罪的停止形态/02 第二节 犯罪既遂" */
  deck: string;
  title: string;
  star: number;
  isFatiao: boolean;
}

const deckPath = (c: AnkiCard) => c.deck.split("::").slice(1).join("/");

export function listAnkiCards(subject?: string): CardListItem[] {
  const out: CardListItem[] = [];
  for (const c of loadAnki().values()) {
    if (subject && c.subject !== subject) continue;
    out.push({
      noteId: c.note_id,
      subject: c.subject,
      deck: deckPath(c),
      title: c.title.trim(),
      star: c.星级 ?? 0,
      isFatiao: c.is_fatiao,
    });
  }
  // 卡组路径排序 = 牌组编号序 = 章节序；同组内保持 note 顺序（即卡组内顺序）
  return out.sort((a, b) => a.deck.localeCompare(b.deck, "zh") || a.noteId - b.noteId);
}

export interface CardView {
  noteId: number;
  subject: string;
  deck: string;
  title: string;
  type: string;
  contentHtml: string;
  sourceHtml: string;
  chapterHtml: string;
  noteHtml: string;
}

export function getAnkiCardView(noteId: number): CardView | null {
  const c = loadAnki().get(noteId);
  if (!c) return null;
  const timu = c.题目HTML ?? "";
  const yuanwen = c.原文HTML ?? "";
  return {
    noteId: c.note_id,
    subject: c.subject,
    deck: deckPath(c),
    title: c.title.trim(),
    type: c.题型 ?? "其他",
    contentHtml: timu || yuanwen,
    sourceHtml: timu && yuanwen ? yuanwen : "",
    chapterHtml: c.章节HTML ?? "",
    noteHtml: c.笔记HTML ?? "",
  };
}

// ============================================================
// 出题：generateQuestion
// ============================================================

export async function generateQuestion(opts: {
  kpId: string;
  level?: Level;
}): Promise<DetectQuestion> {
  const kp = await loadKp(opts.kpId);
  const level: Level = opts.level ?? (kp.cur_level as Level);
  if (level === "L1") return generateL1(kp);
  return generateL2L3(kp, level);
}

function generateL1(kp: KpRow): DetectQuestion {
  const noteIds = ((kp.ext as { anki_note_ids?: number[] })?.anki_note_ids ?? []) as number[];
  const anki = loadAnki();
  const cards = noteIds.map((id) => anki.get(id)).filter((c): c is AnkiCard => !!c);

  if (cards.length === 0) {
    // 缺料：考点没有匹配的 Anki 卡，L1 无法出题 → 让调用方降级到 L2
    return {
      kpId: kp.kp_id,
      level: "L1",
      question: `[L1 缺料] 考点【${(kp.ext as { name?: string })?.name ?? kp.kp_id}】无关联 Anki 卡`,
      answerKey: [],
      source: "none",
      sourceRef: "",
      warning: "无 Anki 卡，建议跳到 L2",
    };
  }

  // 取星级最高的卡（最重要的题目）作为本次检测题
  const pick = cards.sort((a, b) => (b.星级 ?? 0) - (a.星级 ?? 0))[0];

  // 一卡多考点（258 张卡含多个编号小节）→ 题目与 answerKey 必须同段，
  // 否则题目只问第一小节、关键词却混入其他小节 → 永远到不了 80% 通过线（2026-06-10 修）。
  const seg = pickSegment(pick, (kp.ext as { name?: string })?.name ?? "");
  const segTitle = (seg?.标题 || pick.title).trim();

  // L1 关键词集 = 本段 P1必背高精（核心，"高精"层）+ 本段口诀。
  //   不纳入 P2必背：P2 是要点级展开（往往是整句解释），属 L2 理解检测的料；
  //   若全混进 L1 答案集，80% 阈值会变成"逐句默写整本书"，惩罚正常的结构化回答。
  //   （依据 Anki 标注体系：P1=高精必背=L1 默写靶点；P2=要点=L2。见 memory: "P1精确P2要点"）
  const p1 = seg?.P1必背高精 ?? pick.P1必背高精 ?? [];
  const mnemonics = (seg?.口诀 ?? pick.口诀 ?? []).map((s) => s.replace(/【.+?】/g, ""));
  // 兜底：个别段 P1 为空（只标了 P2）→ 退用本段 P2，避免 L1 无料可测。
  const core = p1.length > 0 ? p1 : (seg?.P2必背 ?? pick.P2必背 ?? []);
  const keywords = uniqShort([...core, ...mnemonics]);

  return {
    kpId: kp.kp_id,
    level: "L1",
    question: `请按要点默写：${segTitle}\n（限 60 秒；列出关键词/要点即可，不必逐字）`,
    answerKey: keywords,
    source: "anki",
    sourceRef: `anki:${pick.note_id}`,
  };
}

/**
 * 选出题小节：优先标题与考点名互含的段（去掉 "0XX."/✨/"题目：" 修饰后比对），
 * 否则取星级最高段（同星取首段）。无分段数据 → null（退整卡，与旧行为一致）。
 */
function pickSegment(card: AnkiCard, kpName: string): AnkiSegment | null {
  const segs = (card.分段 ?? []).filter((s) => s.P1必背高精.length || s.P2必背.length || s.口诀.length);
  if (segs.length === 0) return null;
  if (segs.length === 1) return segs[0];
  const clean = (s: string) =>
    normalize(s.replace(/^\d{3}\./, "").replace(/✨/g, "").replace(/^题目[:：]/, ""));
  const name = normalize(kpName);
  if (name.length >= 2) {
    const hit = segs.find((s) => {
      const t = clean(s.标题);
      return t.length >= 2 && (t.includes(name) || name.includes(t));
    });
    if (hit) return hit;
  }
  return [...segs].sort((a, b) => (b.星级 ?? 0) - (a.星级 ?? 0))[0];
}

/**
 * 关键词规则（出题/评分规划器共用）。
 * grep 是逐行子串匹配 → 关键词必须是【单个连续短词，不含空格】，否则几乎必然零命中。
 * 这是 L2/L3 真实验收（2026-06-09）暴露的坑：用完整考点名当 keyword → grep 全空 → 评分无锚退化。
 */
const KEYWORD_RULE = `【关键词硬规则】grep 是逐行子串匹配：
- 关键词必须是【单个连续短词，2-6 字法律术语最佳，不含空格】。
- 把长考点名拆成核心术语，如"正当防卫的概念和成立条件"→只用"正当防卫"；"债务转移与担保"→拆成"债务转移"+"担保"两条。
- 整名/带空格的词几乎零命中，禁止使用。`;

/** 从考点名截出一个适合 grep 的短关键词（去掉"的概念/成立条件/特征"等后缀修饰） */
function shortKeyword(name: string): string {
  let s = name
    .replace(/^(刑法|民法|宪法)(中|上)的/, "") // 剥前缀修饰：刑法中的因果关系→因果关系
    .replace(/的(概念|特征|含义|定义|成立条件|构成要件|分类|种类|意义|认定|效力|原则).*$/, "")
    .replace(/[（(].*?[）)]/g, "")
    .trim();
  if (s.length > 8) s = s.slice(0, 6); // 仍过长则截前 6 字（宁短勿长，命中率优先）
  return s || name.slice(0, 4);
}

async function generateL2L3(kp: KpRow, level: Level): Promise<DetectQuestion> {
  // L2/L3 出题——本期先留骨架（用教材锚生成 Opus 草题），三层题源待真题索引建好后实装。
  // 工作流：① 查 kp.ext.related_zhenti（建库 by build-kp.mjs，刑法已有）；
  //         ② 若主观题真题→直取；客观题→Opus 改造；冷点→Opus 基于教材锚生成。
  // 当前实装：仅"教材生成"路径，标 source=ai 进抽查面板。
  const name = (kp.ext as { name?: string })?.name ?? kp.kp_id;
  const anchor = formatAnchor(kp);

  const rubric =
    level === "L2"
      ? "出一道【简答题】（要求考生分点回答概念/特征/法理依据，4-6 个要点）。"
      : "出一道【迷你案例题】（一段 80-150 字案情，要求考生定性+说明法律关系/罪名+给出法律后果）。";

  const planSys = `你只列检索查询不作答。围绕考点【${name}】（${kp.subject}）规划 3-5 条检索：
- search_xinde：本考点相关心得规则
- search_textbook：教材原文（必查，作答案锚）
- search_zhenti：相关真题（若考点名常考则按年份枚举几年）
${KEYWORD_RULE}
只输出 JSON 数组（示例用短词）：[{"tool":"search_textbook","keyword":"${shortKeyword(name)}"},{"tool":"search_xinde","keyword":"${shortKeyword(name)}"}]`;

  const answerSys = `你是法硕命题人。基于【系统预检索结果】里的教材原文、真题、心得，为考点【${name}】出一道${rubric}

【硬约束】
1. 只在教材或真题已覆盖的范围内出题；超纲一票否决。
2. 输出格式严格如下，不要任何额外文字：

题目：（题干，不含答案）
参考答案要点（4-6 条，逐条短句，命中其中 ≥3 条算通过）：
- 要点1
- 要点2
- ...
教材锚点：${anchor || "（若预检索结果有命中行号则填，否则留空）"}
`;

  const { message, costUsd, grepHits } = await runPlanThenAnswer({
    planSystem: planSys,
    answerSystemStable: answerSys,
    question: `请为【${name}】出一道${level}级检测题。`,
    model: MODELS.GRADING,
    route: `detect:gen:${level}`,
    maxAnswerTokens: 1200,
  });

  const raw = extractText(message);
  const { question, answerKey } = parseGeneratedQuestion(raw);

  return {
    kpId: kp.kp_id,
    level,
    question,
    answerKey,
    source: "ai",
    sourceRef: anchor ? `textbook:${anchor}` : `grep:${grepHits.map((h) => h.path).join(",")}`,
    costUsd,
    warning: "AI 生成（待抽查面板核对）",
  };
}

export function parseGeneratedQuestion(raw: string): {
  question: string;
  answerKey: string[];
} {
  // 容错抽取：题目: ... 参考答案要点（可带括号说明）: ... 教材锚点 ...
  // ⚠️ 标签后可能有"（4-6 条…）"括号说明再接冒号，故用 [^\n]* 吃掉中间，再匹配冒号。
  const q = raw.match(/题目[^\n：:]*[：:]\s*([\s\S]*?)(?=参考答案要点|参考答案|教材锚点|$)/);
  const a = raw.match(
    /参考答案要点[^\n：:]*[：:][^\n]*\n([\s\S]*?)(?=教材锚点|教材依据|$)/,
  );
  const question = (q?.[1] ?? raw).trim();
  const answerKey = (a?.[1] ?? "")
    .split("\n")
    .map((s) => s.replace(/^[\s\t]*[-·•▪️*]+\s*/, "").trim()) // 剥项目符号
    .map((s) => s.replace(/^[（(]?\d+[）)]?[.、:：]?\s*/, "")) // 剥编号 1. / （1）
    .filter((s) => s.length > 1 && s.length < 200);
  return { question, answerKey };
}

// ============================================================
// 评分：gradeAnswer
// ============================================================

export async function gradeAnswer(opts: {
  kpId: string;
  level: Level;
  question: string;
  userAnswer: string;
  answerKey: string[];
  source: QuestionSource;
  sourceRef: string;
  /** 答题耗时秒数（题目呈现→提交）；UI 未传则 null */
  seconds?: number | null;
}): Promise<GradeResult> {
  const kp = await loadKp(opts.kpId);
  const matchLevel = (kp.ext as { anki_match_level?: string })?.anki_match_level;
  const result =
    opts.level === "L1"
      ? gradeL1(opts.userAnswer, opts.answerKey, matchLevel)
      : await gradeL2L3(kp, opts);

  // 写 detection_log
  await supabaseAdmin.from("detection_log").insert({
    kp_id: kp.kp_id,
    level: opts.level,
    question: opts.question,
    answer: opts.userAnswer,
    ai_grade: result.grade,
    passed: result.passed,
    seconds: opts.seconds ?? null,
    model: result.model,
    grep_lines: result.grepLines.join(","),
    confidence: result.confidence,
    starred: result.starred,
  });

  // 更新 kp_state 升降档
  const stateUpdate = await applyStateUpdate(kp, opts.level, result.grade);

  // G1：连续失败达阈值 → events(弱项候选)
  let weakEventEmitted = false;
  if (!result.passed) {
    weakEventEmitted = await maybeEmitWeakEvent(kp, opts.level);
  }

  return {
    ...result,
    kpId: kp.kp_id,
    level: opts.level,
    stateUpdate,
    weakEventEmitted,
  };
}

// ---------------- L1 规则秒判 ----------------

interface L1Internal {
  grade: Grade;
  passed: boolean;
  hits: string[];
  missing: string[];
  confidence: number;
  starred: boolean;
  explanation: string;
  costUsd: number;
  grepLines: number[];
  model: string;
}

function gradeL1(userAnswer: string, answerKey: string[], matchLevel?: string): L1Internal {
  const ans = normalize(userAnswer);
  if (!ans) {
    return {
      grade: "未过",
      passed: false,
      hits: [],
      missing: answerKey,
      confidence: 100,
      starred: false,
      explanation: "答案为空。",
      costUsd: 0,
      grepLines: [],
      model: "rule:l1",
    };
  }
  if (answerKey.length === 0) {
    return {
      grade: "勉强",
      passed: false,
      hits: [],
      missing: [],
      confidence: 30,
      starred: true,
      explanation: "本题无参考关键词（缺料），评分不可靠，标★。",
      costUsd: 0,
      grepLines: [],
      model: "rule:l1",
    };
  }

  const hits: string[] = [];
  const missing: string[] = [];
  for (const kw of answerKey) {
    if (matchKeyword(ans, kw)) hits.push(kw);
    else missing.push(kw);
  }
  const rate = hits.length / answerKey.length;
  // 节级共用题源（answerKey 是整节要点、偏多）→ 放宽通过门槛 0.8→0.6
  const passT = matchLevel === "section" ? 0.6 : 0.8;
  const note = matchLevel === "section" ? "（本节共用题源，门槛已放宽）" : "";

  let grade: Grade;
  let confidence: number;
  if (rate >= passT) {
    grade = "干净通过";
    confidence = Math.round(80 + rate * 20);
  } else if (rate >= passT - 0.2) {
    grade = "勉强"; // TODO: 接 Haiku 复判（成本敏感，先用纯规则）
    confidence = Math.round(50 + rate * 30);
  } else {
    grade = "未过";
    confidence = Math.round(60 + (1 - rate) * 30);
  }

  return {
    grade,
    passed: grade === "干净通过",
    hits,
    missing,
    confidence,
    starred: false,
    explanation: `关键词命中 ${hits.length}/${answerKey.length}（${Math.round(rate * 100)}%）。${note}`,
    costUsd: 0,
    grepLines: [],
    model: "rule:l1",
  };
}

const PUNCT = /[\s、，。；：;:,.()（）""""''《》<>【】\[\]·]+/g;
function normalize(s: string): string {
  return s.replace(PUNCT, "").replace(/[。，！？]/g, "");
}

/**
 * 关键词清洗：剥掉教材的列表编号/标签前缀，只留语义核心。
 * 否则用户不写"1."这种序号就被判漏（false negative）。
 * 处理：①前导编号 1. / （1） / (1) / 一、 / Ø / • ②前导标签 概念：/特征：/含义：
 */
function keywordCore(keyword: string): string {
  let s = keyword.trim();
  // 前导列表标记（可能叠多层，循环剥）
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/^[（(]?\s*[0-9０-９]+\s*[）)]?\s*[.、:：)]?\s*/, "") // 1. / （1） / 1)
      .replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "") // 一、
      .replace(/^[Øø•·▪◦*\-—]+\s*/, "") // 项目符号
      .replace(/^(概念|含义|特征|定义|理解|要点)\s*[:：]\s*/, ""); // 标签前缀
  }
  return normalize(s);
}

/** 关键词命中：剥编号→归一化→子串匹配；过短(<2 字)的关键词跳过防误判 */
function matchKeyword(answer: string, keyword: string): boolean {
  const k = keywordCore(keyword);
  if (k.length < 2) return false;
  if (k.length <= 8) return answer.includes(k);
  // 长关键词：按 2-字滑动取词根，命中 ≥60% 算命中（应对"用自己话说"场景）
  const tokens: string[] = [];
  for (let i = 0; i < k.length - 1; i++) {
    const t = k.slice(i, i + 2);
    if (!/[一-龥]{2}/.test(t)) continue;
    tokens.push(t);
  }
  if (tokens.length === 0) return answer.includes(k);
  const hit = tokens.filter((t) => answer.includes(t)).length;
  return hit / tokens.length >= 0.6;
}

// ---------------- L2/L3 Opus 评分 ----------------

async function gradeL2L3(
  kp: KpRow,
  opts: { level: Level; question: string; userAnswer: string; answerKey: string[] },
): Promise<L1Internal> {
  const name = (kp.ext as { name?: string })?.name ?? kp.kp_id;
  const planSys = `你只列检索查询不作答。本次任务=评分考生对【${name}】（${kp.subject}）的简答/案例作答。规划 3-5 条 grep：
- search_textbook：本考点教材原文（必查，评分锚）
- search_xinde：相关心得规则
- search_zhenti：若题干引自真题则查
${KEYWORD_RULE}
只输出 JSON 数组（示例用短词）：[{"tool":"search_textbook","keyword":"${shortKeyword(name)}"}]`;

  const ans = `═══ 你是法硕评分老师 ═══
对考生作答按下列 rubric 严格评分。【严禁放水：放水=假掌握=飞轮变自欺机器】。

【题目】
${opts.question}

【参考答案要点（命题人给的，仅供参考；真正判分以教材为准）】
${opts.answerKey.map((k) => "- " + k).join("\n")}

【评分 rubric · ${opts.level}】
${opts.level === "L2" ? CFG.评分rubric.L2 : CFG.评分rubric.L3}

【硬约束】
1. 必须根据【系统预检索结果】里 search_textbook 命中的教材原文比对；缺锚点一律降信心度并标★。
2. 判 干净通过 / 勉强 / 未过 三档之一；未过=核心要点缺失或定性错误。
3. 列出"命中要点"和"缺失要点"，逐条引用教材行号（结果里没行号就不要编）。

═══ 输出严格 JSON 块（不要其他文字，不要 markdown 代码块）═══
{"grade":"干净通过|勉强|未过","hits":["..."],"missing":["..."],"confidence":0-100,"starred":true|false,"grep_lines":[行号数字],"explanation":"一句话评分理由"}
`;

  const { message, grepHits, costUsd } = await runPlanThenAnswer({
    planSystem: planSys,
    answerSystemStable: ans,
    question: `【考生作答】\n${opts.userAnswer}`,
    model: MODELS.GRADING,
    route: `detect:grade:${opts.level}`,
    maxAnswerTokens: 1500,
  });

  const raw = extractText(message);
  const parsed = parseGradeJson(raw);
  const grepLines = parsed.grep_lines.length
    ? parsed.grep_lines
    : grepHits.flatMap((h) => h.lines).slice(0, 20);

  return {
    grade: parsed.grade,
    passed: parsed.grade === "干净通过",
    hits: parsed.hits,
    missing: parsed.missing,
    confidence: parsed.confidence,
    starred: parsed.starred || grepLines.length === 0,
    explanation: parsed.explanation,
    costUsd,
    grepLines,
    model: MODELS.GRADING,
  };
}

interface GradeJson {
  grade: Grade;
  hits: string[];
  missing: string[];
  confidence: number;
  starred: boolean;
  grep_lines: number[];
  explanation: string;
}

function parseGradeJson(raw: string): GradeJson {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const fallback: GradeJson = {
    grade: "勉强",
    hits: [],
    missing: [],
    confidence: 30,
    starred: true,
    grep_lines: [],
    explanation: `评分模型未返回合法 JSON：${raw.slice(0, 80)}`,
  };
  if (start === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<GradeJson>;
    const grade = (obj.grade ?? "勉强") as Grade;
    return {
      grade: (["干净通过", "勉强", "未过"] as Grade[]).includes(grade) ? grade : "勉强",
      hits: Array.isArray(obj.hits) ? obj.hits.map(String) : [],
      missing: Array.isArray(obj.missing) ? obj.missing.map(String) : [],
      confidence: typeof obj.confidence === "number" ? obj.confidence : 50,
      starred: !!obj.starred,
      grep_lines: Array.isArray(obj.grep_lines)
        ? obj.grep_lines.map(Number).filter((n) => Number.isFinite(n))
        : [],
      explanation: String(obj.explanation ?? ""),
    };
  } catch {
    return fallback;
  }
}

// ============================================================
// kp_state 升降档 + G1
// ============================================================

const LEVEL_ORDER: Level[] = ["L1", "L2", "L3"];

async function applyStateUpdate(
  kp: KpRow,
  level: Level,
  grade: Grade,
): Promise<KpStateUpdate> {
  const prev = {
    cur_level: kp.cur_level as Level,
    interval_idx: kp.interval_idx,
    difficulty: kp.difficulty,
  };

  let cur_level = prev.cur_level;
  let interval_idx = prev.interval_idx;
  let difficulty = prev.difficulty;
  const cap = kp.cap_level as Level;

  if (grade === "干净通过") {
    difficulty = clamp(difficulty - 1, DIFF_MIN, DIFF_MAX);
    interval_idx = Math.min(interval_idx + 1, MAX_INTERVAL);
    // 当前档通过 → 升到下一档（未到封顶）
    const curIdx = LEVEL_ORDER.indexOf(level);
    const capIdx = LEVEL_ORDER.indexOf(cap);
    if (curIdx < capIdx) cur_level = LEVEL_ORDER[curIdx + 1];
  } else if (grade === "勉强") {
    // 同档重测，难度微升
    difficulty = clamp(difficulty + 1, DIFF_MIN, DIFF_MAX);
  } else {
    // 未过：难度+1，间隔退半档（即 -1），档级不动；error_count++ 在事务里
    difficulty = clamp(difficulty + 1, DIFF_MIN, DIFF_MAX);
    interval_idx = Math.max(interval_idx - 1, 0);
  }

  // 三档全过 = mastered
  const l1ok = level === "L1" ? grade === "干净通过" : kp.l1_status === "passed";
  const l2ok = level === "L2" ? grade === "干净通过" : kp.l2_status === "passed";
  const l3ok = level === "L3" ? grade === "干净通过" : kp.l3_status === "passed";
  const mastered =
    cap === "L1" ? l1ok : cap === "L2" ? l1ok && l2ok : l1ok && l2ok && l3ok;

  const today = new Date();
  const nextDays = INTERVALS[interval_idx];
  const nextDue = new Date(today.getTime() + nextDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const lastReview = today.toISOString().slice(0, 10);

  const statusField =
    level === "L1" ? "l1_status" : level === "L2" ? "l2_status" : "l3_status";
  const statusValue = grade === "干净通过" ? "passed" : grade === "未过" ? "failed" : "untested";

  const update: Record<string, unknown> = {
    cur_level,
    interval_idx,
    difficulty,
    last_review: lastReview,
    next_due: nextDue,
    mastered,
    review_count: kp.review_count + 1,
    error_count: kp.error_count + (grade === "未过" ? 1 : 0),
    [statusField]: statusValue,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("kp_state")
    .update(update)
    .eq("kp_id", kp.kp_id);
  if (error) throw new Error(`kp_state 更新失败：${error.message}`);

  return {
    prev,
    next: { cur_level, interval_idx, difficulty, next_due: nextDue },
    mastered,
  };
}

/**
 * G1：检查最近 N 次同档检测是否连续失败，达阈值则向 events 投递弱项候选。
 * 防重：同 kp_id+level 已有 pending 弱项候选 → 不重发。
 */
async function maybeEmitWeakEvent(kp: KpRow, level: Level): Promise<boolean> {
  const { data: recent } = await supabaseAdmin
    .from("detection_log")
    .select("passed")
    .eq("kp_id", kp.kp_id)
    .eq("level", level)
    .order("ts", { ascending: false })
    .limit(G1_THRESHOLD);
  if (!recent || recent.length < G1_THRESHOLD) return false;
  const allFailed = recent.every((r) => r.passed === false);
  if (!allFailed) return false;

  // 防重：同 kp 已有 pending 弱项候选则跳过
  const { data: existing } = await supabaseAdmin
    .from("events")
    .select("id")
    .eq("type", "弱项候选")
    .eq("kp_id", kp.kp_id)
    .eq("status", "pending")
    .limit(1);
  if (existing && existing.length > 0) return false;

  const name = (kp.ext as { name?: string })?.name ?? kp.kp_id;
  const { error } = await supabaseAdmin.from("events").insert({
    type: "弱项候选",
    subject: kp.subject,
    kp_id: kp.kp_id,
    knowledge: name,
    anchor: formatAnchor(kp) || null,
    source: "检测",
    payload: {
      level,
      连续失败次数: G1_THRESHOLD,
      触发: "G1 背诵失败转弱项",
    },
    status: "pending",
  });
  if (error) {
    console.error("[detection] G1 events 写入失败：", error.message);
    return false;
  }
  return true;
}

// ============================================================
// 工具
// ============================================================

async function loadKp(kpId: string): Promise<KpRow> {
  const { data, error } = await supabaseAdmin
    .from("kp_state")
    .select("*")
    .eq("kp_id", kpId)
    .single();
  if (error || !data) throw new Error(`找不到考点：${kpId}`);
  return data as KpRow;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** 把 kp.ext.{page,src_line} 拼成"P12·行345"风格的锚点串（供出题/事件标注） */
function formatAnchor(kp: KpRow): string {
  const ext = kp.ext as { page?: number | null; src_line?: number | null };
  const parts: string[] = [];
  if (ext?.page) parts.push(`P${ext.page}`);
  if (ext?.src_line) parts.push(`行${ext.src_line}`);
  return parts.join("·");
}

/** 给 UI/路由用：把 GradeResult 加上人民币显示串（其它字段透传） */
export function fmtGradeForUI(g: GradeResult): GradeResult & { costText: string } {
  return { ...g, costText: fmtCost(g.costUsd) };
}

function uniqShort(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s || s.length > 80) continue; // 过长的整句不当关键词
    const k = normalize(s);
    if (k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 20); // 关键词集封顶 20
}
