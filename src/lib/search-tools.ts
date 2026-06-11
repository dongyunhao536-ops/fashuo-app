import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";

/**
 * grep 工具链（v2.3 机制①⑨）——答疑/评分前必须先检索教材/心得/真题，
 * 回答带 grep 命中行号；无 grep 痕迹则信心度 -20% + 标★。
 * 内容来自 content_mirror（GitHub Action 从 markdown 镜像）；冷启动时镜像可能为空。
 *
 * 2026-06-11 重写：
 * - 命中带 ±2 行上下文（重叠块合并），证据卡引用不再被腰斩成单行。
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
      "在《考试分析》教材原文中检索关键词，返回命中片段+行号。回答概念辨析/法条理解/真题答案质疑前必须先调用，核对教材原文（v2.3 机制①⑨）。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要在教材中检索的关键词" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "search_xinde",
    description:
      "在刑法/民法做题心得中检索规则。答疑优先级第一档：心得已有规则则优先据此作答（含真题证据+法理+应用建议）。",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要在心得文件中检索的关键词" },
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

/** 命中行前后各带几行上下文 */
const CONTEXT_LINES = 2;
/** 每次检索最多返回几个上下文块（防"2024"这类宽词把 token 撑爆） */
const MAX_BLOCKS = 8;
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

interface MatchBlock {
  path: string;
  /** 真实行号（start_line 校准） */
  hitLines: number[];
  text: string;
}

/** 在若干镜像行里按谓词逐行匹配，命中行连同 ±CONTEXT_LINES 行合并成上下文块 */
function grepRows(
  rows: MirrorRow[],
  predicate: (line: string) => boolean,
  keyword?: string,
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

    let cur: { from: number; to: number; hits: number[] } | null = null;
    const flush = (span: { from: number; to: number; hits: number[] }) => {
      const hitSet = new Set(span.hits);
      const text = [];
      for (let i = span.from; i <= span.to; i++) {
        const isHit = hitSet.has(i);
        text.push(`${base + i}${isHit ? "►" : " "} ${clipLine(lines[i], isHit ? keyword : undefined)}`);
      }
      blocks.push({
        path: row.path,
        hitLines: span.hits.map((i) => base + i),
        text: text.join("\n"),
      });
    };
    for (const i of hitIdx) {
      const from = Math.max(0, i - CONTEXT_LINES);
      const to = Math.min(lines.length - 1, i + CONTEXT_LINES);
      if (cur && from <= cur.to + 1) {
        cur.to = to;
        cur.hits.push(i);
      } else {
        if (cur) flush(cur);
        cur = { from, to, hits: [i] };
      }
    }
    if (cur) flush(cur);
  }
  return { blocks, totalHits };
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
    ({ blocks, totalHits } = grepRows(rows, (ln) => ln.includes(query), query));
  }

  if (blocks.length === 0) {
    return {
      result: `内容镜像中未检索到「${query}」。注意：content_mirror 可能尚未同步内容（冷启动），此时应在回答中标★并降低信心度。`,
      hit: { tool: name, query, path: "", lines: [] },
    };
  }

  const top = blocks.slice(0, MAX_BLOCKS);
  const body = top.map((b) => `· ${b.path}（►=命中行）\n${b.text}`).join("\n");
  return {
    result: `命中 ${totalHits} 行 / ${blocks.length} 个片段（显示前 ${top.length}）：\n${note}${body}`,
    hit: {
      tool: name,
      query,
      path: top[0].path,
      lines: top.flatMap((b) => b.hitLines).slice(0, 30),
    },
  };
}
