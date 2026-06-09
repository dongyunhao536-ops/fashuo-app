import { runCoach } from "@/lib/coach";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";

/**
 * POST /api/coach —— 教练 T1（系统设计/13）。
 * 入参：{ input: string }（自然语言，如"今天刑法第5章听课"）
 * 出参：{ parsed, pointer, progress, plan, review, weakEmitted, redlines, costUsd, costText }
 *
 * 单次 Opus 调用（无 grep 工具循环）→ 比答疑快/便宜；解析+四段+写 study_log+复盘投 events 一次完成。
 */

export const maxDuration = 120;

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

export async function POST(req: Request) {

  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const input = (body.input ?? "").trim();
  if (!input) return Response.json({ error: "input 不能为空" }, { status: 400 });
  if (input.length > 500) {
    return Response.json({ error: "一句话就好（≤500 字），别写长文" }, { status: 400 });
  }

  try {
    const r = await runCoach(input);
    return Response.json({ ...r, costText: fmtCost(r.costUsd) });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message, kind: "budget" }, { status: 429 });
    }
    if (err instanceof DailyCapError) {
      return Response.json({ error: err.message, kind: "daily_cap" }, { status: 429 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/coach] 失败：", msg);
    return Response.json({ error: msg, kind: "other" }, { status: 502 });
  }
}
