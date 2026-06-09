import { gradeAnswer, fmtGradeForUI } from "@/lib/detection";
import type { Level, QuestionSource } from "@/lib/detection";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";

/**
 * POST /api/detect/grade —— 评分检测题（写 detection_log + 更新 kp_state + G1 弱项候选）。
 * 入参：{ kpId, level, question, userAnswer, answerKey, source, sourceRef }
 *      （除 userAnswer 外，其它字段直接转发 /api/detect/generate 的返回值）
 * 出参：{ grade, passed, hits, missing, confidence, starred, explanation, stateUpdate, weakEventEmitted, costUsd, model }
 *
 * 红线（不可破，对应 BUILD_PLAN §红线）：
 *   ① 评分 Opus 不降级（放水=假掌握，飞轮变自欺机器）
 *   ② grade 内部强制 grep 教材锚定；缺锚 → 标★+信心降
 *   ③ G1：连续失败达阈值（config.G1_背诵失败转弱项.连续失败阈值）→ events(弱项候选)
 */

export const maxDuration = 300;

// 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。

const VALID_LEVELS: Level[] = ["L1", "L2", "L3"];
const VALID_SOURCES: QuestionSource[] = ["anki", "real", "adapted", "ai", "none"];

export async function POST(req: Request) {

  let body: {
    kpId?: string;
    level?: string;
    question?: string;
    userAnswer?: string;
    answerKey?: unknown;
    source?: string;
    sourceRef?: string;
    seconds?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const kpId = body.kpId?.trim();
  const level = body.level?.trim();
  const question = body.question?.trim();
  const userAnswer = body.userAnswer?.trim();
  const source = (body.source ?? "anki").trim();
  const sourceRef = (body.sourceRef ?? "").trim();
  const answerKey = Array.isArray(body.answerKey)
    ? body.answerKey.map(String)
    : [];
  const seconds =
    typeof body.seconds === "number" && Number.isFinite(body.seconds) && body.seconds > 0
      ? Math.round(body.seconds)
      : null;

  if (!kpId) return Response.json({ error: "kpId 不能为空" }, { status: 400 });
  if (!level || !VALID_LEVELS.includes(level as Level)) {
    return Response.json({ error: `level 必须是 L1/L2/L3` }, { status: 400 });
  }
  if (!question) return Response.json({ error: "question 不能为空" }, { status: 400 });
  if (!userAnswer) return Response.json({ error: "userAnswer 不能为空" }, { status: 400 });
  if (!VALID_SOURCES.includes(source as QuestionSource)) {
    return Response.json({ error: `source 非法：${source}` }, { status: 400 });
  }

  try {
    const result = await gradeAnswer({
      kpId,
      level: level as Level,
      question,
      userAnswer,
      answerKey,
      source: source as QuestionSource,
      sourceRef,
      seconds,
    });
    return Response.json(fmtGradeForUI(result));
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message, kind: "budget" }, { status: 429 });
    }
    if (err instanceof DailyCapError) {
      return Response.json({ error: err.message, kind: "daily_cap" }, { status: 429 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/detect/grade] 失败：", msg);
    return Response.json({ error: msg, kind: "other" }, { status: 502 });
  }
}
