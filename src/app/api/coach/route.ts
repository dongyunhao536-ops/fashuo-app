import { runCoach } from "@/lib/coach";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

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
  // 心跳流包裹：单次 Opus 也可能跨过手机蜂窝网的静默超时，保活到底。
  return streamJson(async () => {
    let body: { input?: string };
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }
    const input = (body.input ?? "").trim();
    if (!input) return { status: 400, body: { error: "input 不能为空" } };
    if (input.length > 500) {
      return { status: 400, body: { error: "一句话就好（≤500 字），别写长文" } };
    }

    try {
      const r = await runCoach(input);
      return { status: 200, body: { ...r, costText: fmtCost(r.costUsd) } };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/coach] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}
