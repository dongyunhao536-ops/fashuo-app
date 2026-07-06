import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/weekly/generate —— 【已停用生成 · 2026-07-06】。
 * 周报改为电脑端(PC · Opus)生产、APP 端只展示；「刷新/生成」按钮已从 UI（WeeklyNarrative）移除。
 * 保留端点以防旧客户端直接 POST，命中即提示、不再生成（不花钱、不盖掉 PC 报告）。
 */

export const maxDuration = 10;

export async function POST() {
  return streamJson(async () => ({
    status: 200,
    body: { skipped: true, message: "周报现由电脑端(PC · Opus)生产，APP 端只展示，无需在手机刷新。" },
  }));
}
