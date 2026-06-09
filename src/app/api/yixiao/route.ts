import { listDuelPairs, generateDuel, gradeDuel } from "@/lib/yixiao";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";

/**
 * 易混对决（系统设计/03 §3.5）。
 * GET  /api/yixiao            → 列出全部易混对
 * POST /api/yixiao {action:"generate", path}                          → 出区分题
 * POST /api/yixiao {action:"grade", path, question, correctConcept, keyPoints, userAnswer} → 评分
 */

export const maxDuration = 120;

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

export async function GET(req: Request) {
  const subject = new URL(req.url).searchParams.get("subject") || undefined;
  const pairs = await listDuelPairs(subject);
  return Response.json({ pairs });
}

export async function POST(req: Request) {

  let body: {
    action?: string;
    path?: string;
    question?: string;
    correctConcept?: string;
    keyPoints?: unknown;
    userAnswer?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const path = body.path?.trim();
  if (!path) return Response.json({ error: "path 不能为空" }, { status: 400 });

  try {
    if (body.action === "generate") {
      const q = await generateDuel(path);
      return Response.json({ ...q, costText: fmtCost(q.costUsd) });
    }
    if (body.action === "grade") {
      const userAnswer = body.userAnswer?.trim();
      if (!userAnswer) return Response.json({ error: "userAnswer 不能为空" }, { status: 400 });
      const r = await gradeDuel({
        path,
        question: body.question ?? "",
        correctConcept: body.correctConcept ?? "",
        keyPoints: Array.isArray(body.keyPoints) ? body.keyPoints.map(String) : [],
        userAnswer,
      });
      return Response.json({ ...r, costText: fmtCost(r.costUsd) });
    }
    return Response.json({ error: "action 必须是 generate 或 grade" }, { status: 400 });
  } catch (err) {
    if (err instanceof BudgetExceededError)
      return Response.json({ error: err.message, kind: "budget" }, { status: 429 });
    if (err instanceof DailyCapError)
      return Response.json({ error: err.message, kind: "daily_cap" }, { status: 429 });
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/yixiao] 失败：", msg);
    return Response.json({ error: msg, kind: "other" }, { status: 502 });
  }
}
