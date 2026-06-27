import { runPlanThenAnswer, runSingleTurn, extractText, fmtCost } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { emitEvent, consumeReviewRequests } from "./events";
import { computeTransition } from "./kp-transition";
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

/** L1 关键词填空的一条：挖空句（每个空用 ▢ 占位）+ 各空标准答案（顺序与 ▢ 对应）。 */
export interface ClozeItem {
  s: string;
  a: string[];
  /** 判分模式：exact=逐字秒判（短关键词，缺省值）；semantic=Haiku 按意思判（定义型，意思对就算过）。 */
  mode?: "exact" | "semantic";
}

export interface DetectQuestion {
  kpId: string;
  level: Level;
  question: string;
  /** L1=参考关键词集（评分用，填空时=各空答案展平）；L2/L3=参考答案要点 */
  answerKey: string[];
  /** L1 关键词填空：有则前端渲染挖空填写，answerKey=各空答案展平（顺序一致）；无则退回普通 L1 文本框 */
  cloze?: ClozeItem[];
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
  /** 每张关联 Anki 卡的背诵原文（按 Anki 卡组顺序：卡组路径=章节序 → note_id=节内序） */
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
    // 背诵原文顺序必须与 Anki 卡组一字不差：按卡组路径（=章节序）再按 note_id（=节内顺序）。
    // 不能按星级降序——那样 ✨✨ 高星卡（如"马克思主义法学特征"）会顶到第一节最前面，
    // 与 Anki 浏览顺序不符。（出题挑卡 generateL1 仍按星级，那是另一回事。）
    .sort((a, b) => deckPath(a).localeCompare(deckPath(b), "zh") || a.note_id - b.note_id)
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
  if (level === "L1") return generateL1WithCloze(kp);
  return generateL2L3(kp, level);
}

export function generateL1(kp: KpRow): DetectQuestion {
  const noteIds = ((kp.ext as { anki_note_ids?: number[] })?.anki_note_ids ?? []) as number[];
  const anki = loadAnki();
  const cards = noteIds.map((id) => anki.get(id)).filter((c): c is AnkiCard => !!c);
  const kpName0 = ((kp.ext as { name?: string })?.name ?? "").trim();

  // 根治靶错位（2026-06-15）：优先用【考点专属 L1 要点】ext.l1_keypoints
  //  —— 由 scripts/build-l1-keypoints.mjs 离线按考点名从小节原文抽取，每个考点有自己的靶，
  //  不再像旧逻辑那样多个小考点共用同一张母卡的同一句 P1（"公平原则"被判成"民法基本原则"）。
  //  未抽到的考点（l1_keypoints 缺失）自动回退下面的卡内派生逻辑，平滑兼容。
  const curated = curatedKeypoints(kp);

  if (cards.length === 0) {
    if (curated.length >= 2) {
      return {
        kpId: kp.kp_id,
        level: "L1",
        question: `请按要点默写：${kpName0 || kp.kp_id}\n（限 60 秒；列出关键词/要点即可，不必逐字）`,
        answerKey: curated,
        source: "anki",
        sourceRef: "curated",
      };
    }
    // 缺料：考点没有匹配的 Anki 卡，L1 无法出题 → 让调用方降级到 L2
    return {
      kpId: kp.kp_id,
      level: "L1",
      question: `[L1 缺料] 考点【${kpName0 || kp.kp_id}】无关联 Anki 卡`,
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
  const kpName = kpName0;
  const seg = pickSegment(pick, kpName);
  const segTitle = (seg?.标题 || pick.title).trim();
  // 题面只显示【用户点开的考点名】（与页头 H1 一致）。审计（2026-06-15）证实 96% 的卡里
  // Anki 小节标题 = 考点名 + 噪声（"001."前缀 / ✨ / 【真题年份】），拼进题面又丑又冗；
  // 少数小节标题是更宽的母节（如"法学的产生和发展"的卡是"第一节 法学"）拼上去反而误导
  // 用户以为问错题。考点名最干净准确，内容比对交给评分（含 Haiku 语义兜底）。
  const askName = kpName || segTitle;

  // L1 关键词集 = 本段 P1必背高精（核心，"高精"层）+ 本段口诀。
  //   不纳入 P2必背：P2 是要点级展开（往往是整句解释），属 L2 理解检测的料；
  //   若全混进 L1 答案集，80% 阈值会变成"逐句默写整本书"，惩罚正常的结构化回答。
  //   （依据 Anki 标注体系：P1=高精必背=L1 默写靶点；P2=要点=L2。见 memory: "P1精确P2要点"）
  const p1 = seg?.P1必背高精 ?? pick.P1必背高精 ?? [];
  const mnemonics = (seg?.口诀 ?? pick.口诀 ?? []).map((s) => s.replace(/【.+?】/g, ""));
  // 兜底：个别段 P1 为空（只标了 P2）→ 退用本段 P2，避免 L1 无料可测。
  const core = p1.length > 0 ? p1 : (seg?.P2必背 ?? pick.P2必背 ?? []);
  // 考点专属要点优先；缺失才退回卡内派生
  const keywords = curated.length >= 2 ? curated : uniqShort([...core, ...mnemonics]);

  return {
    kpId: kp.kp_id,
    level: "L1",
    question: `请按要点默写：${askName}\n（限 60 秒；列出关键词/要点即可，不必逐字）`,
    answerKey: keywords,
    source: "anki",
    sourceRef: curated.length >= 2 ? `curated:${pick.note_id}` : `anki:${pick.note_id}`,
  };
}

/**
 * 读考点专属 L1 默写/判分靶。优先 ext.l1_must（按颜色蓝底蓝色离线抽，作者真·必背、按卡/题目天然锁好，
 * 治 Haiku l1_keypoints 串考点的脏靶，2026-06-23）；无则退回 ext.l1_keypoints。非法/不足回空。
 */
function curatedKeypoints(kp: KpRow): string[] {
  const ext = kp.ext as { l1_must?: unknown; l1_keypoints?: unknown };
  const raw = Array.isArray(ext?.l1_must) && ext.l1_must.length >= 2 ? ext.l1_must : ext?.l1_keypoints;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s).trim()).filter((s) => s.length >= 2 && s.length <= 60);
}

/**
 * L1 出题 + 关键词填空（generateQuestion 的 L1 入口，2026-06-18）。
 * 要点是整句，故"关键词填空"= 把句中关键术语挖空让用户填。挖空用 Haiku 现造、缓存到
 * ext.l1_cloze（首次慢、之后免费秒出）。挖空失败/缺料 → 退回普通 L1（前端文本框）。
 */
async function generateL1WithCloze(kp: KpRow): Promise<DetectQuestion> {
  const base = generateL1(kp);
  if (base.answerKey.length === 0) return base; // 缺料：无法填空，原样返回（含 warning，前端走文本框/提示跳 L2）
  const cloze = await getOrBuildCloze(kp, base.answerKey);
  if (cloze.length === 0) return base; // 挖空失败：退回普通 L1
  const kpName = ((kp.ext as { name?: string })?.name ?? "").trim() || kp.kp_id;
  return {
    ...base,
    question: `关键词填空：${kpName}\n（把每个空缺的关键术语填上即可）`,
    answerKey: cloze.flatMap((c) => c.a), // 评分/回传：各空答案展平，顺序=渲染顺序
    cloze,
  };
}

/** 读缓存的 l1_cloze；没有就用 Haiku 现造并写回 kp_state.ext.l1_cloze。 */
async function getOrBuildCloze(kp: KpRow, keypoints: string[]): Promise<ClozeItem[]> {
  // l1_plain=true：离线判定该考点不适合挖空（句型/缺料）→ 走普通默写，禁止 Haiku 现造挖空（曾挖到形容词）。
  if ((kp.ext as { l1_plain?: boolean })?.l1_plain === true) return [];
  const cached = (kp.ext as { l1_cloze?: unknown })?.l1_cloze;
  if (Array.isArray(cached) && cached.length > 0) {
    const valid = cached.filter(
      (it): it is ClozeItem =>
        !!it &&
        typeof (it as ClozeItem).s === "string" &&
        Array.isArray((it as ClozeItem).a) &&
        (it as ClozeItem).a.length > 0,
    );
    if (valid.length > 0) return valid;
  }
  const built = await clozeFromKeypoints(keypoints);
  if (built.length > 0) {
    const newExt = { ...(kp.ext as object | null), l1_cloze: built };
    try {
      await supabaseAdmin.from("kp_state").update({ ext: newExt }).eq("kp_id", kp.kp_id);
      (kp as { ext?: unknown }).ext = newExt; // 让本次请求拿到一致结果
    } catch {
      /* 写缓存失败不影响本次出题 */
    }
  }
  return built;
}

/**
 * 把"整句要点"用 Haiku 挖空成填空题（要点句没预标关键词，需 LLM 挑）。非红线（出题/输入法，
 * 判分仍是确定性规则）→ 用 MODELS.DRAFT(Haiku) 降级省钱。产物非法/失败 → 返回 []。
 */
async function clozeFromKeypoints(keypoints: string[]): Promise<ClozeItem[]> {
  const picked = keypoints.slice(0, 8);
  const list = picked.map((k, i) => `${i + 1}. ${k}`).join("\n");
  const system = `你把中文法考"背诵要点"改成"填空题"。规则：①逐条处理，保留整句结构，只把每条里【最该记的 1~2 个关键术语/数字】挖空，用全角符号 ▢ 占位（一个空一个 ▢）；②不要挖虚词、连词、"的/是/为/在/和"之类，也不要把整句都挖空；③输出严格 JSON 数组，每条形如 {"s":"挖空后的句子","a":["被挖掉的词1","被挖掉的词2"]}，a 的顺序与句中 ▢ 从左到右一一对应、个数相等；④只输出 JSON，不要任何解释。`;
  const user = `把下面每条要点改成填空：\n${list}`;
  try {
    const { message } = await runSingleTurn({
      system,
      user,
      model: MODELS.DRAFT,
      maxTokens: 1500,
      route: "cloze",
    });
    return parseCloze(extractText(message));
  } catch {
    return [];
  }
}

/** 容错解析 cloze JSON，并校验 ▢ 个数==答案个数、答案非空。 */
function parseCloze(text: string): ClozeItem[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ClozeItem[] = [];
  for (const it of arr) {
    const obj = it as { s?: unknown; a?: unknown };
    const s = typeof obj?.s === "string" ? obj.s.trim() : "";
    const a = Array.isArray(obj?.a) ? obj.a.map((x) => String(x).trim()).filter(Boolean) : [];
    const blanks = (s.match(/▢/g) ?? []).length;
    if (s && a.length > 0 && blanks === a.length) out.push({ s, a });
  }
  return out;
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
      ? "出一道【简答题】，考查考生能否把教材原文里的基本观点/概念/特征/法理背出来（4-6 个要点，每条都能在教材原文里找到落点）。不要出需要跨知识点综合、跨流派比较、分野判断或自由发挥的题——那是 L3 的范围。"
      : "出一道【迷你案例题】（一段 80-150 字案情，要求考生定性+说明法律关系/罪名+给出法律后果）。";

  // L2=简答 recall：只锚教材原文（+真题），不检索心得——心得里的跨知识点综合/分野判断会把简答题
  //   抬成"需要发挥的分析题"（用户 2026-06-27）。综合/应用留给 L3，L3 仍检索心得。
  const genRetrieval =
    level === "L2"
      ? `- search_textbook：教材原文（必查，作答案锚）
- search_zhenti：相关真题（若考点名常考则按年份枚举几年）`
      : `- search_xinde：本考点相关心得规则
- search_textbook：教材原文（必查，作答案锚）
- search_zhenti：相关真题（若考点名常考则按年份枚举几年）`;
  const planSys = `你只列检索查询不作答。围绕考点【${name}】（${kp.subject}）规划 3-5 条检索：
${genRetrieval}
${KEYWORD_RULE}
只输出 JSON 数组（示例用短词）：[{"tool":"search_textbook","keyword":"${shortKeyword(name)}"}]`;

  const answerSys = `你是法硕命题人。基于【系统预检索结果】里的${level === "L2" ? "教材原文、真题" : "教材原文、真题、心得"}，为考点【${name}】出一道${rubric}

【硬约束】
1. 只在教材或真题已覆盖的范围内出题；超纲一票否决。${
    level === "L2"
      ? "\n1b. 【L2 简答】参考答案要点只取教材原文已写明的内容（概念/特征/法理依据/代表人物及其观点）；不得加入跨流派、跨知识点的综合比较、分野判断或心得引申——那是 L3 的范围。"
      : ""
  }
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
    planModel: MODELS.PLAN, // 规划阶段（列检索词）降级 Sonnet 省钱；红线只锁作答用 Opus
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
  /** L1 关键词填空：各空填入（顺序与 answerKey 一致）。有则走确定性逐空判分 */
  clozeFilled?: string[];
  /** golden eval / 试评：true=只评分不写库（detection_log/kp_state/events 全跳），不污染生产（#3） */
  dryRun?: boolean;
}): Promise<GradeResult> {
  const kp = await loadKp(opts.kpId);
  const matchLevel = (kp.ext as { anki_match_level?: string })?.anki_match_level;
  let result: L1Internal;
  if (opts.level === "L1") {
    if (opts.clozeFilled && opts.clozeFilled.length > 0) {
      // 判分模式从 kp.ext.l1_cloze 服务端取（不信客户端）：与 answerKey 展平同序；对不齐则全 exact 兜底。
      const cz = (kp.ext as { l1_cloze?: ClozeItem[] })?.l1_cloze;
      const modes = Array.isArray(cz)
        ? cz.flatMap((c) => (c.a ?? []).map(() => (c.mode === "semantic" ? "semantic" : "exact") as "exact" | "semantic"))
        : null;
      result = await gradeL1Cloze(
        opts.clozeFilled,
        opts.answerKey,
        matchLevel,
        modes && modes.length === opts.answerKey.length ? modes : null,
      );
    } else {
      result = await gradeL1WithFallback(kp, opts.userAnswer, opts.answerKey, matchLevel);
    }
  } else {
    result = await gradeL2L3(kp, opts);
  }

  // golden eval / 试评（#3）：dryRun=true 只算评分结果（含"该变成什么"的状态推演），不写任何库
  // （detection_log / kp_state / events 全跳）——L2/L3 评分漂移回归用，不污染生产状态。
  if (opts.dryRun) {
    const t = computeTransition(kp, opts.level, result.grade);
    return {
      ...result,
      kpId: kp.kp_id,
      level: opts.level,
      stateUpdate: {
        prev: { cur_level: kp.cur_level as Level, interval_idx: kp.interval_idx, difficulty: kp.difficulty },
        next: { cur_level: t.cur_level, interval_idx: t.interval_idx, difficulty: t.difficulty, next_due: t.nextDue },
        mastered: t.mastered,
      },
      weakEventEmitted: false,
    };
  }

  // 写 detection_log。这是审计 trail——周报低信心抽样 + #4 G1 不变式对账的参照真值。
  // best-effort（不抛，评分核心写已由 applyStateUpdate 兜底），但失败必须【可见】：
  // 原先 fire-and-forget 会让审计真值静默掉行（参照真值不该有洞）。见 BUILD_PLAN「软硬体制完整性」#1b。
  const { error: logErr } = await supabaseAdmin.from("detection_log").insert({
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
    hits: result.hits, // 迁移007：落结果正文，供「今天背了哪些」复盘回看（非只判分）
    missing: result.missing,
    explanation: result.explanation,
  });
  if (logErr) console.error("[detection] detection_log 写入失败（审计 trail 缺行）：", logErr.message);

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

export function gradeL1(userAnswer: string, answerKey: string[], matchLevel?: string): L1Internal {
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
    grade = "勉强"; // 边界——交给上层 gradeL1WithFallback 的 Haiku 语义复判收口
    confidence = Math.round(50 + rate * 30);
  } else {
    grade = "未过";
    confidence = Math.round(60 + (1 - rate) * 30);
  }

  // 失败原因写成人话（用户要求"把错误原因写出来"）：区分 0 命中 / 部分命中 / 通过，
  // 并点明 L1 是术语默写、缺的就在 missing 里。语义兜底触发时这段会被 Haiku 的理由覆盖。
  const pct = Math.round(rate * 100);
  let explanation: string;
  if (grade === "干净通过") {
    explanation = `命中 ${hits.length}/${answerKey.length} 个必背关键词（${pct}%），通过。${note}`;
  } else if (hits.length === 0) {
    explanation = `没命中任何必背关键词。L1 是核心术语默写——换成你自己的话也行，但要点到下面这些词；若你其实答的是本节别的小点，对照「缺失要点」补背。${note}`;
  } else {
    const gap = grade === "勉强" ? "就差一点到通过线" : "离通过线还差不少";
    explanation = `只命中 ${hits.length}/${answerKey.length} 个必背关键词（${pct}%），${gap}。下面「缺失要点」就是你这次没默到的，重点补这些。${note}`;
  }

  return {
    grade,
    passed: grade === "干净通过",
    hits,
    missing,
    confidence,
    starred: false,
    explanation,
    costUsd: 0,
    grepLines: [],
    model: "rule:l1",
  };
}

/** 单个空逐字判：填入 vs 标准答案归一化后含/被含（容多写字/近义短写）。 */
function exactBlankOk(answer: string, fill: string): boolean {
  const na = keywordCore(answer);
  const nf = normalize(fill ?? "");
  return (
    na.length > 0 &&
    nf.length > 0 &&
    (nf === na || nf.includes(na) || (na.includes(nf) && nf.length >= Math.max(2, Math.ceil(na.length * 0.6))))
  );
}

/**
 * semantic 空批量按意思复判（Haiku 一次调用）：意思一致/同义/涵盖关键点 → true。
 * 失败抛错由上层 try/catch 兜（保持逐字结果，不放水不崩）。
 */
async function gradeSemanticBlanks(
  pairs: { answer: string; fill: string }[],
): Promise<{ verdicts: boolean[]; costUsd: number }> {
  const list = pairs.map((p, i) => `${i + 1}. 标准答案：「${p.answer}」 ｜ 考生填：「${p.fill}」`).join("\n");
  const system = `你给中文法考填空题判对错。【按意思判，不要求逐字】：考生填入与标准答案【意思一致 / 同义 / 涵盖其关键点】=对(true)；意思错、答非所问、空泛套话、漏掉关键限定 =错(false)。不放水也不抠字面。仅输出一个 JSON 布尔数组，长度与条数相同（如 [true,false,true]），不要任何解释。`;
  const { message, costUsd } = await runSingleTurn({
    system,
    user: `逐条判断：\n${list}`,
    model: MODELS.DRAFT,
    maxTokens: 200,
    route: "cloze-grade",
  });
  const txt = extractText(message);
  const a = txt.indexOf("["), b = txt.lastIndexOf("]");
  const arr = JSON.parse(txt.slice(a, b + 1)) as unknown[];
  return { verdicts: pairs.map((_, i) => arr[i] === true), costUsd };
}

/**
 * L1 关键词填空判分（双模式，保 L1 红线不放水）：逐空比对。
 * exact 空：确定性逐字（免费秒判）。semantic 空：先逐字试；没过且有作答 → 攒起来叫一次 Haiku 按意思复判
 *   （治"用自己的话意思对了被判错"）。缺答(空)一律不进语义复判 → 不放水。
 * 通过线：填对 ≥75% → 干净通过；≥50% → 勉强；否则未过。节级共用题源放宽到 60%。
 */
export async function gradeL1Cloze(
  filled: string[],
  answers: string[],
  matchLevel?: string,
  modes?: ("exact" | "semantic")[] | null,
): Promise<L1Internal> {
  if (answers.length === 0) {
    return {
      grade: "勉强",
      passed: false,
      hits: [],
      missing: [],
      confidence: 30,
      starred: true,
      explanation: "本题无填空答案（缺料），评分不可靠，标★。",
      costUsd: 0,
      grepLines: [],
      model: "rule:l1-cloze",
    };
  }
  const ok: boolean[] = [];
  const semIdx: number[] = [];
  for (let i = 0; i < answers.length; i++) {
    ok[i] = exactBlankOk(answers[i], filled[i] ?? "");
    // 语义空：没逐字过 + 确有作答（非空）才送复判；缺答永不放水
    if (!ok[i] && modes?.[i] === "semantic" && normalize(filled[i] ?? "").length > 0) semIdx.push(i);
  }
  let costUsd = 0;
  let usedHaiku = false;
  if (semIdx.length > 0) {
    try {
      const { verdicts, costUsd: c } = await gradeSemanticBlanks(
        semIdx.map((i) => ({ answer: answers[i], fill: filled[i] ?? "" })),
      );
      semIdx.forEach((i, k) => { if (verdicts[k]) ok[i] = true; });
      costUsd = c;
      usedHaiku = true;
    } catch (e) {
      console.error("[l1-cloze] 语义复判失败，保持逐字结果：", e instanceof Error ? e.message : String(e));
    }
  }
  const hits = answers.filter((_, i) => ok[i]);
  const missing = answers.filter((_, i) => !ok[i]);
  const rate = hits.length / answers.length;
  const passT = matchLevel === "section" ? 0.6 : 0.75;
  let grade: Grade;
  let confidence: number;
  if (rate >= passT) {
    grade = "干净通过";
    confidence = Math.round(80 + rate * 20);
  } else if (rate >= 0.5) {
    grade = "勉强";
    confidence = Math.round(50 + rate * 30);
  } else {
    grade = "未过";
    confidence = Math.round(60 + (1 - rate) * 30);
  }
  const pct = Math.round(rate * 100);
  const semNote = usedHaiku ? "（部分空按意思判）" : "";
  const explanation =
    grade === "干净通过"
      ? `填对 ${hits.length}/${answers.length} 个空（${pct}%）${semNote}，通过。`
      : `只填对 ${hits.length}/${answers.length} 个空（${pct}%）${semNote}。下面「缺失要点」是没填对的关键术语，重点补这些。`;
  return {
    grade,
    passed: grade === "干净通过",
    hits,
    missing,
    confidence,
    starred: false,
    explanation,
    costUsd,
    grepLines: [],
    model: usedHaiku ? "rule+haiku:l1-cloze" : "rule:l1-cloze",
  };
}

/**
 * L1 评分（规则秒判 + Haiku 语义兜底）。
 * 规则命中率对【短关键词靶】可靠且免费；对【整句靶 / 单靶 / 一卡多考点共用靶】会退化成"逐字默写"
 * （全卡组 ~21% 的 L1 卡只有一句整句靶）。这类不可靠场景下，叫一次便宜的 Haiku 按【意思】复判：
 * 把考点名 + 本节全部要点（含客观点/口诀，不止那一句 P1）+ 考生作答喂给它，
 * 修两类误杀——①靶点错位（答对"产生条件"却被"含义那句"判 0）②换句话说/答得更细被逐字门槛卡死。
 *
 * 触发兜底（仅在规则【没干净通过】时；干净通过永远走免费秒判）：
 *   - answerKey 含整句靶（归一长度 > 8）→ 子串匹配天然不可靠；或
 *   - 命中率落在"勉强"带（rate ≥ passT−0.2）→ 边界值得语义裁决。
 * 其余（短词靶上确定性零命中 / 空答 / 缺料）一律走规则，0 成本 0 延迟。
 */
async function gradeL1WithFallback(
  kp: KpRow,
  userAnswer: string,
  answerKey: string[],
  matchLevel?: string,
): Promise<L1Internal> {
  const rule = gradeL1(userAnswer, answerKey, matchLevel);
  if (rule.passed) return rule; // 干净通过：免费秒判，不调模型
  if (!normalize(userAnswer) || answerKey.length === 0) return rule; // 空答 / 缺料：规则已正确处理

  // 判定别太死（用户 2026-06-23）：只要考生确有实质作答（≥3 字），就给一次 Haiku 语义复判机会，
  // 治"换句话说/答得更细/靶点错位被逐字门槛卡死"。短词靶真零命中由 Haiku 确认未过（带不放水指令），
  // 不会把答错/空泛放过。代价＝非通过的 L1 多一次便宜 Haiku 调用，换"意思对就算过"。
  if (normalize(userAnswer).length < 3) return rule; // 极短/乱码作答：规则未过即可，不浪费 Haiku

  try {
    return await gradeL1Semantic(kp, userAnswer, answerKey, rule);
  } catch (err) {
    console.error(
      "[gradeL1] 语义兜底失败，退回规则结果：",
      err instanceof Error ? err.message : String(err),
    );
    return rule; // Haiku 渠道/预算/限速异常不阻塞背诵，退回规则结果
  }
}

/** L1 语义复判（Haiku 单次调用，无 grep）：按意思判、吃本节全部要点，治"靶点错位/逐字默写"两类误杀。 */
async function gradeL1Semantic(
  kp: KpRow,
  userAnswer: string,
  answerKey: string[],
  rule: L1Internal,
): Promise<L1Internal> {
  const kpName = (kp.ext as { name?: string })?.name ?? kp.kp_id;
  const reference = buildL1Reference(kp);
  const sys = `你在批改一道法硕「L1 记忆默写」题。考生正在背诵考点【${kpName}】（${kp.subject}）。

【判分原则】
- 按【意思】判，不要求逐字：考生换种说法、答得更细、要点更全，都算覆盖到位。
- 考生只需回忆出与【${kpName}】直接相关的核心要点即可；本节可能还含其他小考点，别因为他没背别的小考点就判错。
- 答错题=未过：若考生答的明显是本节【另一个小考点】的内容（而非【${kpName}】本身），即便那段答得对，也判【未过】——这是答错题、不是答得不全。
- 不放水：与【${kpName}】相关的核心要点缺失 / 关键定性写错 = 未过；核心覆盖但有遗漏 = 勉强；核心都到位 = 干净通过。

【本节参考要点（考生应从中回忆出与考点相关的核心点）】
${reference}

【命题脚本自动抽取的关键词靶（可能只覆盖了本节某一小点，仅供参考；不要因为考生没默到这一条就判错）】
${answerKey.map((k) => "- " + k).join("\n")}

严格输出 JSON（不要任何额外文字、不要 markdown 代码块）：
{"grade":"干净通过|勉强|未过","hits":["考生答对的要点"],"missing":["该补的要点"],"confidence":0-100,"explanation":"一句话评分理由"}`;

  const { message, costUsd } = await runSingleTurn({
    system: sys,
    user: `【考生作答】\n${userAnswer}`,
    model: MODELS.DRAFT,
    maxTokens: 700,
    route: "detect:grade:L1",
  });
  const parsed = parseGradeJson(extractText(message));
  return {
    grade: parsed.grade,
    passed: parsed.grade === "干净通过",
    hits: parsed.hits.length ? parsed.hits : rule.hits,
    missing: parsed.missing,
    confidence: parsed.confidence,
    starred: false,
    explanation: `${parsed.explanation || "已按语义复判"}（AI 语义判 · 规则命中 ${rule.hits.length}/${answerKey.length}）`,
    costUsd,
    grepLines: [],
    model: MODELS.DRAFT,
  };
}

/** 汇集本考点要点做语义判参考。考点专属 l1_keypoints 优先（kp-specific，避免语义判看到兄弟小考点
 *  内容而误给分）；缺失才退回整卡的 P1+P2+客观点+口诀。封顶 40 行防 prompt 膨胀。 */
function buildL1Reference(kp: KpRow): string {
  const curated = curatedKeypoints(kp);
  if (curated.length >= 2) return curated.map((s) => "· " + s).join("\n");
  const noteIds = ((kp.ext as { anki_note_ids?: number[] })?.anki_note_ids ?? []) as number[];
  const anki = loadAnki();
  const lines: string[] = [];
  for (const id of noteIds) {
    const c = anki.get(id);
    if (!c) continue;
    const mn = (c.口诀 ?? []).map((s) => s.replace(/【.+?】/g, ""));
    for (const s of [...(c.P1必背高精 ?? []), ...(c.P2必背 ?? []), ...(c.客观点 ?? []), ...mn]) {
      const t = s.trim();
      if (t) lines.push("· " + t);
    }
  }
  return lines.slice(0, 40).join("\n") || "（本节无结构化要点，按考点名常识判断）";
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
export function keywordCore(keyword: string): string {
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
export function matchKeyword(answer: string, keyword: string): boolean {
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
  // L2 判分只锚教材原文（不检索心得）：与出题对齐，避免把心得里的综合点当成简答的必答要点
  //   而误压到勉强（用户 2026-06-27）。L3 仍检索心得（应用/综合需要）。
  const gradeRetrieval =
    opts.level === "L2"
      ? `- search_textbook：本考点教材原文（必查，评分锚）
- search_zhenti：若题干引自真题则查`
      : `- search_textbook：本考点教材原文（必查，评分锚）
- search_xinde：相关心得规则
- search_zhenti：若题干引自真题则查`;
  const planSys = `你只列检索查询不作答。本次任务=评分考生对【${name}】（${kp.subject}）的简答/案例作答。规划 3-5 条 grep：
${gradeRetrieval}
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
3. 列出"命中要点"和"缺失要点"，逐条引用教材行号（结果里没行号就不要编）。${
    opts.level === "L2"
      ? "\n4. 【本题为 L2 简答】判分只看教材原文已写明的基本观点/概念/特征/法理（含代表人物及其观点）是否背出；不得要求跨流派、跨知识点的综合比较或分野判断，也不要把心得里的引申点当作缺失要点——那是 L3 的范围。但教材已写明的核心要点仍须背到，缺了照扣，不放水。"
      : ""
  }

═══ 输出严格 JSON 块（不要其他文字，不要 markdown 代码块）═══
{"grade":"干净通过|勉强|未过","hits":["..."],"missing":["..."],"confidence":0-100,"starred":true|false,"grep_lines":[行号数字],"explanation":"一句话评分理由"}
`;

  const { message, grepHits, costUsd } = await runPlanThenAnswer({
    planSystem: planSys,
    answerSystemStable: ans,
    question: `【考生作答】\n${opts.userAnswer}`,
    model: MODELS.GRADING,
    planModel: MODELS.PLAN, // 规划阶段降级 Sonnet 省钱；评分作答仍 Opus 不降级（红线①）
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

export function parseGradeJson(raw: string): GradeJson {
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
        ? obj.grep_lines.map(Number).filter((n) => Number.isFinite(n) && n > 0) // 行号必 ≥1；null→0/负数剔除
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

  // 升降档纯逻辑抽到 kp-transition（单测锁定），这里只负责写库 + 投递事件。
  const t = computeTransition(kp, level, grade);

  const update: Record<string, unknown> = {
    cur_level: t.cur_level,
    interval_idx: t.interval_idx,
    difficulty: t.difficulty,
    last_review: t.lastReview,
    next_due: t.nextDue,
    mastered: t.mastered,
    review_count: kp.review_count + 1,
    error_count: kp.error_count + t.errorCountDelta,
    [t.statusField]: t.statusValue,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("kp_state")
    .update(update)
    .eq("kp_id", kp.kp_id);
  if (error) throw new Error(`kp_state 更新失败：${error.message}`);

  // G2 兑现：本考点完成了一次检测（无论结果），pending 复验请求即消费。
  // 不消费它会永久 pending、天天占清单复验桶；没过的话间隔退档+G1 会接手跟进。
  await consumeReviewRequests(kp.kp_id);

  // G1 反向（已强化）：曾出错的考点首次达成 mastered → 投「已强化」。
  // 云在待办筐收下后，PC 登记把当前弱项.md 里对应行移入"已强化"段——弱项有进有出。
  if (t.shouldEmitStrengthened) {
    await emitEvent({
      type: "已强化",
      subject: kp.subject,
      kp_id: kp.kp_id,
      knowledge: (kp.ext as { name?: string })?.name ?? kp.kp_id,
      anchor: formatAnchor(kp) || null,
      source: "检测",
      payload: { 累计错次: kp.error_count, 触发: "弱项考点三档全过达成 mastered" },
      dedupBy: "kp",
    });
  }

  return {
    prev,
    next: { cur_level: t.cur_level, interval_idx: t.interval_idx, difficulty: t.difficulty, next_due: t.nextDue },
    mastered: t.mastered,
  };
}

/**
 * G1：检查最近 N 次同档检测是否连续失败，达阈值则向 events 投递弱项候选。
 * 防重统一走 emitEvent（同 kp_id 已有 pending 弱项候选 → 不重发）。
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

  return emitEvent({
    type: "弱项候选",
    subject: kp.subject,
    kp_id: kp.kp_id,
    knowledge: (kp.ext as { name?: string })?.name ?? kp.kp_id,
    anchor: formatAnchor(kp) || null,
    source: "检测",
    payload: {
      level,
      连续失败次数: G1_THRESHOLD,
      触发: "G1 背诵失败转弱项",
    },
    dedupBy: "kp",
  });
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

export function uniqShort(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s || s.length > 80) continue; // 过长的整句不当关键词
    // 必须用与 matchKeyword 同一个 keywordCore 判"可命中性"：core<2 字的关键词
    // （如 Anki 拆行拆出的孤儿"1.从"→core"从"）matchKeyword 永远 false，留在靶里
    // 只会拉低命中率，把【满分默写也判未过】（FL-0094 类自相矛盾，2026-06-15 修）。
    // 去重也按 core，顺带合并"1.保障"与"保障"这类同义重复。
    const core = keywordCore(s);
    if (core.length < 2 || seen.has(core)) continue;
    seen.add(core);
    out.push(s);
  }
  return out.slice(0, 20); // 关键词集封顶 20
}
