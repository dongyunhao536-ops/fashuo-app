import { buildWeeklyReview } from "@/lib/weekly-review";
import { generateWeeklyNarrative } from "@/lib/weekly-narrative";
import { MODELS } from "@/lib/models";
import { supabaseAdmin } from "@/lib/supabase";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/weekly/generate —— 生成/刷新本周【复盘 + 下周指导】（核心权威层）。
 * 聚合本周真实数据(buildWeeklyReview) → Opus 复盘/指导(generateWeeklyNarrative) → 按 week_start 缓存到 weekly_report。
 * 同一周覆盖刷新（upsert onConflict week_start）。/weekly 页直接读缓存，不每次重算 Opus。
 *
 * 单次 Opus，RPM 慢 → 心跳流保活。鉴权由 src/proxy.ts 网关统一处理。
 */

export const maxDuration = 120;

export async function POST() {
  return streamJson(async () => {
    try {
      const today = new Date();
      const review = await buildWeeklyReview(today);
      const { content, costUsd } = await generateWeeklyNarrative(review, today);

      const { error } = await supabaseAdmin.from("weekly_report").upsert(
        {
          week_start: review.weekStart,
          week_end: review.weekEnd,
          content,
          data_snapshot: review,
          model: MODELS.COACH,
          cost_usd: costUsd,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "week_start" },
      );
      if (error) console.error("[/api/weekly/generate] weekly_report 写入失败：", error.message);

      return {
        status: 200,
        body: {
          content,
          weekStart: review.weekStart,
          weekEnd: review.weekEnd,
          generatedAt: new Date().toISOString(),
          costText: fmtCost(costUsd),
          stored: !error,
        },
      };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/weekly/generate] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}
