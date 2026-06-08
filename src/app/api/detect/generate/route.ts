import { generateQuestion } from "@/lib/detection";
import type { Level } from "@/lib/detection";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";

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

function checkAuth(req: Request): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw || pw === "change-me") return true;
  return req.headers.get("x-app-password") === pw;
}

const VALID_LEVELS: Level[] = ["L1", "L2", "L3"];

export async function POST(req: Request) {
  if (!checkAuth(req)) return Response.json({ error: "未授权" }, { status: 401 });

  let body: { kpId?: string; level?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const kpId = body.kpId?.trim();
  if (!kpId) return Response.json({ error: "kpId 不能为空" }, { status: 400 });

  let level: Level | undefined;
  if (body.level) {
    if (!VALID_LEVELS.includes(body.level as Level)) {
      return Response.json({ error: `level 必须是 L1/L2/L3，收到：${body.level}` }, { status: 400 });
    }
    level = body.level as Level;
  }

  try {
    const q = await generateQuestion({ kpId, level });
    return Response.json(q);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message, kind: "budget" }, { status: 429 });
    }
    if (err instanceof DailyCapError) {
      return Response.json({ error: err.message, kind: "daily_cap" }, { status: 429 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/detect/generate] 失败：", msg);
    return Response.json({ error: msg, kind: "other" }, { status: 502 });
  }
}
