import { generateAndStoreWeekly } from "@/lib/weekly-narrative";

/**
 * POST /api/cron/weekly —— 周一早上自动生成本周【复盘 + 下周指导】（ECS crontab 触发）。
 * 不走用户登录态：proxy 网关放行 /api/cron/*，改由 CRON_SECRET 头部鉴权（仅服务器 crontab 持有）。
 * 与手动「刷新」共用 generateAndStoreWeekly；同周覆盖。
 *
 * crontab（北京周一 07:00）：
 *   0 23 * * 0 root curl -sk --max-time 180 -X POST -H "Authorization: Bearer $CRON_SECRET" https://127.0.0.1:8443/api/cron/weekly
 *   （服务器 UTC 时，周日 23:00 UTC = 周一 07:00 北京；若服务器已是北京时区则用 0 7 * * 1）
 */

export const maxDuration = 120;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await generateAndStoreWeekly(new Date());
    console.log(`[cron/weekly] 已生成 ${r.weekStart} 复盘（stored=${r.stored}, $${r.costUsd.toFixed(4)}）`);
    return Response.json({ ok: true, weekStart: r.weekStart, stored: r.stored, costUsd: r.costUsd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/cron/weekly] 失败：", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}

export const POST = handle;
export const GET = handle;
