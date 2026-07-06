import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";

/**
 * grep 工具链（v2.3 机制①⑨）——答疑/评分前必须先检索教材/心得/真题，
 * 回答带 grep 命中行号；无 grep 痕迹则信心度 -20% + 标★。
 * 内容来自 content_mirror（GitHub Action 从 markdown 镜像）；冷启动时镜像可能为空。
 *
 * 2026-06-11 重写：
 * - 命中带 ±2 行上下文（重叠块合并），证据卡引用不再被腰斩成单行。
 *
 * 2026-07-04 检索质量修（答疑把"中止自动性"答反的事故复盘）：
 * - 块边界句子补全：±2 窗口停在半句中间时向外扩到句读边界（OCR 硬换行文本一句跨多行，
 *   两块夹缝恰好丢掉结论行会造成拼读反转）。
 * - 目录点线行不算命中；关键词检索按块内命中数排序取前 MAX_BLOCKS（原纯文档序，
 *   大词的前排全被目录/概述占掉，规则正文反被丢弃）。
 * - per-request MirrorCache：同一次答疑 12 条检索只把每个 kind 从 Supabase 拉一次
 *   （原先每个关键词全量下载五本教材，串行重复 10+ 次，是答疑延迟的大头之一）。
 * - search_zhenti 修复：year 与 question_no 分别在同一行匹配（原先 join(" ") 成
 *   "2024 48" 整串子串，几乎必然零命中）；题号未命中时退化为按年份检索。
 */

export interface GrepHit {
  tool: string;
  query: string;
  path: string;
  lines: number[];
}

interface MirrorRow {
  path: string;
  content: string;
  start_line: number | null;
}

/** 一次请求内共享的 kind→rows 缓存。每个 API 请求 new 一个，请求结束随 GC 释放。 */
export type MirrorCache = Map<string, MirrorRow[]>;
export function createMirrorCache(): MirrorCache {
  return new Map();
}

// ⚠️ 七牛云/Bedrock 约束：工具参数名(property key)必须匹配 ^[a-zA-Z0-9_.-]{1,64}$（纯 ASCII）。
//    官方 Anthropic 允许中文 key，Bedrock 不允许（实测 400 invalid_request_error）。故 key 用英文，描述照样中文。
export const SEARCH_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_textbook",
    description:
      "在《考试分析》教材 + 《刑法精讲一本通》讲义原文中检索关键词，返回命中片段+行号。两者同级权威。回答概念辨析/法条理解/真题答案质疑前必须先调用，核对原文（v2.3 机制①⑨）。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要在教材中检索的关键词（概念名/罪名，单个连续词不含空格）" },
        refine: {
          type: "string",
          description:
            "可选·争点特征词（如'因果''正在进行'）。填了则同时命中 keyword+refine 的条目排序置顶——治宽词检索把深页争点条目挤出返回窗口。",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search_xinde",
    description:
      "在刑法/民法做题心得 + 刑法讲义心得（《刑法精讲一本通》作者标注的提示/马工程/易错/辨析框，逐字提取，是作者划的重点/权威观点）中检索规则。答疑优先级第一档：心得/讲义心得已有规则则优先据此作答，引用讲义心得带上讲义页码。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要在心得文件中检索的关键词（概念名，单个连续词不含空格）" },
        refine: {
          type: "string",
          description:
            "可选·争点特征词（如'因果'）。填了则同时命中 keyword+refine 的条目排序置顶——把'某概念下讲某争点'那一条从深处拉回前排。",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search_zhenti",
    description: "按年份(+题号)检索真题原文与答案，用于真题锚定。",
    input_schema: {
      type: "object",
      properties: {
        year: { type: "string", description: "年份，如 2024" },
        question_no: { type: "string", description: "题号，如 48 或 案例57（可空）" },
      },
      required: ["year"],
    },
  },
];

const KIND_BY_TOOL: Record<string, string> = {
  search_textbook: "textbook",
  search_xinde: "xinde",
  search_zhenti: "zhenti",
};

/** 命中行前后各带几行上下文（±2 保证证据卡引用不被腰斩，别降） */
const CONTEXT_LINES = 2;
/** 块边界停在半句中间时，向外找句读边界最多再扩几行（35 字/行的 OCR 硬换行文本 3 行≈100 字）。
 *  2026-07-04 教训：考试分析"犯罪中止(3)注意"段跨 6 行，±2 窗口恰好把结论行"可以成立犯罪中止"
 *  夹在两块缝隙里丢掉，剩下两个半句拼读=句意反转，答疑据此答错中止成立要件。 */
const SENTENCE_EXTEND = 3;
/** 每次检索最多返回几个上下文块。2026-07-02 降本：8→5——强制两库全覆盖后检索条数上去了，
 *  每条给 8 块会把作答 input 撑到 2-3 万 token（Opus 计费+拖慢首字）；5 块 × 10 来条查询覆盖已足。 */
const MAX_BLOCKS = 5;
/** xinde 是条目库（一行=一条完整心得，自带页码/真题锚点），邻行是不相干的其他条目——
 *  上下文预算换成覆盖条数：0 行上下文 × 10 块，token 不升反降、覆盖翻倍。
 *  2026-07-04 实录：「犯罪中止」在 xinde 命中 10 块，讲义 P157 马工程因果结论排第 9，
 *  5 块窗口永远轮不到它，答疑因此从未引用过这条已入库的关键心得。 */
const KIND_PARAMS: Record<string, { context: number; maxBlocks: number }> = {
  xinde: { context: 0, maxBlocks: 10 },
};
/** 单行超过这个长度就裁剪（教材 txt 一段一行，可能几千字） */
const LINE_CLIP = 160;

async function fetchKind(kind: string, cache?: MirrorCache): Promise<MirrorRow[]> {
  const cached = cache?.get(kind);
  if (cached) return cached;
  const { data, error } = await supabaseAdmin
    .from("content_mirror")
    .select("path, content, start_line")
    .eq("kind", kind);
  const rows: MirrorRow[] = error || !data ? [] : (data as MirrorRow[]);
  cache?.set(kind, rows);
  return rows;
}

/** 超长行裁剪：命中行以关键词为中心开窗，上下文行截头 */
function clipLine(ln: string, keyword?: string): string {
  const t = ln.trim();
  if (t.length <= LINE_CLIP) return t;
  if (keyword) {
    const idx = t.indexOf(keyword);
    if (idx !== -1) {
      const half = Math.floor((LINE_CLIP - keyword.length) / 2);
      const from = Math.max(0, idx - half);
      const to = Math.min(t.length, idx + keyword.length + half);
      return `${from > 0 ? "…" : ""}${t.slice(from, to)}${to < t.length ? "…" : ""}`;
    }
  }
  return `${t.slice(0, LINE_CLIP)}…`;
}

export interface MatchBlock {
  path: string;
  /** 真实行号（start_line 校准） */
  hitLines: number[];
  text: string;
  /** 争点特征词(refine)是否也在本块【原文】内命中——AND-boost 排序用（见 rankBlocks / executeSearchTool） */
  refineHit: boolean;
}

/** 行是否停在句读边界（空行/表格行也算）。OCR 硬换行文本一行≈35 字，句子常跨行。 */
function endsSentence(ln: string): boolean {
  const t = ln.trim();
  if (t === "") return true;
  return /[。．！？!?…；;：:”」』）)】\]|]$/.test(t);
}

/** 在若干镜像行里按谓词逐行匹配，命中行连同 ±CONTEXT_LINES 行合并成上下文块；
 *  块首尾停在半句中间时向外扩到句读边界（SENTENCE_EXTEND 封顶），扩展后重叠的块二次合并——
 *  两个残句块各自截半句，中间恰好丢结论行的拼读反转，比少几行上下文危险得多。 */
export function grepRows(
  rows: MirrorRow[],
  predicate: (line: string) => boolean,
  keyword?: string,
  context: number = CONTEXT_LINES,
  /** 争点特征词：命中主词的块里，原文若也含 refine 则标 refineHit（AND-boost 排序用） */
  refine?: string,
): { blocks: MatchBlock[]; totalHits: number } {
  const blocks: MatchBlock[] = [];
  let totalHits = 0;
  for (const row of rows) {
    const lines = String(row.content).split("\n");
    const base = row.start_line ?? 1;
    const hitIdx: number[] = [];
    lines.forEach((ln, i) => {
      if (predicate(ln)) hitIdx.push(i);
    });
    totalHits += hitIdx.length;

    // ① 命中行 ±context 聚成初始块（相邻/相接则合并）
    const spans: { from: number; to: number; hits: number[] }[] = [];
    for (const i of hitIdx) {
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      const cur = spans[spans.length - 1];
      if (cur && from <= cur.to + 1) {
        cur.to = to;
        cur.hits.push(i);
      } else {
        spans.push({ from, to, hits: [i] });
      }
    }

    // ② 句子补全：块首接在半句后/块尾停在半句中 → 向外扩到句读边界
    //    （仅连续文本库；context=0 的条目库一行自成一条，不扩邻行）
    if (context > 0) {
      for (const s of spans) {
        let ext = SENTENCE_EXTEND;
        while (s.from > 0 && ext > 0 && !endsSentence(lines[s.from - 1])) {
          s.from--;
          ext--;
        }
        ext = SENTENCE_EXTEND;
        while (s.to < lines.length - 1 && ext > 0 && !endsSentence(lines[s.to])) {
          s.to++;
          ext--;
        }
      }
    }

    // ③ 扩展可能使相邻块重叠 → 二次合并后输出
    const merged: typeof spans = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.from <= last.to + 1) {
        last.to = Math.max(last.to, s.to);
        last.hits.push(...s.hits);
      } else {
        merged.push(s);
      }
    }
    for (const span of merged) {
      const hitSet = new Set(span.hits);
      const text = [];
      let refineHit = false;
      for (let i = span.from; i <= span.to; i++) {
        const isHit = hitSet.has(i);
        // refineHit 用【原始整行】判定，不看裁剪后的显示文本——clipLine 会以主词为心开窗，
        // 特征词可能被切出显示区，但排序必须认它到底在不在这条原文里（这是把"X争点下讲Y"那条捞到前排的关键）。
        if (refine && lines[i].includes(refine)) refineHit = true;
        text.push(`${base + i}${isHit ? "►" : " "} ${clipLine(lines[i], isHit ? keyword : undefined)}`);
      }
      blocks.push({
        path: row.path,
        hitLines: span.hits.map((i) => base + i),
        text: text.join("\n"),
        refineHit,
      });
    }
  }
  return { blocks, totalHits };
}

/**
 * 命中块排序（AND-boost·2026-07-05）——根治"讲义提示/马工程被引不到"：
 * - 有争点特征词(refine)时，原文同时含 keyword+refine 的块【无条件置顶】。单关键词子串检索
 *   表达不了"某概念(中止)下讲某特征(因果)那一条"，深页争点条目会被浅页同词条目按文档序挤出返回窗口
 *   （实录：讲义心得"因果"命中18条、中止因果那条P157排第14，maxBlocks截前10必丢）。refine 把它拉回前排。
 * - 其次按命中密度（规则正文常一段多次点题），最后 sort 稳定→保持文档序。
 * - docOrder=true（真题）时不加权：年份分区本身即位置信息。
 * 纯函数，便于单测锁死这条修复。
 */
export function rankBlocks(
  blocks: MatchBlock[],
  opts: { refine?: string; docOrder?: boolean },
): MatchBlock[] {
  if (opts.docOrder) return blocks;
  return [...blocks].sort((a, b) => {
    if (opts.refine) {
      const co = (b.refineHit ? 1 : 0) - (a.refineHit ? 1 : 0);
      if (co !== 0) return co;
    }
    return b.hitLines.length - a.hitLines.length;
  });
}

export async function executeSearchTool(
  name: string,
  input: Record<string, unknown>,
  cache?: MirrorCache,
): Promise<{ result: string; hit?: GrepHit }> {
  const kind = KIND_BY_TOOL[name];
  if (!kind) return { result: `未知工具：${name}` };

  const rows = await fetchKind(kind, cache);

  let query: string;
  let blocks: MatchBlock[];
  let totalHits: number;
  let note = "";
  let refine: string | undefined;

  if (name === "search_zhenti") {
    const year = String(input["year"] ?? "").trim();
    const qno = String(input["question_no"] ?? "").trim();
    query = qno ? `${year} 第${qno}题` : year;
    if (!year) {
      return { result: "search_zhenti 缺少 year 参数。", hit: { tool: name, query, path: "", lines: [] } };
    }
    // 年份 + 题号要求同一行都出现（"2024年专基第48题"式行）；零命中则退化为按年份撒网，
    // 上下文块里通常能看到具体题号。
    ({ blocks, totalHits } = grepRows(
      rows,
      qno ? (ln) => ln.includes(year) && ln.includes(qno) : (ln) => ln.includes(year),
      year,
    ));
    if (blocks.length === 0 && qno) {
      ({ blocks, totalHits } = grepRows(rows, (ln) => ln.includes(year), year));
      if (blocks.length > 0) note = `（题号「${qno}」未与年份同行命中，已退化为按年份检索，请在上下文里自行定位该题）\n`;
    }
  } else {
    query = String(input["keyword"] ?? "").trim();
    if (!query) {
      return { result: `${name} 缺少 keyword 参数。`, hit: { tool: name, query, path: "", lines: [] } };
    }
    // 争点特征词（可选）：命中主词的条目里，原文也含 refine 的排序置顶（AND-boost，见 rankBlocks）。
    refine = String(input["refine"] ?? "").trim() || undefined;
    // 目录点线行（"犯罪中止....54"式）不算命中——大词检索时它们抢占文档序前排，全是噪音
    ({ blocks, totalHits } = grepRows(
      rows,
      (ln) => ln.includes(query) && !/\.{6,}/.test(ln),
      query,
      (KIND_PARAMS[kind] ?? { context: CONTEXT_LINES }).context,
      refine,
    ));
  }

  if (blocks.length === 0) {
    return {
      result: `内容镜像中未检索到「${query}」。注意：content_mirror 可能尚未同步内容（冷启动），此时应在回答中标★并降低信心度。`,
      hit: { tool: name, query, path: "", lines: [] },
    };
  }

  // 排序：争点特征词(refine)同时命中的块置顶 → 命中密度 → 稳定文档序（规则正文常一段多次点题；
  // 纯文档序会让目录/概述把它挤出前 MAX_BLOCKS——2026-07-04"犯罪中止"133 处命中、前 5 块全是概述噪音的实录）。
  // 真题检索仍按文档序（年份分区本身就是位置信息）。详见 rankBlocks。
  const ranked = rankBlocks(blocks, { refine, docOrder: name === "search_zhenti" });
  const top = ranked.slice(0, KIND_PARAMS[kind]?.maxBlocks ?? MAX_BLOCKS);
  const coHit = refine ? top.filter((b) => b.refineHit).length : 0;
  const refineNote = refine
    ? coHit > 0
      ? `（争点特征词「${refine}」：${coHit} 个同时命中的条目已置顶，优先看它们）\n`
      : `（争点特征词「${refine}」：本轮无条目同时命中主词+特征词，以下仅按主词命中排序，据此需谨慎）\n`
    : "";
  const body = top.map((b) => `· ${b.path}（►=命中行）\n${b.text}`).join("\n");
  return {
    result: `命中 ${totalHits} 行 / ${blocks.length} 个片段（显示前 ${top.length}）：\n${note}${refineNote}${body}`,
    hit: {
      tool: name,
      query: refine ? `${query}+${refine}` : query,
      path: top[0].path,
      lines: top.flatMap((b) => b.hitLines).slice(0, 30),
    },
  };
}
