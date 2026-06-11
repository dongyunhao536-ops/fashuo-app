import { gradeAnswer, fmtGradeForUI } from "@/lib/detection";
import type { Level, QuestionSource } from "@/lib/detection";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

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
  // 心跳流包裹：L2/L3 Opus grep 评分可达 2-3 分钟，保活防手机蜂窝网掐断（L1 快，无副作用）。
  return streamJson(async () => {
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
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }

    const kpId = body.kpId?.trim();
    const level = body.level?.trim();
    const question = body.question?.trim();
    const userAnswer = body.userAnswer?.trim();
    const source = (body.source ?? "anki").trim();
    const sourceRef = (body.sourceRef ?? "").trim();
    const answerKey = Array.isArray(body.answerKey) ? body.answerKey.map(String) : [];
    const seconds =
      typeof body.seconds === "number" && Number.isFinite(body.seconds) && body.seconds > 0
        ? Math.round(body.seconds)
        : null;

    if (!kpId) return { status: 400, body: { error: "kpId 不能为空" } };
    if (!level || !VALID_LEVELS.includes(level as Level)) {
      return { status: 400, body: { error: `level 必须是 L1/L2/L3` } };
    }
    if (!question) return { status: 400, body: { error: "question 不能为空" } };
    if (!userAnswer) return { status: 400, body: { error: "userAnswer 不能为空" } };
    if (!VALID_SOURCES.includes(source as QuestionSource)) {
      return { status: 400, body: { error: `source 非法：${source}` } };
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
      return { status: 200, body: fmtGradeForUI(result) };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/detect/grade] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}
