import { generateAndStoreWeekly } from "@/lib/weekly-narrative";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError, fmtCost } from "@/lib/anthropic";
import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/weekly/generate —— 手动「刷新」本周【复盘 + 下周指导】（用户在 /weekly 点刷新时触发）。
 * 真正的聚合+生成+缓存在 generateAndStoreWeekly（与周一自动 cron 共用）。周一早上由 /api/cron/weekly 自动跑。
 * 单次 Opus，RPM 慢 → 心跳流保活。鉴权由 src/proxy.ts 网关统一处理。
 */

export const maxDuration = 120;

export async function POST() {
  return streamJson(async () => {
    try {
      const r = await generateAndStoreWeekly(new Date());
      return {
        status: 200,
        body: {
          content: r.content,
          weekStart: r.weekStart,
          weekEnd: r.weekEnd,
          generatedAt: new Date().toISOString(),
          costText: fmtCost(r.costUsd),
          stored: r.stored,
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
