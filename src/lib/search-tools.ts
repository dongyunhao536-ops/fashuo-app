import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";

/**
 * grep 工具链（v2.3 机制①⑨）——答疑/评分前必须先检索教材/心得/真题，
 * 回答带 grep 命中行号；无 grep 痕迹则信心度 -20% + 标★。
 * 内容来自 content_mirror（GitHub Action 从 markdown 镜像）；冷启动时镜像可能为空。
 */

export interface GrepHit {
  tool: string;
  query: string;
  path: string;
  lines: number[];
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

/** 在 content_mirror 中按 kind grep，返回命中行（含真实行号） */
async function grepMirror(
  kind: string,
  keyword: string,
): Promise<{ path: string; line: number; text: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("content_mirror")
    .select("path, content, start_line")
    .eq("kind", kind);
  if (error || !data) return [];
  const hits: { path: string; line: number; text: string }[] = [];
  for (const row of data) {
    const lines = String(row.content).split("\n");
    lines.forEach((ln, i) => {
      if (keyword && ln.includes(keyword)) {
        hits.push({
          path: row.path,
          line: (row.start_line ?? 1) + i,
          text: ln.trim(),
        });
      }
    });
  }
  return hits;
}

export async function executeSearchTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: string; hit?: GrepHit }> {
  const kind = KIND_BY_TOOL[name];
  if (!kind) return { result: `未知工具：${name}` };

  const keyword =
    name === "search_zhenti"
      ? [input["year"], input["question_no"]].filter(Boolean).join(" ")
      : String(input["keyword"] ?? "").trim();

  const matches = await grepMirror(kind, keyword);

  if (matches.length === 0) {
    return {
      result: `内容镜像中未检索到「${keyword}」。注意：content_mirror 可能尚未同步内容（冷启动），此时应在回答中标★并降低信心度。`,
      hit: { tool: name, query: keyword, path: "", lines: [] },
    };
  }

  const top = matches.slice(0, 20);
  const body = top.map((m) => `${m.path}:${m.line}  ${m.text}`).join("\n");
  return {
    result: `命中 ${matches.length} 行（显示前 ${top.length}）：\n${body}`,
    hit: {
      tool: name,
      query: keyword,
      path: top[0].path,
      lines: top.map((m) => m.line),
    },
  };
}
