import { runSingleTurn, extractText } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { emitEvent } from "./events";

/**
 * 易混对决（系统设计/03 §3.5）——云的头号敌人=概念交叉污染的正面战场。
 * 数据源=易混概念库（content_mirror kind=yixiao，人工整理的高质量区分手册）。
 * 检测=区分题：给一个迷你场景，问"构成哪个？凭什么不是另外的"——比孤立回忆更治混淆。
 *
 * 复用 runSingleTurn（单次 Opus，把易混档案全文喂进去，无需 grep 工具循环，成本低 ~¥0.1-0.2/题）。
 * 输出用 ===块=== 格式（避 JSON 引号坑，2026-06-09 教训）。
 */

export interface DuelPair {
  path: string;
  subject: string;
  concepts: string[]; // 易混的 2-3 个概念
  label: string; // "高空抛物 vs 过失致死 vs 过失危害公共安全"
}

export interface DuelQuestion {
  pair: DuelPair;
  question: string;
  correctConcept: string;
  keyPoints: string[]; // 关键区分要点（评分参考）
  costUsd: number;
  warning?: string;
}

export interface DuelGrade {
  grade: "干净通过" | "勉强" | "未过";
  passed: boolean;
  hits: string[];
  missing: string[];
  explanation: string;
  weakEmitted: boolean; // 未过时是否投了 events 弱项候选
  costUsd: number;
}

/** 从文件名解析科目 + 概念：易混概念库/刑法-高空抛物vs过失致死vs过失危害公共安全.md */
export function parsePair(path: string): DuelPair {
  const base = path.split("/").pop()!.replace(/\.md$/, "");
  const dash = base.indexOf("-");
  const subject = dash > 0 ? base.slice(0, dash) : "";
  const rest = dash > 0 ? base.slice(dash + 1) : base;
  const concepts = rest.split(/vs|VS|对决/).map((s) => s.trim()).filter(Boolean);
  return { path, subject, concepts, label: concepts.join(" vs ") };
}

/** 列出全部易混对（从 content_mirror kind=yixiao 的 distinct path） */
export async function listDuelPairs(subject?: string): Promise<DuelPair[]> {
  const { data } = await supabaseAdmin
    .from("content_mirror")
    .select("path")
    .eq("kind", "yixiao");
  const paths = [...new Set((data ?? []).map((r) => r.path as string))];
  let pairs = paths.map(parsePair);
  if (subject) pairs = pairs.filter((p) => p.subject === subject);
  return pairs;
}

/** 读某易混对全文（拼 content_mirror 的 chunks）——对决页"先读辨析"背诵区也用它 */
export async function readPairContent(path: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("content_mirror")
    .select("content, chunk_no")
    .eq("kind", "yixiao")
    .eq("path", path)
    .order("chunk_no");
  return (data ?? []).map((r) => r.content as string).join("\n");
}

/** 解析 ===KEY=== 块格式 */
function blocks(raw: string, keys: string[]): Record<string, string> {
  const re = new RegExp(`===\\s*(${keys.join("|")})\\s*===`, "gi");
  const parts = raw.split(re);
  const map: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) map[parts[i].toUpperCase()] = (parts[i + 1] ?? "").trim();
  return map;
}

const bullets = (s: string) =>
  (s ?? "")
    .split("\n")
    .map((l) => l.replace(/^[\s\t]*[-·•*]+\s*/, "").trim())
    .filter((l) => l.length > 1 && l.length < 200);

// ============================================================
// 出区分题
// ============================================================
export async function generateDuel(path: string): Promise<DuelQuestion> {
  const pair = parsePair(path);
  const content = await readPairContent(path);
  if (!content) {
    return {
      pair,
      question: `[缺料] 易混档案 ${path} 未镜像`,
      correctConcept: "",
      keyPoints: [],
      costUsd: 0,
      warning: "档案未镜像到 content_mirror",
    };
  }

  const system = `你是法硕（非法学）命题人。下面是一份【易混概念辨析档案】（人工整理，含一句话区分 test、判断流程、教材依据）。
请基于它出一道【区分题】：编一个 80-130 字的迷你案例场景，场景要刚好踩在这几个易混概念的分界线上，让考生必须用关键区分点才能定性。
要求考生回答：①这构成上述哪一个？②凭什么不是另外的（说出关键区分 test）。

只在档案覆盖范围内出题，不超纲。严格按下面分块输出（段内随便用标点，不要 JSON）：
===QUESTION===
（题干：迷你场景 + 设问，不含答案）
===ANSWER===
（正确答案是哪个概念，一个短语）
===KEYPOINTS===
- 关键区分点1（为什么是它、为什么不是另一个）
- 关键区分点2
- 关键区分点3`;

  const user = `【易混辨析档案：${pair.label}】\n${content}\n\n请出一道区分题。`;
  const { message, costUsd } = await runSingleTurn({
    system,
    user,
    model: MODELS.GRADING,
    route: "yixiao:gen",
    maxTokens: 1500,
  });
  const raw = extractText(message);
  const b = blocks(raw, ["QUESTION", "ANSWER", "KEYPOINTS"]);
  return {
    pair,
    question: (b.QUESTION ?? raw).trim(),
    correctConcept: (b.ANSWER ?? "").trim(),
    keyPoints: bullets(b.KEYPOINTS ?? ""),
    costUsd,
  };
}

// ============================================================
// 评分区分题
// ============================================================
export async function gradeDuel(opts: {
  path: string;
  question: string;
  correctConcept: string;
  keyPoints: string[];
  userAnswer: string;
}): Promise<DuelGrade> {
  const content = await readPairContent(opts.path);
  const system = `你是法硕评分老师，给"易混概念区分题"评分。【严禁放水】。
评分两个维度：①定性是否选对了概念 ②是否说出了关键区分 test（凭什么是它、不是另一个）。
判 干净通过 / 勉强 / 未过：
- 干净通过：选对概念 且 说出核心区分理由
- 勉强：选对概念 但区分理由不清/不全
- 未过：选错概念 或 完全说不出区分依据
依据下面的辨析档案（含标准区分 test）客观判分。

严格按分块输出（不要 JSON）：
===GRADE===
干净通过|勉强|未过
===HITS===
- 答对/命中的点
===MISSING===
- 缺失/答错的点
===EXPLANATION===
一句话评分理由（点出关键区分 test）`;

  const user = `【易混辨析档案】\n${content}\n\n【题目】\n${opts.question}\n\n【标准答案】概念：${opts.correctConcept}；关键区分：${opts.keyPoints.join("；")}\n\n【考生作答】\n${opts.userAnswer}`;
  const { message, costUsd } = await runSingleTurn({
    system,
    user,
    model: MODELS.GRADING,
    route: "yixiao:grade",
    maxTokens: 1200,
  });
  const raw = extractText(message);
  const b = blocks(raw, ["GRADE", "HITS", "MISSING", "EXPLANATION"]);
  const g = (b.GRADE ?? "").trim();
  const grade = (["干净通过", "勉强", "未过"] as const).includes(g as never)
    ? (g as DuelGrade["grade"])
    : "勉强";

  // 未过=选错概念/答不出区分依据 → 真实的概念交叉污染信号，投待办筐弱项候选
  // （统一走 emitEvent：同 pair 连败 pending 期间只留一条，PC 登记进易混档案历次混淆记录）
  let weakEmitted = false;
  if (grade === "未过") {
    const pair = parsePair(opts.path);
    if (pair.subject) {
      weakEmitted = await emitEvent({
        type: "弱项候选",
        subject: pair.subject,
        kp_id: null,
        knowledge: `易混混淆：${pair.label}`,
        anchor: opts.path,
        source: "检测",
        payload: { from: "易混对决", correctConcept: opts.correctConcept },
      });
    }
  }

  return {
    grade,
    passed: grade === "干净通过",
    hits: bullets(b.HITS ?? ""),
    missing: bullets(b.MISSING ?? ""),
    explanation: (b.EXPLANATION ?? "").trim(),
    weakEmitted,
    costUsd,
  };
}
