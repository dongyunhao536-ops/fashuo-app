import { listDuelPairs, generateDuel, gradeDuel } from "@/lib/yixiao";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

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
  // 心跳流包裹：generate/grade 均 Opus 1-3 分钟，保活防手机蜂窝网掐断。
  return streamJson(async () => {
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
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }
    const path = body.path?.trim();
    if (!path) return { status: 400, body: { error: "path 不能为空" } };

    try {
      if (body.action === "generate") {
        const q = await generateDuel(path);
        return { status: 200, body: { ...q, costText: fmtCost(q.costUsd) } };
      }
      if (body.action === "grade") {
        const userAnswer = body.userAnswer?.trim();
        if (!userAnswer) return { status: 400, body: { error: "userAnswer 不能为空" } };
        const r = await gradeDuel({
          path,
          question: body.question ?? "",
          correctConcept: body.correctConcept ?? "",
          keyPoints: Array.isArray(body.keyPoints) ? body.keyPoints.map(String) : [],
          userAnswer,
        });
        return { status: 200, body: { ...r, costText: fmtCost(r.costUsd) } };
      }
      return { status: 400, body: { error: "action 必须是 generate 或 grade" } };
    } catch (err) {
      if (err instanceof BudgetExceededError)
        return { status: 429, body: { error: err.message, kind: "budget" } };
      if (err instanceof DailyCapError)
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/yixiao] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}
