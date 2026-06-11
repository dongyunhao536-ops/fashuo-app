import { generateQuestion } from "@/lib/detection";
import type { Level } from "@/lib/detection";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/detect/generate —— 出检测题。
 * 入参：{ kpId: string, level?: 'L1'|'L2'|'L3' }（level 缺省取 kp.cur_level）。
 * 出参：{ kpId, level, question, answerKey, source, sourceRef, costUsd?, warning? }
 *
 * L1 = 本地规则零成本（Anki P1/P2 关键词）；L2/L3 = Opus 两段式生成（按教材锚，标 source=ai 进抽查）。
 * 红线：题源真题优先，AI 生成必标 source 供云抽查（防出题=评分循环论证，BUILD_PLAN §红线2）。
 */

// 七牛云 RPM 限速 → 两段式 Opus 生成可能 2-3 分钟，放宽超时
export const maxDuration = 300;

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

const VALID_LEVELS: Level[] = ["L1", "L2", "L3"];

export async function POST(req: Request) {
  // 心跳流包裹：L2/L3 两段式 Opus 可达 2-3 分钟，保活防手机蜂窝网掐断（L1 快，无副作用）。
  return streamJson(async () => {
    let body: { kpId?: string; level?: string };
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }
    const kpId = body.kpId?.trim();
    if (!kpId) return { status: 400, body: { error: "kpId 不能为空" } };

    let level: Level | undefined;
    if (body.level) {
      if (!VALID_LEVELS.includes(body.level as Level)) {
        return { status: 400, body: { error: `level 必须是 L1/L2/L3，收到：${body.level}` } };
      }
      level = body.level as Level;
    }

    try {
      const q = await generateQuestion({ kpId, level });
      return { status: 200, body: q };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/detect/generate] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}
